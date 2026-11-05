import { groupsByLabelsOnly, sameTable } from '@zlens/core';
import { parseScopePredicates, type BlockContractMeasure, type BlockContractPredicate } from '../block-contract.js';
import type { AnalyticalIntentV1 } from '../intent.js';
import type { VocabularyEntry, VocabularyIndex } from '../vocabulary.js';
import type { PrepareDeps, PreparedCandidate, PreparedRefusal } from './types.js';

/**
 * CERTIFIED = ENTAILMENT, NOT LEXICAL FIT.
 *
 * A block is a certified answer only when its contract entails the intent:
 * the intent names the block (or measures whose physical binding is one of
 * the block's aggregates over the same scope), every grouping and display
 * ref is an output the block produces, every filter is one the block
 * declares it accepts, and the ordering and limit are provable from the
 * block's own ORDER BY and LIMIT. An intent with no measures never entails.
 * Anything less makes the block evidence for the governed tiers, not an
 * answer.
 */

export interface EntailmentVerdict {
  ok: boolean;
  missing: string[];
  caveats: string[];
  /** Set when the only identity the block offers is a label; the block is a fallback, not the answer. */
  identityNote?: string;
  /** The output column a time window is applied over, when the block has one. */
  windowColumn?: string;
  /** The period the block's own WHERE fixes, when it is exactly the window asked for. */
  fixedWindow?: { column: string; start: string; end: string };
  /** Block outputs matched by meaning to the question's own refs, so the rows can be read under the names the question used. */
  outputRefs?: Array<{ output: string; ref: string }>;
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const leaf = (ref: string) => (ref.split('.').pop() ?? ref).toLowerCase();

/** The normalized column names a filter's ref can stand for on the block's own table. */
function filterColumns(contract: NonNullable<VocabularyEntry['contract']>, vocabulary: VocabularyIndex, ref: string): string[] {
  const entry = vocabulary.get(ref);
  const relation = entry?.physical?.relation;
  const onBlockTable = !relation || (contract.source !== undefined && sameTable(contract.source, relation, 'shared'));
  return [leaf(ref), ...(onBlockTable ? [entry?.physical?.column, entry?.name] : [])].filter((name): name is string => Boolean(name)).map(norm);
}

export function entails(block: VocabularyEntry, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): EntailmentVerdict {
  const contract = block.contract;
  const missing: string[] = [];
  const caveats: string[] = [];
  if (!contract) return { ok: false, missing: ['the block has no contract'], caveats };
  if (intent.measures.length === 0) return { ok: false, missing: ['the intent names no measure'], caveats };
  // A ratio the question composes, or a population the block never declared, is never what a block certified.
  if (intent.measures.some((measure) => measure.derived)) return { ok: false, missing: ['a derived ratio measure is composed by the governed tiers, never served from a block'], caveats };
  if (intent.population === 'all') return { ok: false, missing: ['a block returns the rows it matched; it cannot include every member of the entity'], caveats };
  const outputs = new Set(contract.outputs.map(norm));
  // A filter names a field of the project's vocabulary; a block's scope names a
  // physical column. They are the same filter when the field IS that column of
  // the block's own table; a same-named column of another table is not.
  const columnsOf = (ref: string) => filterColumns(contract, vocabulary, ref);
  const filtersColumn = (predicate: { ref: string }, column: string) => columnsOf(predicate.ref).includes(norm(column));

  const namesBlock = intent.measures.every((measure) => measure.ref === block.ref);
  // Predicates the block's matched measures bring with them: the filter a block
  // declares for a metric, and the base filter the metric's own definition carries.
  // The question must ask for them, or the block answers a narrower question.
  const impliedScope: ImpliedScope[] = [];
  const outputRefs: Array<{ output: string; ref: string }> = [];
  if (!namesBlock) {
    for (const measure of intent.measures) {
      const entry = vocabulary.get(measure.ref);
      const verdict = matchMeasure(measure.ref, entry, contract);
      missing.push(...verdict.missing);
      impliedScope.push(...verdict.impliedScope);
      if (verdict.output) outputRefs.push({ output: verdict.output, ref: measure.ref });
      if (measure.scope?.length) {
        for (const predicate of measure.scope) {
          const column = leaf(predicate.ref);
          const covered = contract.staticScope.some((scope) => filtersColumn(predicate, scope.column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values))
            || verdict.impliedScope.some((scope) => filtersColumn(predicate, scope.column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
          if (!covered) missing.push(`the block does not restrict ${column} the way the measure requires`);
        }
      }
    }
  } else if (intent.measures.length > 1) {
    missing.push('a certified answer names one block');
  }

  // IDENTITY: a ranking or breakdown of an entity must be keyed. A block whose
  // grouping columns are all labels cannot prove which customer is which, so it
  // is evidence, not a certified answer, until it is recertified with the key.
  const grouping = contract.groupBy.length ? contract.groupBy : contract.outputs.filter((output) => !contract.measures.some((m) => norm(m.output) === norm(output)));
  let identityNote: string | undefined;
  if (groupsByLabelsOnly(grouping)) {
    const note = `the block groups by ${grouping.join(', ')} (a label) with no identity key, so two entities sharing a name would merge`;
    // Identity is never certified away: even a block the intent names is
    // evidence, not the answer, until it is recertified with the key. The
    // refusal is repairable, so the interpreter re-expresses the analysis
    // with the block's measures by entity and the keyed governed query answers.
    identityNote = `${note}; the answer is composed by entity key instead, and the block can be recertified with the key column`;
    missing.push(identityNote);
  }
  // A time window is applied over the block's output when an output column IS
  // the window's time column; a block with no such column cannot bound the
  // period, and a published SQL never has a window silently assumed.
  let windowColumn: string | undefined;
  let fixedWindow: EntailmentVerdict['fixedWindow'];
  if (intent.time?.window) {
    const axis = intent.time.ref ? vocabulary.get(intent.time.ref) : undefined;
    const wanted = [axis?.physical?.column, axis?.name, intent.time.ref ? leaf(intent.time.ref) : undefined].filter((name): name is string => Boolean(name)).map(norm);
    windowColumn = contract.outputs.find((output) => wanted.includes(norm(output)));
    // A block the question NAMES may already be fixed to exactly the period
    // asked for (`EXTRACT(YEAR FROM game_date) BETWEEN 2016 AND 2017` for
    // "2016 and 2017"): that is the block answering, not a window assumed.
    const fixed = windowColumn ? undefined : (contract.periods ?? []).find((period) => namesBlock || wanted.includes(norm(period.column)));
    const window = intent.time.window;
    if (!windowColumn && fixed && sameDay(fixed.start, window.start) && sameDay(fixed.end, window.end)) {
      caveats.push(`the block is fixed to ${fixed.column} from ${fixed.start} up to ${fixed.end}, the period the question asks for`);
      fixedWindow = fixed;
    } else if (!windowColumn && fixed) {
      missing.push(`the block is fixed to ${fixed.column} from ${fixed.start} up to ${fixed.end} and has no filter for another period (the question asks for ${window.start} up to ${window.end})`);
    } else if (!windowColumn) {
      missing.push(`the block has no output for the time window ${window.start}..${window.end} (${wanted.join('/')}), so it cannot bound the period; the answer is composed from its measures instead`);
    }
  }
  // Every grouping and display column must be an output.
  for (const group of intent.groupBy) {
    const entry = vocabulary.get(group.ref);
    const column = entry?.physical?.column ?? entry?.name ?? leaf(group.ref);
    const graining = group.role === 'time' && group.grain;
    if (graining && !namesBlock) {
      // A time grain is never assumed: the block must provably truncate that
      // column to that grain, or its rows are a different grain than the question's.
      const truncated = truncatedOutput(contract, column, group.grain!);
      if (truncated) {
        outputRefs.push({ output: truncated, ref: group.ref });
        continue;
      }
      if (outputs.has(norm(column))) missing.push(`the block groups by ${column}, not by ${group.grain}, which cannot be compared with the question; it would need to select date_trunc('${group.grain}', ${column})`);
      else missing.push(`grouping by ${column} by ${group.grain} is not an output of the block (${contract.outputs.join(', ')})`);
      continue;
    }
    if (!outputs.has(norm(column))) missing.push(`grouping by ${column} is not an output of the block (${contract.outputs.join(', ')})`);
    if (graining) caveats.push(`time grain ${group.grain} is assumed to match the block's own grouping`);
  }
  for (const ref of intent.display) {
    const entry = vocabulary.get(ref);
    const column = entry?.physical?.column ?? entry?.name ?? leaf(ref);
    if (!outputs.has(norm(column))) missing.push(`display of ${column} is not an output of the block`);
  }

  // The block's own scope must be what the intent asked for, and every intent filter must be accepted.
  const intentPredicates = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])];
  // A block the intent names by ref was chosen FOR its declared scope; a block
  // matched through its measures must have that scope asked for explicitly.
  for (const scope of namesBlock ? [] : contract.staticScope) {
    const asked = intentPredicates.some((predicate) => filtersColumn(predicate, scope.column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values))
      || impliedScope.some((implied) => norm(implied.column) === norm(scope.column) && scopeMatches(scope.op, scope.values, implied.op, implied.values));
    if (!asked) missing.push(`the block only counts rows where ${describePredicate(scope)}, which the question did not ask for`);
  }
  // Every filter a block's measure declares must be one the question asked for.
  for (const implied of namesBlock ? [] : impliedScope) {
    const asked = intentPredicates.some((predicate) => filtersColumn(predicate, implied.column) && scopeMatches(implied.op, implied.values, predicate.op, predicate.values))
      || (!implied.declared && contract.staticScope.some((scope) => norm(scope.column) === norm(implied.column) && scopeMatches(scope.op, scope.values, implied.op, implied.values)));
    if (!asked) missing.push(`the block's measure is only read where ${describePredicate(implied)}, which the question did not ask for`);
  }
  // Rows the block drops by a condition the contract cannot state are never
  // matched by guess; only a declared metric mapping vouches for them.
  const vouched = !namesBlock && intent.measures.length > 0 && intent.measures.every((measure) => declaredMeasure(vocabulary.get(measure.ref), contract) !== undefined);
  if (!namesBlock && contract.scopeUnparsed?.length && !vouched) {
    missing.push(`the block also filters rows by ${contract.scopeUnparsed.join(' and ')}, which cannot be compared with the question`);
  }
  // The block's grain must be the question's grain: a block that groups by a
  // column the question did not ask for returns more rows than the answer.
  if (!namesBlock) {
    if (contract.grainUnparsed?.length) missing.push(`the block groups rows by ${contract.grainUnparsed.join(' and ')}, which is not the grain it selects, so its rows cannot be compared with the question`);
    const asked = new Set([
      ...intent.groupBy.map((group) => (group.role === 'time' && group.grain ? truncatedOutput(contract, groupColumn(group.ref, vocabulary), group.grain) : undefined) ?? groupColumn(group.ref, vocabulary)),
      ...intent.display.map((ref) => groupColumn(ref, vocabulary)),
    ].map(norm));
    const extra = (contract.groupBy.length ? contract.groupBy : contract.outputs.filter((output) => !contract.measures.some((m) => norm(m.output) === norm(output)))).filter((column) => !asked.has(norm(column)));
    if (extra.length) missing.push(`the block breaks the answer down by ${extra.join(', ')}, which the question did not ask for`);
  }
  const accepted = new Set([...contract.allowedFilters, ...contract.parameters, ...contract.staticScope.map((scope) => scope.column), ...(namesBlock ? contract.outputs : [])].map(norm));
  for (const predicate of namesBlock ? intentPredicates : intent.filters) {
    const column = leaf(predicate.ref);
    const asStatic = [...contract.staticScope, ...impliedScope].some((scope) => filtersColumn(predicate, scope.column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
    const acceptsColumn = columnsOf(predicate.ref).some((name) => accepted.has(name));
    if (!asStatic && !acceptsColumn) missing.push(`the block does not accept a filter on ${column}`);
    if (!asStatic && acceptsColumn) caveats.push(`filter on ${column} needs the block's parameter binding`);
  }

  // Ordering and limit must be provable.
  if (intent.ordering) {
    const orderColumn = intent.ordering.ref.startsWith('measure:') ? contract.measures[0]?.output : (vocabulary.get(intent.ordering.ref)?.physical?.column ?? leaf(intent.ordering.ref));
    const first = contract.orderBy?.[0];
    const sameColumn = first && orderColumn && (norm(first.column) === norm(orderColumn) || contract.measures.some((m) => norm(m.output) === norm(first.column) && vocabulary.get(intent.ordering!.ref)?.physical?.column && norm(m.sourceColumn ?? '') === norm(vocabulary.get(intent.ordering!.ref)!.physical!.column!)));
    if (!first || !sameColumn || first.direction !== intent.ordering.direction) missing.push('the block does not order the way the question asks');
  }
  if (intent.limit !== undefined) {
    // `LIMIT ${top_n}`: the row count is a declared parameter, bound to the question's.
    if (contract.limit === undefined && contract.limitParameter) caveats.push(`the row limit is the block's ${contract.limitParameter} parameter, bound to ${intent.limit}`);
    else if (contract.limit === undefined) missing.push(`the block has no row limit; the question asks for ${intent.limit}`);
    else if (contract.limit !== intent.limit) missing.push(`the block returns ${contract.limit} rows; the question asks for ${intent.limit}`);
  } else if (contract.limit !== undefined) {
    caveats.push(`the block returns at most ${contract.limit} rows`);
  }
  if (!contract.structural) caveats.push('the block SQL could not be read structurally; only its declarations were checked');
  return { ok: missing.length === 0, missing, caveats, ...(identityNote ? { identityNote } : {}), ...(windowColumn ? { windowColumn } : {}), ...(fixedWindow ? { fixedWindow } : {}), ...(outputRefs.length ? { outputRefs } : {}) };
}

type ImpliedScope = BlockContractPredicate & { declared?: boolean };

const sameDay = (left: string, right: string): boolean => left.slice(0, 10) === right.slice(0, 10);

const AGGREGATE_WORDS: Record<string, string> = { sum: 'sums', avg: 'averages', count: 'counts every row of', count_distinct: 'counts distinct', min: 'takes the minimum of', max: 'takes the maximum of', median: 'takes the median of' };
const aggregateWords = (aggregate: string | undefined) => (aggregate ? AGGREGATE_WORDS[aggregate] ?? aggregate : 'computes');
const OP_WORDS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function describePredicate(predicate: BlockContractPredicate): string {
  if (predicate.op === 'is_true') return `${predicate.column} is true`;
  if (predicate.op === 'is_false') return `${predicate.column} is false`;
  if (predicate.op === 'in') return `${predicate.column} is one of ${predicate.values.map((value) => `'${value}'`).join(', ')}`;
  return `${predicate.column} ${OP_WORDS[predicate.op] ?? predicate.op} '${predicate.values[0] ?? ''}'`;
}

function groupColumn(ref: string, vocabulary: VocabularyIndex): string {
  const entry = vocabulary.get(ref);
  return entry?.physical?.column ?? entry?.name ?? leaf(ref);
}

/** The block output that is `date_trunc('<grain>', <column>)`, when it has one. */
function truncatedOutput(contract: NonNullable<VocabularyEntry['contract']>, column: string, grain: string): string | undefined {
  return contract.truncations?.find((item) => norm(item.column) === norm(column) && item.grain === grain.toLowerCase() && contract.outputs.some((output) => norm(output) === norm(item.output)))?.output;
}

/** The block measure that declares it answers this metric, when it does. */
function declaredMeasure(entry: VocabularyEntry | undefined, contract: NonNullable<VocabularyEntry['contract']>): BlockContractMeasure | undefined {
  if (!entry || (entry.kind !== 'metric' && entry.kind !== 'measure')) return undefined;
  // A declaration vouches for the metric, not for the grain: with no outputs the
  // block's rows cannot be compared with the question, so nothing is vouched for.
  if (contract.outputs.length === 0) return undefined;
  const wanted = norm(entry.sourceId ?? entry.name);
  return contract.measures.find((measure) => measure.declaredMetric && norm(measure.declaredMetric.metric) === wanted);
}

interface MetricShape { aggregate?: string; column?: string; relation?: string; scope: BlockContractPredicate[]; readable: boolean }

/** What a metric computes, read from its physical binding: aggregate, column, table and the rows it counts. */
function metricShape(physical: NonNullable<VocabularyEntry['physical']>): MetricShape {
  const shape: MetricShape = { scope: [], readable: true, ...(physical.aggregate ? { aggregate: physical.aggregate.toLowerCase() } : {}), relation: physical.relation };
  let inner = (physical.column ?? physical.expr ?? '').trim();
  const scoped = inner.match(/^case\s+when\s+(.+?)\s+then\s+(.+?)(?:\s+else\s+0)?\s+end$/is);
  if (scoped) {
    const read = parseScopePredicates(scoped[1]!.replace(/["`]/g, ''));
    shape.scope = read.predicates;
    if (read.unparsed.length) shape.readable = false;
    inner = scoped[2]!.trim();
  }
  if (/^(?:"[^"]+"|[A-Za-z_]\w*)(?:\.(?:"[^"]+"|[A-Za-z_]\w*))*$/.test(inner)) shape.column = inner.split('.').pop()!.replace(/"/g, '');
  return shape;
}

/**
 * Does the block compute the same thing as the metric? The block's own names
 * do not matter; its aggregate, column, table and the rows it keeps do. Any
 * difference, or anything the reader cannot see, is a miss with the reason.
 */
function matchMeasure(ref: string, entry: VocabularyEntry | undefined, contract: NonNullable<VocabularyEntry['contract']>): { missing: string[]; impliedScope: ImpliedScope[]; output?: string } {
  const name = entry?.name ?? leaf(ref);
  const declared = declaredMeasure(entry, contract);
  if (declared?.declaredMetric) return { missing: [], impliedScope: declared.declaredMetric.filter.map((predicate) => ({ ...predicate, declared: true })), output: declared.output };
  const miss = (reason: string) => ({ missing: [reason], impliedScope: [] as ImpliedScope[] });
  if (contract.outputs.length === 0 && contract.measures.some((measure) => measure.declaredMetric)) return miss('the block declares a metric mapping but no outputs, so the rows it returns cannot be compared with the question; declare its outputs');
  if (!entry?.physical) return miss(`${name} has no definition over a table that can be compared with the block`);
  const shape = metricShape(entry.physical);
  if (!shape.aggregate || !shape.column || !shape.readable) return miss(`${name} is not a plain aggregate over one column (${shape.aggregate ?? 'no aggregate'} of ${entry.physical.expr ?? entry.physical.column ?? 'unknown'}), so it cannot be compared with the block; the block can declare it with metricMappings`);
  const metricText = `${name} ${aggregateWords(shape.aggregate)} ${shape.column} in ${shape.relation}`;
  const sameColumn = contract.measures.filter((measure) => measure.sourceColumn && norm(measure.sourceColumn) === norm(shape.column!));
  const block = sameColumn.find((measure) => measure.aggregate === shape.aggregate);
  if (!block) {
    const other = sameColumn[0];
    const computes = contract.measures.map((measure) => `${measure.output} ${aggregateWords(measure.aggregate)} ${measure.sourceColumn ?? measure.expr ?? 'an expression'}`).join('; ') || 'no measure';
    return miss(other ? `${metricText}, but the block's ${other.output} ${aggregateWords(other.aggregate)} ${other.sourceColumn}` : `${metricText}; the block computes: ${computes}`);
  }
  if (!contract.source) return miss(`the block does not read from one single table, so it cannot be compared with ${name}, which reads ${shape.relation}`);
  if (!sameTable(contract.source, shape.relation!, 'shared')) return miss(`${name} reads ${shape.relation}, the block reads ${contract.source}`);
  const absent = shape.scope.filter((predicate) => !contract.staticScope.some((scope) => norm(scope.column) === norm(predicate.column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values)));
  if (absent.length) return miss(`${name} only counts rows where ${absent.map(describePredicate).join(' and ')}; the block does not keep only those rows`);
  return { missing: [], impliedScope: shape.scope, output: block.output };
}

function scopeMatches(op: string, values: string[], intentOp: string, intentValues: Array<string | number | boolean>): boolean {
  const boolOf = (v: unknown) => (v === true || String(v).toLowerCase() === 'true') ? 'true' : (v === false || String(v).toLowerCase() === 'false') ? 'false' : undefined;
  if (op === 'is_true' || op === 'is_false') {
    if (intentOp === op) return true;
    if (intentOp === 'eq' && intentValues.length === 1) return boolOf(intentValues[0]) === (op === 'is_true' ? 'true' : 'false');
    return false;
  }
  if ((op === 'eq' || op === 'in') && (intentOp === 'eq' || intentOp === 'in')) {
    const left = new Set(values.map((value) => value.toLowerCase()));
    return intentValues.every((value) => left.has(String(value).toLowerCase())) && intentValues.length === left.size;
  }
  return op === intentOp && values.join('|').toLowerCase() === intentValues.map(String).join('|').toLowerCase();
}

export interface CertifiedPreparation {
  candidates: PreparedCandidate[];
  refusals: PreparedRefusal[];
  /**
   * Blocks refused ONLY for label-only identity. They are not the answer
   * while a keyed governed answer can be composed; when no other tier can
   * prepare, the block is served as published with its identity caveat
   * rather than a dead end.
   */
  fallbacks: PreparedCandidate[];
}

export function prepareCertified(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): CertifiedPreparation {
  const blocks = vocabulary.entries.filter((entry) => entry.kind === 'block' && entry.certified);
  if (blocks.length === 0) return { candidates: [], refusals: [{ tier: 'certified', code: 'no_certified_block', message: 'the project has no certified block', repairable: false }], fallbacks: [] };
  const candidates: PreparedCandidate[] = [];
  const refusals: PreparedRefusal[] = [];
  const fallbacks: PreparedCandidate[] = [];
  const named = intent.measures.map((measure) => measure.ref).filter((ref) => ref.startsWith('block:'));
  const considered = named.length ? blocks.filter((block) => named.includes(block.ref)) : blocks;
  // Why each block was not used, in words: block and field names only, never result values.
  const notUsed: string[] = [];
  for (const block of considered) {
    const verdict = entails(block, intent, vocabulary);
    // The block is compiled and bound like every other surface runs it. The
    // raw-text path survives only for blocks without template parameters.
    const prepared = deps.prepareBlock?.(block.ref, { question: intent.reading, ...(intent.limit !== undefined && block.contract?.limitParameter ? { parameters: { [block.contract.limitParameter]: intent.limit } } : {}) });
    if (prepared && 'error' in prepared) {
      refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: its parameters could not be bound: ${prepared.error}`, repairable: false, detail: { unresolved: prepared.unresolved ?? [] } });
      notUsed.push(`${block.ref}: its parameters could not be bound: ${prepared.error}`);
      continue;
    }
    const rawSource = prepared ? undefined : (deps.blockSql?.(block.ref) ?? block.sql);
    if (rawSource && /\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/.test(rawSource)) {
      refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: declares template parameters that this host does not bind`, repairable: false });
      notUsed.push(`${block.ref}: declares template parameters that this host does not bind`);
      continue;
    }
    const source = prepared?.sql ?? rawSource;
    const identityOnly = !verdict.ok && verdict.identityNote !== undefined && verdict.missing.length === 1;
    if ((verdict.ok || identityOnly) && source) {
      // Filters the block declares it accepts are applied OVER its output, so
      // the certified logic runs unchanged and the filter is provably present.
      const params: unknown[] = prepared ? [...prepared.params] : [];
      // Applied predicates continue the block's positional numbering; a block
      // without parameters keeps the composer's `?` placeholders.
      const placeholder = () => { if (!prepared) return '?'; return `$${params.length}`; };
      const bind = (value: unknown) => { params.push(value); return placeholder(); };
      const outputs = new Set((block.contract?.outputs ?? []).map(norm));
      const applied: string[] = [];
      const blockPredicates = [...intent.filters, ...intent.measures.filter((measure) => measure.ref === block.ref).flatMap((measure) => measure.scope ?? [])];
      for (const predicate of blockPredicates) {
        const columns = block.contract ? filterColumns(block.contract, vocabulary, predicate.ref) : [norm(leaf(predicate.ref))];
        const staticMatch = block.contract?.staticScope.some((scope) => columns.includes(norm(scope.column)) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
        if (staticMatch) continue;
        const output = (block.contract?.outputs ?? []).find((name) => columns.includes(norm(name)));
        if (!output || !outputs.has(norm(output))) continue;
        const quoted = `"${output.replace(/"/g, '""')}"`;
        const value = predicate.values[0];
        if (predicate.op === 'eq' && typeof value === 'string') applied.push(`LOWER(CAST(block.${quoted} AS TEXT)) = ${bind(value.toLowerCase())}`);
        else if (predicate.op === 'eq') applied.push(`block.${quoted} = ${bind(value)}`);
        else if (predicate.op === 'in') applied.push(`LOWER(CAST(block.${quoted} AS TEXT)) IN (${predicate.values.map((item) => bind(typeof item === 'string' ? item.toLowerCase() : item)).join(', ')})`);
        else if (predicate.op === 'is_true') applied.push(`block.${quoted} = TRUE`);
        else if (predicate.op === 'is_false') applied.push(`block.${quoted} = FALSE`);
        else applied.push(`block.${quoted} ${({ neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[predicate.op] ?? '='} ${bind(value)}`);
      }
      if (intent.time?.window && verdict.windowColumn) {
        const quoted = `"${verdict.windowColumn.replace(/"/g, '""')}"`;
        applied.push(`block.${quoted} >= ${bind(intent.time.window.start)}`, `block.${quoted} < ${bind(intent.time.window.end)}`);
      }
      const sql = applied.length ? `SELECT * FROM (\n${source.trim().replace(/;\s*$/, '')}\n) AS block\nWHERE ${applied.join(' AND ')}` : source;
      const candidate: PreparedCandidate = {
        tier: 'certified', trust: 'certified', sql, ...(params.length ? { params } : {}), sourceRef: block.ref, ...(block.owner ? { sourceOwner: block.owner } : {}),
        ...(verdict.fixedWindow ? { fixedWindow: verdict.fixedWindow } : {}),
        // The DQL the answer ran is the certified block itself, as it is saved.
        ...(prepared && 'source' in prepared && prepared.source ? { artifact: { kind: 'certified_block', name: block.name, source: prepared.source, ...(prepared.sourcePath ? { sourcePath: prepared.sourcePath } : {}), persistence: 'saved', trustState: 'certified', compiledSql: sql } } : {}),
        ...(verdict.outputRefs ? { outputRefs: verdict.outputRefs } : {}),
        proof: [`${block.ref} entails the intent: ${block.contract?.measures.map((m) => m.output).join(', ') || 'declared outputs'}${block.contract?.staticScope.length ? ` with scope ${block.contract.staticScope.map((s) => `${s.column} ${s.op}`).join(', ')}` : ''}${applied.length ? `; ${applied.length} declared filter${applied.length > 1 ? 's' : ''} applied over its output` : ''}`, ...(prepared?.parameters.length ? [`parameters bound: ${prepared.parameters.map((parameter) => `${parameter.name} = ${JSON.stringify(parameter.value)} (${parameter.source})`).join(', ')}`] : []), ...verdict.caveats],
      };
      if (identityOnly) {
        candidate.proof.push(`${verdict.identityNote!.split(';')[0]}; the certified block is served as published because no keyed governed answer could be composed`);
        fallbacks.push(candidate);
        refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: ${verdict.identityNote}`, repairable: named.includes(block.ref), detail: verdict });
      } else {
        candidates.push(candidate);
      }
    } else {
      const why = `${block.ref}: ${verdict.missing.join('; ') || 'no SQL source'}`;
      notUsed.push(why);
      if (named.includes(block.ref) || verdict.missing.length <= 2) {
        // A block the model named but which does not entail the intent is a
        // repairable refusal: the resolver can re-express the analysis with the
        // metric and dimension refs the block was standing in for.
        refusals.push({ tier: 'certified', code: 'block_not_applicable', message: why, repairable: named.includes(block.ref), detail: verdict });
      }
    }
  }
  if (candidates.length === 0 && refusals.length === 0) {
    refusals.push({ tier: 'certified', code: 'block_not_applicable', message: notUsed.length ? `no certified block entails the intent. ${notUsed.join(' | ')}` : `no certified block entails the intent (${blocks.map((block) => block.ref).join(', ')})`, repairable: false });
  }
  return { candidates, refusals, fallbacks };
}
