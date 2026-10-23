import type { AnalyticalIntentV1, IntentPredicate } from '../intent.js';
import type { VocabularyEntry, VocabularyIndex } from '../vocabulary.js';
import type { PrepareDeps, PreparedCandidate, PreparedRefusal, SemanticCompileOutput, SemanticCompileRequest } from './types.js';
import { semanticAnswerArtifact } from './dql-artifacts.js';

/**
 * SEMANTIC: bind the intent to the governed metric layer and compile.
 *
 * Every measure must be a metric or measure; every grouping, display, and
 * filter ref must be a semantic dimension or entity. The compiler is asked
 * with model-scoped names (`customers.customer_name`), the engine's own
 * error text comes back verbatim, and a per-measure scope the metric does
 * not already embody is refused here (the relational tier can express it).
 */

// Long-form operator names: the native composer accepts only these, and the
// MetricFlow and dbt Cloud adapters accept both spellings.
const OPERATORS: Record<IntentPredicate['op'], string> = {
  eq: 'equals', neq: 'not_equals', in: 'in', not_in: 'not_in', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', contains: 'contains', is_true: 'equals', is_false: 'equals',
};

function semanticName(entry: VocabularyEntry): string {
  if (entry.kind === 'metric' || entry.kind === 'measure') return entry.sourceId ?? entry.name;
  return entry.sourceId ?? (entry.model ? `${entry.model}.${entry.name}` : entry.name);
}

/**
 * A yes/no flag as the literal its column accepts. Flags are stored as
 * booleans, as 0/1 integers, or (in a semantic model) as a constant `1` joined
 * in: '1'/'0' compares correctly with a boolean and with an integer on every
 * supported warehouse, where 'true' fails on an integer ("could not convert
 * string 'true' to INT32"). Only a column known to hold text keeps the words.
 */
function flagLiteral(entry: VocabularyEntry, value: boolean): string {
  const type = (entry.dataType ?? '').toLowerCase();
  if (/char|text|string/.test(type) || /bool/.test(type)) return value ? 'true' : 'false';
  return value ? '1' : '0';
}

function predicateToFilter(predicate: IntentPredicate, entry: VocabularyEntry): SemanticCompileRequest['filters'] extends Array<infer T> | undefined ? T : never {
  const asFlag = (value: unknown): string => {
    if (!entry.roles.includes('boolean')) return String(value);
    if (value === true || /^true$/i.test(String(value))) return flagLiteral(entry, true);
    if (value === false || /^false$/i.test(String(value))) return flagLiteral(entry, false);
    return String(value);
  };
  const values = predicate.op === 'is_true' ? [flagLiteral(entry, true)] : predicate.op === 'is_false' ? [flagLiteral(entry, false)] : predicate.values.map(asFlag);
  return { dimension: semanticName(entry), operator: OPERATORS[predicate.op], values };
}

export function bindSemanticRequest(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, engine?: PrepareDeps['engine']): { request?: SemanticCompileRequest; refusal?: PreparedRefusal; groupedByLabel?: boolean; derived?: NonNullable<PreparedCandidate['derived']>; changes?: NonNullable<PreparedCandidate['changes']> } {
  const entry = (ref: string) => vocabulary.get(ref);
  if (intent.population === 'all') {
    return { refusal: { tier: 'semantic', code: 'not_semantic', message: 'the semantic layer returns the members it matched; including every member of the entity is composed relationally', repairable: false } };
  }
  const metrics: string[] = [];
  const derived: NonNullable<PreparedCandidate['derived']> = [];
  const changes: NonNullable<PreparedCandidate['changes']> = [];
  const outputByAlias = new Map<string, string>();
  const asked = new Set<string>();
  for (const measure of intent.measures) {
    if (measure.change) {
      changes.push({ alias: measure.alias ?? measure.ref.replace(/^change:/, '').replace(/[^A-Za-z0-9_]+/g, '_'), ...measure.change });
      continue;
    }
    if (measure.derived) {
      if (measure.derived.denominatorScope === 'overall') return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${measure.alias ?? measure.ref} divides by the whole period; the semantic tier computes ratios at one grouping only`, repairable: false } };
      // A ratio is two governed metrics compiled together and divided after execution.
      const parts = [measure.derived.numerator, measure.derived.denominator].map((ref) => entry(ref));
      if (parts.some((part) => !part || (part.kind !== 'metric' && part.kind !== 'measure'))) {
        return { refusal: { tier: 'semantic', code: 'not_semantic', message: `the ratio ${measure.ref} needs two semantic metrics`, repairable: false } };
      }
      if (measure.scope?.length) {
        return { refusal: { tier: 'semantic', code: 'measure_scope_not_expressible', message: `${measure.ref} carries a restriction the semantic layer cannot apply to one measure`, repairable: false } };
      }
      if (intent.ordering && (intent.ordering.ref === measure.ref || intent.ordering.ref === `measure:${intent.measures.indexOf(measure)}`)) {
        return { refusal: { tier: 'semantic', code: 'not_semantic', message: `ordering by the ratio ${measure.ref} is composed relationally`, repairable: false } };
      }
      const [numerator, denominator] = parts.map((part) => semanticName(part!)) as [string, string];
      for (const name of [numerator, denominator]) if (!metrics.includes(name)) metrics.push(name);
      const alias = measure.alias ?? measure.ref.replace(/^ratio:/, '').replace(/[^A-Za-z0-9_]+/g, '_');
      derived.push({ alias, numerator, denominator });
      if (measure.alias) outputByAlias.set(measure.alias, alias);
      continue;
    }
    const found = entry(measure.ref);
    if (!found || (found.kind !== 'metric' && found.kind !== 'measure')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${measure.ref} is not a semantic metric`, repairable: false } };
    }
    if (measure.scope?.length) {
      return { refusal: { tier: 'semantic', code: 'measure_scope_not_expressible', message: `${measure.ref} carries a restriction (${measure.scope.map((p) => `${p.ref} ${p.op} ${p.values.join('/')}`).join(', ')}) that the semantic layer cannot apply to one measure`, repairable: false } };
    }
    const name = semanticName(found);
    asked.add(name);
    if (!metrics.includes(name)) metrics.push(name);
    if (measure.alias) outputByAlias.set(measure.alias, name);
  }
  // A comparison names aliases of measures in THIS reading.  Both leaves must
  // have compiled through the semantic engine above; this is the safe path for
  // an authored previous-period MetricFlow metric, not a generated date-shift.
  const nonChangeAliases = new Set(intent.measures.filter((measure) => !measure.change).map((measure) => measure.alias).filter((alias): alias is string => Boolean(alias)));
  for (const change of changes) {
    if (!nonChangeAliases.has(change.base) || !nonChangeAliases.has(change.comparison)) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${change.alias} needs semantic measures aliased ${change.base} and ${change.comparison} in the same reading`, repairable: true } };
    }
    change.base = outputByAlias.get(change.base) ?? change.base;
    change.comparison = outputByAlias.get(change.comparison) ?? change.comparison;
  }
  for (const item of derived) if (asked.has(item.numerator) || asked.has(item.denominator)) item.keepInputs = true;
  // MetricFlow and dbt Cloud address a metric's own aggregation time as
  // `metric_time`; offset and cumulative metrics resolve only on it. A time
  // grouping, ordering or window on a used measure's aggregation time is
  // therefore `metric_time` on those engines; the native composer knows
  // only concrete dimensions.
  const metricTime = engine && engine !== 'native';
  const aggregationTimes = new Set(intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]).map((ref) => entry(ref)?.timeRef).filter((ref): ref is string => Boolean(ref)));
  const timeName = (ref: string, found: VocabularyEntry) => (metricTime && aggregationTimes.has(ref) ? 'metric_time' : semanticName(found));
  const dimensions: string[] = [];
  let timeDimension: SemanticCompileRequest['timeDimension'];
  for (const group of intent.groupBy) {
    const found = entry(group.ref);
    if (!found || (found.kind !== 'dimension' && found.kind !== 'entity')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${group.ref} is not a semantic dimension or entity`, repairable: false } };
    }
    if (group.role === 'time' && group.grain) {
      // ONE TIME AXIS, OTHER DATES AS DIMENSIONS. The request carries one time
      // dimension; a second date breakdown used to overwrite the first, and the
      // answer silently lost a column the reading asked for while keeping its
      // governed label. A further date at its own (day) grain is grouped as a
      // plain dimension; at another grain it cannot be expressed here.
      if (!timeDimension) {
        timeDimension = { name: timeName(group.ref, found), granularity: group.grain };
      } else if (group.grain === 'day' && timeName(group.ref, found) !== timeDimension.name) {
        dimensions.push(semanticName(found));
      } else {
        return { refusal: { tier: 'semantic', code: 'not_semantic', message: `the semantic layer takes one time axis; ${group.ref} by ${group.grain} beside ${timeDimension.name} by ${timeDimension.granularity} cannot be grouped in the same query`, repairable: false } };
      }
    } else {
      dimensions.push(semanticName(found));
    }
  }
  // EVERY BREAKDOWN THE READING ASKED FOR IS IN THE REQUEST, or the semantic
  // tier does not answer. A governed label on an answer that dropped one is the
  // one outcome this product exists to prevent.
  const grouped = new Set([...dimensions, ...(timeDimension ? [timeDimension.name] : [])]);
  const lost = intent.groupBy.filter((group) => {
    const found = entry(group.ref);
    if (!found) return true;
    return !grouped.has(semanticName(found)) && !(group.role === 'time' && timeDimension && timeName(group.ref, found) === timeDimension.name);
  });
  if (lost.length > 0) {
    return { refusal: { tier: 'semantic', code: 'not_semantic', message: `the semantic request would not group by ${lost.map((group) => group.ref).join(', ')}, which the reading asks for`, repairable: false } };
  }
  for (const ref of intent.display) {
    const found = entry(ref);
    if (!found || (found.kind !== 'dimension' && found.kind !== 'entity')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${ref} is not a semantic dimension`, repairable: false } };
    }
    const name = semanticName(found);
    if (!dimensions.includes(name)) dimensions.push(name);
  }
  const filters: NonNullable<SemanticCompileRequest['filters']> = [];
  for (const predicate of intent.filters) {
    const found = entry(predicate.ref);
    if (!found || (found.kind !== 'dimension' && found.kind !== 'entity')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${predicate.ref} is not a semantic dimension`, repairable: false } };
    }
    // A lifted common restriction on the aggregation time belongs to
    // MetricFlow's `metric_time`, including when a calculated output caused
    // normalization to run after the reading was grounded. Keeping the
    // concrete source dimension here was the source of the photographed
    // prior-period refusal: the authored offset metric could no longer share
    // the one common time restriction.
    const filter = predicateToFilter(predicate, found);
    filters.push({ ...filter, dimension: timeName(predicate.ref, found) });
  }
  if (intent.time?.window) {
    const axis = intent.time.ref ? entry(intent.time.ref) : undefined;
    // A window the host bound to the measures' own time role is each
    // metric's aggregation time. MetricFlow and dbt Cloud express that as
    // `metric_time`, which lets metrics on different models share one
    // window; the native composer knows only concrete dimensions.
    let name = axis ? semanticName(axis) : timeDimension?.name;
    const hostChosen = Boolean(intent.time.ref && (intent.provenance[intent.time.ref] ?? '').startsWith('host:'));
    if (axis && metricTime && (hostChosen || aggregationTimes.has(intent.time.ref!))) name = 'metric_time';
    if (!name) return { refusal: { tier: 'semantic', code: 'not_semantic', message: 'a time window needs a semantic time dimension', repairable: true } };
    filters.push({ dimension: name, operator: 'gte', values: [intent.time.window.start.slice(0, 10)] }, { dimension: name, operator: 'lt', values: [intent.time.window.end.slice(0, 10)] });
  }
  if (intent.time?.ref && intent.time.grain && !timeDimension) {
    const axis = entry(intent.time.ref);
    if (axis) timeDimension = { name: timeName(intent.time.ref, axis), granularity: intent.time.grain };
  }
  let orderBy: SemanticCompileRequest['orderBy'];
  if (intent.ordering) {
    const orderEntry = entry(intent.ordering.ref);
    const name = intent.ordering.ref.startsWith('measure:')
      ? metrics[Number(intent.ordering.ref.slice('measure:'.length)) || 0]
      : orderEntry ? timeName(intent.ordering.ref, orderEntry) : semanticName({ kind: 'dimension', name: intent.ordering.ref, ref: intent.ordering.ref, aliases: [], roles: [] });
    if (name) orderBy = [{ name, direction: intent.ordering.direction }];
  }
  return {
    request: {
      metrics, dimensions,
      ...(filters.length ? { filters } : {}),
      ...(timeDimension ? { timeDimension } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(intent.limit ? { limit: intent.limit } : {}),
    },
    ...(derived.length ? { derived } : {}),
    ...(changes.length ? { changes } : {}),
  };
}

type SemanticProgramBinding = {
  program?: import('./types.js').SemanticExecutionProgram;
  refusal?: PreparedRefusal;
  derived?: NonNullable<PreparedCandidate['derived']>;
  changes?: NonNullable<PreparedCandidate['changes']>;
};

type SemanticProgramLeaf = {
  ref: string;
  scope: IntentPredicate[];
  /** The stable output name used after branch alignment. */
  output: string;
  /** Original alias/reference a change expression can name. */
  aliases: string[];
};

function predicateKey(predicate: IntentPredicate): string {
  // Membership is a set while range bounds are ordered.  Type tags retain the
  // distinction between a string "1" and numeric 1 through the normalizer.
  const values = (predicate.op === 'in' || predicate.op === 'not_in')
    ? [...new Set(predicate.values.map((value) => `${typeof value}:${String(value)}`))].sort()
    : predicate.values.map((value) => `${typeof value}:${String(value)}`);
  return `${predicate.ref}|${predicate.op}|${values.join(',')}`;
}

function mergedFilters(filters: IntentPredicate[], scope: IntentPredicate[]): IntentPredicate[] {
  const out: IntentPredicate[] = [];
  const seen = new Set<string>();
  for (const predicate of [...filters, ...scope]) {
    const key = predicateKey(predicate);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(predicate);
    }
  }
  return out;
}

function safeOutputName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'metric';
}

/**
 * Build a semantic execution program only after final normalization left
 * genuinely different per-measure scopes.  Each branch asks the selected
 * semantic engine for one authored metric under its own scope; Ask aligns the
 * returned values at the declared shape, but never rewrites a metric formula
 * or a MetricFlow offset in SQL.
 */
export function bindSemanticExecutionProgram(
  intent: AnalyticalIntentV1,
  vocabulary: VocabularyIndex,
  engine?: PrepareDeps['engine'],
): SemanticProgramBinding | undefined {
  if (!intent.measures.some((measure) => (measure.scope?.length ?? 0) > 0)) return undefined;
  const entry = (ref: string) => vocabulary.get(ref);
  const leaves: SemanticProgramLeaf[] = [];
  const originalOutput = new Map<string, string>();
  const derived: NonNullable<PreparedCandidate['derived']> = [];

  const addLeaf = (ref: string, scope: IntentPredicate[] | undefined, output: string, aliases: string[]): PreparedRefusal | undefined => {
    const found = entry(ref);
    if (!found || (found.kind !== 'metric' && found.kind !== 'measure')) {
      return { tier: 'semantic', code: 'not_semantic', message: `${ref} is not a semantic metric`, repairable: false };
    }
    leaves.push({ ref, scope: scope ?? [], output, aliases });
    for (const alias of aliases) originalOutput.set(alias, output);
    return undefined;
  };

  for (const measure of intent.measures) {
    if (measure.change) continue;
    if (measure.derived) {
      const alias = measure.alias ?? safeOutputName(measure.ref.replace(/^ratio:/, ''));
      const numerator = `__dql_${safeOutputName(alias)}_numerator`;
      const denominator = `__dql_${safeOutputName(alias)}_denominator`;
      const numeratorError = addLeaf(measure.derived.numerator, measure.scope, numerator, [measure.derived.numerator]);
      if (numeratorError) return { refusal: numeratorError };
      const denominatorError = addLeaf(measure.derived.denominator, measure.scope, denominator, [measure.derived.denominator]);
      if (denominatorError) return { refusal: denominatorError };
      derived.push({ alias, numerator, denominator });
      if (measure.alias) originalOutput.set(measure.alias, alias);
      continue;
    }
    const found = entry(measure.ref);
    if (!found || (found.kind !== 'metric' && found.kind !== 'measure')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${measure.ref} is not a semantic metric`, repairable: false } };
    }
    const output = measure.alias ?? semanticName(found);
    const error = addLeaf(measure.ref, measure.scope, output, [measure.ref, ...(measure.alias ? [measure.alias] : [])]);
    if (error) return { refusal: error };
  }
  if (leaves.length === 0) return undefined;

  // Identical authoring metric/scope pairs compile once. Their output aliases
  // remain distinct after execution, which makes two requested names for one
  // metric deterministic instead of issuing redundant warehouse statements.
  const grouped = new Map<string, SemanticProgramLeaf[]>();
  for (const leaf of leaves) {
    const key = `${leaf.ref}|${leaf.scope.map(predicateKey).sort().join(';')}`;
    const current = grouped.get(key) ?? [];
    current.push(leaf);
    grouped.set(key, current);
  }
  if (grouped.size > 4) {
    return { refusal: { tier: 'semantic', code: 'measure_scope_not_expressible', message: `this comparison needs ${grouped.size} distinct semantic periods; Ask runs at most four bounded semantic branches`, repairable: true } };
  }

  const branches: NonNullable<SemanticProgramBinding['program']>['branches'] = [];
  let ordinal = 0;
  for (const group of grouped.values()) {
    const first = group[0]!;
    const branchIntent: AnalyticalIntentV1 = {
      ...intent,
      measures: [{ ref: first.ref }],
      filters: mergedFilters(intent.filters, first.scope),
      // Ranking/limiting an input period before aligned comparison is wrong.
      // It also makes an authored offset metric's branch shape dependent on
      // a calculated output that MetricFlow never sees. Apply these once,
      // deterministically, after both branches have returned.
      ordering: undefined,
      limit: undefined,
    };
    const bound = bindSemanticRequest(branchIntent, vocabulary, engine);
    if (!bound.request) return { refusal: bound.refusal };
    branches.push({
      id: `semantic-period-${ordinal += 1}`,
      request: bound.request,
      outputs: group.map((leaf) => ({ source: bound.request!.metrics[0]!, as: leaf.output })),
      // A metric carrying an authored prior-period offset is a comparison
      // branch by definition; its SQL still comes from MetricFlow.
      role: /previous|prior|last[_ -]?month|last[_ -]?year/i.test(first.ref) ? 'comparison' : 'base',
    });
  }

  const changes: NonNullable<PreparedCandidate['changes']> = [];
  for (const measure of intent.measures) {
    if (!measure.change) continue;
    // A comparison expression itself has no semantic compiler identity. Its
    // two authored inputs may each have a period/scope, but an extra scope on
    // the calculated output would be silently discarded by a branch program.
    // Refuse it rather than widening the result or inventing a SQL formula.
    if (measure.scope?.length) {
      return { refusal: { tier: 'semantic', code: 'measure_scope_not_expressible', message: `${measure.alias ?? measure.ref} carries a restriction on a calculated comparison; apply it to each authored semantic metric instead`, repairable: true } };
    }
    const base = originalOutput.get(measure.change.base);
    const comparison = originalOutput.get(measure.change.comparison);
    if (!base || !comparison) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${measure.alias ?? measure.ref} needs semantic measures aliased ${measure.change.base} and ${measure.change.comparison} in the same reading`, repairable: true } };
    }
    changes.push({ alias: measure.alias ?? safeOutputName(measure.ref.replace(/^change:/, '')), base, comparison, as: measure.change.as });
  }

  const outputForOrder = (reference: string): string | undefined => {
    const measureAt = reference.startsWith('measure:') ? Number(reference.slice('measure:'.length)) : undefined;
    const measure = Number.isInteger(measureAt) ? intent.measures[measureAt!] : intent.measures.find((candidate) => candidate.ref === reference || candidate.alias === reference);
    if (measure) {
      if (measure.change || measure.derived) return measure.alias ?? safeOutputName(measure.ref.replace(/^(?:change|ratio):/, ''));
      return originalOutput.get(measure.alias ?? measure.ref) ?? (entry(measure.ref) ? semanticName(entry(measure.ref)!) : undefined);
    }
    const found = entry(reference);
    return found ? semanticName(found) : reference || undefined;
  };
  const orderingOutput = intent.ordering ? outputForOrder(intent.ordering.ref) : undefined;
  if (intent.ordering && !orderingOutput) {
    return { refusal: { tier: 'semantic', code: 'measure_scope_not_expressible', message: `the comparison ranking ${intent.ordering.ref} cannot be aligned to a declared semantic output`, repairable: true } };
  }
  const requiresPostProcess = Boolean(intent.ordering || intent.limit);

  return {
    program: {
      version: 1,
      branches,
      shape: intent.expectedShape === 'grouped' || intent.groupBy.length > 0 || intent.display.length > 0 || Boolean(intent.time?.grain) ? 'grouped' : 'scalar',
      ...(requiresPostProcess ? {
        postProcess: {
          ...(orderingOutput && intent.ordering ? { orderBy: { column: orderingOutput, direction: intent.ordering.direction } } : {}),
          ...(intent.limit ? { limit: intent.limit, includeTies: true } : {}),
          // Branch truncation is not a harmless presentation detail when an
          // aligned calculated value decides the rank. Refuse rather than
          // silently rank only the first adapter page.
          requireCompletePopulation: true,
        },
      } : {}),
    },
    ...(derived.length ? { derived } : {}),
    ...(changes.length ? { changes } : {}),
  };
}

/**
 * A semantic answer is From Metrics (`governed`) only when every join the
 * compile took is a certified relationship; a draft or unmodeled join makes it
 * review-required, and the caveat naming the join is said in the answer.
 */
function semanticTrust(compiled: SemanticCompileOutput): Pick<PreparedCandidate, 'trust' | 'trustCaveat'> {
  if (!compiled.joinTrust || compiled.joinTrust.certified) return { trust: 'governed' };
  return { trust: 'review_required', ...(compiled.joinTrust.caveat ? { trustCaveat: compiled.joinTrust.caveat } : {}) };
}

/** The answer's DQL artifact carries the same trust as the answer. */
function withArtifactTrust(artifact: unknown, compiled: SemanticCompileOutput): unknown {
  if (semanticTrust(compiled).trust === 'governed' || !artifact || typeof artifact !== 'object') return artifact;
  return { ...(artifact as Record<string, unknown>), trustState: 'review_required' };
}

function semanticJoinProof(compiled: SemanticCompileOutput): string[] {
  if (!compiled.joinTrust) return [];
  if (!compiled.joinTrust.certified) return [`joins: ${compiled.joinTrust.caveat ?? 'a join is not a certified relationship'}`];
  return (compiled.joinPath?.length ?? 0) > 0 ? ['joins: every join is a certified relationship'] : [];
}

export async function prepareSemantic(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): Promise<{ candidates: PreparedCandidate[]; refusals: PreparedRefusal[] }> {
  if (!deps.compileSemantic) return { candidates: [], refusals: [{ tier: 'semantic', code: 'semantic_runtime_unavailable', message: 'no semantic layer is loaded for this project', repairable: false }] };
  // The bounded branch program exists for metrics ONLY the semantic engine can
  // compute (an authored prior-period offset, a cumulative window) read under
  // different periods. A plain metric with a scope is the relational tier's
  // island, as it has been since round 2; running it through branches here
  // regrouped a one-customer question by its display label.
  // ... or when a metric has no physical binding at all (a MetricFlow-only
  // project whose measure expressions Ask cannot see): then the relational
  // islands cannot compose it and the engine's branches are the only route.
  const needsEngine = intent.measures.some((measure) => {
    const refs = measure.change ? [] : measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref];
    return refs.some((ref) => {
      const entry = vocabulary.get(ref);
      return Boolean(entry?.engineOnly) || ((entry?.kind === 'metric' || entry?.kind === 'measure') && !entry.physical);
    });
  });
  const programBound = needsEngine ? bindSemanticExecutionProgram(intent, vocabulary, deps.engine) : undefined;
  if (programBound?.refusal) return { candidates: [], refusals: [programBound.refusal] };
  if (programBound?.program) {
    if (!deps.compileSemanticProgram) {
      return { candidates: [], refusals: [{ tier: 'semantic', code: 'semantic_runtime_unavailable', message: 'the selected semantic adapter does not expose a bounded multi-period compiler', repairable: false }] };
    }
    try {
      const compiled = await deps.compileSemanticProgram(programBound.program);
      const program = compiled.program
        ? { ...compiled.program, postProcess: compiled.program.postProcess ?? programBound.program.postProcess }
        : undefined;
      if (!program || program.branches.length === 0 || program.branches.some((branch) => !branch.sql || !branch.engine)) {
        return { candidates: [], refusals: [{ tier: 'semantic', code: 'semantic_compile_failed', message: 'the semantic adapter did not return executable SQL for every requested period', repairable: false, detail: programBound.program }] };
      }
      return {
        candidates: [{
          tier: 'semantic', ...semanticTrust(compiled), sql: compiled.sql, engine: compiled.engine,
          semanticProgram: program,
          // One semantic block over every metric the periods read.
          artifact: withArtifactTrust(semanticAnswerArtifact({ ...program.branches[0]!.request, metrics: [...new Set(program.branches.flatMap((branch) => branch.request.metrics))] }, intent.reading, compiled.sql), compiled),
          ...(programBound.derived ? { derived: programBound.derived } : {}),
          ...(programBound.changes ? { changes: programBound.changes } : {}),
          compileRequest: programBound.program,
          proof: [
            `compiled ${program.branches.length} bounded period${program.branches.length === 1 ? '' : 's'} on the ${compiled.engine} semantic engine at ${program.shape} shape`,
            ...program.branches.map((branch) => `${branch.id}: metrics ${branch.request.metrics.join(', ')}${branch.request.filters?.length ? ` with ${branch.request.filters.length} semantic filter${branch.request.filters.length === 1 ? '' : 's'}` : ''}`),
            ...(programBound.derived ?? []).map((item) => `${item.alias} = ${item.numerator} / ${item.denominator}, computed from aligned semantic metrics (null when the denominator is 0)`),
            ...(programBound.changes ?? []).map((item) => `${item.alias} = ${item.comparison} - ${item.base}${item.as === 'percent' ? `, over ${item.base}` : ''}, computed after the authored semantic metrics return${item.as === 'percent' ? ' (null when the earlier value is 0)' : ''}`),
            ...semanticJoinProof(compiled),
          ],
        }],
        refusals: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { candidates: [], refusals: [{ tier: 'semantic', code: 'semantic_compile_failed', message, repairable: /not found|unknown|no such|could not resolve|ambiguous|cannot be grouped|not a dimension/i.test(message), detail: programBound.program }] };
    }
  }
  const bound = bindSemanticRequest(intent, vocabulary, deps.engine);
  if (!bound.request) return { candidates: [], refusals: [bound.refusal!] };
  try {
    const compiled = await deps.compileSemantic(bound.request);
    return {
      candidates: [{
        tier: 'semantic', ...semanticTrust(compiled), sql: compiled.sql, engine: compiled.engine,
        ...(compiled.columns ? { columns: compiled.columns } : {}),
        ...(compiled.fanoutProbeSql ? { fanoutProbeSql: compiled.fanoutProbeSql } : {}),
        artifact: withArtifactTrust(compiled.artifact !== undefined ? compiled.artifact : semanticAnswerArtifact(bound.request, intent.reading, compiled.sql), compiled),
        ...(bound.derived ? { derived: bound.derived } : {}),
        ...(bound.changes ? { changes: bound.changes } : {}),
        compileRequest: bound.request,
        proof: [
          `compiled on the ${compiled.engine} semantic engine from metrics ${bound.request.metrics.join(', ')}${bound.request.dimensions.length ? ` by ${bound.request.dimensions.join(', ')}` : ''}${compiled.strategy ? ` (${compiled.strategy})` : ''}`,
          ...(bound.derived ?? []).map((item) => `${item.alias} = ${item.numerator} / ${item.denominator}, computed from the executed metrics (null when the denominator is 0)`),
          ...(bound.changes ?? []).map((item) => `${item.alias} = ${item.comparison} - ${item.base}${item.as === 'percent' ? `, over ${item.base}` : ''}, computed from the semantic metrics${item.as === 'percent' ? ' (null when the earlier value is 0)' : ''}`),
          ...(compiled.warnings ?? []).slice(0, 3).map((warning) => `engine note: ${warning}`),
          ...semanticJoinProof(compiled),
        ],
      }],
      refusals: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      candidates: [],
      refusals: [{ tier: 'semantic', code: 'semantic_compile_failed', message, repairable: /not found|unknown|no such|could not resolve|ambiguous|cannot be grouped|not a dimension/i.test(message), detail: bound.request }],
    };
  }
}
