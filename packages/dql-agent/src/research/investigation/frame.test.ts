import { describe, expect, it } from 'vitest';
import type { AnalyticalIntentV1, IntentPredicate } from '../../ask-pipeline/intent.js';
import { buildVocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import { frameNeedsFreshness, investigationWindowsFor, planInvestigationFrame, type InvestigationFramePlan } from './frame.js';

const vocabulary = buildVocabularyIndex({
  metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
  dimensions: [
    { name: 'region', model: 'orders', label: 'Region', dataType: 'string' },
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
  ],
});
const TIME = 'dimension:orders.ordered_at';
const REVENUE = 'metric:orders.revenue';

const reading = (overrides: Partial<AnalyticalIntentV1> = {}): AnalyticalIntentV1 => ({
  version: 1, kind: 'analytics', reading: 'Revenue in August 2025.',
  measures: [{ ref: REVENUE }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {},
  time: { ref: TIME, grain: 'month', window: { start: '2025-08-01', end: '2025-09-01' } },
  ...overrides,
} as AnalyticalIntentV1);

const between = (start: string, end: string): IntentPredicate[] => [
  { ref: TIME, op: 'gte', values: [start] }, { ref: TIME, op: 'lt', values: [end] },
] as IntentPredicate[];

function planned(intent: AnalyticalIntentV1, lane: 'governed' | 'ai' = 'governed'): InvestigationFramePlan {
  const result = planInvestigationFrame({ reading: intent, vocabulary, lane });
  if (result.status !== 'planned') throw new Error(`expected a plan, got ${result.status}`);
  return result.plan;
}

describe('framing an investigation from a reading', () => {
  it('a stated period is investigated as stated, against the period before and the same period a year earlier', () => {
    const plan = planned(reading());
    expect(plan).toMatchObject({ metric: { ref: REVENUE, label: 'Revenue', additivity: 'additive' }, timeRef: TIME, grain: 'month', shape: 'level', stated: { current: { start: '2025-08-01', end: '2025-09-01' } } });
    expect(frameNeedsFreshness(plan)).toBe(false);
    const windows = investigationWindowsFor(plan, { now: new Date('2026-09-12T00:00:00Z') });
    expect(windows.windowBasis).toBe('stated');
    expect(windows.windows.current.label).toBe('August 2025');
    expect(windows.windows.prior.label).toBe('July 2025');
    expect(windows.windows.yearAgo.label).toBe('August 2024');
    expect(windows.windows.yearAgoPrior.label).toBe('July 2024');
    expect(investigationWindowsFor(plan, { now: new Date(), fromSourceRun: true }).windowBasis).toBe('source_run');
  });

  it('a relative period after the data ends moves to the latest complete period, and says so', () => {
    const plan = planned(reading({ time: { ref: TIME, grain: 'month', window: { start: '2026-08-01', end: '2026-09-01', expression: 'last month' } } }));
    expect(frameNeedsFreshness(plan)).toBe(true);
    const windows = investigationWindowsFor(plan, { observedThrough: '2025-08-21', now: new Date('2026-09-12T00:00:00Z') });
    expect(windows.windowBasis).toBe('shifted_to_data');
    expect(windows.windows.current).toEqual({ start: '2025-07-01', end: '2025-08-01', label: 'July 2025' });
    expect(windows.notes.join(' ')).toContain('the data runs through 2025-08-20');

    const inside = investigationWindowsFor(planned(reading({ time: { ref: TIME, grain: 'month', window: { start: '2025-07-01', end: '2025-08-01', expression: 'last month' } } })), { observedThrough: '2025-09-01', now: new Date('2025-08-12T00:00:00Z') });
    expect(inside.windowBasis).toBe('stated');
    expect(inside.windows.current.label).toBe('July 2025');
  });

  it('without a stated period, the latest complete period of the data, or of today when the data end is unknown', () => {
    const plan = planned(reading({ time: { ref: TIME, grain: 'month' } }));
    expect(frameNeedsFreshness(plan)).toBe(true);
    expect(investigationWindowsFor(plan, { observedThrough: '2025-09-01', now: new Date('2026-09-12T00:00:00Z') })).toMatchObject({ windowBasis: 'latest_complete', windows: { current: { label: 'August 2025' } } });
    const fromToday = investigationWindowsFor(plan, { now: new Date('2026-09-12T00:00:00Z') });
    expect(fromToday.windows.current.label).toBe('August 2026');
    expect(fromToday.notes).toHaveLength(1);
  });

  it('a trend reading is investigated at its last period against the one before', () => {
    const plan = planned(reading({ expectedShape: 'trend', time: { ref: TIME, window: { start: '2025-01-01', end: '2025-09-01', expression: 'through August 2025' } } }));
    expect(plan).toMatchObject({ grain: 'month', shape: 'change', stated: { trailing: true } });
    expect(frameNeedsFreshness(plan)).toBe(false);
    const windows = investigationWindowsFor(plan, { now: new Date('2026-09-12T00:00:00Z') });
    expect(windows.windows.current).toEqual({ start: '2025-08-01', end: '2025-09-01', label: 'August 2025' });
    expect(windows.windows.prior.label).toBe('July 2025');
    expect(windows.windows.yearAgo.label).toBe('August 2024');
    expect(windows.notes.join(' ')).toContain('The reading covered January 2025 to August 2025; Research compares its last month, August 2025');

    // One period of its own grain is investigated as stated.
    const year = planned(reading({ expectedShape: 'trend', time: { ref: TIME, window: { start: '2025-01-01', end: '2026-01-01' } } }));
    expect(year.stated?.trailing).toBeUndefined();
  });

  it('a change between two scoped measures compares the periods each names', () => {
    const plan = planned(reading({
      time: { ref: TIME, grain: 'month' },
      measures: [
        { ref: REVENUE, alias: 'july', scope: between('2025-07-01', '2025-08-01') },
        { ref: REVENUE, alias: 'august', scope: between('2025-08-01', '2025-09-01') },
        { ref: 'change:august-july', alias: 'change', change: { base: 'july', comparison: 'august' } },
      ] as AnalyticalIntentV1['measures'],
    }));
    expect(plan.shape).toBe('change');
    expect(plan.stated).toMatchObject({ current: { start: '2025-08-01', end: '2025-09-01' }, prior: { start: '2025-07-01', end: '2025-08-01' } });
    expect(investigationWindowsFor(plan, { now: new Date() }).windows.prior.label).toBe('July 2025');
  });

  it('a period written as a token on the date field ("2025-06") is the period the question named', () => {
    const token = (value: string) => [{ ref: TIME, op: 'eq', values: [value], source: 'question' }] as IntentPredicate[];
    const plan = planned(reading({
      time: { ref: TIME, window: { start: '2025-05-01', end: '2025-07-01', expression: 'May 2025 vs June 2025' } },
      measures: [
        { ref: REVENUE, alias: 'prior_month', scope: token('2025-05') },
        { ref: REVENUE, alias: 'june_2025', scope: token('2025-06') },
        { ref: 'change:june-may', alias: 'change', change: { base: 'prior_month', comparison: 'june_2025', as: 'absolute' } },
      ] as AnalyticalIntentV1['measures'],
    }));
    expect(plan.stated).toMatchObject({ current: { start: '2025-06-01', end: '2025-07-01' }, prior: { start: '2025-05-01', end: '2025-06-01' } });
    expect(frameNeedsFreshness(plan)).toBe(false);
    const windows = investigationWindowsFor(plan, { now: new Date('2026-09-12T00:00:00Z') });
    expect([windows.windows.current.label, windows.windows.prior.label]).toEqual(['June 2025', 'May 2025']);

    const quarter = planned(reading({ time: { ref: TIME }, filters: token('2025-Q2') }));
    expect(quarter.stated?.current).toEqual({ start: '2025-04-01', end: '2025-07-01' });
    expect(quarter.baseFilters).toEqual([]);
  });

  it('every query keeps the reading\'s restrictions except the dates the periods replace', () => {
    const region = { ref: 'dimension:orders.region', op: 'eq', values: ['West'] } as IntentPredicate;
    const plan = planned(reading({ filters: [region, ...between('2025-01-01', '2026-01-01')] }));
    expect(plan.baseFilters).toEqual([region]);
  });

  it('a ratio compares its parts, and an average is not added across periods', () => {
    const ratio = planned(reading({ measures: [{ ref: 'ratio:food/revenue', alias: 'food_share', derived: { numerator: 'metric:orders.food_revenue', denominator: REVENUE } }] as AnalyticalIntentV1['measures'] }));
    expect(ratio.metric).toMatchObject({ additivity: 'ratio', label: 'food share', ratio: { numeratorRef: 'metric:orders.food_revenue', denominatorRef: REVENUE } });
    const average = planned(reading({ measures: [{ ref: 'column:dev.orders.amount', aggregation: 'avg' }] }), 'ai');
    expect(average.metric).toMatchObject({ additivity: 'non_additive', aggregation: 'avg' });
    expect(average.lane).toBe('ai');
  });

  it('a certified block is measured through the governed metric with its definition, never one that shares a name', () => {
    const contract = (sourceColumn: string) => ({
      version: 1 as const, name: 'monthly_revenue', outputs: ['month', 'gross_revenue', 'order_count'],
      measures: [{ output: 'gross_revenue', aggregate: 'sum' as const, sourceColumn }, { output: 'order_count', aggregate: 'count' as const }],
      groupBy: ['month'], staticScope: [], allowedFilters: [], parameters: [], entities: ['order'], relations: ['dev.orders'], structural: true,
    });
    const withBlock = (sourceColumn: string) => buildVocabularyIndex({
      metrics: [
        { name: 'order_total', model: 'orders', aggregation: 'sum', type: 'simple', expr: 'order_total', physical: { relation: 'dev.orders', column: 'order_total', aggregate: 'sum' } },
        // Same aggregate, different relation and meaning: never the block's number.
        { name: 'revenue', model: 'order_items', aggregation: 'sum', type: 'simple', expr: 'revenue', physical: { relation: 'dev.order_items', column: 'revenue', aggregate: 'sum' } },
      ],
      dimensions: [{ name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] }],
      blocks: [{ name: 'monthly_revenue', domain: 'commerce', certified: true, contract: contract(sourceColumn) }],
    });
    const blockReading = reading({ measures: [{ ref: 'block:commerce.monthly_revenue' }] });

    const governed = planInvestigationFrame({ reading: blockReading, vocabulary: withBlock('order_total'), lane: 'governed' });
    expect(governed).toMatchObject({ status: 'planned', plan: { lane: 'governed', metric: { ref: 'metric:orders.order_total', additivity: 'additive' } } });
    if (governed.status === 'planned') expect(governed.plan.notes?.[0]).toContain('certified saved query monthly revenue, which cannot be split into periods');

    const tables = planInvestigationFrame({ reading: blockReading, vocabulary: withBlock('order_cost'), lane: 'governed' });
    expect(tables).toMatchObject({ status: 'planned', plan: { lane: 'ai', metric: { ref: 'column:dev.orders.order_cost', aggregation: 'sum', additivity: 'additive' } } });
  });

  it('a numeric season is the period when no date field is known', () => {
    const SEASON = 'dimension:local_player_season_facts.season';
    const seasons = buildVocabularyIndex({
      metrics: [{ name: 'total_points', model: 'local_player_season_facts', label: 'Total points', aggregation: 'sum' }],
      dimensions: [
        { name: 'season', model: 'local_player_season_facts', label: 'Source season', dataType: 'number' },
        { name: 'player_name', model: 'local_player_season_facts', label: 'Player', dataType: 'string' },
      ],
    });
    const ranking = {
      version: 1, kind: 'analytics', reading: 'Rank players by total points in season 2017.',
      measures: [{ ref: 'metric:local_player_season_facts.total_points' }],
      groupBy: [{ ref: 'dimension:local_player_season_facts.player_name', role: 'categorical' }], display: [],
      filters: [{ ref: SEASON, op: 'eq', values: [2017], source: 'question' }],
      expectedShape: 'ranking', unresolved: [], provenance: {},
    } as AnalyticalIntentV1;
    const result = planInvestigationFrame({ reading: ranking, vocabulary: seasons, lane: 'governed' });
    if (result.status !== 'planned') throw new Error(`expected a plan, got ${result.status}`);
    expect(result.plan).toMatchObject({ timeRef: SEASON, grain: 'year', periodAxis: { ref: SEASON, name: 'season', current: 2017 }, baseFilters: [] });
    expect(frameNeedsFreshness(result.plan)).toBe(false);
    const windows = investigationWindowsFor(result.plan, { now: new Date('2026-09-12T00:00:00Z') });
    expect(windows.windows.current).toEqual({ start: '2017', end: '2018', label: '2017 season' });
    expect(windows.windows.prior.label).toBe('2016 season');
    expect(windows.windows.yearAgo.start).toBe(windows.windows.prior.start);

    // No season named: the latest season in the data, with a note.
    const unnamed = planInvestigationFrame({ reading: { ...ranking, filters: [] }, vocabulary: seasons, lane: 'governed' });
    if (unnamed.status !== 'planned') throw new Error(`expected a plan, got ${unnamed.status}`);
    expect(unnamed.plan.periodAxis).toEqual({ ref: SEASON, name: 'season' });
    expect(frameNeedsFreshness(unnamed.plan)).toBe(true);
    const latest = investigationWindowsFor(unnamed.plan, { observedValue: 2022, now: new Date('2026-09-12T00:00:00Z') });
    expect(latest).toMatchObject({ windowBasis: 'latest_complete', windows: { current: { label: '2022 season' }, prior: { label: '2021 season' } } });
    expect(latest.notes.join(' ')).toContain('the latest season in the data, 2022');
  });

  it('a filter on a raw column is the governed dimension over that column, and a filter written twice is kept once', () => {
    const PLAYER = 'dimension:local_player_season_facts.player';
    const seasons = buildVocabularyIndex({
      metrics: [{ name: 'total_points', model: 'local_player_season_facts', label: 'Total points', aggregation: 'sum' }],
      dimensions: [
        { name: 'player', model: 'local_player_season_facts', label: 'Player', dataType: 'string', physical: { relation: 'TRANSFORMED.local_player_season_facts', column: 'player_name' } },
        { name: 'season', model: 'local_player_season_facts', label: 'Source season', dataType: 'number', physical: { relation: 'TRANSFORMED.local_player_season_facts', column: 'season' } },
      ],
      relations: [
        { schema: 'TRANSFORMED', name: 'local_player_season_facts', columns: [{ name: 'player_name', dataType: 'varchar' }, { name: 'season', dataType: 'integer' }] },
        { schema: 'TRANSFORMED', name: 'local_player_game_facts', columns: [{ name: 'player_name', dataType: 'varchar' }] },
      ],
    });
    const column = seasons.entries.find((entry) => entry.kind === 'column' && entry.ref.includes('local_player_season_facts.player_name'))!.ref;
    const otherTable = seasons.entries.find((entry) => entry.kind === 'column' && entry.ref.includes('local_player_game_facts.player_name'))!.ref;
    const lebron = ['LeBron James'];
    // The reading the live NBA run produced: the player twice, once as the raw column.
    const result = planInvestigationFrame({
      vocabulary: seasons, lane: 'governed',
      reading: {
        version: 1, kind: 'analytics', reading: "LeBron James's total points in the 2017 season.",
        measures: [{ ref: 'metric:local_player_season_facts.total_points' }], groupBy: [], display: [],
        filters: [
          { ref: column, op: 'eq', values: lebron, source: 'question' },
          { ref: PLAYER, op: 'eq', values: lebron, source: 'question' },
          { ref: 'dimension:local_player_season_facts.season', op: 'eq', values: [2017], source: 'question' },
        ],
        expectedShape: 'scalar', unresolved: [], provenance: {},
      } as AnalyticalIntentV1,
    });
    if (result.status !== 'planned') throw new Error(`expected a plan, got ${result.status}`);
    expect(result.plan.baseFilters).toEqual([{ ref: PLAYER, op: 'eq', values: lebron, source: 'question' }]);
    expect(result.plan.periodAxis).toMatchObject({ current: 2017 });

    // A column of another table is not that dimension's column: it stays as written.
    const other = planInvestigationFrame({
      vocabulary: seasons, lane: 'governed',
      reading: {
        version: 1, kind: 'analytics', reading: 'Total points in the 2017 season.',
        measures: [{ ref: 'metric:local_player_season_facts.total_points' }], groupBy: [], display: [],
        filters: [{ ref: otherTable, op: 'eq', values: lebron, source: 'question' }, { ref: 'dimension:local_player_season_facts.season', op: 'eq', values: [2017], source: 'question' }],
        expectedShape: 'scalar', unresolved: [], provenance: {},
      } as AnalyticalIntentV1,
    });
    if (other.status !== 'planned') throw new Error(`expected a plan, got ${other.status}`);
    expect(other.plan.baseFilters.map((filter) => filter.ref)).toEqual([otherTable]);
  });

  it('a metric that is itself a growth or running total does not add up across members', () => {
    const derived = buildVocabularyIndex({
      metrics: [
        { name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum', type: 'simple' },
        { name: 'revenue_growth_mom', model: 'orders', label: 'Revenue Growth % M/M', type: 'derived' },
        { name: 'cumulative_revenue', model: 'orders', label: 'Cumulative revenue', type: 'cumulative' },
      ],
      dimensions: [{ name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] }],
    });
    const additivityOf = (ref: string) => {
      const result = planInvestigationFrame({ vocabulary: derived, lane: 'governed', reading: { ...reading(), measures: [{ ref }] } });
      if (result.status !== 'planned') throw new Error(`expected a plan, got ${result.status}`);
      return result.plan.metric.additivity;
    };
    expect(additivityOf('metric:orders.revenue')).toBe('additive');
    expect(additivityOf('metric:orders.revenue_growth_mom')).toBe('non_additive');
    expect(additivityOf('metric:orders.cumulative_revenue')).toBe('non_additive');
  });

  it('asks for a measure when there is none, and declines what is not a change over time', () => {
    expect(planInvestigationFrame({ reading: reading({ measures: [] }), vocabulary, lane: 'governed' }).status).toBe('clarify');
    // A project with no metrics offers the numeric columns the question names, never a text or date column.
    const raw = buildVocabularyIndex({
      relations: [{ schema: 'sales', name: 'mart_arr', columnCompleteness: 'complete', columns: [
        { name: 'arr', dataType: 'DOUBLE' }, { name: 'arr_month', dataType: 'DATE' }, { name: 'arr_band', dataType: 'VARCHAR' }, { name: 'crm_account_name', dataType: 'VARCHAR' },
      ] }],
    });
    const why = planInvestigationFrame({
      reading: reading({ reading: 'The question asks for an explanation of a change, which is not computable.', measures: [], time: undefined }),
      question: 'Why did net ARR change in June 2025?', vocabulary: raw, lane: 'ai',
    });
    expect(why.status).toBe('clarify');
    if (why.status === 'clarify') {
      expect(why.options).toContain('column:sales.mart_arr.arr');
      expect(why.options.some((ref) => /arr_month|arr_band/.test(ref))).toBe(false);
    }
    expect(planInvestigationFrame({ reading: reading({ kind: 'conversation' } as Partial<AnalyticalIntentV1>), vocabulary, lane: 'governed' }).status).toBe('not_investigable');
    const timeless = buildVocabularyIndex({ metrics: [{ name: 'headcount', model: 'teams', aggregation: 'sum' }] });
    const result = planInvestigationFrame({ reading: reading({ measures: [{ ref: 'metric:teams.headcount' }], time: undefined }), vocabulary: timeless, lane: 'governed' });
    expect(result).toMatchObject({ status: 'not_investigable' });
  });
});
