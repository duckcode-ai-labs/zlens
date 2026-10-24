import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parse } from '@zlens/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { deriveGeneratedDraftSlug, deriveSemanticDraftName, upsertGeneratedDqlArtifactDraft, upsertGeneratedDraft, upsertReviewRequiredAnswerDraft } from './drafts.js';

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
