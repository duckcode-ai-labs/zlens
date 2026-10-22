import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../../api/client';
import type { DatasetDescriptor, DatasetField, DatasetMeasureField, DatasetPhysicalField } from '@zlens/core/datasets/descriptor';
import { tileQueryValidationRuns, validateTileQuery, type TileQuery } from '@zlens/core/apps/tile-query';
import { defaultTimeGrain, groupDatasetFields } from './field-query';
import { withTopN } from './sort-top-n';
import { humanize } from './studio-ui';
import { needsReview } from './app-data';

/**
 * Quick start without AI (round-2 design Q2): three quick choices instead of
 * matching the words of a request.
 *
 *   [KPI]   Total of [measure ▾]
 *   [Trend] [measure ▾] by [time grain ▾]   (on the data's main time field)
 *   [Top]   Top [N] [dimension ▾] by [measure ▾]
 *
 * The pickers list the fields of the App's data, with the same names as the
 * Data pane (related fields included). The result is exactly what was chosen:
 * ordinary field tiles composed through the App API, Top N through the tile
 * query's sort and limit, a KPI as a single value. Pure: no React, no fetches.
 */

export type QuickChoiceKind = 'kpi' | 'trend' | 'top';

/** At most this many tiles in one go. */
export const QUICK_CHOICE_LIMIT = 6;
export const QUICK_TOP_N_CHOICES = [5, 10, 25] as const;
export const QUICK_CHOICE_KIND_LABELS: Record<QuickChoiceKind, string> = { kpi: 'KPI', trend: 'Trend', top: 'Top' };
export const QUICK_START_TAB = 'Quick start';
export const CONNECT_AI_TO_DESCRIBE_IN_WORDS = 'Connect an AI provider to describe an App in your own words';

/** One field a picker offers. `key` is unique across the App's data. */
export interface QuickField {
  key: string;
  sourceId: string;
  name: string;
  /** As the Data pane names it: "Order Total", a related field's "Customer Name". */
  label: string;
  /** The picker group: the data's name, or "Orders → Customer" for related fields. */
  group: string;
  /** The field is used through a join nobody certified yet: its tile needs review. */
  review: boolean;
}

export interface QuickMeasure extends QuickField {
  aggregation: DatasetMeasureField['aggregation'];
}

/** The main time field a trend groups by, and the grains it offers. */
export interface QuickTime {
  name: string;
  label: string;
  grains: string[];
  defaultGrain: string;
}

/** One piece of the App's data with fields the quick choices can use. */
export interface QuickData {
  sourceId: string;
  label: string;
  certified: boolean;
  /** In the App's Domain (always true when the App has none). */
  inDomain: boolean;
  descriptor: DatasetDescriptor;
  measures: QuickMeasure[];
  dimensions: QuickField[];
  time?: QuickTime;
}

export interface QuickChoice {
  id: string;
  kind: QuickChoiceKind;
  /** A QuickField key. */
  measure: string;
  /** Trend only. */
  grain?: string;
  /** Top only: a QuickField key from the same data as the measure. */
  dimension?: string;
  /** Top only. */
  n?: number;
}

const GENERAL_DOMAINS = new Set(['', 'general', 'unassigned']);
const DEFAULT_GRAINS = ['day', 'week', 'month', 'quarter', 'year'];

export function quickFieldKey(sourceId: string, name: string): string {
  return `${sourceId}|${name}`;
}

function splitKey(key: string): { sourceId: string; name: string } {
  const at = key.lastIndexOf('|');
  return at < 0 ? { sourceId: '', name: key } : { sourceId: key.slice(0, at), name: key.slice(at + 1) };
}

function sameDomain(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '').trim().toLowerCase() === (right ?? '').trim().toLowerCase();
}

function mainTimeField(fields: DatasetPhysicalField[]): DatasetPhysicalField | undefined {
  return fields.find((field) => field.time?.primary) ?? fields[0];
}

/**
 * The App's data as the pickers list it: data in the App's Domain first, then
 * certified data first, otherwise in the App's order. Data without fields (a
 * saved query whose columns were never read) is left out.
 */
export function quickChoiceData(items: readonly AppBlockRecommendation[], appDomain?: string): QuickData[] {
  const domain = GENERAL_DOMAINS.has((appDomain ?? '').trim().toLowerCase()) ? '' : (appDomain ?? '').trim();
  const data: QuickData[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const descriptor = item.capabilities?.dataset as DatasetDescriptor | undefined;
    const sourceId = item.sourceId ?? item.id;
    if (!descriptor || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const label = humanize(descriptor.label || item.name);
    const groups = groupDatasetFields(descriptor);
    const field = (entry: DatasetField, group: string, review = false): QuickField => ({
      key: quickFieldKey(sourceId, entry.name), sourceId, name: entry.name, label: humanize(entry.name), group, review,
    });
    const measures = groups.measures.flatMap((entry) => entry.kind === 'measure' ? [{ ...field(entry, label), aggregation: entry.aggregation }] : []);
    // Keys last: "Top 10 customer ids" is rarely what anyone wants.
    const own = [...groups.dimensions.filter((entry) => entry.role !== 'key'), ...groups.dimensions.filter((entry) => entry.role === 'key')]
      .filter((entry) => entry.type !== 'number');
    const related = groups.related.flatMap((group) => group.fields
      .filter((entry) => entry.role !== 'time' && entry.type !== 'date' && entry.type !== 'timestamp' && entry.type !== 'number')
      .map((entry) => field(entry, `${label} → ${group.path}`, group.review)));
    const time = mainTimeField(groups.time);
    const grains = time ? (time.time?.grains?.length ? time.time.grains : DEFAULT_GRAINS) : [];
    data.push({
      sourceId,
      label,
      certified: !needsReview(item),
      inDomain: !domain || sameDomain(item.domain || descriptor.domain, domain),
      descriptor,
      measures,
      dimensions: [...own.map((entry) => field(entry, label)), ...related],
      ...(time ? { time: { name: time.name, label: humanize(time.name), grains, defaultGrain: defaultTimeGrain(time) ?? (grains.includes('month') ? 'month' : grains[0]!) } } : {}),
    });
  }
  return data
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => Number(right.entry.inDomain) - Number(left.entry.inDomain)
      || Number(right.entry.certified) - Number(left.entry.certified)
      || left.index - right.index)
    .map(({ entry }) => entry);
}

export function quickMeasures(data: readonly QuickData[]): QuickMeasure[] {
  return data.flatMap((entry) => entry.measures);
}

export function findQuickMeasure(data: readonly QuickData[], key: string | undefined): QuickMeasure | undefined {
  return key ? quickMeasures(data).find((measure) => measure.key === key) : undefined;
}

export function findQuickDimension(data: readonly QuickData[], key: string | undefined): QuickField | undefined {
  return key ? data.flatMap((entry) => entry.dimensions).find((field) => field.key === key) : undefined;
}

export function quickDataOf(data: readonly QuickData[], key: string | undefined): QuickData | undefined {
  if (!key) return undefined;
  const { sourceId } = splitKey(key);
  return data.find((entry) => entry.sourceId === sourceId);
}

/** Measures a choice of this kind can use: a trend needs a time field, a top list a dimension. */
export function quickMeasureOptions(data: readonly QuickData[], kind: QuickChoiceKind, dimension?: string): QuickMeasure[] {
  if (kind === 'trend') return data.filter((entry) => entry.time).flatMap((entry) => entry.measures);
  if (kind === 'top') {
    const owner = quickDataOf(data, dimension);
    if (owner) return owner.measures;
    return data.filter((entry) => entry.dimensions.length).flatMap((entry) => entry.measures);
  }
  return quickMeasures(data);
}

/** Dimensions a top list can rank: from data that also has a measure. */
export function quickDimensionOptions(data: readonly QuickData[]): QuickField[] {
  return data.filter((entry) => entry.measures.length).flatMap((entry) => entry.dimensions);
}

/** Which kinds the App's data can make. */
export function quickKindAvailable(data: readonly QuickData[], kind: QuickChoiceKind): boolean {
  if (kind === 'kpi') return quickMeasures(data).length > 0;
  if (kind === 'trend') return quickMeasureOptions(data, 'trend').length > 0;
  return quickDimensionOptions(data).length > 0;
}

/** A total reads best for a sum; counts, averages and rates read as themselves. */
function preferredMeasure(measures: readonly QuickMeasure[]): QuickMeasure | undefined {
  return measures.find((measure) => measure.aggregation === 'sum') ?? measures[0];
}

/** "Customer Name" ranks better than "Customer Id"; a field of the same data as the KPI wins a tie. */
function dimensionScore(field: QuickField, preferSourceId?: string): number {
  const words = field.label.toLowerCase();
  let score = 0;
  if (/\bname\b/.test(words)) score += 3;
  if (/\b(id|key|uuid|code)\b/.test(words)) score -= 4;
  if (!field.review) score += 1;
  if (preferSourceId && field.sourceId === preferSourceId) score += 1;
  return score;
}

let choiceCounter = 0;
function nextChoiceId(kind: QuickChoiceKind): string {
  choiceCounter += 1;
  return `${kind}-${choiceCounter}`;
}

/** A new choice of one kind with sensible picks; undefined when the data can't make it. */
export function newQuickChoice(data: readonly QuickData[], kind: QuickChoiceKind, like?: { measure?: string }): QuickChoice | undefined {
  if (!quickKindAvailable(data, kind)) return undefined;
  if (kind === 'kpi') {
    const measure = findQuickMeasure(data, like?.measure) ?? preferredMeasure(quickMeasures(data));
    return measure ? { id: nextChoiceId(kind), kind, measure: measure.key } : undefined;
  }
  if (kind === 'trend') {
    const options = quickMeasureOptions(data, 'trend');
    const measure = options.find((option) => option.key === like?.measure) ?? preferredMeasure(options);
    const time = quickDataOf(data, measure?.key)?.time;
    return measure && time ? { id: nextChoiceId(kind), kind, measure: measure.key, grain: time.defaultGrain } : undefined;
  }
  const preferSourceId = like?.measure ? splitKey(like.measure).sourceId : undefined;
  const dimension = [...quickDimensionOptions(data)]
    .map((field, index) => ({ field, index, score: dimensionScore(field, preferSourceId) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.field;
  if (!dimension) return undefined;
  const options = quickMeasureOptions(data, 'top', dimension.key);
  const measure = options.find((option) => option.key === like?.measure) ?? preferredMeasure(options);
  return measure ? { id: nextChoiceId(kind), kind, measure: measure.key, dimension: dimension.key, n: 10 } : undefined;
}

/** The three quick choices a new App opens with: a KPI, its trend, and a top list. */
export function defaultQuickChoices(data: readonly QuickData[]): QuickChoice[] {
  const kpi = newQuickChoice(data, 'kpi');
  return [kpi, newQuickChoice(data, 'trend', { measure: kpi?.measure }), newQuickChoice(data, 'top', { measure: kpi?.measure })]
    .filter((choice): choice is QuickChoice => Boolean(choice));
}

/**
 * A changed choice that still makes sense: a trend's grain is one its time
 * field offers; a top list's measure comes from the same data as its dimension.
 */
export function updateQuickChoice(data: readonly QuickData[], choice: QuickChoice, patch: Partial<Omit<QuickChoice, 'id' | 'kind'>>): QuickChoice {
  const next: QuickChoice = { ...choice, ...patch };
  if (next.kind === 'trend') {
    const time = quickDataOf(data, next.measure)?.time;
    if (time && (!next.grain || !time.grains.includes(next.grain))) next.grain = time.grains.includes(choice.grain ?? '') ? choice.grain : time.defaultGrain;
  }
  if (next.kind === 'top' && patch.dimension) {
    const options = quickMeasureOptions(data, 'top', next.dimension);
    if (!options.some((option) => option.key === next.measure)) next.measure = preferredMeasure(options)?.key ?? next.measure;
  }
  return next;
}

// ── Titles ───────────────────────────────────────────────────────────────────

/** "Order Total" stays itself; a summed "Lifetime Spend" is "Total Lifetime Spend"; counts and rates read as named. */
export function quickKpiTitle(measure: Pick<QuickMeasure, 'label' | 'aggregation'>): string {
  if (measure.aggregation !== 'sum' || /\b(total|sum|count|number|avg|average)\b/i.test(measure.label)) return measure.label;
  return `Total ${measure.label}`;
}

/** "Order Total by month". */
export function quickTrendTitle(measure: Pick<QuickMeasure, 'label'>, grain: string): string {
  return `${measure.label} by ${grain.replace(/_/g, ' ').toLowerCase()}`;
}

function pluralWord(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** What one row of a dimension is, in words: "Customer Name" → "customers"; "Region" → "regions". */
export function quickDimensionNoun(label: string, n = 2): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const trimmed = words.length > 1 && /^(name|id|key|code|label|title)$/i.test(words[words.length - 1]!) ? words.slice(0, -1) : words;
  const lower = trimmed.map((word) => word.toLowerCase());
  if (n === 1 || !lower.length) return lower.join(' ');
  return [...lower.slice(0, -1), pluralWord(lower[lower.length - 1]!)].join(' ');
}

/** "Top 10 customers by Lifetime Spend". */
export function quickTopTitle(n: number, dimension: Pick<QuickField, 'label'>, measure: Pick<QuickMeasure, 'label'>): string {
  return `Top ${n} ${quickDimensionNoun(dimension.label, n)} by ${measure.label}`;
}

/** The title a choice's tile gets, or '' while its picks are incomplete. */
export function quickChoiceTitle(data: readonly QuickData[], choice: QuickChoice): string {
  const measure = findQuickMeasure(data, choice.measure);
  if (!measure) return '';
  if (choice.kind === 'kpi') return quickKpiTitle(measure);
  if (choice.kind === 'trend') return choice.grain ? quickTrendTitle(measure, choice.grain) : '';
  const dimension = findQuickDimension(data, choice.dimension);
  return dimension ? quickTopTitle(choice.n ?? 10, dimension, measure) : '';
}

/**
 * The App's name: what the author typed, else "<Domain> overview" from the
 * App's Domain, else from its data's Domain, else its first data's name.
 * Never the request or a sentence.
 */
export function quickStartAppName(input: { name?: string; domainLabel?: string; data?: readonly Pick<QuickData, 'label' | 'descriptor'>[] }): string {
  const typed = input.name?.trim();
  if (typed) return typed;
  const domain = input.domainLabel?.trim();
  if (domain && !GENERAL_DOMAINS.has(domain.toLowerCase())) return `${humanize(domain)} overview`;
  const dataDomain = input.data?.map((entry) => entry.descriptor.domain?.trim() ?? '').find((value) => value && !GENERAL_DOMAINS.has(value.toLowerCase()));
  if (dataDomain) return `${humanize(dataDomain)} overview`;
  const first = input.data?.[0]?.label;
  return first ? `${first} overview` : 'New App';
}

// ── Tiles ────────────────────────────────────────────────────────────────────

type DraftTile = AppStudioBuildDraft['pages'][number]['layout']['items'][number];

/** One tile to compose: exactly what a choice asked for. */
export interface QuickTileSpec {
  choiceId: string;
  sourceId: string;
  view: 'kpi' | 'chart';
  visualization: 'single_value' | 'line' | 'bar';
  title: string;
  query: TileQuery;
}

export type QuickTilesPlan =
  | { ok: true; tiles: QuickTileSpec[] }
  | { ok: false; error: string };

/**
 * The tiles for the chosen quick choices, each checked against its data's
 * contract the same way every field tile is.
 */
export function quickChoiceTiles(data: readonly QuickData[], choices: readonly QuickChoice[]): QuickTilesPlan {
  if (!choices.length) return { ok: false, error: 'Choose at least one tile.' };
  if (choices.length > QUICK_CHOICE_LIMIT) return { ok: false, error: `Choose at most ${QUICK_CHOICE_LIMIT} tiles at once.` };
  const tiles: QuickTileSpec[] = [];
  for (const [index, choice] of choices.entries()) {
    const measure = findQuickMeasure(data, choice.measure);
    const owner = quickDataOf(data, choice.measure);
    if (!measure || !owner) return { ok: false, error: `Tile ${index + 1}: choose a measure.` };
    const base: TileQuery = { dimensions: [], measures: [{ measure: measure.name }], respectsGlobalFilters: true };
    let query: TileQuery;
    let visualization: QuickTileSpec['visualization'];
    if (choice.kind === 'kpi') {
      query = base;
      visualization = 'single_value';
    } else if (choice.kind === 'trend') {
      if (!owner.time) return { ok: false, error: `Tile ${index + 1}: ${owner.label} has no date to show a trend over.` };
      const grain = choice.grain && owner.time.grains.includes(choice.grain) ? choice.grain : owner.time.defaultGrain;
      query = { ...base, dimensions: [{ field: owner.time.name, timeGrain: grain }] };
      visualization = 'line';
    } else {
      const dimension = findQuickDimension(data, choice.dimension);
      if (!dimension) return { ok: false, error: `Tile ${index + 1}: choose what to rank.` };
      if (dimension.sourceId !== owner.sourceId) return { ok: false, error: `Tile ${index + 1}: ${dimension.label} and ${measure.label} come from different data. Pick both from ${owner.label}.` };
      query = withTopN({ ...base, dimensions: [{ field: dimension.name }] }, measure.name, choice.n ?? 10);
      visualization = 'bar';
    }
    let runs = false;
    let reason = '';
    try {
      const validation = validateTileQuery(owner.descriptor, query);
      runs = tileQueryValidationRuns(validation);
      reason = validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ');
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause);
    }
    if (!runs) return { ok: false, error: `Tile ${index + 1} can't be made from ${owner.label}${reason ? `: ${reason}` : '.'}` };
    tiles.push({
      choiceId: choice.id,
      sourceId: owner.sourceId,
      view: choice.kind === 'kpi' ? 'kpi' : 'chart',
      visualization,
      title: quickChoiceTitle(data, { ...choice, n: choice.n ?? 10 }),
      query,
    });
  }
  return { ok: true, tiles };
}

/**
 * Where the new tiles go, under what the page already has: KPIs side by side
 * in one row (3 columns each), then charts two to a row.
 */
export function quickTileLayout(existing: readonly Pick<DraftTile, 'y' | 'h'>[], tiles: readonly Pick<QuickTileSpec, 'view'>[], columns = 12): Array<{ x: number; y: number; w: number; h: number }> {
  const top = existing.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const kpiWidth = 3;
  const kpisPerRow = Math.max(1, Math.floor(columns / kpiWidth));
  const kpiCount = tiles.filter((tile) => tile.view === 'kpi').length;
  const chartTop = top + Math.ceil(kpiCount / kpisPerRow) * 2;
  const half = Math.floor(columns / 2);
  let kpi = 0;
  let chart = 0;
  return tiles.map((tile) => {
    if (tile.view === 'kpi') {
      const spot = { x: (kpi % kpisPerRow) * kpiWidth, y: top + Math.floor(kpi / kpisPerRow) * 2, w: kpiWidth, h: 2 };
      kpi += 1;
      return spot;
    }
    const spot = { x: (chart % 2) * half, y: chartTop + Math.floor(chart / 2) * 4, w: half, h: 4 };
    chart += 1;
    return spot;
  });
}
