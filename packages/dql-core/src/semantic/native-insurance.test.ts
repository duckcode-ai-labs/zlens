import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbtProvider, entityJoinSql } from './providers/dbt-provider.js';
import type { SemanticLayer } from './semantic-layer.js';

/**
 * A small insurance book shaped like the ACME P&C project that surfaced these
 * defects: claim money on claim amounts, premium on policy amounts, claims on
 * policies, and a policy/party bridge that has no key column of its own.
 *
 *   policy 1 (Auto): premium 100 + 100, claim 100 (open)   amounts 50 + 30
 *   policy 2 (Home): premium 400,       claim 101 (closed) amount 100
 *                                       claim 102 (open)   amount 20
 *
 * Loss ratio: Auto 80/200 = 0.4, Home 120/400 = 0.3, book 200/600.
 * Amounts 1000 and 1002 are loss payments (the loss_payment subtype table).
 */
const SETUP_SQL = `
CREATE TABLE policy (Policy_Identifier INTEGER, Line_Of_Business VARCHAR);
INSERT INTO policy VALUES (1, 'Auto'), (2, 'Home');
CREATE TABLE policy_amount (Policy_Amount_Identifier INTEGER, Policy_Identifier INTEGER, Policy_Amount DOUBLE);
INSERT INTO policy_amount VALUES (10, 1, 100), (11, 1, 100), (12, 2, 400);
CREATE TABLE claim (Claim_Identifier INTEGER, Policy_Identifier INTEGER, Claim_Status VARCHAR);
INSERT INTO claim VALUES (100, 1, 'open'), (101, 2, 'closed'), (102, 2, 'open');
CREATE TABLE claim_amount (Claim_Amount_Identifier INTEGER, Claim_Identifier INTEGER, Claim_Amount DOUBLE);
INSERT INTO claim_amount VALUES (1000, 100, 50), (1001, 100, 30), (1002, 101, 100), (1003, 102, 20);
CREATE TABLE loss_payment (Claim_Amount_Identifier INTEGER);
INSERT INTO loss_payment VALUES (1000), (1002);
CREATE TABLE agreement_party_role (Agreement_Identifier INTEGER, Party_Identifier INTEGER, Party_Role_Code VARCHAR);
INSERT INTO agreement_party_role VALUES (1, 7, 'PH'), (1, 8, 'AG'), (2, 9, 'PH'), (2, 8, 'AG');
CREATE TABLE policy_agent (Agreement_Identifier INTEGER, Party_Identifier INTEGER);
INSERT INTO policy_agent VALUES (1, 8), (2, 8);
CREATE TABLE policy_coverage (Policy_Identifier INTEGER, Coverage_Code VARCHAR, Limit_Band VARCHAR);
INSERT INTO policy_coverage VALUES (1, 'COLL', 'high'), (1, 'LIAB', 'low'), (2, 'COLL', 'low');
CREATE TABLE coverage_premium (Policy_Identifier INTEGER, Coverage_Code VARCHAR, Premium DOUBLE);
INSERT INTO coverage_premium VALUES (1, 'COLL', 70), (1, 'LIAB', 30), (2, 'COLL', 400);
`;

const SEMANTIC_MANIFEST = {
  semantic_models: [
    {
      name: 'insurance_policies',
      node_relation: { alias: 'policy' },
      entities: [{ name: 'policy', type: 'primary', expr: 'Policy_Identifier' }],
      dimensions: [{ name: 'line_of_business', type: 'categorical', expr: 'Line_Of_Business' }],
      measures: [{ name: 'policy_count', agg: 'count_distinct', expr: 'Policy_Identifier' }],
    },
    {
      name: 'policy_amounts',
      node_relation: { alias: 'policy_amount' },
      entities: [
        { name: 'policy_amount', type: 'primary', expr: 'Policy_Amount_Identifier' },
        { name: 'policy', type: 'foreign', expr: 'Policy_Identifier' },
      ],
      measures: [{ name: 'written_premium', agg: 'sum', expr: 'Policy_Amount' }],
    },
    {
      name: 'insurance_claims',
      node_relation: { alias: 'claim' },
      entities: [
        { name: 'claim', type: 'primary', expr: 'Claim_Identifier' },
        { name: 'policy', type: 'foreign', expr: 'Policy_Identifier' },
      ],
      dimensions: [{ name: 'claim_status', type: 'categorical', expr: 'Claim_Status' }],
      measures: [{ name: 'claim_count', agg: 'count_distinct', expr: 'Claim_Identifier' }],
    },
    {
      name: 'claim_amounts',
      node_relation: { alias: 'claim_amount' },
      entities: [
        { name: 'claim_amount', type: 'primary', expr: 'Claim_Amount_Identifier' },
        { name: 'claim', type: 'foreign', expr: 'Claim_Identifier' },
      ],
      measures: [{ name: 'incurred_losses', agg: 'sum', expr: 'Claim_Amount' }],
    },
    {
      // A subtype table: one row per claim amount that is a loss payment.
      name: 'loss_payments',
      node_relation: { alias: 'loss_payment' },
      entities: [{ name: 'claim_amount', type: 'primary', expr: 'Claim_Amount_Identifier' }],
      dimensions: [{ name: 'is_loss_payment', type: 'categorical', expr: '1' }],
    },
    {
      // A bridge: one row per policy, party and role. No column is its key,
      // so dbt declares the entity at model level.
      name: 'policy_party_role',
      primary_entity: 'party_role_assignment',
      node_relation: { alias: 'agreement_party_role' },
      entities: [{ name: 'policy', type: 'foreign', expr: 'Agreement_Identifier' }],
      dimensions: [{ name: 'party_role', type: 'categorical', expr: 'Party_Role_Code' }],
      measures: [{ name: 'parties_with_role', agg: 'count_distinct', expr: 'Party_Identifier' }],
    },
    {
      // The modeling answer to the bridge: one row per policy (its agent),
      // keyed `unique` by policy so policies stays the primary target.
      name: 'policy_agents',
      primary_entity: 'policy_agent',
      node_relation: { alias: 'policy_agent' },
      entities: [{ name: 'policy', type: 'unique', expr: 'Agreement_Identifier' }],
      dimensions: [{ name: 'agent_party_id', type: 'categorical', expr: 'Party_Identifier' }],
    },
    {
      // A composite key: a coverage is a policy AND a coverage code.
      name: 'coverages',
      node_relation: { alias: 'policy_coverage' },
      entities: [{ name: 'coverage', type: 'primary', expr: "Policy_Identifier || '-' || Coverage_Code" }],
      dimensions: [{ name: 'limit_band', type: 'categorical', expr: 'Limit_Band' }],
    },
    {
      name: 'coverage_premiums',
      node_relation: { alias: 'coverage_premium' },
      entities: [{ name: 'coverage', type: 'foreign', expr: "Policy_Identifier || '-' || Coverage_Code" }],
      measures: [{ name: 'coverage_premium', agg: 'sum', expr: 'Premium' }],
    },
  ],
  metrics: [
    { name: 'incurred_losses', type: 'simple', type_params: { measure: 'incurred_losses' } },
    { name: 'written_premium', type: 'simple', type_params: { measure: 'written_premium' } },
    { name: 'claim_count', type: 'simple', type_params: { measure: 'claim_count' } },
    { name: 'coverage_premium', type: 'simple', type_params: { measure: 'coverage_premium' } },
    {
      // A metric filter on a column of the JOINED claims table.
      name: 'open_claim_losses',
      type: 'simple',
      type_params: { measure: 'incurred_losses' },
      filter: { where_filters: [{ where_sql_template: "{{ Dimension('claim__claim_status') }} = 'open'" }] },
    },
    {
      // The amount kind comes from the subtype table, not an `in (from ...)`.
      name: 'losses_paid',
      type: 'simple',
      type_params: { measure: 'incurred_losses' },
      filter: { where_filters: [{ where_sql_template: "{{ Dimension('claim_amount__is_loss_payment') }} = 1" }] },
    },
    {
      name: 'loss_ratio',
      type: 'ratio',
      type_params: {
        numerator: { name: 'incurred_losses', filter: null, alias: null },
        denominator: { name: 'written_premium', filter: null, alias: null },
      },
    },
    {
      name: 'open_loss_ratio',
      type: 'ratio',
      type_params: {
        numerator: {
          name: 'incurred_losses',
          filter: { where_filters: [{ where_sql_template: "{{ Dimension('claim__claim_status') }} = 'open'" }] },
        },
        denominator: 'written_premium',
      },
    },
    {
      name: 'claim_severity',
      type: 'ratio',
      type_params: { numerator: 'incurred_losses', denominator: 'claim_count' },
    },
    {
      name: 'losses_per_open_claim',
      type: 'ratio',
      type_params: { numerator: 'open_loss_ratio', denominator: 'claim_count' },
    },
    { name: 'premium_growth', type: 'derived', type_params: { expr: 'written_premium * 2', metrics: ['written_premium'] } },
    {
      name: 'premium_growth_mom',
      type: 'derived',
      type_params: {
        expr: '(current_premium - prior_premium) / prior_premium',
        metrics: [
          { name: 'written_premium', alias: 'current_premium' },
          { name: 'written_premium', alias: 'prior_premium', offset_window: '1 month' },
        ],
      },
    },
    {
      name: 'loss_per_claim',
      type: 'derived',
      type_params: { expr: 'incurred_losses / NULLIF(claim_count, 0)', metrics: ['incurred_losses', 'claim_count'] },
    },
    { name: 'unsafe_derived', type: 'derived', type_params: { expr: 'written_premium; DROP TABLE x', metrics: ['written_premium'] } },
  ],
};

const DUCKDB_CLI = spawnSync('duckdb', ['-version'], { encoding: 'utf-8' }).status === 0;

/** Run composed SQL against the fixture book with the duckdb CLI. */
function run(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync('duckdb', ['-json', ':memory:'], {
    input: `${SETUP_SQL}\n${sql};\n`,
    encoding: 'utf-8',
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const out = result.stdout.trim();
  return out ? JSON.parse(out) as Array<Record<string, unknown>> : [];
}

function rounded(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, typeof value === 'number' ? Math.round(value * 10_000) / 10_000 : value])));
}

describe('native semantic engine on an insurance book', () => {
  let root: string;
  let layer: SemanticLayer;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-native-insurance-'));
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify(SEMANTIC_MANIFEST));
    layer = new DbtProvider().load({ provider: 'dbt' }, root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('ratio metrics (loss ratio = losses / premium)', () => {
    it('reports a ratio of two simple metrics as natively composable', () => {
      expect(layer.canComposeMetric('loss_ratio')).toBe(true);
      expect(layer.explainNativeMetricGap('loss_ratio')).toBeUndefined();
    });

    it('divides the sums, per output row, across two fact tables', () => {
      const composed = layer.composeQuery({ metrics: ['loss_ratio'], dimensions: ['line_of_business'], orderBy: [{ name: 'line_of_business', direction: 'asc' }] });
      expect(composed).not.toBeNull();
      // Two facts → one aggregate island each; never a fact-to-fact join.
      expect(composed!.strategy).toBe('aggregate_islands');
      expect(composed!.sql).toContain('1.0 * ratio_inputs.incurred_losses / NULLIF(ratio_inputs.written_premium, 0) AS loss_ratio');
      expect(composed!.sql).toMatch(/ORDER BY line_of_business ASC$/);
      // The islands stay top-level CTEs: SQL Server rejects WITH in a derived table.
      expect(composed!.sql).toMatch(/^WITH metric_1_incurred_losses AS/);
      expect(composed!.sql).toContain('ratio_inputs AS (');
      if (!DUCKDB_CLI) return;
      expect(rounded(run(composed!.sql))).toEqual([
        { line_of_business: 'Auto', loss_ratio: 0.4 },
        { line_of_business: 'Home', loss_ratio: 0.3 },
      ]);
    });

    it('computes the book-level ratio, not an average of ratios', () => {
      const composed = layer.composeQuery({ metrics: ['loss_ratio', 'written_premium'], dimensions: [] });
      expect(composed).not.toBeNull();
      if (!DUCKDB_CLI) return;
      expect(rounded(run(composed!.sql))).toEqual([{ loss_ratio: 0.3333, written_premium: 600 }]);
    });

    it('applies a filter the ratio puts on its numerator, and only there', () => {
      const composed = layer.composeQuery({ metrics: ['open_loss_ratio'], dimensions: ['line_of_business'], orderBy: [{ name: 'open_loss_ratio', direction: 'desc' }] });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toContain("insurance_claims.Claim_Status = 'open'");
      if (!DUCKDB_CLI) return;
      expect(rounded(run(composed!.sql))).toEqual([
        { line_of_business: 'Auto', open_loss_ratio: 0.4 },
        { line_of_business: 'Home', open_loss_ratio: 0.05 },
      ]);
    });

    it('composes a same-model style ratio across claims and claim amounts', () => {
      const composed = layer.composeQuery({ metrics: ['claim_severity'], dimensions: [] });
      expect(composed).not.toBeNull();
      if (!DUCKDB_CLI) return;
      expect(rounded(run(composed!.sql))).toEqual([{ claim_severity: 66.6667 }]);
    });

    it('refuses a ratio whose side is itself a ratio, and says why', () => {
      expect(layer.composeQuery({ metrics: ['losses_per_open_claim'], dimensions: [] })).toBeNull();
      expect(layer.canComposeMetric('losses_per_open_claim')).toBe(false);
      expect(layer.explainNativeMetricGap('losses_per_open_claim')).toContain('open_loss_ratio is not one');
      expect(layer.explainNativeMetricGap('premium_growth_mom')).toContain('derived metric');
    });

    it('never leaks its request-scoped numerator into the catalog', () => {
      layer.composeQuery({ metrics: ['open_loss_ratio'], dimensions: [] });
      expect(layer.getMetric('open_loss_ratio__numerator')).toBeUndefined();
      expect(layer.canComposeMetric('open_loss_ratio__numerator')).toBe(false);
    });
  });

  describe('derived metrics (arithmetic over simple metrics)', () => {
    it('composes a derived metric over one simple input', () => {
      expect(layer.canComposeMetric('premium_growth')).toBe(true);
      expect(layer.explainNativeMetricGap('premium_growth')).toBeUndefined();
      const composed = layer.composeQuery({ metrics: ['premium_growth'], dimensions: [] });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toContain('ratio_inputs.written_premium * 2 AS premium_growth');
      if (!DUCKDB_CLI) return;
      expect(run(composed!.sql)).toEqual([{ premium_growth: 1200 }]);
    });

    it('evaluates the expression per output row over inputs from two fact tables', () => {
      const composed = layer.composeQuery({ metrics: ['loss_per_claim'], dimensions: ['line_of_business'], orderBy: [{ name: 'line_of_business', direction: 'asc' }] });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toContain('ratio_inputs.incurred_losses / NULLIF(ratio_inputs.claim_count, 0) AS loss_per_claim');
      if (!DUCKDB_CLI) return;
      const inputs = run(layer.composeQuery({ metrics: ['incurred_losses', 'claim_count'], dimensions: ['line_of_business'], orderBy: [{ name: 'line_of_business', direction: 'asc' }] })!.sql);
      expect(rounded(run(composed!.sql))).toEqual(rounded(inputs.map((row) => ({
        line_of_business: row.line_of_business,
        loss_per_claim: Number(row.incurred_losses) / Number(row.claim_count),
      }))));
    });

    it('refuses an offset window or an expression that is not arithmetic, and says why', () => {
      expect(layer.composeQuery({ metrics: ['premium_growth_mom'], dimensions: [] })).toBeNull();
      expect(layer.canComposeMetric('premium_growth_mom')).toBe(false);
      expect(layer.explainNativeMetricGap('premium_growth_mom')).toContain('no offset window');
      expect(layer.composeQuery({ metrics: ['unsafe_derived'], dimensions: [] })).toBeNull();
      expect(layer.canComposeMetric('unsafe_derived')).toBe(false);
    });
  });

  describe('metric filters on a joined table', () => {
    it('joins the claims table a claim-amount metric filters on', () => {
      const composed = layer.composeQuery({ metrics: ['open_claim_losses'], dimensions: [] });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toContain('LEFT JOIN claim AS insurance_claims ON claim_amounts.Claim_Identifier = insurance_claims.Claim_Identifier');
      expect(composed!.sql).toContain("insurance_claims.Claim_Status = 'open'");
      if (!DUCKDB_CLI) return;
      expect(run(composed!.sql)).toEqual([{ open_claim_losses: 100 }]);
    });

    it('still groups by a further joined dimension', () => {
      const composed = layer.composeQuery({ metrics: ['open_claim_losses'], dimensions: ['line_of_business'], orderBy: [{ name: 'line_of_business', direction: 'asc' }] });
      expect(composed).not.toBeNull();
      if (!DUCKDB_CLI) return;
      expect(run(composed!.sql)).toEqual([
        { line_of_business: 'Auto', open_claim_losses: 80 },
        { line_of_business: 'Home', open_claim_losses: 20 },
      ]);
    });
  });

  describe('subtype tables keyed by the same entity', () => {
    it('joins a subtype one-to-one and reads its flag as "this row exists"', () => {
      const composed = layer.composeQuery({ metrics: ['losses_paid'], dimensions: [] });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toContain('LEFT JOIN loss_payment AS loss_payments ON claim_amounts.Claim_Amount_Identifier = loss_payments.Claim_Amount_Identifier');
      expect(composed!.sql).toContain('CASE WHEN loss_payments.Claim_Amount_Identifier IS NOT NULL THEN 1 END = 1');
      if (!DUCKDB_CLI) return;
      // 50 + 100, never all four amounts (a constant `1 = 1` would sum 200).
      expect(run(composed!.sql)).toEqual([{ losses_paid: 150 }]);
    });

    it('groups by the subtype flag with NULL for amounts that are not loss payments', () => {
      const composed = layer.composeQuery({
        metrics: ['incurred_losses'],
        dimensions: ['claim_amount__is_loss_payment'],
        orderBy: [{ name: 'claim_amount__is_loss_payment', direction: 'asc' }],
      });
      expect(composed).not.toBeNull();
      if (!DUCKDB_CLI) return;
      expect(run(composed!.sql)).toEqual([
        { is_loss_payment: 1, incurred_losses: 150 },
        { is_loss_payment: null, incurred_losses: 50 },
      ]);
    });
  });

  describe('claim money through a policy/party bridge', () => {
    it('refuses a bridge dimension for a claim metric, and says why', () => {
      expect(layer.composeQuery({ metrics: ['incurred_losses'], dimensions: ['party_role_assignment__party_role'] })).toBeNull();
      const gap = layer.explainDimensionGap(['incurred_losses'], 'party_role_assignment__party_role');
      expect(gap).toContain('insurance_policies → policy_party_role');
      expect(gap).toContain('one row per insurance_policies');
      // The same answer for a ratio: its inputs are what reach the dimension.
      expect(layer.explainDimensionGap(['loss_ratio'], 'party_role')).toContain('policy_party_role');
      // A reachable dimension has no gap to explain.
      expect(layer.explainDimensionGap(['incurred_losses'], 'line_of_business')).toBeUndefined();
    });

    it('does not list a bridge dimension as compatible with a claim metric', () => {
      const { compatible, incompatible } = layer.explainCompatibleDimensions(['incurred_losses']);
      expect(compatible.find((dimension) => dimension.name === 'party_role')).toBeUndefined();
      expect(incompatible.find((dimension) => dimension.name === 'party_role')?.reason).toBe('one_to_many_only');
      // Every dimension compatibility offers is one the composer accepts.
      for (const dimension of compatible) {
        expect(layer.composeQuery({ metrics: ['incurred_losses'], dimensions: [dimension.qualifiedName ?? dimension.name] }), dimension.name).not.toBeNull();
      }
    });

    it('reaches the agent through a one-row-per-policy model keyed by policy', () => {
      // Policies stay the target of every foreign `policy` entity.
      expect(layer.getCube('insurance_claims')!.joins.map((join) => join.right)).toEqual(['insurance_policies']);
      // Named as MetricFlow names it: two hops, `policy` spelled once.
      const compatible = layer.explainCompatibleDimensions(['incurred_losses']).compatible;
      expect(compatible.find((dimension) => dimension.name === 'agent_party_id')?.qualifiedName).toBe('claim__policy__agent_party_id');
      expect(compatible.find((dimension) => dimension.name === 'is_loss_payment')?.qualifiedName).toBe('claim_amount__is_loss_payment');
      const composed = layer.composeQuery({ metrics: ['incurred_losses'], dimensions: ['agent_party_id'] });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toContain('LEFT JOIN policy_agent AS policy_agents ON insurance_policies.Policy_Identifier = policy_agents.Agreement_Identifier');
      if (!DUCKDB_CLI) return;
      expect(run(composed!.sql)).toEqual([{ agent_party_id: 8, incurred_losses: 200 }]);
    });
  });

  it('blames the one-to-many step, not a one-to-one join before it', () => {
    // Registration order puts the reverse copy of the claims ↔ claim_coverage
    // one-to-one join first in the adjacency list, as it was on the real
    // insurance project, where the message blamed claims → claim_coverages.
    const manifest = {
      semantic_models: [
        { name: 'claim_coverages', node_relation: { alias: 'claim_coverage' }, primary_entity: 'claim_coverage',
          entities: [{ name: 'claim', type: 'unique', expr: 'Claim_Identifier' }, { name: 'policy', type: 'foreign', expr: 'Policy_Identifier' }] },
        { name: 'claims', node_relation: { alias: 'claim' }, entities: [{ name: 'claim', type: 'primary', expr: 'Claim_Identifier' }] },
        { name: 'claim_amounts', node_relation: { alias: 'claim_amount' },
          entities: [{ name: 'claim_amount', type: 'primary', expr: 'Claim_Amount_Identifier' }, { name: 'claim', type: 'foreign', expr: 'Claim_Identifier' }],
          measures: [{ name: 'losses', agg: 'sum', expr: 'Claim_Amount' }] },
        { name: 'policies', node_relation: { alias: 'policy' }, entities: [{ name: 'policy', type: 'primary', expr: 'Policy_Identifier' }] },
        { name: 'party_roles', node_relation: { alias: 'agreement_party_role' }, primary_entity: 'party_role',
          entities: [{ name: 'policy', type: 'foreign', expr: 'Agreement_Identifier' }],
          dimensions: [{ name: 'role_code', type: 'categorical', expr: 'Party_Role_Code' }] },
      ],
      metrics: [{ name: 'losses', type: 'simple', type_params: { measure: 'losses' } }],
    };
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify(manifest));
    const bridged = new DbtProvider().load({ provider: 'dbt' }, root);
    expect(bridged.composeQuery({ metrics: ['losses'], dimensions: ['role_code'] })).toBeNull();
    const gap = bridged.explainDimensionGap(['losses'], 'role_code');
    expect(gap).toContain('policies → party_roles');
    expect(gap).not.toContain('claims → claim_coverages');
  });

  describe('model-level primary_entity', () => {
    it('qualifies the dimensions of a keyless bridge by its declared primary entity', () => {
      const partyRole = layer.listDimensions(undefined, { includeVariants: true }).find((dimension) => dimension.name === 'party_role');
      expect(partyRole?.qualifiedName).toBe('party_role_assignment__party_role');
      expect(partyRole?.entityLink).toBe('party_role_assignment');
    });

    it('composes with the MetricFlow spelling of that dimension', () => {
      const composed = layer.composeQuery({ metrics: ['parties_with_role'], dimensions: ['party_role_assignment__party_role'] });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toContain('Party_Role_Code AS party_role');
    });
  });

  describe('composite entity keys', () => {
    it('qualifies every column of an expression key on its own side', () => {
      const coveragePremiums = layer.getCube('coverage_premiums')!;
      expect(coveragePremiums.joins[0]!.sql).toBe(
        "${left}.Policy_Identifier || '-' || ${left}.Coverage_Code = ${right}.Policy_Identifier || '-' || ${right}.Coverage_Code",
      );
      const composed = layer.composeQuery({ metrics: ['coverage_premium'], dimensions: ['limit_band'], orderBy: [{ name: 'limit_band', direction: 'asc' }] });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toContain(
        "ON coverage_premiums.Policy_Identifier || '-' || coverage_premiums.Coverage_Code = coverages.Policy_Identifier || '-' || coverages.Coverage_Code",
      );
      if (!DUCKDB_CLI) return;
      expect(run(composed!.sql)).toEqual([
        { limit_band: 'high', coverage_premium: 70 },
        { limit_band: 'low', coverage_premium: 430 },
      ]);
    });

    it('pairs a column-list key position by position', () => {
      expect(entityJoinSql('Policy_Identifier, Coverage_Code', 'Policy_Identifier, Coverage_Code')).toBe(
        '${left}.Policy_Identifier = ${right}.Policy_Identifier AND ${left}.Coverage_Code = ${right}.Coverage_Code',
      );
      expect(entityJoinSql('coalesce(a, b)', 'id')).toBe('coalesce(${left}.a, ${left}.b) = ${right}.id');
      expect(entityJoinSql('a, b', 'id')).toBeNull();
      expect(entityJoinSql('location_id', 'location_id')).toBe('${left}.location_id = ${right}.location_id');
    });
  });

  describe('order_by', () => {
    it('orders by an entity-qualified dimension reference', () => {
      const composed = layer.composeQuery({
        metrics: ['written_premium'],
        dimensions: ['policy__line_of_business'],
        orderBy: [{ name: 'policy__line_of_business', direction: 'desc' }],
      });
      expect(composed).not.toBeNull();
      expect(composed!.sql).toMatch(/ORDER BY line_of_business DESC$/);
      if (!DUCKDB_CLI) return;
      expect(run(composed!.sql).map((row) => row.line_of_business)).toEqual(['Home', 'Auto']);
    });
  });
});
