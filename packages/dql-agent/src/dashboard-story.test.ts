import { describe, expect, it } from 'vitest';
import { buildDeterministicDashboardStory, validateDashboardStoryBrief } from './dashboard-story.js';

describe('dashboard business story', () => {
  it('uses all eligible governed tiles and keeps the least-trusted source', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Explain beverage revenue and top customers',
      filters: { category: 'Beverage', period: ['2026-01-01', '2026-06-30'] },
      driverTileIds: ['segments'],
      tiles: [
        {
          tileId: 'customers', title: 'Top customers', status: 'ok', trustState: 'certified',
          result: { columns: ['customer', 'revenue'], rows: [{ customer: 'Alice', revenue: 120 }, { customer: 'Bob', revenue: 80 }] },
          citation: { kind: 'block', name: 'top_customers' },
        },
        {
          tileId: 'segments', title: 'Revenue by beverage type', status: 'ok', trustState: 'review_required',
          result: { columns: ['type', 'revenue'], rows: [{ type: 'Coffee', revenue: 150 }, { type: 'Tea', revenue: 50 }] },
          citation: { kind: 'semantic_query', name: 'beverage_type_revenue' },
        },
      ],
    });
    expect(new Set(result.facts.map((fact) => fact.tileId))).toEqual(new Set(['customers', 'segments']));
    expect(result.story.trustState).toBe('review_required');
    // "Verified" wording is reserved for stories whose every source is certified.
    expect(result.story.implication).not.toMatch(/verified/i);
    expect(result.story.implication).toMatch(/need review/);
    expect(result.story.paragraphs.join(' ')).toContain('Alice');
    expect(result.story.paragraphs.join(' ')).toContain('Coffee');
    expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
  });

  it('reads an empty multi-select (All) as no filter, not as a blank value', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Claims this week', filters: { region: [] },
      tiles: [{ tileId: 'filed', title: 'Claims filed', status: 'ok', trustState: 'certified', result: { columns: ['claim_count'], rows: [{ claim_count: 147 }] }, citation: { kind: 'block', name: 'claims' } }],
    });
    expect(result.story.paragraphs[0]).toMatch(/^For the current scope, /);
    expect(result.story.paragraphs.join(' ')).not.toContain('region ,');
  });

  it('rejects invented numbers and unsupported causal language', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Revenue overview', filters: {},
      tiles: [{
        tileId: 'revenue', title: 'Revenue', status: 'ok', trustState: 'certified',
        result: { columns: ['revenue'], rows: [{ revenue: 100 }] },
      }],
    });
    const invalid = {
      ...result.story,
      paragraphs: ['Revenue fell 25 because renewals caused the decline.'],
      claims: [{ text: 'Renewals caused the decline.', factIds: [result.facts[0]!.id], kind: 'driver' as const }],
      generatedBy: 'ai' as const,
    };
    const validation = validateDashboardStoryBrief(invalid, result.facts);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/unsupported number|causal claim/);
  });

  it('keeps grouped Dataset rows as formatted observations instead of reaggregating distinct counts or ratios', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Commerce monthly health',
      filters: {},
      tiles: [{
        tileId: 'monthly-health', title: 'Monthly customer health', status: 'ok', trustState: 'certified',
        datasetScope: {
          kind: 'grouped_observations',
          dimensions: ['order_date'],
          outputDimensionAliases: ['order_date_month'],
          limited: false,
        },
        result: {
          columns: ['order_date_month', 'customer_count', 'margin_rate'],
          columnsMeta: [
            { name: 'customer_count', kind: 'count' },
            { name: 'margin_rate', kind: 'percent', unit: 'fraction', decimals: 1 },
          ],
          rows: [
            { order_date_month: new Date('2026-01-01T00:00:00.000Z'), customer_count: 12_500, margin_rate: 0.4166667 },
            { order_date_month: new Date('2026-02-01T00:00:00.000Z'), customer_count: 25_000, margin_rate: 0.6 },
            { order_date_month: new Date('2026-03-01T00:00:00.000Z'), customer_count: 25_000, margin_rate: 0.6 },
          ],
        },
      }],
    });

    // The old generic summary emitted 62,500 and 1.6167. Neither number is a
    // valid whole-scope distinct count or ratio-of-sums for this grouped tile.
    expect(result.facts.map((fact) => fact.value)).not.toContain(62_500);
    expect(result.facts.map((fact) => fact.value)).not.toContain(1.6166667);
    // The largest observations are narrated; February and March tie, and the
    // earlier month comes first.
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringContaining('2026-02-01'), value: 25_000 }),
      expect.objectContaining({ label: expect.stringContaining('2026-02-01'), value: 0.6, unit: 'percent:1' }),
    ]));
    expect(result.story.paragraphs.join(' ')).toContain('60.0%');
    expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
  });

  it('does not narrate a deliberately excluded Dataset tile as if it shared the active filter scope', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'California revenue health',
      filters: { region: ['CA'] },
      tiles: [
        {
          tileId: 'california-revenue', title: 'Revenue', status: 'ok', trustState: 'certified',
          filters: { region: ['CA'] },
          result: { columns: ['revenue'], rows: [{ revenue: 60 }] },
        },
        {
          tileId: 'monthly-revenue', title: 'Monthly Revenue', status: 'ok', trustState: 'certified',
          // The page control remains active but this component was omitted
          // from its Dataset binding. These are full-source observations.
          filters: {},
          datasetScope: {
            kind: 'grouped_observations', dimensions: ['order_date'], outputDimensionAliases: ['order_date_month'], limited: false,
          },
          result: {
            columns: ['order_date_month', 'revenue'],
            rows: [
              { order_date_month: '2026-01-01', revenue: 60 },
              { order_date_month: '2026-02-01', revenue: 30 },
              { order_date_month: '2026-03-01', revenue: 40 },
            ],
          },
        },
      ],
    });

    const scopedFactIds = new Set(result.facts
      .filter((fact) => JSON.stringify(fact.filters) === JSON.stringify({ region: ['CA'] }))
      .map((fact) => fact.id));
    const narratedFactIds = new Set(result.story.claims.flatMap((claim) => claim.factIds));
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tileId: 'monthly-revenue', value: 60, filters: {} }),
      expect.objectContaining({ tileId: 'monthly-revenue', value: 40, filters: {} }),
    ]));
    expect([...narratedFactIds].every((factId) => scopedFactIds.has(factId))).toBe(true);
    expect(result.story.paragraphs.join(' ')).not.toContain('Monthly Revenue');
    expect(result.story.caveat).toContain('outside the current filter scope');
  });

  it('does not claim the filter scope when no tile reflects the selected filters (F6)', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'NBA player performance',
      filters: { season_start: 2016, season_end: 2017, top_n: 5 },
      tiles: [{
        tileId: 'codex-scorers', title: 'Codex Top Scorers', status: 'ok', trustState: 'certified',
        // The block took none of the page values.
        filters: {},
        result: { columns: ['player_name', 'total_points'], rows: [{ player_name: 'James Harden', total_points: 5534 }] },
      }],
    });
    const text = [result.story.headline, ...result.story.paragraphs].join(' ');
    expect(text).not.toMatch(/season start 2016|top n 5/);
    expect(result.story.paragraphs[0]).toMatch(/^For the current scope, /);
    expect(result.story.caveat).toContain('Season start, season end and top n do not narrow any tile summarized here');
  });

  it('describes tiles narrowed by different filters with their own scope, in labels and readable dates (review phase 2)', () => {
    const month = { start: '2025-01-01', end: '2025-06-30' };
    const result = buildDeterministicDashboardStory({
      goal: 'Sales manager review',
      filters: { month, customer_name: 'Angela Moyer' },
      filterLabels: { month: 'Month', customer_name: 'Customer Name' },
      tiles: [
        {
          tileId: 'revenue', title: 'Gross Revenue', status: 'ok', trustState: 'certified',
          // The customer filter does not reach the revenue KPI.
          filters: { month },
          result: { columns: ['gross_revenue'], rows: [{ gross_revenue: 395828.89 }] },
        },
        {
          tileId: 'customers', title: 'Top customers', status: 'ok', trustState: 'certified',
          filters: { customer_name: 'Angela Moyer' },
          result: { columns: ['customer_name', 'lifetime_spend'], rows: [{ customer_name: 'Angela Moyer', lifetime_spend: 1200 }] },
        },
      ],
    });
    const text = [result.story.headline, ...result.story.paragraphs, result.story.caveat ?? ''].join(' ');
    expect(text).not.toContain('[object Object]');
    expect(text).not.toMatch(/None of the tiles|no tile reflects/);
    expect(result.story.paragraphs[0]).toContain('For Month 1 Jan 2025 – 30 Jun 2025 (not filtered by Customer Name), the clearest signal is Gross Revenue');
    expect(result.story.paragraphs[0]).toContain('For Customer Name Angela Moyer (not filtered by Month)');
    expect(result.story.claims.map((claim) => claim.factIds.every((id) => id.startsWith(claim.factIds[0]!.split(':')[0]!)))).toEqual([true, true]);
    expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
  });

  it('reads a one-sided date range as "from" and never as an object', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Revenue', filters: { month: { start: '2025-03-01', end: '' } }, filterLabels: { month: 'Month' },
      tiles: [{ tileId: 'kpi', title: 'Revenue', status: 'ok', trustState: 'certified', filters: { month: { start: '2025-03-01', end: '' } }, result: { columns: ['revenue'], rows: [{ revenue: 10 }] } }],
    });
    expect(result.story.paragraphs[0]).toMatch(/^For Month from 1 Mar 2025, /);
    expect(validateDashboardStoryBrief(result.story, result.facts).ok).toBe(true);
  });

  it('narrates only tiles the page filters reached and names the filter that reached none (F6)', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'NBA player performance',
      filters: { season: 2017, season_start: 2016, season_end: 2017, top_n: 5 },
      tiles: [
        {
          tileId: 'top-players', title: 'Top Players', status: 'ok', trustState: 'certified',
          filters: { season_start: 2016, season_end: 2017, top_n: 5 },
          result: { columns: ['player_name', 'total_points'], rows: [{ player_name: 'James Harden', total_points: 5534 }] },
        },
        {
          tileId: 'codex-scorers', title: 'Codex Top Scorers', status: 'ok', trustState: 'certified',
          filters: {},
          result: { columns: ['player_name', 'games'], rows: [{ player_name: 'LeBron James', games: 990 }] },
        },
      ],
    });
    expect(result.story.paragraphs[0]).toContain('For season start 2016, season end 2017, top n 5,');
    expect(result.story.paragraphs.join(' ')).not.toContain('Codex Top Scorers');
    expect(result.story.caveat).toContain('outside the current filter scope');
    expect(result.story.caveat).toContain('Season does not narrow any tile summarized here');
    expect(validateDashboardStoryBrief(result.story, result.facts).ok).toBe(true);
  });

  describe('a rank, an id or a year is never a measure (0.1.0 re-test #1)', () => {
    // The App give-me-top-5-players-who: rows ordered by rank, rank first.
    const ranked = [
      { rank: 1, player_name: 'James Harden', points_2016: 2646, points_2017: 2888, total_points_2016_2017: 5534, games_played_2016_2017: 189, player_id_count: 1 },
      { rank: 2, player_name: 'LeBron James', points_2016: 2511, points_2017: 2820, total_points_2016_2017: 5331, games_played_2016_2017: 214, player_id_count: 1 },
      { rank: 3, player_name: 'Russell Westbrook', points_2016: 2610, points_2017: 2642, total_points_2016_2017: 5252, games_played_2016_2017: 198, player_id_count: 1 },
      { rank: 4, player_name: 'Stephen Curry', points_2016: 2863, points_2017: 2388, total_points_2016_2017: 5251, games_played_2016_2017: 201, player_id_count: 1 },
      { rank: 5, player_name: 'Kevin Durant', points_2016: 2850, points_2017: 1985, total_points_2016_2017: 4835, games_played_2016_2017: 188, player_id_count: 1 },
    ];
    const rankedTile = (rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
      tileId: 'top5', title: 'Top 5 players', status: 'ok', trustState: 'review_required' as const,
      result: { columns: Object.keys(rows[0]!), rows },
      citation: { kind: 'block', name: 'top_5_players_points_2016_2017' },
      ...extra,
    });

    it('names the player ranked first, on the measure the ranking is by, and sums nothing', () => {
      const result = buildDeterministicDashboardStory({ goal: 'Top 5 scorers', filters: {}, tiles: [rankedTile(ranked)] });
      const text = result.story.paragraphs.join(' ');
      expect(text).toContain('**James Harden** is ranked first, with **5,534** total points 2016 2017');
      expect(result.facts[0]!.label).toMatch(/ranked first by total points 2016 2017/);
      expect(result.facts[0]!.value).toBe('James Harden: 5,534');
      // No "rank is 15", no summed Top-N ("points 2016 is 13,480"), no fifth-ranked leader.
      expect(text).not.toMatch(/rank is/i);
      expect(text).not.toContain('15');
      expect(text).not.toContain('13,480');
      expect(text).not.toContain('Kevin Durant');
      expect(result.facts.map((fact) => fact.id)).toEqual(['top5:rank:1']);
      expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
    });

    it('leads with the row ranked first even when the rows arrive in another order', () => {
      const result = buildDeterministicDashboardStory({ goal: 'Top 5 scorers', filters: {}, tiles: [rankedTile([...ranked].reverse())] });
      expect(result.facts[0]!.value).toBe('James Harden: 5,534');
    });

    it('prefers the measure the source declares', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Top 5 scorers', filters: {},
        tiles: [rankedTile(ranked, { declaredMeasures: ['games_played_2016_2017'] })],
      });
      expect(result.facts[0]!.label).toMatch(/ranked first by games played 2016 2017/);
      expect(result.facts[0]!.value).toBe('James Harden: 189');
    });

    it('treats a column contract that says dimension as one, whatever its name', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Revenue by store', filters: {},
        tiles: [{
          tileId: 'stores', title: 'Stores', status: 'ok', trustState: 'certified',
          result: {
            columns: ['store', 'store_size', 'revenue'],
            columnsMeta: [{ name: 'store_size', kind: 'number', ref: 'dimension:stores.store_size' }, { name: 'revenue', kind: 'currency', unit: 'USD', ref: 'metric:revenue' }],
            rows: [{ store: 'North', store_size: 3, revenue: 120 }, { store: 'South', store_size: 9, revenue: 80 }],
          },
        }],
      });
      expect(result.facts.map((fact) => fact.id)).toEqual(['stores:value:revenue', 'stores:rank:1']);
      expect(result.facts[1]!.value).toBe('North: $120.00');
    });

    it('reports no figure for a table of only ids and years', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Players by season', filters: {},
        tiles: [{
          tileId: 'ids', title: 'Player seasons', status: 'ok', trustState: 'certified',
          result: {
            columns: ['player_id', 'team_id', 'season', 'game_year', 'jersey_number', 'team_code'],
            rows: [
              { player_id: 201935, team_id: 1610612745, season: 2016, game_year: 2017, jersey_number: 13, team_code: 1 },
              { player_id: 2544, team_id: 1610612739, season: 2016, game_year: 2017, jersey_number: 23, team_code: 2 },
            ],
          },
        }],
      });
      expect(result.facts).toEqual([]);
      expect(result.story.paragraphs.join(' ')).not.toMatch(/\d{4,}/);
    });

    it('does not add a rate across rows', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Shooting', filters: {},
        tiles: [{
          tileId: 'fg', title: 'Field goals', status: 'ok', trustState: 'certified',
          result: { columns: ['player', 'fg_pct', 'made'], rows: [{ player: 'A', fg_pct: 0.5, made: 10 }, { player: 'B', fg_pct: 0.4, made: 20 }] },
        }],
      });
      expect(result.facts.map((fact) => fact.id)).not.toContain('fg:value:fg_pct');
      expect(result.facts.find((fact) => fact.id === 'fg:value:made')?.value).toBe(30);
    });
  });

  describe('a top-N list without a rank column is led by its first row, never summed', () => {
    // The certified App nba-player-performance-stakeholders-using-certified:
    // a top 5 with no rank column. It used to say "total points is 26,203".
    const TOP5_SQL = `SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points, COUNT(DISTINCT details_game_id) AS games_played
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) BETWEEN \${season_start} AND \${season_end} AND player_name IS NOT NULL
GROUP BY player_name
ORDER BY total_points DESC, player_name ASC
LIMIT \${top_n}`;
    const top5 = [
      { player_name: 'James Harden', total_points: 5534, games_played: 189 },
      { player_name: 'LeBron James', total_points: 5331, games_played: 214 },
      { player_name: 'Russell Westbrook', total_points: 5252, games_played: 198 },
      { player_name: 'Stephen Curry', total_points: 5251, games_played: 201 },
      { player_name: 'Kevin Durant', total_points: 4835, games_played: 188 },
    ];
    const tile = (extra: Record<string, unknown>) => ({
      tileId: 'top-players', title: 'Scorers 2016 2017', status: 'ok', trustState: 'certified' as const,
      result: { columns: ['player_name', 'total_points', 'games_played'], rows: top5 },
      citation: { kind: 'block', name: 'Top Players By Total Points 2016 2017' },
      ...extra,
    });
    const expectLedByHarden = (result: ReturnType<typeof buildDeterministicDashboardStory>) => {
      const text = result.story.paragraphs.join(' ');
      expect(text).toContain('**James Harden** leads with **5,534** total points');
      expect(text).not.toContain('26,203');
      expect(text).not.toContain('990');
      expect(text).not.toMatch(/total points is/);
      expect(result.facts.map((fact) => fact.id)).toEqual(['top-players:rank:1']);
      expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
    };

    it('ORDER BY … LIMIT in the block SQL', () => {
      expectLedByHarden(buildDeterministicDashboardStory({
        goal: 'Top scorers', filters: { top_n: 5 }, tiles: [tile({ source: { sql: TOP5_SQL }, filters: { top_n: 5 } })],
      }));
    });

    it('a precomputed ordering from the server', () => {
      expectLedByHarden(buildDeterministicDashboardStory({
        goal: 'Top scorers', filters: {},
        tiles: [tile({ ordering: { kind: 'top_n', reason: 'order_limit', orderColumn: 'total_points', direction: 'desc' } })],
      }));
    });

    it('a "Top …" tile title alone', () => {
      expectLedByHarden(buildDeterministicDashboardStory({
        goal: 'Top scorers', filters: {}, tiles: [tile({ title: 'Top Players By Total Points 2016 2017' })],
      }));
    });

    it('rows alone: one per player, sorted by points, five of them', () => {
      expectLedByHarden(buildDeterministicDashboardStory({ goal: 'Top scorers', filters: {}, tiles: [tile({})] }));
    });

    it('a full additive breakdown (points by team, all teams) still sums', () => {
      const teams = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS'];
      const rows = teams.map((team, index) => ({ team, points: 9000 - index * 10 }));
      const total = rows.reduce((sum, row) => sum + row.points, 0);
      const result = buildDeterministicDashboardStory({
        goal: 'Points by team', filters: {},
        tiles: [{
          tileId: 'teams', title: 'Points by team', status: 'ok', trustState: 'certified',
          result: { columns: ['team', 'points'], rows },
          source: { sql: 'SELECT team, SUM(pts) AS points FROM games GROUP BY team ORDER BY points DESC' },
        }],
      });
      expect(result.facts.map((fact) => fact.id)).toEqual(['teams:value:points', 'teams:rank:1']);
      expect(result.facts[0]!.value).toBe(total);
      expect(result.story.paragraphs.join(' ')).toContain(`points is **${total.toLocaleString('en-US')}**`);
      expect(result.facts[1]!.value).toBe('ATL: 9,000');
    });

    it('a small whole-population breakdown whose SQL has no limit still sums', () => {
      const rows = [
        { conference: 'East', points: 410 }, { conference: 'West', points: 395 }, { conference: 'Other', points: 300 },
      ];
      const result = buildDeterministicDashboardStory({
        goal: 'Points by conference', filters: {},
        tiles: [{
          tileId: 'conf', title: 'Points by conference', status: 'ok', trustState: 'certified',
          result: { columns: ['conference', 'points'], rows },
          source: { sql: 'SELECT conference, SUM(pts) AS points FROM games GROUP BY 1 ORDER BY points DESC' },
        }],
      });
      expect(result.facts.find((fact) => fact.id === 'conf:value:points')?.value).toBe(1105);
    });

    it('a LIMIT with no order is a sample: not summed', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Games', filters: {},
        tiles: [{
          tileId: 'sample', title: 'Some games', status: 'ok', trustState: 'certified',
          result: { columns: ['game', 'points'], rows: [{ game: 'g1', points: 100 }, { game: 'g2', points: 120 }] },
          source: { sql: 'SELECT game, points FROM games LIMIT 2' },
        }],
      });
      expect(result.facts.map((fact) => fact.id)).toEqual(['sample:rank:1']);
    });
  });
  describe('clearest signals do not depend on result row order', () => {
    // The commerce-pilot `details` page: one certified Dataset tile grouped
    // by order line with no ORDER BY, so each run returned the same nine rows
    // in a different order and the story named different signals each time.
    const orderLines = [
      { order_line_id: 'OL-001', revenue: 40 },
      { order_line_id: 'OL-002', revenue: 20 },
      { order_line_id: 'OL-003', revenue: null },
      { order_line_id: 'OL-004', revenue: 30 },
      { order_line_id: 'OL-005', revenue: 0 },
      { order_line_id: 'OL-006', revenue: 5 },
      { order_line_id: 'OL-007', revenue: 25 },
      { order_line_id: 'OL-008', revenue: 10 },
      { order_line_id: 'OL-009', revenue: 15 },
    ];
    const pick = (...ids: string[]) => ids.map((id) => orderLines.find((row) => row.order_line_id === id)!);
    const storyFor = (rows: Array<Record<string, unknown>>, extra: { columns?: string[]; limited?: boolean } = {}) => buildDeterministicDashboardStory({
      goal: 'Order line revenue',
      filters: {},
      tiles: [{
        tileId: 'component-2', title: 'revenue by order_line_id', status: 'ok', trustState: 'certified',
        datasetScope: {
          kind: 'grouped_observations', dimensions: ['order_line_id'], outputDimensionAliases: ['order_line_id'], limited: extra.limited ?? false,
        },
        result: {
          columns: extra.columns ?? ['order_line_id', 'revenue'],
          columnsMeta: [{ name: 'revenue', kind: 'currency', unit: 'USD' }],
          rows,
        },
        citation: { kind: 'dataset', name: 'order_lines' },
      }],
    });

    it('tells the same story for the same rows in two different orders', () => {
      // Both orders were observed on consecutive runs of the same page.
      const first = storyFor(pick('OL-009', 'OL-003', 'OL-008', 'OL-004', 'OL-006', 'OL-001', 'OL-007', 'OL-002', 'OL-005'));
      const second = storyFor(pick('OL-001', 'OL-002', 'OL-003', 'OL-005', 'OL-004', 'OL-007', 'OL-006', 'OL-009', 'OL-008'));

      expect(second.story).toEqual(first.story);
      expect(second.facts).toEqual(first.facts);
      expect(first.story.paragraphs[0]).toBe(
        'For the current scope, the clearest signals are revenue by order_line_id — revenue for OL-001 is **$40.00** and revenue by order_line_id — revenue for OL-004 is **$30.00**. '
        + 'These figures come from tiles with this exact filter scope, so the summary and visible results stay aligned when filters change.',
      );
      expect(validateDashboardStoryBrief(first.story, first.facts)).toEqual({ ok: true, errors: [] });
    });

    it('never counts a missing value as a signal, and settles an equal value by the group', () => {
      // OL-010 ties OL-004 for second place; the group, not row position, decides.
      const tied = [...orderLines, { order_line_id: 'OL-010', revenue: 30 }];
      const orders = [tied, [...tied].reverse(), [...tied.slice(4), ...tied.slice(0, 4)]];
      const stories = orders.map((rows) => storyFor(rows));
      for (const result of stories) expect(result.story).toEqual(stories[0]!.story);
      const text = stories[0]!.story.paragraphs.join(' ');
      expect(text).toContain('OL-001 is **$40.00**');
      expect(text).toContain('OL-004 is **$30.00**');
      expect(text).not.toContain('OL-010');

      // With the only other rows missing a value, one signal is all there is.
      const sparse = storyFor(pick('OL-003', 'OL-009'));
      expect(sparse.facts.map((fact) => fact.label)).toEqual(['revenue by order_line_id — revenue for OL-009']);
      expect(sparse.story.paragraphs.join(' ')).not.toMatch(/OL-003|not available/);
    });

    it('ranks by magnitude, so a large loss is a clearer signal than a small gain', () => {
      const result = storyFor([
        { order_line_id: 'OL-001', revenue: 12 },
        { order_line_id: 'OL-002', revenue: -45 },
        { order_line_id: 'OL-003', revenue: 30 },
      ]);
      expect(result.facts.map((fact) => fact.value)).toEqual([-45, 30]);
    });

    it('does not narrate a pivot total row as a group', () => {
      const withTotals = [
        ...orderLines.map((row) => ({ ...row, __total_order_line_id: 0 })),
        { order_line_id: null, revenue: 145, __total_order_line_id: 1 },
      ];
      const result = storyFor([...withTotals].reverse(), { columns: ['order_line_id', 'revenue', '__total_order_line_id'] });
      expect(result.facts.map((fact) => fact.value)).toEqual([40, 30]);
      expect(result.story.paragraphs.join(' ')).not.toMatch(/145|total order line id/);
    });
  });

  it('names the highest value as a tile leader, whatever the row order', () => {
    const leaderFor = (rows: Array<Record<string, unknown>>) => buildDeterministicDashboardStory({
      goal: 'Customer revenue', filters: {},
      tiles: [{
        tileId: 'customers', title: 'Customers', status: 'ok', trustState: 'certified',
        result: { columns: ['customer', 'revenue'], rows },
      }],
    }).facts.find((fact) => fact.kind === 'rank')?.value;
    const rows = [{ customer: 'Cy', revenue: null }, { customer: 'Bob', revenue: 80 }, { customer: 'Alice', revenue: 120 }];
    expect(leaderFor(rows)).toBe('Alice: 120');
    expect(leaderFor([...rows].reverse())).toBe('Alice: 120');
  });

  it('settles a tied leader by its label, whatever the row order (port 7 regression)', () => {
    const leaderFor = (rows: Array<Record<string, unknown>>) => buildDeterministicDashboardStory({
      goal: 'Customer revenue', filters: {},
      tiles: [{ tileId: 'customers', title: 'Customers', status: 'ok', trustState: 'certified', result: { columns: ['customer', 'revenue'], rows } }],
    }).facts.find((fact) => fact.kind === 'rank')?.value;
    const rows = [{ customer: 'Bob', revenue: 120 }, { customer: 'Cy', revenue: 40 }, { customer: 'Alice', revenue: 120 }];
    expect(leaderFor(rows)).toBe('Alice: 120');
    expect(leaderFor([...rows].reverse())).toBe('Alice: 120');
  });

  it('reads a grouped tile its SQL orders and limits in that order, not by magnitude (port 7 regression)', () => {
    // A bottom-3 Dataset tile: ORDER BY revenue ASC LIMIT 3. Its story is the
    // smallest values, as the tile shows them, not the largest of the three.
    const result = buildDeterministicDashboardStory({
      goal: 'Weakest order lines', filters: {},
      tiles: [{
        tileId: 'bottom', title: 'Bottom order lines', status: 'ok', trustState: 'certified',
        source: { sql: 'SELECT order_line_id, SUM(revenue) AS revenue FROM order_lines GROUP BY 1 ORDER BY revenue ASC LIMIT 3' },
        datasetScope: { kind: 'grouped_observations', dimensions: ['order_line_id'], outputDimensionAliases: ['order_line_id'], limited: true },
        result: { columns: ['order_line_id', 'revenue'], rows: [{ order_line_id: 'OL-005', revenue: 0 }, { order_line_id: 'OL-006', revenue: 5 }, { order_line_id: 'OL-008', revenue: 10 }] },
      }],
    });
    expect(result.facts.map((fact) => fact.value)).toEqual([0, 5]);
  });
});
