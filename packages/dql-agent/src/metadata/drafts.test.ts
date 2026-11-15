import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parse } from '@zlens/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { withSignedInOwner } from './identity.js';
import { automaticAskDraftState, clearAutomaticAskDrafts, deriveGeneratedDraftSlug, deriveReviewDraftSlug, deriveSemanticDraftName, draftQuestionKey, listAutomaticAskDrafts, upsertGeneratedDqlArtifactDraft, upsertGeneratedDraft, upsertReviewRequiredAnswerDraft } from './drafts.js';

describe('generated draft blocks', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-generated-draft-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'drafts' }), 'utf-8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes parseable DQL with flat Tier-2 review metadata', () => {
    const draft = upsertGeneratedDraft(projectRoot, {
      slug: 'enterprise_revenue_by_week',
      question: 'Break revenue down by Enterprise week',
      proposedSql: `
        SELECT week_start, SUM(revenue) AS revenue
        FROM main.revenue_events
        WHERE segment = 'Enterprise'
        GROUP BY 1
      `,
      proposedContractId: 'finance.Revenue.enterprise_revenue_by_week',
      proposedDomain: 'finance',
      proposedEntity: 'Revenue',
      upstreamRefs: ['revenue_total'],
      sourceDqlArtifact: {
        kind: 'semantic_block',
        name: 'certified_revenue_by_week',
        sourcePath: 'semantic-layer/blocks/revenue/certified_revenue_by_week.dql',
        source: 'block "certified_revenue_by_week" {\n  type = "semantic"\n  metric = "revenue"\n}',
        metrics: ['revenue'],
        dimensions: ['week'],
        filters: [
          { dimension: 'segment', operator: 'equals', values: ['Enterprise'] },
          { dimension: 'week', operator: 'equals', values: ['last week'] },
        ],
        timeDimension: { name: 'week', granularity: 'week' },
        orderBy: [{ name: 'revenue', direction: 'desc' }],
        limit: 10,
      },
      sourceQuestion: 'What was revenue last week?',
      sourceBlock: 'revenue_total',
      followupKind: 'drilldown',
      requestedFilters: ['Enterprise', 'last week'],
      requestedDimensions: ['week'],
      outputs: ['week_start', 'revenue'],
      contextPackId: 'ctx_test',
      routeIntent: 'entity_drilldown',
      validationWarnings: ['review_required'],
    });

    const source = readFileSync(join(projectRoot, draft.path), 'utf-8');

    expect(source).toContain('// Tier-2 generated proposal');
    expect(source).not.toContain('# Tier-2');
    expect(source).toContain('outputs = ["week_start", "revenue"]');
    expect(source).toContain('source_dql_kind = "semantic_block"');
    expect(source).toContain('source_dql_name = "certified_revenue_by_week"');
    expect(source).toContain('source_dql_path = "semantic-layer/blocks/revenue/certified_revenue_by_week.dql"');
    expect(source).toMatch(/source_dql_hash = "[a-f0-9]{64}"/);
    expect(source).toContain('source_dql_metrics = ["revenue"]');
    expect(source).toContain('source_dql_dimensions = ["week"]');
    expect(source).toContain('source_dql_filters = ["segment=Enterprise", "week=last week"]');
    expect(source).toContain('source_dql_time_dimension = "week"');
    expect(source).toContain('source_dql_granularity = "week"');
    expect(source).toContain('source_dql_order_by = ["revenue desc"]');
    expect(source).toContain('source_dql_limit = 10');
    expect(() => parse(source)).not.toThrow();

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((diagnostic) => diagnostic.kind === 'parse')).toEqual([]);
    expect(manifest.blocks.enterprise_revenue_by_week?.declaredOutputs).toEqual(['week_start', 'revenue']);
    expect(manifest.blocks.enterprise_revenue_by_week?.draftMetadata).toMatchObject({
      sourceQuestion: 'What was revenue last week?',
      sourceBlock: 'revenue_total',
      sourceDqlKind: 'semantic_block',
      sourceDqlName: 'certified_revenue_by_week',
      sourceDqlPath: 'semantic-layer/blocks/revenue/certified_revenue_by_week.dql',
      sourceDqlHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceDqlMetrics: ['revenue'],
      sourceDqlDimensions: ['week'],
      sourceDqlFilters: ['segment=Enterprise', 'week=last week'],
      sourceDqlTimeDimension: 'week',
      sourceDqlGranularity: 'week',
      sourceDqlOrderBy: ['revenue desc'],
      sourceDqlLimit: 10,
      followupKind: 'drilldown',
      requestedFilters: ['Enterprise', 'last week'],
      requestedDimensions: ['week'],
      contextPackId: 'ctx_test',
      routeIntent: 'entity_drilldown',
      askedTimes: 1,
      validationWarnings: ['review_required'],
    });
  });

  it('writes generated drafts under the domain-first draft folder when the domain exists', () => {
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const draft = upsertGeneratedDraft(projectRoot, {
      slug: 'enterprise_revenue_by_week',
      question: 'Break revenue down by Enterprise week',
      proposedSql: 'SELECT 1 AS revenue',
      proposedContractId: 'finance.Revenue.enterprise_revenue_by_week',
      proposedDomain: 'finance',
      proposedEntity: 'Revenue',
    });

    expect(draft.path).toBe('domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql');

    const source = readFileSync(join(projectRoot, draft.path), 'utf-8');
    expect(source).toContain('zlens certify --from-draft domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql');
    expect(() => parse(source)).not.toThrow();

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.blocks.enterprise_revenue_by_week?.filePath).toBe(draft.path);
    expect(manifest.blocks.enterprise_revenue_by_week?.draftMetadata?.askedTimes).toBe(1);
  });

  it('persists semantic DQL artifacts without wrapping them as custom SQL drafts', () => {
    const draft = upsertGeneratedDqlArtifactDraft(projectRoot, {
      slug: 'monthly_revenue_by_channel',
      question: 'Show monthly revenue by channel',
      proposedContractId: 'finance.Unknown.monthly_revenue_by_channel',
      proposedDomain: 'finance',
      dqlArtifact: {
        kind: 'semantic_block',
        source: `block "monthly_revenue_by_channel" {
  status = "draft"
  domain = "finance"
  type = "semantic"
  description = "Show monthly revenue by channel"
  metric = "total_revenue"
  dimensions = ["channel"]
  time_dimension = "order_date"
  granularity = "month"
}`,
        metrics: ['total_revenue'],
        dimensions: ['channel'],
      },
      contextPackId: 'ctx_semantic',
      routeIntent: 'ad_hoc_breakdown',
      outputs: ['channel', 'order_date_month', 'total_revenue'],
      validationWarnings: ['semantic_draft_review_required'],
    });

    const source = readFileSync(join(projectRoot, draft.path), 'utf-8');

    expect(source).toContain('type = "semantic"');
    expect(source).toContain('metric = "total_revenue"');
    expect(source).toContain('dimensions = ["channel"]');
    expect(source).toContain('owner = "');
    expect(source).toContain('asked_times = 1');
    expect(source).toContain('context_pack_id = "ctx_semantic"');
    expect(source).toContain('outputs = ["channel", "order_date_month", "total_revenue"]');
    expect(source).toContain('validation_warnings = ["semantic_draft_review_required"]');
    expect(source).not.toContain('type = "custom"');
    expect(source).not.toContain('query = """');
    expect(() => parse(source)).not.toThrow();

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((diagnostic) => diagnostic.kind === 'parse')).toEqual([]);
    expect(manifest.blocks.monthly_revenue_by_channel?.filePath).toBe(draft.path);
    expect(manifest.blocks.monthly_revenue_by_channel?.draftMetadata?.askedTimes).toBe(1);
  });
});

describe('semantic draft naming (spec 14, part D)', () => {
  const QUESTION = 'Can you build the total orders by geography at the daily level?';

  it('never names a block after the literal question', () => {
    const name = deriveSemanticDraftName({ question: QUESTION });
    expect(name).not.toBe(deriveGeneratedDraftSlug(QUESTION));
    expect(name).not.toContain('can_you_build');
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('rule-based extraction yields entity + key dimension + grain', () => {
    const name = deriveSemanticDraftName({ question: QUESTION });
    expect(name).toBe('orders_by_geography_daily');
  });

  it('prefers a valid provider-suggested snake_case name', () => {
    const name = deriveSemanticDraftName({
      question: QUESTION,
      providerName: 'orders_by_region_daily',
    });
    expect(name).toBe('orders_by_region_daily');
  });

  it('coerces a loosely-formatted provider name into snake_case', () => {
    const name = deriveSemanticDraftName({
      question: QUESTION,
      providerName: 'Orders By Region',
    });
    expect(name).toBe('orders_by_region');
  });

  it('dedupes against existing slugs', () => {
    const name = deriveSemanticDraftName({
      question: QUESTION,
      providerName: 'orders_by_region_daily',
      existingSlugs: ['orders_by_region_daily'],
    });
    expect(name).toBe('orders_by_region_daily_2');
  });

  it('falls back to the legacy tokenizer only when no entity is recognizable', () => {
    const question = 'Give me a widget breakdown by sprocket';
    const name = deriveSemanticDraftName({ question });
    // No recognized entity → legacy tokenizer, but still valid + deduped.
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(name.length).toBeGreaterThan(0);
  });
});

describe('review-required answer drafts (graduated trust, Tier 2)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-review-draft-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'drafts' }), 'utf-8');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  const sql = 'SELECT team_id, SUM(wins) AS total_wins FROM team_season_facts WHERE season = 2017 GROUP BY team_id ORDER BY total_wins DESC LIMIT 1';
  const artifact = { kind: 'sql_block', name: 'which_team_had_the_most_wins_in_season_2017', source: `block "which_team_had_the_most_wins_in_season_2017" {\n  type = "custom"\n  status = "certified"\n  description = "Which team had the most wins in season 2017?"\n  query = """\n    ${sql}\n  """\n}` };

  it('leaves one durable, parseable draft that is never certified', () => {
    const saved = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Which team had the most wins in season 2017?', sql, dqlArtifact: artifact, owner: 'analyst@example.com', runId: 'run-1' });
    expect(saved).toMatchObject({ created: true, askedTimes: 1 });
    expect(saved.path).toMatch(/^blocks\/_drafts\/.+\.dql$/);
    const source = readFileSync(join(projectRoot, saved.path), 'utf-8');
    expect(source).toContain('status = "draft"');
    expect(source).not.toContain('status = "certified"');
    expect(source).toContain(`answer_fingerprint = "${saved.fingerprint}"`);
    expect(source).toContain('source_run_id = "run-1"');
    expect(() => parse(source, saved.path)).not.toThrow();
  });

  it('de-duplicates repeats by answer fingerprint and by question, bumping asked_times', () => {
    const first = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Which team had the most wins in season 2017?', sql, dqlArtifact: artifact });
    // The same answer SQL asked in other words, with different spacing and case.
    const reworded = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Top team by wins, 2017 season', sql: sql.toLowerCase().replace(/ /g, '  ') });
    expect(reworded).toMatchObject({ created: false, path: first.path, askedTimes: 2, fingerprint: first.fingerprint });
    // The same question with different SQL keeps one draft per question.
    const sameQuestion = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Which team had the most wins in season 2017?', sql: 'SELECT 1' });
    expect(sameQuestion).toMatchObject({ created: false, path: first.path, askedTimes: 3 });
    expect(readFileSync(join(projectRoot, first.path), 'utf-8')).toContain('asked_times = 3');
    expect(readdirSync(join(projectRoot, 'blocks', '_drafts')).filter((name) => name.endsWith('.dql'))).toHaveLength(1);
    expect(existsSync(join(projectRoot, first.path))).toBe(true);
  });

  describe('the Ask draft from the recording (average order value at each store)', () => {
    const question = 'What is the average order value at each store?';
    const aovSql = 'SELECT l.location_id, l.location_name, SUM(o.order_total) / COUNT(*) AS average_order_value FROM "jaffle_shop"."dev"."orders" AS o JOIN "jaffle_shop"."dev"."locations" AS l ON o.location_id = l.location_id GROUP BY l.location_id, l.location_name';
    // The AI names the transient artifact after its restatement of the question.
    const aiName = 'for_each_jaffle_shop_location_store_the_average_';
    const aovArtifact = { kind: 'sql_block', name: aiName, source: `block "${aiName}" {\n  type = "custom"\n  status = "draft"\n  description = "For each Jaffle Shop location (store), the average order value"\n  query = """\n    ${aovSql}\n  """\n}` };
    const domain = (id: string, sourceSystems: string[]) => {
      mkdirSync(join(projectRoot, 'domains', id), { recursive: true });
      writeFileSync(join(projectRoot, 'domains', id, 'domain.dql'), `domain "${id}" {\n  id = "${id}"\n  owner = "analytics@jaffle.shop"\n  sourceSystems = [${sourceSystems.map((system) => `"${system}"`).join(', ')}]\n}\n`);
    };

    it('names the block after the draft id and proposes the one Domain its tables belong to', () => {
      domain('commerce', ['dbt:orders', 'dbt:order_items', 'dbt:locations']);
      domain('marketing', ['dbt:campaigns']);
      const saved = upsertReviewRequiredAnswerDraft(projectRoot, { question, sql: aovSql, dqlArtifact: aovArtifact });
      expect(saved.path).toBe('domains/commerce/blocks/_drafts/average_order_value_each_store.dql');
      const source = readFileSync(join(projectRoot, saved.path), 'utf-8');
      expect(source).toMatch(/^block "average_order_value_each_store" \{/);
      expect(source).not.toContain(aiName);
      expect(source).toMatch(/^\s*domain = "commerce"$/m);
      expect(source).toContain('proposed_domain = "commerce"');
      expect(() => parse(source, saved.path)).not.toThrow();
    });

    it('proposes no Domain when the tables span Domains or one is in none', () => {
      domain('commerce', ['dbt:orders']);
      domain('stores', ['dbt:locations']);
      const spans = upsertReviewRequiredAnswerDraft(projectRoot, { question, sql: aovSql, dqlArtifact: aovArtifact });
      expect(spans.path).toBe('blocks/_drafts/average_order_value_each_store.dql');
      const source = readFileSync(join(projectRoot, spans.path), 'utf-8');
      expect(source).toMatch(/^block "average_order_value_each_store" \{/);
      expect(source).not.toMatch(/^\s*domain\s*=/m);
      expect(source).toContain('proposed_domain = ""');
    });
  });

  it('MCP query_via_metadata drafts share the fingerprint, so an Ask repeat reuses them', () => {
    const mcp = upsertGeneratedDraft(projectRoot, { slug: 'top_team_wins', question: 'Top team by wins in 2017', proposedSql: sql, proposedContractId: 'nba.Team.top_team_wins' });
    const ask = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Which team had the most wins in season 2017?', sql });
    expect(ask).toMatchObject({ created: false, path: mcp.path, askedTimes: 2 });
  });
});

describe('fewer automatic Ask drafts (V13)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-ask-drafts-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'drafts' }), 'utf-8');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));
  const draftFiles = (dir = join(projectRoot, 'blocks', '_drafts')) => existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.dql')) : [];

  it('names a draft with its question word and cuts the name only between words', () => {
    expect(deriveReviewDraftSlug('How many teams are there?')).toBe('how_many_teams');
    expect(deriveReviewDraftSlug('How many points did LeBron James score in the 2012 playoffs?')).toBe('how_many_points_lebron_james_score_2012_playoffs');
    const long = deriveReviewDraftSlug('Help a Warriors fan see how the Golden State Warriors did in each season from 2014 to 2018: regular-season wins and losses, and playoff wins, shown separately.');
    expect(long.length).toBeLessThanOrEqual(80);
    // Every part of the name is a whole word of the question.
    for (const part of long.split('_')) expect(` help warriors fan see how golden state each season 2014 2018 regular wins losses playoff shown separately `).toContain(` ${part} `);
  });

  it('keeps one draft for the same question asked again, even when its tables propose another Domain', () => {
    mkdirSync(join(projectRoot, 'domains', 'nba'), { recursive: true });
    writeFileSync(join(projectRoot, 'domains', 'nba', 'domain.dql'), 'domain "nba" {\n  id = "nba"\n  owner = "a@b.c"\n  sourceSystems = ["team_game_facts"]\n}\n');
    const first = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'How many games did the Warriors win in 2015?', sql: 'SELECT COUNT(*) FROM team_game_facts WHERE season = 2015' });
    expect(first.path).toBe('domains/nba/blocks/_drafts/how_many_games_warriors_win_2015.dql');
    const again = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'how many games did the warriors win in 2015', sql: 'SELECT COUNT(*) FROM other_facts WHERE yr = 2015' });
    expect(again).toMatchObject({ created: false, path: first.path, askedTimes: 2 });
    expect(draftFiles()).toHaveLength(0);
    // Nobody changed the draft, so it holds the newer answer.
    expect(readFileSync(join(projectRoot, first.path), 'utf-8')).toContain('other_facts');
  });

  it('a draft a person edited keeps their work: a repeat only counts the ask, and Clear drafts leaves it', () => {
    const saved = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Which team won the most games in 2016?', sql: 'SELECT team, COUNT(*) AS wins FROM games GROUP BY team' });
    const file = join(projectRoot, saved.path);
    expect(automaticAskDraftState(readFileSync(file, 'utf-8'))).toBe('untouched');
    writeFileSync(file, readFileSync(file, 'utf-8').replace('COUNT(*) AS wins', 'COUNT(*) AS games_won'));
    expect(automaticAskDraftState(readFileSync(file, 'utf-8'))).toBe('edited');
    const again = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Which team won the most games in 2016?', sql: 'SELECT 2' });
    expect(again).toMatchObject({ created: false, path: saved.path, askedTimes: 2 });
    expect(readFileSync(file, 'utf-8')).toContain('games_won');
    expect(clearAutomaticAskDrafts(projectRoot)).toEqual({ removed: [], kept: 1 });
    expect(existsSync(file)).toBe(true);
  });

  it('Clear drafts removes only automatic drafts nobody changed, never a saved query a person wrote', () => {
    const untouched = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'How many teams are there?', sql: 'SELECT COUNT(*) FROM teams' });
    const asked = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'How many games are in our data?', sql: 'SELECT COUNT(*) FROM games' });
    upsertReviewRequiredAnswerDraft(projectRoot, { question: 'How many games are in our data', sql: 'select count(*) from games' });
    const certified = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'How many players are there?', sql: 'SELECT COUNT(*) FROM players' });
    const certifiedFile = join(projectRoot, certified.path);
    writeFileSync(certifiedFile, readFileSync(certifiedFile, 'utf-8').replace('status = "draft"', 'status = "certified"'));
    const mine = join(projectRoot, 'blocks', '_drafts', 'my_own_query.dql');
    writeFileSync(mine, 'block "my_own_query" {\n  type = "custom"\n  status = "draft"\n  query = """\n    SELECT 1\n  """\n}\n');
    expect(listAutomaticAskDrafts(projectRoot).map((draft) => [draft.path, draft.state]).sort()).toEqual([
      [asked.path, 'untouched'], [certified.path, 'edited'], [untouched.path, 'untouched'],
    ].sort());
    const cleared = clearAutomaticAskDrafts(projectRoot);
    expect(cleared.removed.sort()).toEqual([asked.path, untouched.path].sort());
    expect(cleared.kept).toBe(1);
    expect(draftFiles().sort()).toEqual(['how_many_players.dql', 'my_own_query.dql']);
  });

  it('a draft from before the check counts as unchanged only while its file is as Ask last wrote it', () => {
    const legacy = join(projectRoot, 'blocks', '_drafts', 'many_teams.dql');
    mkdirSync(join(projectRoot, 'blocks', '_drafts'), { recursive: true });
    const stamped = '2026-11-01T10:00:00.000Z';
    writeFileSync(legacy, `block "many_teams" {\n  type = "custom"\n  status = "draft"\n  asked_times = 3\n  last_asked = "${stamped}"\n  answer_fingerprint = "abc"\n  query = """\n    SELECT 1\n  """\n}\n`);
    utimesSync(legacy, new Date(stamped), new Date(Date.parse(stamped) + 2_000));
    expect(listAutomaticAskDrafts(projectRoot)).toMatchObject([{ path: 'blocks/_drafts/many_teams.dql', state: 'untouched', askedTimes: 3 }]);
    utimesSync(legacy, new Date(stamped), new Date(Date.parse(stamped) + 3_600_000));
    expect(listAutomaticAskDrafts(projectRoot)).toMatchObject([{ state: 'edited' }]);
  });

  it('never takes over a saved query a person wrote under the same name', () => {
    mkdirSync(join(projectRoot, 'blocks', '_drafts'), { recursive: true });
    const mine = join(projectRoot, 'blocks', '_drafts', 'how_many_teams.dql');
    const original = 'block "how_many_teams" {\n  type = "custom"\n  status = "draft"\n  query = """\n    SELECT 30\n  """\n}\n';
    writeFileSync(mine, original);
    const saved = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'How many teams?', sql: 'SELECT COUNT(*) FROM teams' });
    expect(saved).toMatchObject({ created: true, path: 'blocks/_drafts/how_many_teams_2.dql' });
    expect(readFileSync(mine, 'utf-8')).toBe(original);
    expect(() => parse(readFileSync(join(projectRoot, saved.path), 'utf-8'), saved.path)).not.toThrow();
  });
});

describe('a question asked again keeps one draft, whatever its reading said (V14, from the V13 retest: 38 to 45 drafts)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-ask-repeat-drafts-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'drafts' }), 'utf-8');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));
  const draftFiles = (dir = join(projectRoot, 'blocks', '_drafts')) => existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.dql')) : [];

  it('reads "the same question" by its words: case, punctuation and possessives aside', () => {
    expect(draftQuestionKey("How many games did the Warriors' win?")).toBe(draftQuestionKey('how many games did the warriors win'));
    expect(draftQuestionKey("Which team's arena is the biggest?")).toBe('which team arena is the biggest');
  });

  it('a repeat filed under a differently worded reading and other SQL finds the draft by the asked words, and counts the ask', () => {
    const asked = 'Which teams did Kevin Durant play for, and in which seasons?';
    const first = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'List the teams Kevin Durant played for in each season, from his player-season records', askedQuestion: asked, sql: 'SELECT season, team FROM player_games GROUP BY 1, 2' });
    expect(first.created).toBe(true);
    const again = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Teams and seasons Kevin Durant played in, by team nickname', askedQuestion: 'which teams did kevin durant play for and in which seasons', sql: 'SELECT s.season, t.nickname FROM games s JOIN teams t ON t.id = s.team GROUP BY 1, 2' });
    expect(again).toMatchObject({ created: false, path: first.path, askedTimes: 2 });
    expect(draftFiles()).toHaveLength(1);
    // Nobody changed the draft, so it holds the newer answer and the words it was asked in.
    const content = readFileSync(join(projectRoot, first.path), 'utf-8');
    expect(content).toContain('source_question = "which teams did kevin durant play for and in which seasons"');
    expect(content).toContain('t.nickname');
    expect(() => parse(content, first.path)).not.toThrow();
    // Asked a third time in the first words, it is still the one draft.
    expect(upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Durant teams by season', askedQuestion: asked, sql: 'SELECT 3' })).toMatchObject({ created: false, path: first.path, askedTimes: 3 });
  });

  it('the same SQL asked in other words still reuses its draft, and another question gets its own', () => {
    const first = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Home win percent', askedQuestion: 'What percentage of games does the home team win?', sql: 'SELECT AVG(home_win) FROM games' });
    expect(upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Share of home wins', askedQuestion: 'How often does the home team win?', sql: 'select avg(home_win)  from games' })).toMatchObject({ created: false, path: first.path, askedTimes: 2 });
    expect(upsertReviewRequiredAnswerDraft(projectRoot, { question: 'Away win percent', askedQuestion: 'What percentage of games does the away team win?', sql: 'SELECT AVG(1 - home_win) FROM games' }).created).toBe(true);
    expect(draftFiles()).toHaveLength(2);
  });
});

describe('V2: one draft per name, and its owner in the app for Snowflake (tester V14 retest, listing retake F4)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-ask-v2-drafts-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'drafts', identity: { owner: 'zlens@local' } }), 'utf-8');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));
  const question = 'How many games did the Toronto Raptors win in the 2018 regular season?';
  const slug = deriveReviewDraftSlug(question);

  it('a draft of the same name in another drafts folder is the one answered again, and the answer counts the ask', () => {
    // Saved before under the nba Domain, named for the same words, with the reading of that time as its question.
    const old = join(projectRoot, 'domains', 'nba', 'blocks', '_drafts', `${slug}.dql`);
    mkdirSync(join(projectRoot, 'domains', 'nba', 'blocks', '_drafts'), { recursive: true });
    writeFileSync(old, `block "${slug}" {\n  type = "custom"\n  status = "draft"\n  owner = "zlens@local"\n  asked_times = 2\n  last_asked = "2026-11-13T10:00:00.000Z"\n  answer_fingerprint = "abc"\n  source_question = "Count the Raptors wins in 2018, based on the team-season win totals"\n  query = """\n    SELECT 58\n  """\n}\n`);
    const again = upsertReviewRequiredAnswerDraft(projectRoot, { question, askedQuestion: question, sql: 'SELECT SUM(win) FROM team_game_facts WHERE season = 2018' });
    expect(again).toMatchObject({ created: false, path: `domains/nba/blocks/_drafts/${slug}.dql`, askedTimes: 3 });
    expect(existsSync(join(projectRoot, 'blocks', '_drafts', `${slug}.dql`))).toBe(false);
  });

  it('a new draft never takes a name a saved query already has in another drafts folder', () => {
    mkdirSync(join(projectRoot, 'domains', 'nba', 'blocks', '_drafts'), { recursive: true });
    const mine = join(projectRoot, 'domains', 'nba', 'blocks', '_drafts', `${slug}.dql`);
    writeFileSync(mine, `block "${slug}" {\n  type = "custom"\n  status = "draft"\n  query = """\n    SELECT 58\n  """\n}\n`);
    const saved = upsertReviewRequiredAnswerDraft(projectRoot, { question, sql: 'SELECT 58' });
    expect(saved).toMatchObject({ created: true, path: `blocks/_drafts/${slug}_2.dql` });
  });

  it('in the app for Snowflake a draft is owned by the signed-in user, or by nobody, never by the container ("zlens@local")', () => {
    const signedIn = withSignedInOwner('ANALYST', () => upsertReviewRequiredAnswerDraft(projectRoot, { question, sql: 'SELECT 58' }));
    expect(readFileSync(join(projectRoot, signedIn.path), 'utf-8')).toMatch(/^\s*owner = "ANALYST"$/m);
    const nobody = withSignedInOwner(undefined, () => upsertReviewRequiredAnswerDraft(projectRoot, { question: 'How many teams are there?', sql: 'SELECT 30' }));
    const content = readFileSync(join(projectRoot, nobody.path), 'utf-8');
    expect(content).not.toContain('@local');
    expect(content).toMatch(/^\s*owner = ""$/m);
    // Outside the app, the project's owner as before.
    const local = upsertReviewRequiredAnswerDraft(projectRoot, { question: 'How many players are there?', sql: 'SELECT 2611' });
    expect(readFileSync(join(projectRoot, local.path), 'utf-8')).toContain('owner = "zlens@local"');
  });
});
