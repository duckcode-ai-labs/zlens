import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { CONNECTION_CREDENTIAL_FIELDS, type ConnectionConfig, type QueryPurpose } from '@zlens/connectors';
import { currentHostHooks } from './request-context.js';

/**
 * WHOSE EYES A STATEMENT SAW THROUGH. With a host's `credentials` hook each
 * person's statements run with their own warehouse permissions: row access
 * and masking rules, the tables their role may see. Anything ZLens keeps from
 * such a statement (rows, a table's columns, "this table is missing", a join
 * that was proven) was seen through that person's connection, and belongs to
 * the execution scope it ran in. A cache that keeps it includes the scope in
 * its key, so it is never served to anyone else.
 *
 * The scope of a connection is `shared` when it is the configured connection
 * itself (no host, no hook, or a hook that changes nothing), and otherwise a
 * digest of who it runs as: the `identity` the hook names with the other
 * settings it lays over, or, when it names none, everything it lays over,
 * credential included. An unnamed identity is therefore one scope per
 * credential: safe, and as long-lived as the credential.
 */
export const SHARED_EXECUTION_SCOPE = 'shared';

/** Digests are keyed per process: a scope or an identity digest means nothing outside this process. */
const PROCESS_KEY = randomBytes(32);
const digest = (text: string): string => createHmac('sha256', PROCESS_KEY).update(text).digest('hex').slice(0, 32);

/**
 * The identity a host named, as the connection carries it (`ConnectionConfig.executionIdentity`): a digest, so the
 * host's own name for a person is never in a key, a log line or an error.
 */
export function executionIdentityDigest(identity: string): string {
  return `id-${digest(`identity\u0000${identity}`)}`;
}

function stableText(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableText(record[key])}`).join(',')}}`;
}

const CREDENTIAL_FIELDS = new Set<string>(CONNECTION_CREDENTIAL_FIELDS);

/**
 * The execution scope of `resolved`, the connection a statement runs on, given `configured`, the connection before
 * the host's hook. Every setting the hook changed counts (a role or a user name decides what is visible as much as
 * a token does); with a named identity the credential itself does not, so a renewed token stays in its scope.
 */
export function executionScopeOf(configured: ConnectionConfig, resolved: ConnectionConfig): string {
  const identity = typeof resolved.executionIdentity === 'string' && resolved.executionIdentity ? resolved.executionIdentity : undefined;
  const before = configured as unknown as Record<string, unknown>;
  const after = resolved as unknown as Record<string, unknown>;
  const changed: Array<[string, string]> = [];
  for (const field of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    // Neither names who it runs as: the identity is read above, and a host's session provider is a function of the
    // request (the same person's session, a new closure each time).
    if (field === 'executionIdentity' || field === 'hostSession') continue;
    if (identity && CREDENTIAL_FIELDS.has(field)) continue;
    const now = stableText(after[field]);
    if (stableText(before[field]) !== now) changed.push([field, now]);
  }
  if (!identity && changed.length === 0) return SHARED_EXECUTION_SCOPE;
  return `person-${digest(`scope\u0000${JSON.stringify([identity ?? null, changed])}`)}`;
}

/**
 * A scope nobody else has: for a request whose connection could not be resolved (the hook refused or failed).
 * Nothing kept under it is ever found again by another request.
 */
export function unknownExecutionScope(): string {
  return `unknown-${randomUUID()}`;
}

/** How the server's hooked executor answers "which scope would this statement run in?" (row-policy.ts sets it). */
export const EXECUTION_SCOPE: unique symbol = Symbol.for('zlens.executionScope');

export type ExecutionScopeResolver = (config: ConnectionConfig, purpose?: QueryPurpose) => Promise<string>;

/**
 * Executors a host's `credentials` hook was put in front of (row-policy.ts): the wrapped executor and the one
 * underneath. Asked directly, without the wrapper's resolver, either one cannot say whose connection a statement
 * would run on.
 */
const SIGNS_PEOPLE_IN = new WeakSet<object>();

/** Record that statements of this executor run on each person's own connection (a `credentials` hook is set). */
export function markSignsPeopleIn(executor: unknown): void {
  if (executor && (typeof executor === 'object' || typeof executor === 'function')) SIGNS_PEOPLE_IN.add(executor);
}

/**
 * THE ONE HELPER. The execution scope a statement of the current request would run in on this connection, asked of
 * the executor that will run it, so the answer comes from the same hook, for the same person and purpose.
 *
 * An executor that cannot answer (it does not carry the resolver) is `shared` only where nobody is signed in to
 * the warehouse as themselves: no host, or a host without the `credentials` hook. Where the hook is set (for the
 * server handling this work, or in front of this very executor) the scope is unknown, and unknown is never
 * `shared`: the caller gets a scope of its own, so what it keeps is found by no other request. A new wrapper around
 * the executor that forgets to pass the resolver on therefore costs a cache, never a leak.
 */
export async function executionScopeFor(executor: unknown, config: ConnectionConfig | undefined, purpose?: QueryPurpose): Promise<string> {
  if (!config) return SHARED_EXECUTION_SCOPE;
  const asked = executor && (typeof executor === 'object' || typeof executor === 'function') ? executor as { [EXECUTION_SCOPE]?: ExecutionScopeResolver } : undefined;
  const resolver = asked?.[EXECUTION_SCOPE];
  if (typeof resolver !== 'function') {
    const signsPeopleIn = typeof currentHostHooks()?.credentials === 'function' || (asked !== undefined && SIGNS_PEOPLE_IN.has(asked));
    return signsPeopleIn ? unknownExecutionScope() : SHARED_EXECUTION_SCOPE;
  }
  try {
    return await resolver(config, purpose);
  } catch {
    return unknownExecutionScope();
  }
}

/** A cache key held to an execution scope. The shared scope keeps the key it always had. */
export function scopedKey(key: string, scope: string): string {
  return scope === SHARED_EXECUTION_SCOPE ? key : `${key}|as=${scope}`;
}

/**
 * `map.set`, keeping at most `max` entries (the oldest go first). Scoped keys multiply with the people asking and,
 * for an unnamed identity, with every renewed credential: a cache that was bounded by the project is bounded here.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
