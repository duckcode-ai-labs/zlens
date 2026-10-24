import type { ManifestRelationshipValidationEvidence } from '@zlens/core';

/**
 * Certify where you are (T4), the parts that decide what the short reviews
 * say and whether "I vouch for this — certify" may write anything: one for a
 * saved query (it runs, its tests pass, who owns it, what one row is) and one
 * for a join (its keys, the fresh check, what would double-count if it were
 * wrong, and the grain and keys Modeling needs, filled only from what a check
 * proved). Pure: the server runs the checks and writes through the existing
 * certification paths; these only read their results.
 */

const count = (value: number): string => value.toLocaleString('en-US');
const plural = (value: number, one: string, many = `${one}s`): string => `${count(value)} ${value === 1 ? one : many}`;
const words = (value: string): string => value.replace(/_+/g, ' ').trim();

/** What `certifyBlockStudioSource` reports, as far as the review reads it. */
export interface SavedQueryVerdictLike {
  preview: { result: { rowCount?: number; rows?: unknown[] } } | null;
  testResults: { passed: number; failed: number; assertions: Array<{ name: string; passed: boolean; error?: string }> } | null;
  checklist: { issues: Array<{ code?: string; message: string }> };
}

export interface SavedQueryReview {
  /** It runs: ran just now, with how many rows, or why not. */
  runs: { ok: true; sentence: string } | { ok: false; error: string };
  /** Its tests and how each one did. */
  tests: Array<{ name: string; passed: boolean; error?: string }>;
  /** "All 3 tests pass.", "1 of 3 tests failed.", "No tests declared." */
  testsSentence: string;
  /** Who owns it, as the source declares it; absent when nobody is named. */
  owner?: string;
  /** Nobody owns it yet: the review asks for an owner and writes it. */
  ownerRequired: boolean;
  /** What one row is, when known ("One row for each region and month."). */
  row?: string;
  /** What keeps it from being certified now, besides a missing owner. */
  blockers: string[];
  /** The plain-word checks the receipt records once it is certified. */
  checks: string[];
}

/** What one row of a saved query is: its declared grain, else its grouping columns, else its key fields. */
export function savedQueryRowSentence(input: { grain?: string; dimensions?: readonly string[]; keyFields?: readonly string[] }): string | undefined {
  const grain = input.grain?.trim();
  // A grain written as a sentence ("one row per beverage product") is said as written.
  if (grain && /^(?:one|each|a) row\b/i.test(grain)) return `${grain.charAt(0).toUpperCase()}${grain.slice(1).replace(/[.\s]+$/, '')}.`;
  if (grain) return `Each row is one ${words(grain)}.`;
  const groups = (input.dimensions ?? []).map((value) => value.trim()).filter(Boolean);
  if (groups.length) return `One row for each ${groups.map(words).join(' and ')}.`;
  const keys = (input.keyFields ?? []).filter(Boolean);
  if (keys.length) return `Each row is one ${keys.map(words).join(' and ')}.`;
  return undefined;
}

/** The saved query's short review, from the verdict of the same certification path Block Studio's Certify runs. */
export function savedQueryReview(input: {
  verdict: SavedQueryVerdictLike;
  owner?: string;
  grain?: string;
  dimensions?: readonly string[];
  keyFields?: readonly string[];
}): SavedQueryReview {
  const { verdict } = input;
  const issues = verdict.checklist.issues;
  const runError = issues.find((issue) => issue.code === 'preview_failed' || issue.code === 'preview_required')?.message;
  const rows = verdict.preview ? verdict.preview.result.rowCount ?? verdict.preview.result.rows?.length ?? 0 : 0;
  const runs: SavedQueryReview['runs'] = verdict.preview && !runError
    ? { ok: true, sentence: `Ran just now: ${plural(rows, 'row')}.` }
    : { ok: false, error: runError ?? 'It did not run.' };
  const tests = (verdict.testResults?.assertions ?? []).map((assertion) => ({
    name: assertion.name,
    passed: assertion.passed,
    ...(assertion.error ? { error: assertion.error } : {}),
  }));
  const failed = tests.filter((test) => !test.passed).length;
  const testsSentence = tests.length === 0
    ? 'No tests declared.'
    : failed === 0
      ? (tests.length === 1 ? 'Its one test passes.' : `All ${tests.length} tests pass.`)
      : `${failed} of ${tests.length} ${tests.length === 1 ? 'test' : 'tests'} failed.`;
  const owner = input.owner?.trim() || undefined;
  const row = savedQueryRowSentence(input);
  const blockers = Array.from(new Set(issues.filter((issue) => issue.code !== 'owner_missing').map((issue) => issue.message)));
  const checks = [
    ...(runs.ok ? [`Runs: ${runs.sentence.replace(/^Ran just now: /, 'ran on certification, ')}`] : []),
    `Tests: ${testsSentence}`,
    ...(owner ? [`Owner: ${owner}`] : []),
    ...(row ? [`One row: ${row}`] : []),
  ];
  return { runs, tests, testsSentence, ...(owner ? { owner } : {}), ownerRequired: !owner, ...(row ? { row } : {}), blockers, checks };
}

/** One side of a join as Modeling knows it: its table, and the grain and keys of its model when set. */
export interface JoinCertifySide {
  /** The table as people know it ("orders"). */
  table: string;
  /** One row of it, in words, singular ("order"). */
  noun: string;
  grain?: string;
  keys?: readonly string[];
}

/** A row-key check run for this certification: the key columns, and whether every row has a different, filled value. */
export interface RowKeyCheck {
  keys: readonly string[];
  ok: boolean;
  error?: string;
  /** Where the check came from, in words ("the Dataset's row key, checked just now"). */
  source: string;
}

export interface JoinGrainFill {
  side: 'from' | 'to';
  table: string;
  grain: string;
  keys: string[];
  /** Why ZLens may fill it: the check that proved it. */
  because: string;
}

export interface JoinCertifyDecision {
  ok: boolean;
  /** Why it cannot be certified now; empty when it can. */
  blockers: string[];
  /** "orders.location_id = locations.location_id" */
  keysSentence: string;
  /** "each order has one location — checked on 61,948 rows" (only when the check passed). */
  checkedSentence?: string;
  /** What else the check found, in plain words. */
  checkLines: string[];
  /** What would double-count if the join were wrong. */
  doubleCount: string;
  /** The grain and keys Modeling needs that this certification fills, from the checks just run. */
  fills: JoinGrainFill[];
  /** The grains and keys of both sides it is certified against (when it can be certified). */
  certifiedAgainst?: { from: { grain: string; keys: string[] }; to: { grain: string; keys: string[] } };
}

/**
 * Decide a join's certification from a fresh warehouse check. It can be
 * certified only when the check passed (each "many" row finds at most one
 * row on the "one" side, few rows lose their match) and both sides' grain and
 * keys are known — set in the model, or proved by a check run now: the "one"
 * side's join key from this check (filled and different on every row), the
 * other side's row key from its own check. Nothing a check did not prove is
 * filled; a failed check refuses with its reason.
 */
export function joinCertifyDecision(input: {
  from: JoinCertifySide;
  to: JoinCertifySide;
  keys: ReadonlyArray<{ from: string; to: string }>;
  cardinality: string;
  evidence: ManifestRelationshipValidationEvidence;
  /** "each order has one location", when the Dataset already says it. */
  sentence?: string;
  /** Row-key checks run now for either side (the Dataset's row key). */
  rowKeyChecks?: { from?: RowKeyCheck; to?: RowKeyCheck };
  /** Measures that would be summed through the join ("Order Total"). */
  measures?: readonly string[];
}): JoinCertifyDecision {
  const { from, to, evidence } = input;
  const keysSentence = input.keys.map((pair) => `${from.table}.${pair.from} = ${to.table}.${pair.to}`).join(' and ');
  const blockers: string[] = [];
  const checkLines: string[] = [];
  const supported = input.cardinality === 'many_to_one' || input.cardinality === 'one_to_one' || input.cardinality === 'one_to_many';
  // Orient to many → one for the sentences: the "many" side is the one whose rows are counted.
  const reversed = input.cardinality === 'one_to_many';
  const many = reversed ? to : from;
  const one = reversed ? from : to;
  const manyRows = reversed ? evidence.toRows : evidence.fromRows;
  const oneKeys = input.keys.map((pair) => (reversed ? pair.from : pair.to));
  const measureWords = (input.measures ?? []).slice(0, 3).map(words);
  const doubleCount = `If ${one.table} had two rows for one ${oneKeys.join(', ')}, every ${many.noun} with that value would be joined twice, so totals${measureWords.length ? ` such as ${measureWords.join(', ')}` : ''} would be counted more than once.`;

  if (!supported) blockers.push(`A ${words(input.cardinality)} join cannot be certified: only a join where each row finds at most one row on the other side keeps totals right.`);
  const passed = evidence.status === 'passed';
  if (!passed) {
    const reason = (evidence.message ?? '').replace(/^Warehouse evidence does not prove the declared cardinality and safe fanout policy\.\s*/, '').trim();
    blockers.push(`The check did not pass${reason ? `: ${reason}` : '.'}`);
  }
  const unmatched = evidence.unmatchedKeyedFrom ?? Math.max(0, evidence.unmatchedFrom - evidence.fromNullKeys);
  if (unmatched > 0) checkLines.push(`${plural(unmatched, from.noun)} with a key ${unmatched === 1 ? 'finds' : 'find'} no ${to.noun}.`);
  else if (evidence.fromRows > 0) checkLines.push(`Every ${from.noun} with a key finds its ${to.noun}.`);
  if (evidence.fromNullKeys > 0) checkLines.push(`${plural(evidence.fromNullKeys, from.noun)} ${evidence.fromNullKeys === 1 ? 'has' : 'have'} no ${input.keys.map((pair) => pair.from).join(', ')}.`);
  const checkedSentence = passed && supported
    ? `${input.sentence?.trim() || `each ${many.noun} has one ${one.noun}`} — checked on ${plural(manyRows, 'row')}`
    : undefined;

  // The grain and keys of each side: as the model has them, else proved now.
  const fills: JoinGrainFill[] = [];
  const sideKey = (side: 'from' | 'to', model: JoinCertifySide): { grain: string; keys: string[] } | undefined => {
    if (model.grain?.trim() && model.keys?.length) return { grain: model.grain.trim(), keys: [...model.keys] };
    // This check proves the join key unique on a "one" side, and filled on every row.
    const keyColumns = input.keys.map((pair) => pair[side]);
    const maxPerKey = side === 'to' ? evidence.maxToPerKey : evidence.maxFromPerKey;
    const nullKeys = side === 'to' ? evidence.toNullKeys : evidence.fromNullKeys;
    const rows = side === 'to' ? evidence.toRows : evidence.fromRows;
    const oneSide = input.cardinality === 'one_to_one' || (side === 'to' ? input.cardinality === 'many_to_one' : input.cardinality === 'one_to_many');
    if (passed && oneSide && rows > 0 && maxPerKey <= 1 && nullKeys === 0) {
      const fill = { side, table: model.table, grain: keyColumns.join(', '), keys: keyColumns, because: `${keyColumns.join(', ')} is filled and different on every one of ${plural(rows, 'row')} of ${model.table}, checked just now.` };
      fills.push(fill);
      return { grain: fill.grain, keys: fill.keys };
    }
    const check = input.rowKeyChecks?.[side];
    if (check?.ok && check.keys.length) {
      const fill = { side, table: model.table, grain: check.keys.join(', '), keys: [...check.keys], because: `${check.keys.join(', ')} is filled and different on every row of ${model.table} (${check.source}).` };
      fills.push(fill);
      return { grain: fill.grain, keys: fill.keys };
    }
    // A failed join check already says why; it proves nothing to fill.
    if (!passed) return undefined;
    if (check && !check.ok) {
      blockers.push(`ZLens could not prove what one row of ${model.table} is: ${check.error ?? `${check.keys.join(', ')} did not pass its check`}.`);
    } else {
      blockers.push(`ZLens could not prove what one row of ${model.table} is: no check covers its row key yet. Certify ${model.table} as data first, or set its grain and key columns in Modeling.`);
    }
    return undefined;
  };
  const fromGrain = sideKey('from', from);
  const toGrain = sideKey('to', to);
  const ok = blockers.length === 0 && Boolean(fromGrain && toGrain);
  return {
    ok,
    blockers,
    keysSentence,
    ...(checkedSentence ? { checkedSentence } : {}),
    checkLines,
    doubleCount,
    fills: ok ? fills : [],
    ...(ok ? { certifiedAgainst: { from: fromGrain!, to: toGrain! } } : {}),
  };
}

/** A short relationship id (`orders_to_locations`) that is not taken yet: a second one between the same models gets `_2`. */
export function nextRelationshipId(fromLocalId: string, toLocalId: string, taken: Iterable<string>): string {
  const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const used = new Set([...taken].map((id) => id.toLowerCase()));
  const base = `${slug(fromLocalId) || 'model'}_to_${slug(toLocalId) || 'model'}`;
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    if (!used.has(`${base}_${index}`)) return `${base}_${index}`;
  }
}
