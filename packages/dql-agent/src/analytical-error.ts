/**
 * Failure ORIGIN taxonomy.
 *
 * The Ask loop catches errors from four very different producers — the
 * warehouse driver, the DQL block compiler, DQL's own governance gates, and
 * retrieval — and used to funnel every one of them through
 * `normalizeWarehouseSqlFailure`, whose classifier is a set of regexes over the
 * message text. An internal throw such as `I need values for: region.` was
 * therefore reported to the user as
 *
 *   "The generated SQL failed to execute against the bounded preview: …"
 *
 * which is false: the warehouse was never contacted. The reverse also happened —
 * `createAnalyticalFailure` replaced a real driver message with a canned string,
 * so the true cause was unrecoverable even from the inspector.
 *
 * The rule this module enforces: **origin is assigned at the THROW site and is
 * never inferred at the catch site.** A catch site may only read the origin an
 * error already carries, and falls back to `warehouse` solely for errors that
 * genuinely came off a connector.
 *
 * The tag is a plain enumerable property rather than a Symbol on purpose: it
 * crosses a package boundary (`apps/cli` throws, `packages/dql-agent` catches)
 * and must survive two module instances resolving to different copies.
 */

/** Who produced the failure. */
export type AnalyticalErrorOrigin =
  /** The warehouse driver rejected or failed the statement. */
  | 'warehouse'
  /** ZLens could not compile/parse/bind its own block artifact. The warehouse is innocent. */
  | 'dql_compilation'
  /** A governance gate deliberately refused before execution. */
  | 'governance_gate'
  /** The relation/column may well exist; retrieval never inspected it. */
  | 'retrieval_gap'
  /** The question is genuinely ambiguous and needs the user. */
  | 'ambiguity'
  /** The AI provider errored or was unavailable. */
  | 'provider'
  /** ZLens host/runtime defect (bug, misconfiguration). */
  | 'host';

/** Where in the pipeline it happened. */
export type AnalyticalErrorStage =
  | 'grounding'
  | 'validation'
  | 'compile'
  | 'bind'
  | 'execute'
  | 'result_contract';

export interface AnalyticalErrorOffending {
  relation?: string;
  column?: string;
  parameter?: string;
}

export interface AnalyticalErrorDetailV1 {
  version: 1;
  origin: AnalyticalErrorOrigin;
  stage: AnalyticalErrorStage;
  /** Producer-specific code, e.g. `unknown_relation`, `unresolved_parameter`. */
  code?: string;
  offending?: AnalyticalErrorOffending;
  /** Full untruncated text for the inspector. The user-facing copy is redacted separately. */
  diagnostic?: string;
}

/** Property carrying the tag. Enumerable and string-keyed so it survives package boundaries. */
export const ANALYTICAL_ERROR_PROPERTY = 'dqlAnalyticalError';

function isDetail(value: unknown): value is AnalyticalErrorDetailV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.origin === 'string' && typeof record.stage === 'string';
}

/**
 * Attach an origin to an error without changing its identity, so an existing
 * throw site keeps its message, stack, and any connector fields. A tag that is
 * already present WINS: the innermost throw knows best, and an outer wrapper
 * must not relabel it.
 */
export function tagAnalyticalError<E>(error: E, detail: Omit<AnalyticalErrorDetailV1, 'version'>): E {
  if (!error || typeof error !== 'object') return error;
  const record = error as Record<string, unknown>;
  if (isDetail(record[ANALYTICAL_ERROR_PROPERTY])) return error;
  record[ANALYTICAL_ERROR_PROPERTY] = { version: 1, ...detail } satisfies AnalyticalErrorDetailV1;
  return error;
}

/** Read the origin an error was tagged with at its throw site, if any. */
export function analyticalErrorDetail(error: unknown): AnalyticalErrorDetailV1 | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const detail = (error as Record<string, unknown>)[ANALYTICAL_ERROR_PROPERTY];
  return isDetail(detail) ? detail : undefined;
}

/** Construct an already-tagged error. */
export function analyticalError(
  message: string,
  detail: Omit<AnalyticalErrorDetailV1, 'version'>,
): Error {
  return tagAnalyticalError(new Error(message), detail);
}

/**
 * Run `fn`, tagging anything it throws with `detail`. Used to put a single
 * honest origin on a whole region — for example every parse/bind/compile throw
 * raised inside the DQL block round-trip, which spans three packages and would
 * otherwise need a tag at each individual throw.
 */
export async function withAnalyticalErrorOrigin<T>(
  detail: Omit<AnalyticalErrorDetailV1, 'version'>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw tagAnalyticalError(error, detail);
  }
}

/** Synchronous counterpart of {@link withAnalyticalErrorOrigin}. */
export function withAnalyticalErrorOriginSync<T>(
  detail: Omit<AnalyticalErrorDetailV1, 'version'>,
  fn: () => T,
): T {
  try {
    return fn();
  } catch (error) {
    throw tagAnalyticalError(error, detail);
  }
}

/**
 * The user-facing headline for an origin. Deliberately says what DQL DID, not
 * just that something failed: "the warehouse rejected it" and "ZLens stopped it
 * before running" call for completely different user actions, and conflating
 * them is what sent people hunting for SQL bugs that did not exist.
 */
export function analyticalErrorHeadline(origin: AnalyticalErrorOrigin): string {
  switch (origin) {
    case 'warehouse':
      return 'The warehouse rejected the query.';
    case 'dql_compilation':
      return 'ZLens could not turn this answer into a reusable saved query.';
    case 'governance_gate':
      return 'ZLens stopped this query before running it.';
    case 'retrieval_gap':
      return "ZLens could not confirm this relation is in the inspected metadata.";
    case 'ambiguity':
      return 'One detail is missing before this can be answered.';
    case 'provider':
      return 'The AI provider failed.';
    case 'host':
      return 'ZLens hit an internal error.';
  }
}

/**
 * Whether a failure of this origin means the QUERY did not produce data.
 * A `dql_compilation` failure after Phase 2 happens once the query has already
 * run, so it must never be presented as a query failure — the answer stands and
 * only the reusable-block artifact is degraded.
 */
export function analyticalErrorBlocksAnswer(origin: AnalyticalErrorOrigin): boolean {
  return origin !== 'dql_compilation';
}
