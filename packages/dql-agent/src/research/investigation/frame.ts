/**
 * FRAMING AN INVESTIGATION from a reading: the metric, the date field it is
 * measured over, the grain, the filters every query keeps, and the periods to
 * compare. Pure: the only data it reads is the vocabulary and, when given, the
 * day the data runs through.
 */
import type { AnalyticalIntentV1, Grain, IntentMeasure, IntentPredicate } from '../../ask-pipeline/intent.js';
import { fieldIdentity } from '../../ask-pipeline/policies.js';
import type { VocabularyEntry, VocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import type { InvestigationFrameV1, InvestigationMetric, InvestigationWindow } from './types.js';
import { addDays, addGrains, bucketsIn, dayOf, formatDay, grainOfWindow, latestCompleteWindow, parseDay, priorWindow, startOfGrain, windowOf, yearAgoWindow } from './windows.js';

export interface InvestigationFramePlan {
  reading: string;
  lane: 'governed' | 'ai';
  metric: InvestigationMetric;
  timeRef: string;
  grain: Grain;
  /**
   * `trailing`: the reading covers several periods to show the way to the last
   * one (a trend "through August 2025"); the change investigated is that last
   * period against the one before.
   */
  stated?: { current: { start: string; end: string }; prior?: { start: string; end: string }; expression?: string; trailing?: true };
  baseFilters: IntentPredicate[];
  shape: 'change' | 'level';
  /** What framing decided that a reader should know (a certified block measured through its governed metric). */
  notes?: string[];
  /** A numeric period field (a season, a year) used because no date field is known, with the values the reading named. */
  periodAxis?: { ref: string; name: string; current?: number; prior?: number };
}

export type InvestigationFramePlanResult =
  | { status: 'planned'; plan: InvestigationFramePlan }
  | { status: 'clarify'; question: string; options: string[] }
  | { status: 'not_investigable'; reason: string };

const NON_ADDITIVE = new Set(['avg', 'median', 'count_distinct', 'min', 'max']);
const NUMERIC_TYPE = /(int|decimal|float|double|numeric|number|real|money)/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_FIELD = /(^|_)(season|year|fiscal_year|fy)$/i;

export function entryLabel(vocabulary: VocabularyIndex, ref: string, fallback?: string): string {
  const entry = vocabulary.get(ref);
  const name = entry?.label ?? entry?.name ?? fallback ?? ref.replace(/^[a-z_]+:/i, '').split('.').pop() ?? ref;
  return name.replace(/_/g, ' ');
}

/** A value that names a year-like period (2017, "2017"), or undefined. */
export function yearOfPeriodValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d{4}(\.0+)?\s*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number >= 1900 && number <= 2100 ? number : undefined;
}

const isTimeRef = (vocabulary: VocabularyIndex, ref: string, timeRef?: string) => ref === timeRef || Boolean(vocabulary.get(ref)?.roles.includes('time'));

const PERIOD_TOKEN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?|-Q([1-4]))?$/i;

/** A partial date the reader wrote for a whole period: "2025", "2025-06", "2025-Q2", "2025-06-15". */
function periodOfToken(value: unknown): { start: string; end: string } | undefined {
  const text = String(value ?? '').trim().replace(/[T ]00:00:00(?:\.0+)?(?:Z|\+00:00)?$/, '');
  const match = PERIOD_TOKEN.exec(text);
  if (!match) return undefined;
  const grain: Grain = match[3] ? 'day' : match[4] ? 'quarter' : match[2] ? 'month' : 'year';
  const month = match[4] ? (Number(match[4]) - 1) * 3 + 1 : Number(match[2] ?? 1);
  const start = parseDay(`${match[1]}-${String(month).padStart(2, '0')}-${match[3] ?? '01'}`);
  return start ? { start: formatDay(start), end: formatDay(addGrains(start, grain, 1)) } : undefined;
}

function windowFromPredicates(vocabulary: VocabularyIndex, predicates: IntentPredicate[] | undefined, timeRef?: string): { start: string; end: string; ref: string } | undefined {
  const onTime = (predicates ?? []).filter((predicate) => isTimeRef(vocabulary, predicate.ref, timeRef));
  const from = onTime.find((predicate) => predicate.op === 'gte');
  const to = onTime.find((predicate) => predicate.op === 'lt');
  const start = from ? String(from.values[0]).slice(0, 10) : '';
  const end = to ? String(to.values[0]).slice(0, 10) : '';
  if (ISO_DAY.test(start) && ISO_DAY.test(end) && end > start) return { start, end, ref: from!.ref };
  // The reader may name the period as one token on the date field ("June 2025" as "2025-06").
  const equal = onTime.find((predicate) => predicate.op === 'eq' && predicate.values.length === 1);
  const period = equal ? periodOfToken(equal.values[0]) : undefined;
  return period ? { ...period, ref: equal!.ref } : undefined;
}

/** A ratio's parts from a derived metric written `a / b` over two named inputs. */
function ratioOfEntry(entry: VocabularyEntry | undefined): InvestigationMetric['ratio'] | undefined {
  const inputs = entry?.derived?.inputs ?? [];
  const parts = /^\s*([A-Za-z_]\w*)\s*\/\s*([A-Za-z_]\w*)\s*$/.exec(entry?.derived?.expr ?? '');
  if (!parts || inputs.length !== 2) return undefined;
  const numerator = inputs.find((input) => input.alias === parts[1]);
  const denominator = inputs.find((input) => input.alias === parts[2]);
  return numerator && denominator ? { numeratorRef: numerator.ref, denominatorRef: denominator.ref } : undefined;
}

function metricOf(vocabulary: VocabularyIndex, measure: IntentMeasure): InvestigationMetric {
  const entry = vocabulary.get(measure.ref) ?? vocabulary.resolve(measure.ref);
  const ref = entry?.ref ?? measure.ref;
  const label = entryLabel(vocabulary, ref, measure.alias);
  if (measure.derived) {
    return {
      ref, label, additivity: 'ratio',
      ratio: {
        numeratorRef: measure.derived.numerator, denominatorRef: measure.derived.denominator,
        ...(measure.derived.numeratorAggregation ? { numeratorAggregation: measure.derived.numeratorAggregation } : {}),
        ...(measure.derived.denominatorAggregation ? { denominatorAggregation: measure.derived.denominatorAggregation } : {}),
      },
    };
  }
  const ratio = ratioOfEntry(entry);
  if (ratio) return { ref, label, additivity: 'ratio', ratio };
  const aggregation = measure.aggregation ?? (entry?.aggregation as IntentMeasure['aggregation'] | undefined);
  // Only a simple aggregate adds up across members: a derived, cumulative,
  // conversion or ratio metric (a growth rate, a running total) does not.
  const nonAdditive = NON_ADDITIVE.has(aggregation ?? '') || Boolean(entry?.metricType && entry.metricType !== 'simple');
  return { ref, label, additivity: nonAdditive ? 'non_additive' : 'additive', ...(measure.aggregation ? { aggregation: measure.aggregation } : {}) };
}

/**
 * A certified block is one query, not a metric: it cannot be split into
 * periods. Research measures the governed metric with the block's definition
 * (the same aggregate of the same column on the same relation), or, when no
 * governed metric has it, that column itself on the AI-written lane. A name is
 * never enough: "revenue" on another relation is a different number.
 */
function measureForBlock(vocabulary: VocabularyIndex, measure: IntentMeasure): { measure: IntentMeasure; lane?: 'ai'; note?: string } {
  const block = vocabulary.get(measure.ref);
  const source = block?.kind === 'block' ? block.contract?.measures.find((item) => item.sourceColumn && item.aggregate) : undefined;
  if (!block || !source?.sourceColumn || !source.aggregate) return { measure };
  const leaf = (value: string) => value.replace(/"/g, '').toLowerCase().split('.').pop() ?? '';
  const column = leaf(source.sourceColumn);
  const relations = new Set((block.contract?.relations ?? []).map(leaf));
  const definition = (entry: VocabularyEntry) => {
    const call = /^\s*([a-z_]+)\s*\(\s*([\w."]+)\s*\)\s*$/i.exec(entry.physical?.expr ?? entry.expr ?? '');
    return {
      aggregate: (call?.[1] ?? entry.physical?.aggregate ?? entry.aggregation ?? '').toLowerCase(),
      reads: leaf(call?.[2] ?? entry.physical?.column ?? entry.physical?.expr ?? entry.expr ?? ''),
    };
  };
  const same = vocabulary.entries.filter((entry) => {
    if ((entry.kind !== 'metric' && entry.kind !== 'measure') || entry.inventory || entry.derived) return false;
    if (entry.metricType && entry.metricType !== 'simple') return false;
    const { aggregate, reads } = definition(entry);
    return aggregate === source.aggregate && reads === column
      && (!entry.physical?.relation || relations.size === 0 || relations.has(leaf(entry.physical.relation)));
  });
  const metrics = same.filter((entry) => entry.kind === 'metric');
  const pool = metrics.length ? metrics : same;
  const blockLabel = entryLabel(vocabulary, block.ref);
  if (pool.length === 1) {
    const governed = pool[0]!;
    return {
      measure: { ...measure, ref: governed.ref },
      note: `The reading named the certified saved query ${blockLabel}, which cannot be split into periods; Research measures ${entryLabel(vocabulary, governed.ref)}, the governed metric with the same definition.`,
    };
  }
  const relation = block.contract?.relations[0];
  if (!relation) return { measure };
  return {
    measure: { ...measure, ref: `column:${relation}.${source.sourceColumn}`, aggregation: source.aggregate },
    lane: 'ai',
    note: `The reading named the certified saved query ${blockLabel}, which cannot be split into periods, and no governed metric has its definition; Research measures the ${source.aggregate} of ${source.sourceColumn} with SQL the AI writes from the tables.`,
  };
}

function timeRefFor(vocabulary: VocabularyIndex, reading: AnalyticalIntentV1, measure: IntentMeasure, metricRef: string): string | undefined {
  const timeGroup = reading.groupBy.find((group) => group.role === 'time');
  const scoped = windowFromPredicates(vocabulary, measure.scope)?.ref ?? windowFromPredicates(vocabulary, reading.filters)?.ref;
  const entry = vocabulary.get(metricRef);
  const sameModel = entry?.model
    ? vocabulary.entries.find((candidate) => (candidate.kind === 'dimension' || candidate.kind === 'column') && candidate.roles.includes('time') && candidate.model === entry.model)?.ref
    : undefined;
  return reading.time?.ref ?? timeGroup?.ref ?? scoped ?? entry?.timeRef ?? sameModel;
}

/**
 * A numeric period field when no date field is known: a season or a year the
 * reading restricts ("season = 2017"), compares (two scoped measures), groups
 * by, or that the metric's own model carries.
 */
function periodAxisFor(
  vocabulary: VocabularyIndex,
  reading: AnalyticalIntentV1,
  primary: IntentMeasure,
  metricRef: string,
  change?: { comparison: IntentMeasure; base: IntentMeasure },
): InvestigationFramePlan['periodAxis'] | undefined {
  const nameOf = (ref: string) => vocabulary.get(ref)?.name ?? ref.split('.').pop() ?? ref;
  const isPeriodField = (ref: string) => !isTimeRef(vocabulary, ref) && PERIOD_FIELD.test(nameOf(ref));
  const valueIn = (predicates: IntentPredicate[] | undefined) => {
    const predicate = (predicates ?? []).find((item) => item.op === 'eq' && item.values.length === 1 && isPeriodField(item.ref) && yearOfPeriodValue(item.values[0]) !== undefined);
    return predicate ? { ref: predicate.ref, value: yearOfPeriodValue(predicate.values[0])! } : undefined;
  };
  const current = change ? valueIn(change.comparison.scope) : valueIn(primary.scope) ?? valueIn(reading.filters);
  const prior = change ? valueIn(change.base.scope) : undefined;
  const grouped = reading.groupBy.find((group) => isPeriodField(group.ref));
  const model = vocabulary.get(metricRef)?.model;
  const onModel = model
    ? vocabulary.entries.find((entry) => (entry.kind === 'dimension' || entry.kind === 'column') && entry.model === model && isPeriodField(entry.ref))?.ref
    : undefined;
  const ref = current?.ref ?? prior?.ref ?? grouped?.ref ?? onModel;
  if (!ref) return undefined;
  return {
    ref,
    name: nameOf(ref).replace(/_/g, ' '),
    ...(current ? { current: current.value } : {}),
    ...(prior ? { prior: prior.value } : {}),
  };
}

/**
 * A filter the reading wrote on a raw column is the governed dimension of the
 * metric's model that reads the same column: one raw column in a reading keeps
 * the semantic layer from compiling any of Research's queries and sends every
 * figure to SQL the AI writes. The same filter written twice is kept once.
 */
function governedFilters(vocabulary: VocabularyIndex, metricRef: string, filters: IntentPredicate[]): IntentPredicate[] {
  const model = (vocabulary.get(metricRef) ?? vocabulary.resolve(metricRef))?.model;
  const governed = (predicate: IntentPredicate): IntentPredicate => {
    if (!model || !predicate.ref.startsWith('column:')) return predicate;
    const field = fieldIdentity(predicate.ref, vocabulary);
    const dimension = vocabulary.entries.find((entry) => entry.kind === 'dimension' && !entry.inventory && entry.physical?.column
      && (entry.model === model || Boolean(entry.joinReach?.includes(model)))
      && fieldIdentity(entry.ref, vocabulary) === field);
    return dimension ? { ...predicate, ref: dimension.ref } : predicate;
  };
  const seen = new Set<string>();
  return filters.map(governed).filter((predicate) => {
    const key = JSON.stringify([predicate.ref, predicate.op, predicate.values, predicate.on ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Frame the reading: what is measured, over which date field, at which grain, under which filters. */
export function planInvestigationFrame(input: { reading: AnalyticalIntentV1; vocabulary: VocabularyIndex; lane: 'governed' | 'ai'; question?: string }): InvestigationFramePlanResult {
  const { reading, vocabulary } = input;
  if (reading.kind !== 'analytics') return { status: 'not_investigable', reason: 'Research investigates how a measure changed over time; this question is not a question about data.' };
  const byAlias = (alias: string) => reading.measures.find((measure) => measure.alias === alias);
  const changeMeasure = reading.measures.find((measure) => measure.change);
  const base = changeMeasure ? byAlias(changeMeasure.change!.base) : undefined;
  const comparison = changeMeasure ? byAlias(changeMeasure.change!.comparison) : undefined;
  const primary = comparison ?? reading.measures.find((measure) => !measure.change);
  if (!primary) {
    // The choices come from the words of the question (a reading that found no
    // measure may describe the question rather than restate it): governed
    // metrics first, and numeric columns when the project declares none.
    const hits = vocabulary.lookup([input.question, reading.reading].filter(Boolean).join(' '), { limit: 24, minScore: 0.35 }).map((hit) => hit.entry);
    const governed = hits.filter((entry) => entry.kind === 'metric' || entry.kind === 'measure');
    const numeric = hits.filter((entry) => (entry.kind === 'column' || entry.kind === 'dimension') && NUMERIC_TYPE.test(entry.dataType ?? ''));
    const options = [...new Set([...governed, ...numeric].map((entry) => entry.ref))].slice(0, 4);
    return { status: 'clarify', question: 'Research needs a measure to investigate. Which one should it look at?', options };
  }
  const measured = measureForBlock(vocabulary, primary);
  const metric = metricOf(vocabulary, measured.measure);
  const lane = measured.lane ?? input.lane;
  const timeRef = timeRefFor(vocabulary, reading, primary, metric.ref);
  if (!timeRef) {
    // No date field, but a season or a year: the periods are its values.
    const axis = periodAxisFor(vocabulary, reading, primary, metric.ref, comparison && base ? { comparison, base } : undefined);
    if (!axis) return { status: 'not_investigable', reason: `Research compares periods, and no date field is known for ${metric.label}.` };
    const keepOffAxis = (predicate: IntentPredicate) => predicate.on !== 'aggregate' && predicate.ref !== axis.ref;
    return {
      status: 'planned',
      plan: {
        reading: reading.reading, lane, metric, timeRef: axis.ref, grain: 'year',
        baseFilters: governedFilters(vocabulary, metric.ref, [...reading.filters, ...(primary.scope ?? [])]).filter(keepOffAxis),
        shape: changeMeasure || axis.prior !== undefined ? 'change' : 'level',
        periodAxis: axis,
        ...(measured.note ? { notes: [measured.note] } : {}),
      },
    };
  }
  const currentStated = comparison && base
    ? windowFromPredicates(vocabulary, comparison.scope, timeRef)
    : (reading.time?.window && ISO_DAY.test(reading.time.window.start.slice(0, 10)) && ISO_DAY.test(reading.time.window.end.slice(0, 10))
      ? { start: reading.time.window.start.slice(0, 10), end: reading.time.window.end.slice(0, 10), ref: timeRef }
      : windowFromPredicates(vocabulary, primary.scope, timeRef) ?? windowFromPredicates(vocabulary, reading.filters, timeRef));
  const priorStated = comparison && base ? windowFromPredicates(vocabulary, base.scope, timeRef) : undefined;
  const timeGroup = reading.groupBy.find((group) => group.role === 'time');
  const grain = reading.time?.grain ?? timeGroup?.grain ?? (currentStated ? grainOfWindow(currentStated) : undefined) ?? 'month';
  const trailing = Boolean(currentStated && !changeMeasure && !priorStated
    && (reading.expectedShape === 'trend' || timeGroup)
    && (bucketsIn(currentStated, grain) ?? 0) > 1);
  // Every query keeps the reading's restrictions, and the measure's own scope
  // ("beverage revenue"), except the dates the periods replace.
  const keep = (predicate: IntentPredicate) => predicate.on !== 'aggregate' && !isTimeRef(vocabulary, predicate.ref, timeRef);
  const baseFilters = governedFilters(vocabulary, metric.ref, [...reading.filters, ...(primary.scope ?? [])]).filter(keep);
  return {
    status: 'planned',
    plan: {
      reading: reading.reading, lane, metric, timeRef, grain, baseFilters,
      ...(measured.note ? { notes: [measured.note] } : {}),
      shape: changeMeasure || priorStated || trailing ? 'change' : 'level',
      ...(currentStated ? { stated: { current: { start: currentStated.start, end: currentStated.end }, ...(priorStated ? { prior: { start: priorStated.start, end: priorStated.end } } : {}), ...(reading.time?.window?.expression ? { expression: reading.time.window.expression } : {}), ...(trailing ? { trailing: true as const } : {}) } } : {}),
    },
  };
}

const RELATIVE_WORDS = /\b(last|this|previous|prior|past|recent|current|latest|ytd|mtd|qtd|yesterday|today|ago)\b/i;

/** The periods to compare, from what the question stated and what the data covers. */
export function investigationWindowsFor(plan: InvestigationFramePlan, input: { observedThrough?: string; observedValue?: number; now: Date; fromSourceRun?: boolean }): Pick<InvestigationFrameV1, 'windows' | 'windowBasis' | 'observedThrough' | 'notes'> {
  if (plan.periodAxis) return periodValueWindows(plan, plan.periodAxis, input);
  const { grain } = plan;
  const notes: string[] = [];
  let current: InvestigationWindow;
  let basis: InvestigationFrameV1['windowBasis'];
  const lastDataDay = input.observedThrough ? formatDay(addDays(parseDay(input.observedThrough)!, -1)) : undefined;
  if (plan.stated) {
    const stated = windowOf(parseDay(plan.stated.current.start)!, parseDay(plan.stated.current.end)!, grain);
    const relative = Boolean(plan.stated.expression && RELATIVE_WORDS.test(plan.stated.expression) && !/\b\d{4}\b/.test(plan.stated.expression));
    if (input.observedThrough && stated.start >= input.observedThrough && relative) {
      current = latestCompleteWindow(input.observedThrough, grain);
      basis = 'shifted_to_data';
      notes.push(`The question asked about ${stated.label}, but the data runs through ${lastDataDay}, so this investigates ${current.label}, the latest complete ${grain}.`);
    } else if (plan.stated.trailing) {
      const start = startOfGrain(addDays(parseDay(stated.end)!, -1), grain);
      current = windowOf(start, addGrains(start, grain, 1), grain);
      basis = input.fromSourceRun ? 'source_run' : 'stated';
      notes.push(`The reading covered ${stated.label}; Research compares its last ${grain}, ${current.label}, with the ${grain} before.`);
    } else {
      current = stated;
      basis = input.fromSourceRun ? 'source_run' : 'stated';
    }
  } else if (input.observedThrough) {
    current = latestCompleteWindow(input.observedThrough, grain);
    basis = 'latest_complete';
  } else {
    current = latestCompleteWindow(formatDay(dayOf(input.now)), grain);
    basis = 'latest_complete';
    notes.push(`How far the data runs could not be read, so the latest complete ${grain} is taken from today's date.`);
  }
  const prior = plan.stated?.prior && basis !== 'shifted_to_data'
    ? windowOf(parseDay(plan.stated.prior.start)!, parseDay(plan.stated.prior.end)!, grain)
    : priorWindow(current, grain);
  return {
    windows: { current, prior, yearAgo: yearAgoWindow(current, grain), yearAgoPrior: yearAgoWindow(prior, grain) },
    windowBasis: basis,
    ...(input.observedThrough ? { observedThrough: input.observedThrough } : {}),
    notes: [...(plan.notes ?? []), ...notes],
  };
}

/** Seasons (or years) as periods: the one named, or the latest with data, against the one before. */
function periodValueWindows(
  plan: InvestigationFramePlan,
  axis: NonNullable<InvestigationFramePlan['periodAxis']>,
  input: { observedValue?: number; now: Date; fromSourceRun?: boolean },
): Pick<InvestigationFrameV1, 'windows' | 'windowBasis' | 'notes'> {
  const notes: string[] = [];
  let current: number;
  let basis: InvestigationFrameV1['windowBasis'];
  if (axis.current !== undefined) {
    current = axis.current;
    basis = input.fromSourceRun ? 'source_run' : 'stated';
  } else if (input.observedValue !== undefined) {
    current = input.observedValue;
    basis = 'latest_complete';
    notes.push(`The question names no ${axis.name}, so Research compares the latest ${axis.name} in the data, ${current}, which may still be in progress.`);
  } else {
    current = dayOf(input.now).year - 1;
    basis = 'latest_complete';
    notes.push(`The latest ${axis.name} in the data could not be read, so Research compares ${current}.`);
  }
  const prior = axis.prior ?? current - 1;
  const period = (value: number): InvestigationWindow => ({ start: String(value), end: String(value + 1), label: `${value} ${axis.name}` });
  // One season earlier is the season before: the report compares it once.
  return {
    windows: { current: period(current), prior: period(prior), yearAgo: period(prior), yearAgoPrior: period(prior - 1) },
    windowBasis: basis,
    notes: [...(plan.notes ?? []), ...notes],
  };
}

/** Whether the frame needs to know how far the data runs before its windows can be set. */
export function frameNeedsFreshness(plan: InvestigationFramePlan): boolean {
  if (plan.periodAxis) return plan.periodAxis.current === undefined;
  return !plan.stated || Boolean(plan.stated.expression && RELATIVE_WORDS.test(plan.stated.expression) && !/\b\d{4}\b/.test(plan.stated.expression));
}
