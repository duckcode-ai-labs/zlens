import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { currentRecordOwner, type RecordOwner } from './host/record-owner.js';

/**
 * REQUESTS THAT OUTLAST A PROXY'S TIME LIMIT.
 *
 * The Snowflake ingress in front of the Native App ends a request that has
 * not answered within 90 seconds. The browser then gets the proxy's own
 * 504 "upstream request timeout", while the work runs on. Snowflake's advice
 * for anything longer is to poll. New-user test V10: "Describe with AI" (one
 * App Builder planner call on Cortex, plus the saved-query reads before it)
 * took over 80 s, and 3 of 3 tries ended in that 504.
 *
 * A caller that may wait long asks for an asynchronous answer the standard
 * way (RFC 7240): `Prefer: respond-async, wait=20`.
 * - Work done within `wait` seconds answers as it always did.
 * - Otherwise the answer is `202 { longRequest: { id, state: 'running' } }`.
 *   The caller asks `GET /api/long-requests/<id>` (also with `Prefer: wait`),
 *   and each ask waits up to `wait` seconds. When the work is done, that ask
 *   answers with the work's own status and body.
 * A caller that does not ask (MCP, the CLI, older pages) is answered as
 * before, in one request.
 *
 * The work's answer is kept for the person who started it, in this process,
 * for LONG_REQUEST_TTL_MS after it ends.
 */
export interface LongRequestAnswer {
  status: number;
  body: unknown;
}

export const LONG_REQUEST_PATH = '/api/long-requests/';
/** Upper bound on any one wait, well under the 90 s ingress limit. */
export const LONG_REQUEST_MAX_WAIT_S = 30;
const DEFAULT_WAIT_S = 20;
const LONG_REQUEST_TTL_MS = 10 * 60_000;

type Serialize = (value: unknown) => string;

interface LongRequestJob {
  owner: RecordOwner;
  done: Promise<LongRequestAnswer>;
  serialize: Serialize;
  answer?: LongRequestAnswer;
  expires?: NodeJS.Timeout;
}

const jobs = new Map<string, LongRequestJob>();

/** Seconds the caller will wait for this answer, or undefined when it did not ask to be answered asynchronously. */
export function preferredWaitSeconds(req: IncomingMessage, requireAsync = true): number | undefined {
  const raw = req.headers?.prefer;
  const prefer = (Array.isArray(raw) ? raw.join(',') : raw ?? '').toLowerCase();
  if (requireAsync && !/(^|[\s,;])respond-async\b/.test(prefer)) return undefined;
  const wait = /(?:^|[\s,;])wait\s*=\s*(\d+)/.exec(prefer);
  const seconds = wait ? Number(wait[1]) : DEFAULT_WAIT_S;
  return Math.max(0, Math.min(LONG_REQUEST_MAX_WAIT_S, Number.isFinite(seconds) ? seconds : DEFAULT_WAIT_S));
}

function send(res: ServerResponse, answer: LongRequestAnswer, serialize: Serialize = JSON.stringify, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(answer.status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(serialize(answer.body));
}

/** The answer if `done` settles within `ms`, else undefined. */
async function within(done: Promise<LongRequestAnswer>, ms: number): Promise<LongRequestAnswer | undefined> {
  if (ms <= 0) return Promise.race([done, Promise.resolve(undefined)]);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      done,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function running(id: string): LongRequestAnswer {
  return { status: 202, body: { ok: true, longRequest: { id, state: 'running', poll: `${LONG_REQUEST_PATH}${encodeURIComponent(id)}` } } };
}

/**
 * Run `work` and answer with what it returns: at once when it finishes within
 * the caller's `Prefer: wait`, else as a long request the caller polls. `work`
 * must turn its own failures into an answer; an unexpected throw becomes a 500.
 */
export async function answerLongRequest(
  req: IncomingMessage,
  res: ServerResponse,
  work: () => Promise<LongRequestAnswer>,
  options: { serialize?: Serialize } = {},
): Promise<void> {
  const serialize = options.serialize ?? JSON.stringify;
  const done = work().catch((error: unknown): LongRequestAnswer => ({
    status: 500,
    body: { ok: false, error: error instanceof Error ? error.message : String(error) },
  }));
  const owner = currentRecordOwner();
  const waitSeconds = preferredWaitSeconds(req);
  // A host that names nobody for this request has no one to keep the answer for.
  if (waitSeconds === undefined || owner === null) {
    send(res, await done, serialize);
    return;
  }
  const early = await within(done, waitSeconds * 1000);
  if (early) {
    send(res, early, serialize);
    return;
  }
  // Node discards a request body still unread when its response ends: answer
  // only once the work has read its body (or is done).
  if (!req.readableEnded) {
    await Promise.race([
      new Promise<void>((resolve) => { req.once('end', () => resolve()); req.once('close', () => resolve()); }),
      done,
    ]);
  }
  const settled = await within(done, 0);
  if (settled) {
    send(res, settled, serialize);
    return;
  }
  const id = randomUUID();
  const job: LongRequestJob = { owner, done, serialize };
  jobs.set(id, job);
  void done.then((answer) => {
    job.answer = answer;
    job.expires = setTimeout(() => { jobs.delete(id); }, LONG_REQUEST_TTL_MS);
    job.expires.unref?.();
  });
  send(res, running(id), JSON.stringify, { 'Preference-Applied': 'respond-async' });
}

/** `GET /api/long-requests/<id>`: the work's answer once it is done, else still running. */
export async function handleLongRequestPoll(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith(LONG_REQUEST_PATH)) return false;
  if (req.method !== 'GET') {
    send(res, { status: 405, body: { ok: false, error: 'Method not allowed.' } });
    return true;
  }
  const id = decodeURIComponent(path.slice(LONG_REQUEST_PATH.length));
  const job = jobs.get(id);
  // Only the person who started it reads it (without a host, the one local user).
  if (!job || job.owner !== currentRecordOwner()) {
    send(res, {
      status: 404,
      body: {
        ok: false,
        code: 'LONG_REQUEST_NOT_FOUND',
        error: 'ZLens no longer has this request. It may have restarted. Try again.',
      },
    });
    return true;
  }
  const answer = job.answer ?? await within(job.done, (preferredWaitSeconds(req, false) ?? DEFAULT_WAIT_S) * 1000);
  if (answer) send(res, answer, job.serialize);
  else send(res, running(id));
  return true;
}

/** Test seam: forget every kept answer. */
export function clearLongRequestsForTests(): void {
  for (const job of jobs.values()) if (job.expires) clearTimeout(job.expires);
  jobs.clear();
}
