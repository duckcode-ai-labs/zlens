import type { NotificationIR } from '@zlens/dql-compiler';
import type { Notifier, NotifierPayload } from '../types.js';
import { createEmailNotifier } from './email.js';
import { createFileNotifier } from './file.js';
import { createSlackNotifier } from './slack.js';
import { createWebhookNotifier } from './webhook.js';
import { noEgress } from '@zlens/connectors';
import { scopedHostHooks } from '../../host/request-context.js';
import { logUnderReference } from '../../host/plain-errors.js';

/** A delivery target: compiled block notifications, or an App schedule's webhook. */
export type DeliveryTarget = NotificationIR | { type: 'webhook'; recipients: string[] };

export interface NotificationDispatchResult {
  type: string;
  recipients: string[];
  delivered: boolean;
  error?: string;
}

/**
 * A host's delivery (RFC 0010 HH-8): its own mail, Slack app or signed
 * webhooks in place of DQL's senders. Each target is handed over as it is;
 * the host reports whether it went out.
 */
export type DeliverySink = (message: { type: string; recipients: string[]; payload: NotifierPayload }) => Promise<{ delivered: boolean; error?: string }>;

let deliverySink: DeliverySink | null = null;
/** Install the process's delivery sink, or remove it with null. */
export function setDeliverySink(sink: DeliverySink | null): void {
  deliverySink = sink;
}

export async function dispatchNotifications(
  notifications: DeliveryTarget[],
  payload: NotifierPayload,
  projectRoot: string,
): Promise<NotificationDispatchResult[]> {
  // The current work's server's sink (none for a server without a host): a host's previews and Production share a
  // process, and a server without hooks may run beside them. The process-wide sink is only for work outside them.
  const scoped = scopedHostHooks();
  const activeSink = scoped ? (scoped.hooks?.delivery ?? null) : deliverySink;
  if (activeSink) {
    const sink = activeSink;
    const delivered: NotificationDispatchResult[] = [];
    for (const n of notifications) {
      try {
        const result: unknown = await sink({ type: n.type, recipients: n.recipients, payload });
        // Only `{ delivered: true }` is delivered; any other answer is not. The host's own reason (a text) is kept.
        const answer = result && typeof result === 'object' ? result as { delivered?: unknown; error?: unknown } : {};
        const reason = typeof answer.error === 'string' && answer.error.trim() ? answer.error.trim().slice(0, 300) : undefined;
        delivered.push({ type: n.type, recipients: n.recipients, delivered: answer.delivered === true, ...(reason ? { error: reason } : answer.delivered === true ? {} : { error: 'The host did not say it delivered this message.' }) });
      } catch (error) {
        // A sink that fails (or does not answer in time) is "not delivered"; its own words go to the log under a reference.
        const reference = logUnderReference('A host delivery failed', error);
        delivered.push({ type: n.type, recipients: n.recipients, delivered: false, error: `The host could not deliver this message (reference ${reference}).` });
      }
    }
    return delivered;
  }
  // An install with no internet access (an app inside Snowflake) sends nothing out: only the project's own
  // files are written; a run's results stay in ZLens.
  const offline = noEgress();
  const notifiers: Record<string, Notifier> = offline ? { file: createFileNotifier(projectRoot) } : {
    email: createEmailNotifier(),
    slack: createSlackNotifier(),
    file: createFileNotifier(projectRoot),
    webhook: createWebhookNotifier(),
  };

  const out: NotificationDispatchResult[] = [];
  for (const n of notifications) {
    const notifier = notifiers[n.type];
    if (!notifier && offline) {
      out.push({
        type: n.type,
        recipients: n.recipients,
        delivered: false,
        error: `This install has no internet access (ZLENS_NO_EGRESS), so it does not send ${n.type} messages. The results stay in ZLens.`,
      });
      continue;
    }
    if (!notifier) {
      out.push({
        type: n.type,
        recipients: n.recipients,
        delivered: false,
        error: `no notifier registered for type "${n.type}"`,
      });
      continue;
    }
    const result = await notifier.send(n.recipients, payload);
    out.push({ type: n.type, recipients: n.recipients, ...result });
  }

  // Always append to file log for audit trail, even if no explicit file target.
  const fileLog = notifiers.file;
  const auditResult = await fileLog.send([], payload);
  if (auditResult.delivered || auditResult.error) {
    out.push({ type: 'file', recipients: ['.dql/runs/notifications.log'], ...auditResult });
  }

  return out;
}
