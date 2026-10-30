import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  candidateToDqlSource,
  clearBlockStudioImportSessions,
  createBlockStudioImportSession,
  deleteBlockStudioImportSession,
  listBlockStudioImportSessions,
  loadBlockStudioImportSession,
  parameterizeSqlForDqlImport,
  updateBlockStudioImportCandidate,
} from './block-studio-import.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-import-'));
  tempDirs.push(dir);
  return dir;
}

describe('Block Studio SQL import', () => {
  it('parameterizes reusable season and top-N filters for AI import drafts', () => {
    const sql = `
SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) IN (2016, 2017)
GROUP BY player_name
ORDER BY total_points DESC
LIMIT 5
`;

    const parameterized = parameterizeSqlForDqlImport(sql);
    const source = candidateToDqlSource({
      name: 'Top NBA Scorers',
      domain: 'player_performance',
      description: 'Ranks NBA players by total points for a selected season range.',
      owner: 'analytics',
      tags: ['nba', 'players'],
      pattern: 'ranking',
      grain: 'player_name',
      entities: ['Player'],
      outputs: ['player_name', 'total_points'],
      allowedFilters: parameterized.allowedFilters,
      parameterPolicy: parameterized.parameterPolicy,
      filterBindings: parameterized.filterBindings,
      parameterDecisions: parameterized.parameterDecisions,
      sourceSystems: ['TRANSFORMED'],
      replacementFor: [],
      sql: parameterized.sql,
      llmContext: 'Use after review for top NBA scorer questions.',
    });

    expect(parameterized.sql).toContain('${season_start}');
    expect(parameterized.sql).toContain('${season_end}');
    expect(parameterized.sql).toContain('${top_n}');
    expect(parameterized.sql).toContain('EXTRACT(YEAR FROM game_date_est) BETWEEN ${season_start} AND ${season_end}');
    expect(parameterized.sql).not.toContain('IN (${season_start}, ${season_end})');
    expect(parameterized.parameterPolicy).toEqual(expect.arrayContaining([
      { name: 'season_start', policy: 'dynamic' },
      { name: 'season_end', policy: 'dynamic' },
      { name: 'top_n', policy: 'dynamic' },
    ]));
    expect(parameterized.filterBindings).toEqual([{ filter: 'season_range', binding: 'game_date_est.year' }]);
    expect(source).toContain('parameterPolicy {');
    expect(source).toContain('filterBindings {');
    expect(source).toContain('params {');
    expect(source).toContain('season_start = 2016');
    expect(source).toContain('top_n = 5');
  });

  it('infers ranking pattern after LIMIT is parameterized', () => {
    const parameterized = parameterizeSqlForDqlImport(`
SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) IN (2016, 2017)
GROUP BY player_name
ORDER BY total_points DESC
LIMIT 5
`);

    const source = candidateToDqlSource({
      name: 'Top NBA Scorers',
      domain: 'player_performance',
      description: 'Ranks NBA players by total points for a selected season range.',
      owner: 'analytics',
      tags: ['nba', 'players'],
      grain: 'player_name',
      outputs: ['player_name', 'total_points'],
      allowedFilters: parameterized.allowedFilters,
      parameterPolicy: parameterized.parameterPolicy,
      filterBindings: parameterized.filterBindings,
      parameterDecisions: parameterized.parameterDecisions,
      sourceSystems: ['TRANSFORMED'],
      replacementFor: [],
      sql: parameterized.sql,
      llmContext: 'Use after review for top NBA scorer questions.',
    });

    expect(parameterized.sql).toContain('LIMIT ${top_n}');
    expect(source).toContain('pattern = "ranking"');
  });

  it('keeps non-contiguous year lists as explicit selected-set parameters', () => {
    const parameterized = parameterizeSqlForDqlImport(`
select player_name, sum(pts) as total_points
from TRANSFORMED.int_player_stats
where extract(year from game_date_est) in (2016, 2018)
group by player_name
`);

    expect(parameterized.sql).toMatch(/in\s*\(\$\{season_year_2016\},\s*\$\{season_year_2018\}\)/i);
    expect(parameterized.sql).not.toContain('BETWEEN ${season_start} AND ${season_end}');
    expect(parameterized.parameterPolicy).toEqual(expect.arrayContaining([
      { name: 'season_year_2016', policy: 'dynamic' },
      { name: 'season_year_2018', policy: 'dynamic' },
    ]));
    expect(parameterized.filterBindings).toEqual([{ filter: 'season_set', binding: 'game_date_est.year' }]);
    expect(parameterized.allowedFilters).toEqual(expect.arrayContaining(['season_set', 'season_year_2016', 'season_year_2018']));
  });

  it('parameterizes runtime selected-set filters as array-backed business params', () => {
    const parameterized = parameterizeSqlForDqlImport(`
select player_name, team_abbreviation, sum(pts) as total_points
from TRANSFORMED.int_player_stats
where team_abbreviation in ('LAL', 'BOS')
group by player_name, team_abbreviation
`);

    expect(parameterized.sql).toContain('team_abbreviation IN (${team_abbreviation_set})');
    expect(parameterized.parameterDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'team_abbreviation_set',
        policy: 'dynamic',
        valueType: 'set',
        value: ['LAL', 'BOS'],
      }),
    ]));
    expect(parameterized.filterBindings).toEqual([{ filter: 'team_abbreviation_set', binding: 'team_abbreviation' }]);

    const source = candidateToDqlSource({
      name: 'Scoring By Team Set',
      domain: 'player_performance',
      description: 'Ranks scoring for a selected team set.',
      owner: 'analytics',
      tags: ['nba'],
      pattern: 'ranking',
      grain: 'player_name',
      entities: ['Player'],
      outputs: ['player_name', 'team_abbreviation', 'total_points'],
      allowedFilters: parameterized.allowedFilters,
      parameterPolicy: parameterized.parameterPolicy,
      filterBindings: parameterized.filterBindings,
      parameterDecisions: parameterized.parameterDecisions,
      sourceSystems: ['TRANSFORMED'],
      replacementFor: [],
      sql: parameterized.sql,
      llmContext: 'Use for selected-team scoring questions.',
    });

    expect(source).toContain('team_abbreviation_set = ["LAL", "BOS"]');
    expect(source).toContain('team_abbreviation_set = "dynamic"');
  });

  it('parameterizes date BETWEEN filters as reusable date ranges', () => {
    const parameterized = parameterizeSqlForDqlImport(`
select player_name, sum(pts) as total_points
from TRANSFORMED.int_player_stats
where game_date_est between '2016-10-01' and '2017-06-30'
group by player_name
`);

    expect(parameterized.sql).toContain('game_date_est BETWEEN ${start_date} AND ${end_date}');
    expect(parameterized.parameterPolicy).toEqual(expect.arrayContaining([
      { name: 'start_date', policy: 'dynamic' },
      { name: 'end_date', policy: 'dynamic' },
    ]));
    expect(parameterized.filterBindings).toEqual([{ filter: 'date_range', binding: 'game_date_est' }]);
    expect(parameterized.allowedFilters).toEqual(expect.arrayContaining(['date_range', 'start_date', 'end_date']));
  });

  it('preserves optional parameter policies in generated DQL', () => {
    const source = candidateToDqlSource({
      name: 'Player Scoring By Team',
      domain: 'player_performance',
      description: 'Ranks player scoring with an optional team filter.',
      owner: 'analytics',
      tags: ['nba', 'players'],
      pattern: 'ranking',
      grain: 'player_name',
      entities: ['Player'],
      outputs: ['player_name', 'total_points'],
      dimensions: ['team_name'],
      allowedFilters: ['team'],
      parameterPolicy: [{ name: 'team', policy: 'optional' }],
      filterBindings: [{ filter: 'team', binding: 'team_name' }],
      parameterDecisions: [],
      sourceSystems: ['TRANSFORMED'],
      replacementFor: [],
      sql: 'SELECT player_name, SUM(pts) AS total_points FROM TRANSFORMED.int_player_stats WHERE (${team} IS NULL OR team_name = ${team}) GROUP BY player_name',
      llmContext: 'Use the team parameter only when the question asks for one team.',
    });

    expect(source).toContain('team = "optional"');
    expect(source).toContain('dimensions = ["team_name"]');
    expect(source).not.toContain('team = "ambiguous_review_required"');
  });

  it('previews a single SQL file as a local block candidate', () => {
    const root = tempProject();
    writeFileSync(join(root, 'revenue.sql'), `-- name: revenue by region
-- description: Revenue by region from legacy BI
-- domain: finance
-- tags: dashboard, migration
select region, sum(revenue) as total_revenue
from marts.orders
group by region;
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'revenue.sql',
      domain: 'finance',
      owner: 'analytics',
    });

    expect(session.candidates).toHaveLength(1);
    const candidate = session.candidates[0];
    expect(candidate.sourceKind).toBe('raw-sql-file');
    expect(candidate.name).toBe('Revenue By Region');
    expect(candidate.domain).toBe('finance');
    expect(candidate.owner).toBe('analytics');
    expect(candidate.description).toBe('Revenue by region from legacy BI');
    expect(candidate.tags).toEqual(['imported', 'raw-sql', 'dashboard', 'migration']);
    expect(candidate.lineage.sourceTables).toEqual(['marts.orders']);
    expect(candidate.dqlSource).toContain('block "Revenue By Region"');
    expect(candidate.dqlSource).toContain('status = "draft"');
    expect(candidate.dqlSource).toContain('query = """');
    expect(candidate.reviewStatus).toBe('draft');
    expect(candidate.conversionNotes?.[0]).toMatch(/Deterministic SQL extraction/);
    expect(readFileSync(join(root, '.dql', 'imports', session.id, 'manifest.json'), 'utf-8')).toContain(candidate.id);
  });

  it('splits multi-statement SQL without breaking semicolons inside strings', () => {
    const root = tempProject();
    writeFileSync(join(root, 'legacy.sql'), `
select 'a;b' as label, count(*) as n from raw.events;
select region, count(*) as n from raw.accounts group by region;
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'legacy.sql',
      domain: 'ops',
    });

    expect(session.candidates).toHaveLength(2);
    expect(session.candidates[0].sql).toContain("'a;b'");
    expect(session.candidates[0].lineage.sourceTables).toEqual(['raw.events']);
    expect(session.candidates[1].lineage.sourceTables).toEqual(['raw.accounts']);
    expect(session.candidates[0].lineage.totalStatements).toBe(2);
  });

  it('splits SQL Server style GO batches', () => {
    const root = tempProject();
    writeFileSync(join(root, 'legacy-go.sql'), `
select count(*) as n from raw.events
GO
select region, count(*) as n from raw.accounts group by region
go
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'legacy-go.sql',
      domain: 'ops',
    });

    expect(session.candidates).toHaveLength(2);
    expect(session.candidates[0].lineage.sourceTables).toEqual(['raw.events']);
    expect(session.candidates[1].lineage.sourceTables).toEqual(['raw.accounts']);
    expect(session.candidates[0].splitStrategy).toBe('semicolon-go');
  });

  it('keeps the name header of a query that follows a GO line and a blank line', () => {
    const root = tempProject();
    writeFileSync(join(root, 'batches.sql'), 'select count(*) as n from raw.events\nGO\n\n-- name: Account regions\nselect region, count(*) as n from raw.accounts group by region\nGO\n');
    const session = createBlockStudioImportSession(root, { inputPath: 'batches.sql', domain: 'ops' });
    expect(session.candidates[1].name).toBe('Account Regions');
  });

  it('infers useful metadata for pasted analytical SQL without comments', () => {
    const root = tempProject();
    const session = createBlockStudioImportSession(root, {
      inputMode: 'paste',
      sources: [{
        path: 'pasted.sql',
        content: `
select
  player_name,
  sum(coalesce(pts, 0)) as total_points,
  count(distinct details_game_id) as games_played
from TRANSFORMED.int_player_stats
where extract(year from game_date_est) = 2017
  and player_name is not null
group by player_name
order by total_points desc
limit 3;
`,
      }],
    });

    const candidate = session.candidates[0];
    expect(candidate.name).toBe('Top Players By Total Points 2017');
    expect(candidate.description).toBe('Ranks players by total points for 2017 using TRANSFORMED.int_player_stats, including games played.');
    expect(candidate.tags).toEqual(expect.arrayContaining(['transformed', 'player', 'stats', 'total', 'points', '2017']));
    expect(candidate.dqlSource).toContain('block "Top Players By Total Points 2017"');
    expect(candidate.dqlSource).toContain('pattern = "ranking"');
    expect(candidate.dqlSource).toContain('grain = "player_name"');
    expect(candidate.dqlSource).toContain('outputs = ["player_name", "total_points", "games_played"]');
    expect(candidate.dqlSource).toContain('allowedFilters = ["game_date_est", "player_name"]');
    expect(candidate.dqlSource).toContain('sourceSystems = ["transformed"]');
  });

  it('splits named query sections without semicolons', () => {
    const root = tempProject();
    writeFileSync(join(root, 'named-sections.sql'), `
-- name: active customers
select * from raw.customers
-- title: account revenue
with account_revenue as (
  select account_id, sum(amount) as revenue from raw.orders group by account_id
)
select * from account_revenue
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'named-sections.sql',
      domain: 'customer',
    });

    expect(session.candidates).toHaveLength(2);
    expect(session.candidates[0].name).toBe('Active Customers');
    expect(session.candidates[1].name).toBe('Account Revenue');
    expect(session.candidates[0].splitStrategy).toBe('metadata-comment');
    expect(session.candidates[0].lineage.totalStatements).toBe(2);
    expect(session.candidates[0].lineage.sourceTables).toEqual(['raw.customers']);
  });

  it('makes one draft of the same query found twice, and lists the copy as left out', () => {
    const root = tempProject();
    mkdirSync(join(root, 'legacy'));
    writeFileSync(join(root, 'legacy', '01_monthly_revenue.sql'), "-- name: Monthly revenue\nselect date_trunc('month', ordered_at) as order_month, sum(order_total) as revenue\nfrom dev.orders\ngroup by 1\norder by 1\n");
    writeFileSync(join(root, 'legacy', '06_copy.sql'), "SELECT DATE_TRUNC('month', ordered_at) AS order_month,\n       SUM(order_total)  AS revenue\nFROM dev.orders\nGROUP BY 1\nORDER BY 1;\n");
    const session = createBlockStudioImportSession(root, { inputPath: 'legacy', domain: 'finance' });
    expect(session.candidates.map((candidate) => candidate.name)).toEqual(['Monthly Revenue']);
    expect(session.skippedStatements).toEqual([expect.objectContaining({
      sourcePath: 'legacy/06_copy.sql',
      kind: 'duplicate',
      reason: 'Same query as "Monthly Revenue" (legacy/01_monthly_revenue.sql).',
    })]);
    expect(loadBlockStudioImportSession(root, session.id).skippedStatements).toHaveLength(1);
  });

  it('names a query from the comment above it, keeps name headers out of descriptions, and numbers only names that repeat', () => {
    const root = tempProject();
    writeFileSync(join(root, 'finance_pack.sql'), `-- name: Store revenue for a period
select l.location_name, sum(o.order_total) as revenue
from dev.orders o join dev.locations l on l.location_id = o.location_id
group by 1;

-- Average order value per customer type
select c.customer_type, avg(o.order_total) as avg_order_value
from dev.orders o join dev.customers c on c.customer_id = o.customer_id
group by 1;

select product_type, count(*) as items_sold from dev.products group by 1;
select product_type, count(*) as items_sold from dev.products where is_food_item group by 1;
`);
    const session = createBlockStudioImportSession(root, { inputPath: 'finance_pack.sql', domain: 'finance' });
    expect(session.candidates.map((candidate) => candidate.name)).toEqual([
      'Store Revenue For A Period',
      'Average Order Value Per Customer Type',
      'Items Sold By Product Type',
      'Items Sold By Product Type 2',
    ]);
    expect(session.candidates[0].description).not.toMatch(/name:/i);
    expect(session.candidates[0].description).toBe('Calculates revenue by location name using dev.orders, dev.locations.');
    expect(session.candidates[1].description).toBe('Calculates avg order value by customer type using dev.orders, dev.customers.');
  });

  it('turns a report parameter with no value into a required parameter and one with a DECLARE value into a default', () => {
    const root = tempProject();
    writeFileSync(join(root, 'params.sql'), `DECLARE @since date = '2024-01-01'
SELECT l.location_name, SUM(o.order_total) AS revenue
FROM [dev].[orders] AS o
JOIN [dev].[locations] AS l ON l.location_id = o.location_id
WHERE o.ordered_at >= @since AND l.location_name = <Parameters.Store>
GROUP BY l.location_name
`);
    const session = createBlockStudioImportSession(root, { inputPath: 'params.sql', domain: 'finance' });
    expect(session.candidates).toHaveLength(1);
    const candidate = session.candidates[0];
    expect(candidate.splitStrategy).toBe('statement-start');
    expect(candidate.lineage.sourceTables).toEqual(['dev.orders', 'dev.locations']);
    expect(candidate.sql).toContain('o.ordered_at >= ${since} AND l.location_name = ${store}');
    expect(candidate.dqlSource).toContain('since = "2024-01-01"');
    expect(candidate.dqlSource).toContain('store: string');
    expect(candidate.warnings.join(' ')).toMatch(/<Parameters\.Store> became the parameter store\. Give it a default value/);
  });

  it('warns when one candidate likely contains several undelimited scripts', () => {
    const root = tempProject();
    writeFileSync(join(root, 'missing-delimiters.sql'), 'select * from raw.events select * from raw.accounts');

    const session = createBlockStudioImportSession(root, {
      inputPath: 'missing-delimiters.sql',
      domain: 'ops',
    });

    expect(session.candidates).toHaveLength(1);
    expect(session.candidates[0].warnings.join(' ')).toMatch(/multiple SELECT\/WITH clauses/i);
  });

  it('drops comment-only fragments after a trailing semicolon', () => {
    const root = tempProject();
    writeFileSync(join(root, 'availability.sql'), `
with games_details_summary as (
  select count(*) as total_records from NBA_GAMES.RAW.GAMES_DETAILS
),
final_summary as (
  select total_records from games_details_summary
)
select * from final_summary
order by total_records;
-- Order by dataset name for clarity
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'availability.sql',
      domain: 'quality',
    });

    expect(session.candidates).toHaveLength(1);
    expect(session.candidates[0].lineage.sourceTables).toEqual(['NBA_GAMES.RAW.GAMES_DETAILS']);
    expect(session.candidates[0].lineage.totalStatements).toBe(1);
  });

  it('imports every SQL file in a folder and reloads the persisted session', () => {
    const root = tempProject();
    mkdirSync(join(root, 'queries'));
    writeFileSync(join(root, 'queries', 'a.sql'), 'select * from source_a;');
    writeFileSync(join(root, 'queries', 'b.sql'), 'select * from source_b;');

    const session = createBlockStudioImportSession(root, {
      inputPath: 'queries',
      domain: 'shared reporting',
    });
    const reloaded = loadBlockStudioImportSession(root, session.id);

    expect(reloaded.sourceKind).toBe('raw-sql-folder');
    expect(reloaded.candidates.map((candidate) => candidate.lineage.sourceTables[0]).sort()).toEqual(['source_a', 'source_b']);
    expect(reloaded.defaults.domain).toBe('shared-reporting');
  });

  it('creates sessions from pasted or uploaded SQL sources and lists summaries', () => {
    const root = tempProject();
    const session = createBlockStudioImportSession(root, {
      inputMode: 'paste',
      sources: [{ path: 'manual.sql', content: 'select * from raw.events; select * from raw.accounts;' }],
      domain: 'ops',
    });
    const summaries = listBlockStudioImportSessions(root);

    expect(session.inputMode).toBe('paste');
    expect(session.sourceFiles).toEqual(['manual.sql']);
    expect(session.candidates).toHaveLength(2);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].candidateCount).toBe(2);
  });

  it('deletes one import session or clears all import history', () => {
    const root = tempProject();
    const first = createBlockStudioImportSession(root, {
      inputMode: 'paste',
      sources: [{ path: 'first.sql', content: 'select * from first_table;' }],
    });
    createBlockStudioImportSession(root, {
      inputMode: 'paste',
      sources: [{ path: 'second.sql', content: 'select * from second_table;' }],
    });

    expect(listBlockStudioImportSessions(root)).toHaveLength(2);
    deleteBlockStudioImportSession(root, first.id);
    expect(listBlockStudioImportSessions(root)).toHaveLength(1);
    expect(clearBlockStudioImportSessions(root)).toBe(1);
    expect(listBlockStudioImportSessions(root)).toHaveLength(0);
  });

  it('detects parameters and refreshes generated DQL when a candidate is updated', () => {
    const root = tempProject();
    writeFileSync(join(root, 'parameterized.sql'), "select ':not_a_param' as label, * from orders where region = :region and dt >= {{ start_date }};");
    const session = createBlockStudioImportSession(root, { inputPath: 'parameterized.sql' });

    expect(session.candidates[0].lineage.parameters.sort()).toEqual(['region', 'start_date']);
    const updated = updateBlockStudioImportCandidate(root, session.id, session.candidates[0].id, {
      name: 'Orders Filtered',
      domain: 'sales',
      sql: 'select * from orders where region = :region;',
    });

    expect(updated.name).toBe('Orders Filtered');
    expect(updated.domain).toBe('sales');
    expect(updated.dqlSource).toContain('block "Orders Filtered"');
    expect(updated.lineage.parameters).toEqual(['region']);
  });

  it('generates a valid DQL block shape from a candidate', () => {
    const source = candidateToDqlSource({
      name: 'Legacy Query',
      domain: 'finance',
      description: 'Imported legacy SQL',
      owner: 'owner',
      tags: ['imported', 'raw-sql'],
      sql: 'select * from finance.orders',
    });

    expect(source).toContain('domain = "finance"');
    expect(source).toContain('tags = ["imported", "raw-sql"]');
    expect(source).toContain('pattern = "custom"');
    expect(source).toContain('sourceSystems = ["finance"]');
    expect(source).toContain('visualization {');
    expect(source).toContain('chart = "table"');
  });
});

describe('LIKE/ILIKE filter parameterization (auto filter pickup)', () => {
  it('parameterizes an ILIKE member filter as a dynamic runtime input', () => {
    const parameterized = parameterizeSqlForDqlImport(
      "SELECT customer_name, SUM(amount) AS revenue FROM orders WHERE customer_name ILIKE '%Capital One%' GROUP BY customer_name",
    );
    expect(parameterized.sql).toContain('customer_name ILIKE ${customer_name}');
    const param = parameterized.parameterDecisions.find((decision) => decision.name === 'customer_name');
    expect(param?.policy).toBe('dynamic');
    expect(param?.value).toBe('%Capital One%');
  });

  it('leaves NOT LIKE and non-scope columns untouched', () => {
    const parameterized = parameterizeSqlForDqlImport(
      "SELECT * FROM orders WHERE note NOT LIKE '%test%' AND internal_flag LIKE 'x%'",
    );
    expect(parameterized.sql).toContain("note NOT LIKE '%test%'");
    expect(parameterized.sql).toContain("internal_flag LIKE 'x%'");
  });
});

describe('candidateToDqlSource — never emits an unrunnable empty query', () => {
  const base = {
    name: 'dod_bic_bcm_by_customer',
    domain: 'commerce',
    description: 'Percent DOD BIC BCM by customer.',
    owner: '',
    tags: ['ai-generated'],
    terms: [],
    pattern: '',
    grain: '',
    entities: [],
    outputs: ['customer_name', 'percent_dod_bic_bcm'],
    dimensions: ['customer_name'],
    allowedFilters: [],
    parameterPolicy: [],
    filterBindings: [],
    parameterDecisions: [],
    sourceSystems: [],
    replacementFor: [],
    reviewCadence: '',
    llmContext: '',
  };

  it('omits the query section when the semantic route produced no SQL', () => {
    // A semantic answer has metrics/dimensions and no generated SQL. Emitting
    // `query = """ """` produced a custom block that could never execute.
    const source = candidateToDqlSource({ ...base, sql: '' });
    expect(source).not.toContain('query = """');
    expect(source).toContain('dimensions = ["customer_name"]');
  });

  it('still emits the query section when there is SQL', () => {
    const source = candidateToDqlSource({ ...base, sql: 'SELECT 1 AS value' });
    expect(source).toContain('query = """');
    expect(source).toContain('SELECT 1 AS value');
  });
});
