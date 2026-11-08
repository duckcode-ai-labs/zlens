import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What ZLens was doing when it sent a statement: the server's route action and request id, a
 * command's name. Connectors that can label a statement in the warehouse's own history carry them
 * (Snowflake: `QUERY_TAG`), so a customer can find ZLens's queries and what each was for.
 * Never values from the data, and never a person: one person's name in a shared query history is
 * the host's call, not the connector's.
 */
export type QueryLabels = Readonly<Record<string, string>>;

const labels = new AsyncLocalStorage<QueryLabels>();

/** Labels longer than this are cut; a statement's whole tag must stay short (Snowflake allows 2,000 characters). */
const MAX_LABEL_LENGTH = 120;

/** Run `work` with `added` on every statement it sends; labels set further out are kept unless replaced. */
export function withQueryLabels<T>(added: Record<string, string | undefined>, work: () => T): T {
  const merged: Record<string, string> = { ...labels.getStore() };
  for (const [key, value] of Object.entries(added)) {
    const name = key.trim();
    const text = value?.trim();
    if (name && text) merged[name] = text.slice(0, MAX_LABEL_LENGTH);
  }
  return labels.run(merged, work);
}

/** The labels for a statement sent now; empty outside `withQueryLabels`. */
export function currentQueryLabels(): QueryLabels {
  return labels.getStore() ?? {};
}
