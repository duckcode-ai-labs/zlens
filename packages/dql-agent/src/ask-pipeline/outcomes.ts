import { describeIntent, type AnalyticalIntentV1 } from './intent.js';
import { relationName, type ExecutedRows, type ResultColumnMeta, type WarehouseFailure } from './execute.js';
import type { PreparedCandidate, PreparedRefusal } from './prepare/types.js';
import type { VocabularyIndex } from './vocabulary.js';
import type { InvestigationReceiptV1 } from '../research/investigation/types.js';

/**
 * THE FOUR WAYS A TURN ENDS, and the words for each.
 *
 * answered · clarify · gap · failed (plus the two non-analytical replies).
 * A gap says which of five things is true — not retrieved, not modeled,
 * ambiguous, unsupported, denied — and names the nearest vocabulary. A
 * failure names the stage and carries the verbatim error. Nothing here ever
 * describes budgets, dispatches, snapshots or kernels.
 */

export type GapKind = 'not_retrieved' | 'not_modeled' | 'ambiguous' | 'unsupported' | 'denied';

export interface PipelineReceipt {
  version: 1;
  vocabularyFingerprint: string;
  intent?: AnalyticalIntentV1;
  reading?: string;
  dispatches: Array<{
    purpose: string; ms: number; reply?: string;
    /** The size of what was sent, so a prompt budget is a measured number. */ promptChars?: number;
    /** When the call finished (epoch ms), so AI calls sit in order beside the story. */ at?: number;
    /** 1-based attempt within its reading or drafting. */ attempt?: number;
    /** The certified blocks a drafting call was given as the team's approved computations (their refs). */ blocks?: string[];
    /** What the call was for, in the words the run views use. */ label?: 'read' | 'correct' | 'reread' | 'draft' | 'redraft' | 'fix' | 'retry_empty' | 'widen' | 'review' | 'revise';
    /** What a drafting call returned; a result review says accepted or revise. */ outcome?: 'sql' | 'declined' | 'rejected' | 'error' | 'accepted' | 'revise';
  }>;
  candidates: Array<{ tier: string; trust: string; proof: string[]; sqlFingerprint?: string; engine?: string }>;
  /** The checks an AI-written statement was held to before it ran: one entry per check per draft. */
  checks?: Array<{ id: 'stated_values' | 'required_filters' | 'join_fanout' | 'certified_joins' | 'catalog_columns' | 'read_only' | 'key_labels'; label: string; passed: boolean; message: string; attempt: number }>;
  refusals: PreparedRefusal[];
  /** Tier attempts per preparation round, in order. */
  tiers: Array<{ round: number; tier: string; outcome: string; detail?: string }>;
  executed?: { tier: string; sqlFingerprint: string; rowCount: number; ms: number; proofs: string[] };
  timings: Record<string, number>;
  reuse?: 'interpretation' | 'preparation' | 'none';
  build?: Record<string, string>;
  /** Question words naming vocabulary the reading does not use; shown as a warning, never a refusal. */
  uncovered?: string[];
  /** Refs or words the question named that the whole inventory holds outside this envelope — explained, never read. */
  outOfScope?: Array<{ ref: string; domain?: string }>;
  /** What each uncovered word means: a restriction the reading did not apply, or a word it may cover under another name. */
  /** `names`: the kinds of governed object the word names exactly (a metric, an entity, a dimension …). */
  coverage?: Array<{ word: string; state: 'unsatisfied' | 'uncertain'; names?: string[] }>;
  /** Member literals the host grounded against allowlisted columns before preparing (canonical value, or that none matched). */
  grounding?: string[];
  /** Why resolution or execution stopped, verbatim, when it did. */
  failure?: { stage: 'resolve' | 'prepare' | 'execute'; reason?: string; message: string; problems?: Array<{ path: string; message: string; suggestions?: string[] }>; warehouse?: WarehouseFailure };
  /** Warehouse statements this run dispatched and how many failed; `executed` is the one that succeeded. A failed attempt is never "no query ran". */
  /** What the host sent to the warehouse for this run: queries attempted, of which failed and succeeded. */
  warehouse?: { attempts: number; failures: number; executions?: number };
  /** Last fully completed pipeline phase; retained when a deadline/cancellation interrupts the next phase. */
  lastCompletedPhase?: string;
  /** Exact physical bindings admitted for this request; targets are redacted fingerprints. */
  physicalBindings?: Array<{ relation: string; completeness: 'complete' | 'partial'; columns: number; targetFingerprint?: string }>;
  /**
   * What the answer does NOT carry although the question asked for it: a
   * requested human label the governed vocabulary could not reach, a facet the
   * project does not model. An answer with an unmet obligation is served with
   * the omission named; it never counts as a complete one.
   */
  unmet?: Array<{ obligation: 'display_label' | 'coverage'; message: string; refs?: string[] }>;
  /** The original question's obligations and what each later reading did with them. */
  ledger?: { clauses: Array<{ clause: string; kind?: string }>; timeGrain?: { ref: string; grain: string }; measures: string[]; entries: Array<{ clause: string; kind?: string; disposition: string; by?: string; round: number }> };
  /** The context ledger (CTX-010): what was retrieved, admitted, rendered, selected, enforced and used. Identifiers and counts only. */
  context?: ContextLedgerV1;
  /** Every typed policy effect applied to the reading (SKILL-004), by skill and field. */
  policies?: Array<{ policyId: string; field: string; effect: string }>;
  /** What the run did, in order, in the reader's words: what was searched, what each tier found or missed, what ran. */
  story?: AskStoryStepV1[];
  /** A Research run's investigation: its frame, programs, budget and one pipeline receipt per query. */
  investigation?: InvestigationReceiptV1;
}

/**
 * One step of the story a run tells while it works and keeps afterwards.
 * `missed` is a place the run looked and did not find an answer (a tier that
 * refused, a field the reading named that the project does not hold); it is
 * part of the path, not an error. Titles and details never carry row values.
 */
export interface AskStoryStepV1 {
  version: 1;
  /** Ask phases, then Research's: framing the change, checking the data, analysing it, drilling in, weighing the evidence, writing the report. */
  phase: 'context' | 'read' | 'search' | 'tier' | 'join' | 'schema' | 'execute' | 'frame' | 'check' | 'analyze' | 'drill' | 'verdict' | 'report';
  /** Research: the program this step belongs to, and the query it ran. */
  programId?: string;
  queryId?: string;
  title: string;
  detail?: string;
  state: 'done' | 'missed' | 'failed';
  ms?: number;
  /** Epoch milliseconds when the step finished; orders host and pipeline steps into one story. */
  at: number;
}

export interface ContextLedgerV1 {
  version: 1;
  /** Where the host's context assembly spent its time, by phase (ms): base source, relevance, warehouse probe, source rebuild, pack, projection, index. */
  timings?: Record<string, number>;
  packId?: string;
  snapshotId?: string;
  envelope?: { activeDomain: string | null; ancestors: string[]; descendants: string[]; allowedImports: number; purpose?: string; modelAreaId?: string; skillRefs?: string[]; source: string; confidence: string };
  retrieved?: { lanes?: Record<string, number>; fused?: number };
  admitted?: { byKind: Record<string, number>; dropped?: Record<string, number>; unindexed?: Record<string, number>; eligibleFingerprint?: string };
  rendered?: { byKind: Record<string, number>; charsByKind: Record<string, number>; totalChars: number; truncated: Array<{ kind: string; shown: number; total: number }>; skills: string[]; hints: string[] };
  selected?: { refs: string[]; byKind: Record<string, number>; unrendered: string[] };
  enforced?: { policies: Array<{ policyId: string; field: string; effect: string }>; requiredFilters: string[]; gaps: string[] };
  /** An unscoped question whose context all came from one domain: the domain Ask offers to scope to. Never applied on its own. */
  suggestedDomain?: string;
  /**
   * What the answer used. A join an AI-written statement made also names its
   * two relations, its keys and the Modeling relationship it followed
   * (`authority` certified | validated | draft | stale), or `none`.
   */
  used?: { joins: Array<{ source: string; relationshipId?: string; name?: string; authority: string; scope?: string; relations?: string[]; keys?: Array<{ from: string; to: string }> }>; relations: string[]; tier?: string; engine?: string };
}

/**
 * The Ask pipeline's diagnostic receipt, persisted on the run root as
 * `diagnosticReceiptV9` and served by the trace API as `runtimeReceiptV9`.
 * V1–V8 receipts stay readable for the runs that carry them.
 */
export type AskPipelineReceiptV9 = PipelineReceipt;

export type PipelineOutcome =
  | { kind: 'answered'; intent: AnalyticalIntentV1; candidate: PreparedCandidate; result: ExecutedRows; text: string; receipt: PipelineReceipt }
  | { kind: 'clarify'; intent: AnalyticalIntentV1; question: string; options: Array<{ ref: string; label: string; description?: string }>; text: string; receipt: PipelineReceipt }
  | { kind: 'conversation' | 'definition'; reply: string; text: string; receipt: PipelineReceipt; intent?: AnalyticalIntentV1 }
  | { kind: 'gap'; gap: GapKind; message: string; nearest: string[]; text: string; receipt: PipelineReceipt; intent?: AnalyticalIntentV1; offerExploration: boolean }
  | { kind: 'failed'; stage: 'resolve' | 'prepare' | 'execute'; message: string; text: string; receipt: PipelineReceipt; intent?: AnalyticalIntentV1 }
  /** Only with `stopAfter: 'reading'`: the proven, policed reading, before anything is prepared. */
  | { kind: 'reading'; intent: AnalyticalIntentV1; lane: 'governed' | 'ai'; text: string; receipt: PipelineReceipt };

export function labelFor(vocabulary: VocabularyIndex): (ref: string) => string {
  return (ref) => {
    const entry = vocabulary.get(ref);
    if (!entry) return ref;
    return (entry.label ?? entry.name).replace(/_/g, ' ');
  };
}

/** An ISO instant at UTC midnight is a calendar date; it is never rendered through the host timezone. */
const UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|\+00:00)$/;

export function formatValue(value: unknown, meta?: ResultColumnMeta): string {
  if (value === null || value === undefined) return 'null';
  if (meta && typeof value === 'number' && Number.isFinite(value)) {
    if (meta.kind === 'percent') {
      const points = meta.unit === 'percentage_points' ? value : value * 100;
      return meta.unit === 'percentage_points' ? `${points.toFixed(meta.decimals ?? 1)} pp` : `${points.toFixed(meta.decimals ?? 1)}%`;
    }
    if (meta.kind === 'count') return String(Math.round(value));
    if (meta.kind === 'currency') return value.toFixed(meta.decimals ?? 2);
    if (meta.decimals !== undefined) return value.toFixed(meta.decimals);
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? formatValue(value.toISOString()) : 'null';
  if (typeof value === 'string') {
    const date = UTC_MIDNIGHT.exec(value);
    return date ? date[1]! : value;
  }
  return String(value);
}

// A name establishes currency only when it says money. "total", "amount" and
// "value" are generic: total_points is not dollars, and a repo that means
// money by them declares a display format.
// A column or metric NAMED as a percentage holds a fraction unless it declares otherwise.
const PERCENT_NAME = /(^|_)(pct|percent|percentage)(_|$)/i;
const CURRENCY_NAME = /(^|_)(revenue|sales|spend|price|cost|profit|income|tax|fee|fees|salary|wage|wages|payment|payments|budget|margin_amount|gmv|arr|mrr)(_|$)|(^|_)(order|invoice|bill|payment|sale|purchase|transaction)_(total|amount|value)(_|$)/i;
const COUNT_NAME = /(^|_)(count|orders|customers|items|units|quantity|num|number)(_|$)/i;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}(T00:00:00(?:\.0+)?(?:Z|\+00:00))?$/;

/**
 * The units contract of a result: what each column IS, from the vocabulary
 * entry it carries (display format, aggregation, metric type), the intent
 * (a time grain, a ratio of two measures), and only then the values.
 */
export function describeResultColumns(intent: AnalyticalIntentV1, result: Pick<ExecutedRows, 'columns' | 'rows'>, vocabulary: VocabularyIndex): ResultColumnMeta[] {
  const lower = (value: string) => value.toLowerCase();
  const entryOf = (ref: string) => vocabulary.get(ref);
  const byName = new Map<string, { ref?: string; meta: Partial<ResultColumnMeta> }>();
  const kindOfEntry = (ref: string, aggregation?: string): Partial<ResultColumnMeta> => {
    const entry = entryOf(ref);
    if (!entry) return {};
    // A column part of a ratio carries its own aggregation: counting is a count.
    if (aggregation === 'count' || aggregation === 'count_distinct') return { kind: 'count' };
    if (entry.displayFormat) return { kind: entry.displayFormat.kind, ...(entry.displayFormat.kind === 'currency' ? { unit: entry.displayFormat.currency ?? 'USD' } : entry.displayFormat.kind === 'percent' ? { unit: 'fraction' } : {}), ...(entry.displayFormat.decimals !== undefined ? { decimals: entry.displayFormat.decimals } : {}) };
    if (entry.metricType === 'ratio') return { kind: 'percent', unit: 'fraction' };
    // A derived formula that multiplies by 100 is already in points (growth, margin %).
    if (entry.metricType === 'derived' && /\*\s*100(?![0-9.])/.test(entry.expr ?? '')) return { kind: 'percent', unit: 'percentage_points' };
    const aggregate = (entry.physical?.aggregate ?? entry.aggregation ?? '').toLowerCase();
    if (aggregate === 'count' || aggregate === 'count_distinct') return { kind: 'count' };
    // dbt counts are often a SUM over 1 (`order_count: expr: 1, agg: sum`), or a sum named as a count.
    const summedExpr = (entry.physical?.expr ?? entry.expr ?? '').replace(/^SUM\(|\)$/gi, '').replace(/"[^"]*"\./g, '').trim();
    if (aggregate === 'sum' && (/^1$/.test(summedExpr) || /^\s*1\s*$/.test(entry.expr ?? '') || COUNT_NAME.test(entry.name) || COUNT_NAME.test(entry.label ?? '') || /(^|_)count(_|$)/i.test(summedExpr))) return { kind: 'count' };
    if (entry.roles.includes('time')) return { kind: 'date' };
    // An AGGREGATED field takes its type from the aggregation: SUM(team_lost)
    // over a Boolean is a number of losses, not a flag. Only an unaggregated
    // field keeps the Boolean kind.
    const aggregated = Boolean(aggregate) || entry.kind === 'metric' || entry.kind === 'measure' || (aggregation !== undefined && aggregation !== 'none');
    const booleanField = entry.roles.includes('boolean') || entry.dataType?.toLowerCase() === 'boolean';
    if (booleanField) return aggregated ? { kind: 'number' } : { kind: 'boolean' };
    if (PERCENT_NAME.test(entry.name)) return { kind: 'percent', unit: 'fraction' };
    if (entry.kind === 'metric' || entry.kind === 'measure') return CURRENCY_NAME.test(entry.name) ? { kind: 'currency', unit: 'USD' } : { kind: 'number' };
    if (/(int|decimal|numeric|double|float|real|bigint)/i.test(entry.dataType ?? '')) return { kind: 'number' };
    return { kind: 'text' };
  };
  const register = (name: string | undefined, ref: string | undefined, meta: Partial<ResultColumnMeta>) => {
    if (!name) return;
    byName.set(lower(name), { ...(ref ? { ref } : {}), meta });
  };
  for (const measure of intent.measures) {
    const entry = entryOf(measure.ref);
    const name = measure.alias ?? entry?.name ?? measure.ref.replace(/^ratio:/, '').replace(/^change:/, '').replace(/[^A-Za-z0-9_]+/g, '_');
    if (measure.change) {
      // A percentage change is a fraction of the earlier value; an absolute
      // change keeps the unit of what it compares.
      if (measure.change.as === 'percent') { register(name, undefined, { kind: 'percent', unit: 'fraction' }); continue; }
      const compared = intent.measures.find((item) => (item.alias ?? '') === measure.change!.base);
      register(name, undefined, compared && !compared.derived && !compared.change ? kindOfEntry(compared.ref, compared.aggregation) : { kind: 'number' });
      continue;
    }
    if (measure.derived) {
      const numerator = kindOfEntry(measure.derived.numerator, measure.derived.numeratorAggregation);
      const denominator = kindOfEntry(measure.derived.denominator, measure.derived.denominatorAggregation);
      // A share, rate or percentage is a fraction; a "per" ratio is a number
      // in the numerator's unit (points per game), currency per count stays
      // currency. Nothing else may become a percent: when a repo's metadata
      // gives no type for the operands they both read as text, and matching
      // unknown against unknown once turned 3.26 rebounds a game into 326%.
      const perName = /(^|[_\s])per([_\s]|$)/i.test(name);
      const fractionByName = !perName && /(pct|percent|percentage|share|margin)|(^|[_\s])rate([_\s]|$)/i.test(name);
      const meta: Partial<ResultColumnMeta> = numerator.kind === 'currency' && (denominator.kind === 'count' || denominator.kind === 'number') ? { kind: 'currency', unit: 'USD' }
        : fractionByName || (numerator.kind === denominator.kind && numerator.kind === 'currency') ? { kind: 'percent', unit: 'fraction' }
        : { kind: 'number' };
      register(name, undefined, meta);
      continue;
    }
    // A column measure carries its own aggregation: SUM over a Boolean column is a number.
    register(name, measure.ref, kindOfEntry(measure.ref, measure.aggregation));
    if (entry?.name && entry.name !== name) register(entry.name, measure.ref, kindOfEntry(measure.ref, measure.aggregation));
  }
  for (const group of intent.groupBy) {
    const entry = entryOf(group.ref);
    const base = entry?.physical?.column ?? entry?.name;
    const meta: Partial<ResultColumnMeta> = group.role === 'time' ? { kind: 'date', ...(group.grain ? { grain: group.grain } : {}) } : kindOfEntry(group.ref);
    register(base, group.ref, meta);
    if (group.role === 'time' && base && group.grain) register(`${base}_${group.grain}`, group.ref, meta);
  }
  for (const ref of intent.display) { const entry = entryOf(ref); register(entry?.physical?.column ?? entry?.name, ref, kindOfEntry(ref)); }
  const values = (column: string) => result.rows.slice(0, 50).map((row) => row[column]).filter((value) => value !== null && value !== undefined);
  return result.columns.map((rawColumn) => {
    const column = String(rawColumn ?? '');
    const key = lower(column);
    // Semantic engines qualify a column (`order_item__ordered_at__month`); the
    // registered name is found under the qualifier and the grain suffix.
    const stripped = key.replace(/__(day|week|month|quarter|year)$/, '');
    const found = byName.get(key)
      ?? [...byName.entries()].find(([name]) => stripped === name || stripped.endsWith(`__${name}`) || key.endsWith(`__${name}`) || key.endsWith(`_${name}`) || key.startsWith(`${name}__`))?.[1];
    if (found?.meta.kind) return { name: column, ...found.meta, kind: found.meta.kind, ...(found.ref ? { ref: found.ref } : {}) };
    const sample = values(column);
    if (sample.length && sample.every((value) => typeof value === 'boolean')) return { name: column, kind: 'boolean' };
    if (sample.length && sample.every((value) => typeof value === 'string' && UTC_DAY.test(value))) return { name: column, kind: 'date' };
    if (sample.length && sample.every((value) => typeof value === 'number' || typeof value === 'bigint')) {
      if (COUNT_NAME.test(column) && sample.every((value) => Number.isInteger(Number(value)))) return { name: column, kind: 'count' };
      return CURRENCY_NAME.test(column) ? { name: column, kind: 'currency', unit: 'USD' } : { name: column, kind: 'number' };
    }
    return { name: column, kind: 'text' };
  });
}

const TECHNICAL_IDENTIFIER = /(?:^|_)(?:id|uuid|key|code)$/i;
// A column that reads as a name beside an id (the result table hides the id beside it).
const BUSINESS_LABEL = /(?:name|title|label|display|description|customer|account|product|region|segment|category|channel)$/i;
/** A value no reader can read: a UUID, or a long run of hex digits. */
const OPAQUE_VALUE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,})$/i;

/**
 * THE COLUMNS THE PROSE READS OUT. A column of opaque values (UUIDs, hashes)
 * is never read out: "4b6c2304-2b9e-… · 11.29" tells a reader nothing, and
 * the result table already hides such an id beside its name. When nothing in
 * the result names those rows, the answer says what identifies them instead.
 * A readable key (a player number, a store code) is still read out.
 */
export function proseColumns(columns: string[], rows: Array<Record<string, unknown>>): { shown: string[]; opaque: string[]; unnamed: string[] } {
  const sample = rows.slice(0, 50);
  const opaque = columns.filter((column) => {
    const values = sample.map((row) => row[column]).filter((value) => value !== null && value !== undefined && value !== '');
    return values.length > 0 && values.every((value) => typeof value === 'string' && OPAQUE_VALUE.test(value.trim()));
  });
  const named = columns.some((column) => !opaque.includes(column) && BUSINESS_LABEL.test(column) && !TECHNICAL_IDENTIFIER.test(column));
  return { shown: columns.filter((column) => !opaque.includes(column)), opaque, unnamed: named ? [] : opaque };
}

/** Deterministic answer prose from the rows themselves: no claim without a cell behind it. */
export function composeAnsweredText(intent: AnalyticalIntentV1, result: ExecutedRows, vocabulary: VocabularyIndex, trust: string, extras: { notes?: string[]; caveats?: string[] } = {}): string {
  const reading = intent.reading || describeIntent(intent, labelFor(vocabulary));
  const lines: string[] = [`I read this as: ${reading.replace(/[.\s]+$/, '')}.`];
  const columns = result.columns;
  const metaOf = (column: string) => result.columnsMeta?.find((meta) => meta.name === column);
  if (result.rowCount === 0) {
    lines.push('The query ran and returned no rows for that reading.');
    return lines.join(' ');
  }
  const prose = proseColumns(columns, result.rows);
  // Rows told apart only by opaque keys are said to be, never read out.
  const keyedOnly = prose.unnamed;
  const keyedNote = keyedOnly.length ? `The rows are identified by ${keyedOnly.join(', ')}, internal key${keyedOnly.length === 1 ? '' : 's'} with no name beside ${keyedOnly.length === 1 ? 'it' : 'them'} in this result.` : undefined;
  if (result.rowCount === 1 && columns.length <= 4) {
    const row = result.rows[0] ?? {};
    if (prose.shown.length) lines.push(prose.shown.map((column) => `${column.replace(/_/g, ' ')}: ${formatValue(row[column], metaOf(column))}`).join(', ') + '.');
    if (keyedNote) lines.push(keyedNote);
  } else {
    lines.push(`${result.rowCount} row${result.rowCount === 1 ? '' : 's'} across ${columns.length} column${columns.length === 1 ? '' : 's'}${result.truncated ? ' (bounded)' : ''}.`);
    const first = prose.shown.length ? result.rows.slice(0, 3).map((row) => prose.shown.map((column) => formatValue(row[column], metaOf(column))).join(' · ')) : [];
    if (first.length) lines.push(`Leading rows: ${first.join(' | ')}.`);
    if (keyedNote) lines.push(keyedNote);
  }
  // CONCENTRATION IS A TOTAL, NOT A LIST. "How concentrated is scoring among
  // the top five" asks what the five together are, and five rows of "1.0%"
  // never say 4.4%. The shares are over one whole-period denominator, so they
  // add up: the sum is the answer to the question that was asked.
  const shareColumn = intent.measures.find((measure) => measure.derived?.denominatorScope === 'overall')?.alias;
  if (shareColumn && intent.limit !== undefined && result.rowCount > 1 && columns.includes(shareColumn)) {
    const total = result.rows.reduce((sum, row) => {
      const value = typeof row[shareColumn] === 'number' ? row[shareColumn] as number : Number(row[shareColumn]);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
    lines.push(`Together the ${result.rowCount} rows are ${formatValue(total, metaOf(shareColumn))} of the whole period.`);
  }
  // Identity: several members share the asked-for name; the rows keep them apart.
  for (const note of extras.notes ?? []) {
    if (note.startsWith('identity:')) lines.push(`${note.slice('identity:'.length).trim().replace(/[.\s]+$/, '')}.`);
    // A join the warehouse proved but nobody certified is said out loud.
    else if (note.startsWith('relationship:')) lines.push(`${note.slice('relationship:'.length).trim().replace(/[.\s]+$/, '')}.`);
  }
  // Definitions: a grouping or filter dimension with a governed description
  // is explained ("new" is a customer with one lifetime order).
  const defined = [...intent.groupBy.map((group) => group.ref), ...intent.filters.map((predicate) => predicate.ref)]
    .map((ref) => vocabulary.get(ref))
    .filter((entry, index, all): entry is NonNullable<typeof entry> => Boolean(entry && entry.kind === 'dimension' && entry.description && all.indexOf(entry) === index))
    .slice(0, 2);
  if (defined.length) lines.push(`Definitions: ${defined.map((entry) => `${entry.label ?? entry.name}: ${entry.description!.replace(/\s+/g, ' ').slice(0, 200).replace(/[.\s]+$/, '')}`).join('; ')}.`);
  lines.push(trust === 'certified' ? 'Source: a certified saved query.' : trust === 'governed' ? 'Source: the semantic layer.' : 'Source: SQL written by AI from the schema (review before relying on it).');
  for (const caveat of extras.caveats ?? []) lines.push(caveat.replace(/[.\s]+$/, '') + '.');
  return lines.join(' ');
}

export function composeGapText(gap: GapKind, message: string, nearest: string[], offerExploration: boolean): string {
  const because = {
    not_retrieved: 'nothing in the governed catalogue was retrieved for it',
    not_modeled: 'the project does not model it',
    ambiguous: 'it can be read more than one way',
    unsupported: 'the governed engines cannot express it',
    denied: 'policy does not allow it',
  }[gap];
  const near = nearest.length ? ` The nearest governed vocabulary: ${nearest.join(', ')}.` : '';
  const offer = offerExploration ? ' You can ask for a review-required exploration of the physical tables instead.' : '';
  return `No governed query was run because ${because}: ${message}.${near}${offer}`;
}

/**
 * What a person reads when a query could not be completed. A warehouse
 * failure is said in its class's words: a missing or unreadable table names
 * only tables the statement reads; a column or function the warehouse lacks
 * is said as such, never as a table "the connection cannot see".
 *
 * Without a host the warehouse's own words follow, for the person running
 * the project. With a host (`warehouse.reference`), they stay in the host's
 * log: the answer gives the reference to ask an administrator about, and
 * nothing of the statement the host sent (RFC 0010 HH-3).
 */
export function composeFailedText(stage: 'resolve' | 'prepare' | 'execute', message: string, warehouse?: WarehouseFailure): string {
  const where = stage === 'resolve' ? 'while reading the question' : stage === 'prepare' ? 'while preparing the query; no warehouse query ran' : 'on the warehouse';
  if (stage === 'execute' && warehouse) {
    const named = warehouse.relations.length ? ` ${warehouse.relations.join(', ')}` : '';
    const hosted = Boolean(warehouse.reference);
    const column = warehouse.column ? ` (${warehouse.column})` : '';
    const table = warehouse.relations.length === 1 ? `the ${relationName(warehouse.relations[0]!)} table` : 'its table';
    const lead = warehouse.class === 'warehouse_suspended'
      ? hosted
        ? 'The warehouse is not running, so the query could not execute. Ask the same question again once it is running.'
        : 'The warehouse is not running, so the query could not execute. Resume it and ask the same question again.'
      : warehouse.class === 'relation_missing'
        ? hosted
          ? `The warehouse does not have${named || ' a table this answer reads'}, although the catalog lists it.`
          : `The connection cannot see${named || ' the table this query needs'}, although the catalog lists it. The catalog and the warehouse disagree; refresh the catalog or point the connection at the database that has it.`
        : warehouse.class === 'relation_denied'
          ? hosted
            ? `This connection is not allowed to read${named || ' the table this answer needs'}.`
            : `This connection is not allowed to read${named || ' the table this query needs'}. Grant it access, or ask with data it can read.`
          : warehouse.class === 'catalog_stale'
            ? `No query was sent:${named || ' a table this query needs'} is already known to be missing on this connection.`
            : warehouse.class === 'column_missing'
              ? `A column this answer reads${column} is not in ${table} on the warehouse. The table may have changed since the answer was defined${hosted ? '.' : '; refresh the catalog, or update the block or model that names it.'}`
              : warehouse.class === 'function_missing'
                ? `The statement calls a function${warehouse.function ? ` (${warehouse.function})` : ''} that this warehouse does not have. ${hosted ? 'Rephrase the question.' : 'Rephrase the question, or name a function this warehouse supports.'}`
                : hosted
                  ? 'The warehouse could not run this statement.'
                  : undefined;
    if (lead && hosted) return `${lead} Ask your administrator about reference ${warehouse.reference}.`;
    if (lead) return `${lead} The warehouse said: ${message}`;
  }
  return `This could not be completed ${where}: ${message}`;
}
