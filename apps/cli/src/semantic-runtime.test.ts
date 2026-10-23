import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWarehouseTargetIdentity, DbtProvider, SemanticLayer } from '@zlens/core';
import { physicalRelationBinding } from '@zlens/agent';
import { saveTestedSemanticRuntimeSettings } from './semantic-runtime-settings.js';
import {
  assertMetricFlowAskTarget,
  assertDbtCloudMetricInventory,
  compileSemanticRuntimeQuery,
  describeRuntimeCompatibility,
  getSemanticRuntimeStatus,
  normalizeSemanticRuntimeQueryRequest,
  semanticRuntimeAdapterSupportsHaving,
  semanticMetricExecutionCapability,
  selectSemanticRuntimeAdapters,
} from './semantic-runtime.js';
import { managedMetricFlowBin } from './metricflow.js';

let root: string;
let priorMfBin: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-semantic-runtime-'));
  priorMfBin = process.env.ZLENS_METRICFLOW_BIN;
  process.env.ZLENS_METRICFLOW_BIN = join(root, 'missing-mf');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (priorMfBin === undefined) delete process.env.ZLENS_METRICFLOW_BIN;
  else process.env.ZLENS_METRICFLOW_BIN = priorMfBin;
});

function layer(): SemanticLayer {
  return new SemanticLayer({
    metrics: [
      { name: 'revenue', label: 'Revenue', description: '', domain: 'sales', sql: 'SUM(amount)', type: 'sum', table: 'orders' },
      { name: 'revenue_ratio', label: 'Revenue ratio', description: '', domain: 'sales', sql: 'revenue_ratio', type: 'custom', table: '', metricType: 'ratio' },
      {
        name: 'previous_day_revenue',
        label: 'Previous day revenue',
        description: '',
        domain: 'sales',
        sql: 'previous_day_revenue',
        type: 'custom',
        table: '',
        metricType: 'derived',
        typeParams: {
          metrics: [{ name: 'revenue', offset_window: { count: 1, granularity: 'day' } }],
        },
      },
    ],
    dimensions: [],
  });
}

function askMetricFlowTarget(
  selectedDatabase: string,
  profileDatabase: string,
  options: { preserveConfiguredSpelling?: boolean } = {},
) {
  const targetFingerprint = `ask-target:${selectedDatabase}`;
  const target = (database: string, connectionRef: string) => {
    const identity = createWarehouseTargetIdentity({
      connectionRef,
      driver: 'snowflake',
      dialect: 'snowflake',
      redactedContext: {
        account: 'ACME-PROD',
        database,
        schema: 'SEMANTIC',
        role: 'ANALYST',
        warehouse: 'REPORTING',
      },
    });
    return options.preserveConfiguredSpelling
      ? { ...identity, redactedContext: { ...identity.redactedContext, database } }
      : identity;
  };
  return {
    snapshotId: 'snapshot:ask-selected-target',
    executionTargetFingerprint: targetFingerprint,
    selectedExecutionTarget: target(selectedDatabase, `connection:${selectedDatabase}`),
    physicalBindings: [physicalRelationBinding({
      logicalRelation: 'PUBLIC.ORDERS',
      physicalRelation: `${selectedDatabase}.PUBLIC.ORDERS`,
      driver: 'snowflake',
      snapshotId: 'snapshot:ask-selected-target',
      executionTargetFingerprint: targetFingerprint,
      source: 'warehouse_probe',
      columns: [{ name: 'AMOUNT', type: 'NUMBER' }],
      columnCompleteness: 'complete',
    })],
    profileTarget: {
      expectedTarget: target(profileDatabase, `profile:${profileDatabase}`),
      profileName: 'office',
      targetName: 'default',
      profilesPath: '/redacted/profiles.yml',
    },
  };
}

describe('shared semantic runtime selector', () => {
  it('AGT-013/SEC-004 locks automatic execution to the selected adapter', () => {
    expect(selectSemanticRuntimeAdapters(undefined, 'dbt-cloud')).toEqual(['dbt-cloud']);
    expect(selectSemanticRuntimeAdapters(undefined, 'metricflow-cli')).toEqual(['metricflow-cli']);
    expect(selectSemanticRuntimeAdapters(undefined, 'native')).toEqual(['native']);
    expect(selectSemanticRuntimeAdapters('native', 'dbt-cloud')).toEqual(['native']);
  });

  it('AGT-014 keeps an unavailable explicit adapter selected instead of silently downgrading', async () => {
    const { saveSemanticRuntimePreference } = await import('./semantic-runtime-settings.js');
    saveSemanticRuntimePreference(root, 'metricflow-cli');
    const status = await getSemanticRuntimeStatus(root);
    expect(status.active).toBe('metricflow-cli');
    expect(status.adapters.find((adapter) => adapter.id === 'metricflow-cli')?.ready).toBe(false);
    await expect(compileSemanticRuntimeQuery({ metrics: ['revenue'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: {},
      semanticLayer: layer(),
    })).rejects.toMatchObject({ code: 'SEMANTIC_RUNTIME_REQUIRED' });
  });

  it('API-004 rejects a local metric absent from the persisted dbt Cloud compiler inventory', () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'secret',
      },
    }, {
      ok: true,
      message: 'Catalog verified',
      dialect: 'snowflake',
      metricCount: 1,
      metricNames: ['revenue'],
      semanticCatalogFingerprint: 'cloud-catalog',
      metricInventoryComplete: true,
    }, createWarehouseTargetIdentity({
      connectionRef: 'connection:test',
      driver: 'snowflake',
      redactedContext: { account: 'acme', database: 'analytics', schema: 'semantic' },
    }));

    expect(() => assertDbtCloudMetricInventory(root, ['revenue_ratio'])).toThrow(
      expect.objectContaining({ code: 'SEMANTIC_SOURCE_DRIFT' }),
    );
    expect(semanticMetricExecutionCapability('revenue_ratio', layer(), 'dbt', {
      preference: 'dbt-cloud',
      active: 'dbt-cloud',
      setup: null,
      adapters: [],
    }, root)).toMatchObject({
      status: 'requires_setup',
      engine: 'dbt-cloud',
      reasonCode: 'SEMANTIC_SOURCE_DRIFT',
      semanticCatalogFingerprint: 'cloud-catalog',
    });
  });

  it('API-004/AGT-001 adds metric_time at the offset grain without overriding an explicit time selection', () => {
    expect(normalizeSemanticRuntimeQueryRequest({
      metrics: ['previous_day_revenue'],
      dimensions: [],
    }, layer())).toMatchObject({
      timeDimension: { name: 'metric_time', granularity: 'day' },
    });
    expect(normalizeSemanticRuntimeQueryRequest({
      metrics: ['previous_day_revenue'],
      dimensions: [],
      timeDimension: { name: 'metric_time', granularity: 'month' },
    }, layer())).toMatchObject({
      timeDimension: { name: 'metric_time', granularity: 'month' },
    });
  });

  /**
   * REPORTED: a semantic block combining an offset metric with an
   * entity-qualified time dimension failed every compile with
   * "The query includes a metric ... that specifies a time offset ... However,
   * group-by-items do not [include] 'metric_time'."
   *
   * The normalizer bailed out whenever ANY time dimension was set, so the
   * requirement it exists to enforce was never applied to exactly the case that
   * needs it. `metric_time` IS the metrics' aggregation time dimension, so
   * substituting it preserves the requested grain and intent.
   */
  it('substitutes metric_time when an offset metric is grouped by a qualified time dimension', () => {
    expect(normalizeSemanticRuntimeQueryRequest({
      metrics: ['previous_day_revenue'],
      dimensions: [],
      timeDimension: { name: 'orders.close_date', granularity: 'month' },
    }, layer())).toMatchObject({
      timeDimension: { name: 'metric_time', granularity: 'month' },
    });
  });

  it('keeps a qualified time dimension when no metric uses an offset', () => {
    expect(normalizeSemanticRuntimeQueryRequest({
      metrics: ['revenue'],
      dimensions: [],
      timeDimension: { name: 'orders.close_date', granularity: 'month' },
    }, layer())).toMatchObject({
      timeDimension: { name: 'orders.close_date', granularity: 'month' },
    });
  });

  it('falls back to the offset grain when the caller gave no granularity', () => {
    expect(normalizeSemanticRuntimeQueryRequest({
      metrics: ['previous_day_revenue'],
      dimensions: [],
      timeDimension: { name: 'orders.close_date' } as never,
    }, layer())).toMatchObject({
      timeDimension: { name: 'metric_time', granularity: 'day' },
    });
  });

  it('uses the bundled native compiler for composable metrics', async () => {
    const result = await compileSemanticRuntimeQuery({ metrics: ['revenue'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: {},
      semanticLayer: layer(),
      tableMapping: { orders: 'analytics.orders' },
    });
    expect(result?.engine).toBe('native');
    expect(result?.sql).toContain('analytics.orders');
  });

  it('APP-062 applies a native governed total filter after aggregation and refuses adapters that do not advertise it', async () => {
    const status = await getSemanticRuntimeStatus(root);
    expect(semanticRuntimeAdapterSupportsHaving(status, 'native')).toBe(true);
    expect(semanticRuntimeAdapterSupportsHaving(status, 'metricflow-cli')).toBe(false);
    expect(semanticRuntimeAdapterSupportsHaving(status, 'dbt-cloud')).toBe(false);

    const native = await compileSemanticRuntimeQuery({
      metrics: ['revenue'],
      dimensions: [],
      having: [{ metric: 'revenue', operator: 'gt', values: ['50'] }],
      orderBy: [{ name: 'revenue', direction: 'desc' }],
      limit: 5,
    }, {
      projectRoot: root,
      projectConfig: {},
      semanticLayer: layer(),
      tableMapping: { orders: 'analytics.orders' },
    });
    expect(native).toMatchObject({ engine: 'native' });
    expect(native?.sql).toContain('FROM (');
    expect(native?.sql).toMatch(/WHERE\s+"dql_semantic_aggregate"\."revenue"\s*>\s*50/);
    expect(native?.sql).toMatch(/ORDER BY\s+"dql_semantic_aggregate"\."revenue" DESC/);
    expect(native?.sql).toContain('LIMIT 5');

    await expect(compileSemanticRuntimeQuery({
      metrics: ['revenue'],
      dimensions: [],
      having: [{ metric: 'revenue', operator: 'gt', values: ['50'] }],
      engine: 'metricflow-cli',
    }, {
      projectRoot: root,
      projectConfig: {},
      semanticLayer: layer(),
    })).rejects.toMatchObject({ code: 'SEMANTIC_HAVING_UNSUPPORTED' });
  });

  it('uses a detected local MetricFlow runtime for derived metrics without an AI planning call', async () => {
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), '{}');
    const bin = join(root, 'mf');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then exit 0; fi',
      'printf "%s\\n" "SELECT revenue_ratio FROM metricflow_compiled"',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;

    const result = await compileSemanticRuntimeQuery({ metrics: ['revenue_ratio'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
    });
    expect(result).toMatchObject({ engine: 'metricflow-cli', sql: 'SELECT revenue_ratio FROM metricflow_compiled' });
  });

  it('AGT-017 records a dbt profile target that differs from the selected connection as a warning on the compile, and refuses only a different driver', async () => {
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), '{}');
    const bin = join(root, 'mf');
    const argsPath = join(root, 'mf-args.txt');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.14.0"; exit 0; fi',
      `printf "%s\\n" "$*" > '${argsPath.replace(/'/g, "'\\''")}'`,
      'printf "%s\\n" "SELECT revenue_ratio FROM metricflow_compiled"',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;

    // MetricFlow renders the SQL; the selected connection runs it. A profile
    // default target in another database changes nothing in the statement, so
    // the compile proceeds and the difference is recorded, never hidden.
    const differing = await compileSemanticRuntimeQuery({
      metrics: ['revenue_ratio'],
      dimensions: [],
      engine: 'metricflow-cli',
    }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
      metricFlowAskTarget: askMetricFlowTarget('DB_B', 'DB_A'),
    });
    expect(differing).toMatchObject({ engine: 'metricflow-cli', sql: 'SELECT revenue_ratio FROM metricflow_compiled' });
    expect((differing?.warnings ?? []).join(' ')).toContain('differs from the selected connection in database');
    expect(readFileSync(argsPath, 'utf8')).toContain('--metrics revenue_ratio');

    rmSync(argsPath, { force: true });
    const compiled = await compileSemanticRuntimeQuery({
      metrics: ['revenue_ratio'],
      dimensions: [],
      engine: 'metricflow-cli',
      limit: 3,
    }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
      metricFlowAskTarget: askMetricFlowTarget('DB_B', 'DB_B'),
    });
    expect(compiled).toMatchObject({ engine: 'metricflow-cli', sql: 'SELECT revenue_ratio FROM metricflow_compiled' });
    expect((compiled?.warnings ?? []).some((warning) => warning.includes('differs from the selected connection'))).toBe(false);
    expect(readFileSync(argsPath, 'utf8')).toContain('--limit 3');

    // Unquoted Snowflake components fold to upper case: `db_b` is `DB_B`.
    expect(assertMetricFlowAskTarget(askMetricFlowTarget('DB_B', 'db_b', { preserveConfiguredSpelling: true }))).toEqual([]);
    // Quoted names keep their case, so this IS a difference — recorded, not refused.
    expect(assertMetricFlowAskTarget(askMetricFlowTarget('"DB_B"', '"db_b"', { preserveConfiguredSpelling: true })).join(' ')).toContain('differs from the selected connection');
    // A profile that could not be read is a warning too; the person keeps their engine.
    const unverifiable = askMetricFlowTarget('DB_B', 'DB_B');
    delete (unverifiable as { profileTarget?: unknown }).profileTarget;
    expect(assertMetricFlowAskTarget(unverifiable).join(' ')).toContain('could not be verified');
    // A different DRIVER would render different SQL: that one stops before dispatch.
    const otherDriver = askMetricFlowTarget('DB_B', 'DB_B');
    otherDriver.profileTarget.expectedTarget = { ...otherDriver.profileTarget.expectedTarget, driver: 'duckdb', dialect: 'duckdb' } as typeof otherDriver.profileTarget.expectedTarget;
    expect(() => assertMetricFlowAskTarget(otherDriver)).toThrow('does not match the warehouse selected');
  });

  it('AGT-005/API-007 sends the frozen qualified group-by identity to MetricFlow order-by', async () => {
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), '{}');
    const bin = join(root, 'mf');
    const argsPath = join(root, 'mf-args.txt');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "%s\\n" "0.13.0"; exit 0; fi',
      `printf "%s\\n" "$*" > '${argsPath.replace(/'/g, "'\\''")}'`,
      'printf "%s\\n" "SELECT customer_name, total_bcm FROM metricflow_compiled"',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;
    const frozenGrouping = 'order_id__customer__customer_name';
    const semanticLayer = new SemanticLayer({
      metrics: [{ name: 'total_bcm', label: 'Total BCM', description: '', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr' }],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: '', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr', qualifiedName: frozenGrouping, entityLink: 'customer' }],
    });

    const result = await compileSemanticRuntimeQuery({
      metrics: ['total_bcm'],
      dimensions: [frozenGrouping],
      orderBy: [{ name: 'customer_name', direction: 'desc' }],
      engine: 'metricflow-cli',
    }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.' } },
      detectedProvider: 'dbt',
      semanticLayer,
    });

    expect(result?.runtimeRequest).toMatchObject({
      dimensions: [frozenGrouping],
      orderBy: [{ name: frozenGrouping, direction: 'desc' }],
    });
    const args = readFileSync(argsPath, 'utf8');
    expect(args).toContain(`--group-by ${frozenGrouping}`);
    expect(args).toContain(`--order -${frozenGrouping}`);
    expect(args).not.toContain('--order -customer_name');
  });

  it('API-007 preserves a selected runtime compiler failure as a stable error', async () => {
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), '{}');
    const bin = join(root, 'mf');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "%s\\n" "0.13.0"; exit 0; fi',
      'printf "%s\\n" "Unknown metric eu_gb_months_bcm_qty" >&2',
      'exit 1',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;

    await expect(compileSemanticRuntimeQuery({
      metrics: ['eu_gb_months_bcm_qty'],
      dimensions: [],
    }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
    })).rejects.toMatchObject({
      code: 'SEMANTIC_COMPILATION_FAILED',
      adapter: 'metricflow-cli',
    });
  });

  it('API-004/E2E-008 passes the inferred metric_time group-by to MetricFlow for an offset metric', async () => {
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), '{}');
    const bin = join(root, 'mf');
    const argsPath = join(root, 'mf-args.txt');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then exit 0; fi',
      `printf "%s\\n" "$*" > '${argsPath.replace(/'/g, "'\\''")}'`,
      'printf "%s\\n" "SELECT previous_day_revenue FROM metricflow_compiled"',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;

    const result = await compileSemanticRuntimeQuery({
      metrics: ['previous_day_revenue'],
      dimensions: [],
    }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
    });

    expect(result?.effectiveRequest.timeDimension).toEqual({ name: 'metric_time', granularity: 'day' });
    expect(readFileSync(argsPath, 'utf8')).toContain('--group-by metric_time__day');
  });

  it('activates a managed project-local runtime immediately and forwards the configured profiles directory', async () => {
    delete process.env.ZLENS_METRICFLOW_BIN;
    mkdirSync(join(root, 'target'), { recursive: true });
    mkdirSync(join(root, '.dql', 'runtimes', 'metricflow', 'bin'), { recursive: true });
    // A dbt semantic layer MetricFlow can read: at least one semantic model.
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify({ semantic_models: [{ name: 'orders' }], metrics: [] }));
    const bin = managedMetricFlowBin(root);
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.13.0"; exit 0; fi',
      'printf "SELECT \'%s\' AS profiles_dir\\n" "$DBT_PROFILES_DIR"',
    ].join('\n'));
    chmodSync(bin, 0o755);

    const status = await getSemanticRuntimeStatus(root);
    expect(status.active).toBe('metricflow-cli');
    expect(status.adapters.find((adapter) => adapter.id === 'metricflow-cli')).toMatchObject({
      configured: true,
      ready: true,
      source: 'local',
    });
    expect(status.adapters.find((adapter) => adapter.id === 'metricflow-cli')?.detail).toContain('project-local managed runtime');

    const result = await compileSemanticRuntimeQuery({ metrics: ['revenue_ratio'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.', profilesDir: 'profiles' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
    });
    expect(result).toMatchObject({ engine: 'metricflow-cli' });
    expect(result?.sql).toContain(join(root, 'profiles'));
  });

  // F4 (ZLens 0.1.0 e2e): an `mf` on PATH became the active runtime for a
  // project whose metrics are DQL semantic-layer YAML, and every metric in the
  // picker failed with "Local MetricFlow returned no compatible dimensions".
  describe('a detected MetricFlow serves only a semantic layer it can read', () => {
    const fakeMf = () => {
      const bin = join(root, 'mf');
      writeFileSync(bin, [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.14.0"; exit 0; fi',
        'exit 0',
      ].join('\n'));
      chmodSync(bin, 0o755);
      process.env.ZLENS_METRICFLOW_BIN = bin;
    };
    const dqlLayer = () => new SemanticLayer({
      metrics: [{ name: 'team_wins', label: 'Team wins', description: '', domain: 'nba', sql: 'SUM(wins)', type: 'sum', table: 'team_season_facts' }],
      dimensions: [{ name: 'team', label: 'Team', description: '', domain: 'nba', sql: 'team_id', type: 'number', table: 'team_season_facts' }],
    });

    it('auto keeps a DQL semantic layer on the native compiler and says why MetricFlow is not used', async () => {
      fakeMf();
      writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ semanticLayer: { provider: 'dql', path: 'semantic-layer' } }));
      // dbt writes an empty semantic manifest on every parse: it is not a dbt semantic layer.
      mkdirSync(join(root, 'target'), { recursive: true });
      writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify({ semantic_models: [], metrics: [], project_configuration: {} }));
      const status = await getSemanticRuntimeStatus(root);
      expect(status.active).toBe('native');
      expect(status.adapters.find((adapter) => adapter.id === 'metricflow-cli')).toMatchObject({ ready: true });
      expect(status.adapters.find((adapter) => adapter.id === 'metricflow-cli')?.detail).toContain('Not used automatically');
      const compat = await describeRuntimeCompatibility(root, dqlLayer(), ['team_wins'], { semanticLayer: { provider: 'dql' } });
      expect(compat.engine).toBe('native');
      expect(compat.dimensions.map((dimension) => dimension.name)).toEqual(['team']);
    });

    it('auto still selects MetricFlow for a dbt semantic layer', async () => {
      fakeMf();
      writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ semanticLayer: { provider: 'dbt', projectPath: '.' } }));
      expect((await getSemanticRuntimeStatus(root)).active).toBe('metricflow-cli');
      rmSync(join(root, 'dql.config.json'));
      mkdirSync(join(root, 'target'), { recursive: true });
      writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify({ semantic_models: [{ name: 'orders' }], metrics: [] }));
      expect((await getSemanticRuntimeStatus(root)).active).toBe('metricflow-cli');
    });

    it('an explicit MetricFlow choice over DQL metrics fails with guidance, not a bare code', async () => {
      fakeMf();
      writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ semanticLayer: { provider: 'dql', path: 'semantic-layer' } }));
      const { saveSemanticRuntimePreference } = await import('./semantic-runtime-settings.js');
      saveSemanticRuntimePreference(root, 'metricflow-cli');
      const failure = await describeRuntimeCompatibility(root, dqlLayer(), ['team_wins'], { semanticLayer: { provider: 'dql' } }).catch((error: unknown) => error as Error & { code?: string });
      expect(failure).toMatchObject({ code: 'SEMANTIC_RUNTIME_REQUIRED' });
      expect((failure as Error).message).toContain('defined in the DQL semantic layer, which MetricFlow does not read');
      expect((failure as Error).message).toContain('Settings → Semantic runtime');
    });
  });

  it('selects a successfully tested dbt Cloud adapter without exposing its token', async () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'auto',
      dbtCloud: { host: 'semantic-layer.cloud.getdbt.com', environmentId: '99', serviceToken: 'cloud-secret' },
    }, { ok: true, message: 'Test passed', metricCount: 7_500 }, createWarehouseTargetIdentity({
      connectionRef: 'connection:test',
      driver: 'snowflake',
      redactedContext: { account: 'acme', database: 'analytics', schema: 'semantic' },
    }));

    const status = await getSemanticRuntimeStatus(root);
    expect(status.active).toBe('dbt-cloud');
    expect(status.adapters.find((adapter) => adapter.id === 'dbt-cloud')).toMatchObject({
      configured: true,
      tested: true,
      ready: true,
    });
    expect(JSON.stringify(status)).not.toContain('cloud-secret');
  });
});

describe('describeRuntimeCompatibility (native cascade fallback)', () => {
  function bcmLayer(): SemanticLayer {
    // A metric on bcm_hdr with one own-model dimension carrying its qualified name.
    return new SemanticLayer({
      metrics: [
        { name: 'total_bcm', label: 'Total BCM', description: '', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr', objectKind: 'metric' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr', qualifiedName: 'bcm_hdr__customer_name', entityLink: 'bcm_hdr' },
      ],
    });
  }

  it('falls back to native and carries the qualified name when no runtime is active', async () => {
    // The suite's beforeEach points ZLENS_METRICFLOW_BIN at a missing path and no
    // dbt Cloud is configured, so the active adapter resolves to native.
    const { describeRuntimeCompatibility } = await import('./semantic-runtime.js');
    const result = await describeRuntimeCompatibility(root, bcmLayer(), ['total_bcm']);
    expect(result.engine).toBe('native');
    const customer = result.dimensions.find((d) => d.name === 'customer_name');
    expect(customer?.qualifiedName).toBe('bcm_hdr__customer_name');
  });

  it('returns metric_unresolved for an unknown metric', async () => {
    const { describeRuntimeCompatibility } = await import('./semantic-runtime.js');
    const result = await describeRuntimeCompatibility(root, bcmLayer(), ['nope']);
    expect(result.incompatible).toContainEqual({ name: 'nope', qualifiedName: undefined, reason: 'metric_unresolved' });
  });

  it('offers only dimensions the composer accepts, and says which are one-to-many (jaffle-golden)', async () => {
    const { describeRuntimeCompatibility } = await import('./semantic-runtime.js');
    const layer = new DbtProvider().load({ provider: 'dbt' }, fileURLToPath(new URL('../test/fixtures/jaffle-golden', import.meta.url)));
    const result = await describeRuntimeCompatibility(root, layer, ['order_total']);
    // orders → order_item runs one-to-many, so products is out of reach.
    expect(result.dimensions.find((d) => d.name === 'product_name')).toBeUndefined();
    expect(result.incompatible.find((d) => d.name === 'product_name')?.reason).toBe('one_to_many_only');
    expect(layer.explainDimensionGap(['order_total'], 'product_name')).toContain('orders → order_item');
    // Many-to-one reach is kept.
    expect(result.dimensions.find((d) => d.name === 'customer_name')).toBeTruthy();
    for (const dimension of result.dimensions) {
      expect(layer.composeQuery({ metrics: ['order_total'], dimensions: [dimension.qualifiedName ?? dimension.name] }), dimension.name).not.toBeNull();
    }
  });
});

describe('qualifyForMetricFlow (Phase 3 boundary)', () => {
  function bcmLayer(): SemanticLayer {
    return new SemanticLayer({
      metrics: [
        { name: 'total_bcm', label: 'Total BCM', description: '', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr', objectKind: 'metric' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr', qualifiedName: 'bcm_hdr__customer_name', entityLink: 'bcm_hdr' },
      ],
    });
  }

  it('rewrites bare dimension + order-by names to entity-qualified names', async () => {
    const { qualifyForMetricFlow } = await import('./semantic-runtime.js');
    const { request } = qualifyForMetricFlow({
      metrics: ['total_bcm'],
      dimensions: ['customer_name'],
      orderBy: [{ name: 'customer_name', direction: 'asc' }],
    }, bcmLayer());
    expect(request.dimensions).toEqual(['bcm_hdr__customer_name']);
    expect(request.orderBy?.[0]?.name).toBe('bcm_hdr__customer_name');
  });

  it('AGT-005/API-007 keeps a bare MetricFlow order-by bound to the frozen qualified group-by', async () => {
    const { qualifyForMetricFlow } = await import('./semantic-runtime.js');
    // This mirrors the built-CLI failure: the router had already frozen the
    // complete relationship identity, while the planner retained the readable
    // leaf name for ranking. MetricFlow 0.13 requires the exact selected
    // group-by member in order_by.
    const frozenGrouping = 'order_id__customer__customer_name';
    const { request, bindings } = qualifyForMetricFlow({
      metrics: ['total_bcm'],
      dimensions: [frozenGrouping],
      orderBy: [{ name: 'customer_name', direction: 'desc' }],
    }, bcmLayer());

    expect(request.dimensions).toEqual([frozenGrouping]);
    expect(request.orderBy).toEqual([{ name: frozenGrouping, direction: 'desc' }]);
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'order_by',
        authoringReference: 'customer_name',
        runtimeReference: frozenGrouping,
      }),
    ]));
  });

  it('passes through unresolvable names and metric_time untouched', async () => {
    const { qualifyForMetricFlow } = await import('./semantic-runtime.js');
    const { request } = qualifyForMetricFlow({
      metrics: ['total_bcm'],
      dimensions: ['not_a_dim', 'bcm_hdr__customer_name'],
      timeDimension: { name: 'metric_time', granularity: 'month' },
    }, bcmLayer());
    expect(request.dimensions).toEqual(['not_a_dim', 'bcm_hdr__customer_name']);
    expect(request.timeDimension?.name).toBe('metric_time');
  });

  it('AGT-010/E2E-008 maps a model-scoped identity to the owning MetricFlow group-by', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [
        { name: 'total_bcm', label: 'Total BCM', description: '', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr', objectKind: 'metric' },
      ],
      dimensions: [
        { name: 'report_date', label: 'Header report date', description: '', sql: 'report_as_of_dt', type: 'date', table: 'bcm_hdr', cube: 'bcm_hdr', qualifiedName: 'bcm_hdr__report_date', entityLink: 'bcm_hdr', isTimeDimension: true },
        { name: 'report_date', label: 'Line report date', description: '', sql: 'report_as_of_dt', type: 'date', table: 'bcm_line', cube: 'bcm_line', qualifiedName: 'bcm_line__report_date', entityLink: 'bcm_line', isTimeDimension: true },
      ],
    });
    const { qualifyForMetricFlow } = await import('./semantic-runtime.js');
    const { request } = qualifyForMetricFlow({
      metrics: ['total_bcm'],
      dimensions: ['bcm_hdr.report_date'],
    }, semanticLayer);
    expect(request.dimensions).toEqual(['bcm_hdr__report_date']);
  });

  it('AGT-014/E2E-009 binds an explicit metric-relative entity path without replacing the DQL identity', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [
        { name: 'percent_dod_acm', label: 'Percent DoD ACM', description: '', domain: 'consumption', sql: 'SUM(acm)', type: 'sum', table: 'sm_consumption_daily_metrics_detail', cube: 'sm_consumption_daily_metrics_detail', objectKind: 'metric' },
      ],
      dimensions: [
        {
          name: 'report_as_of_dt',
          label: 'Report Date',
          description: '',
          sql: 'report_as_of_dt',
          type: 'date',
          table: 'sm_consumption_daily_metrics_detail',
          cube: 'sm_consumption_daily_metrics_detail',
          qualifiedName: 'bcm_dtl__report_as_of_dt',
          entityLink: 'bcm_dtl',
          isTimeDimension: true,
        },
      ],
    });
    const {
      qualifyForMetricFlow,
      parseSemanticDimensionSelection,
    } = await import('./semantic-runtime.js');
    const selected = 'sm_consumption_daily_metrics_detail.report_as_of_dt@via(bcm_ccu_pc)';
    const { request, bindings } = qualifyForMetricFlow({
      metrics: ['percent_dod_acm'],
      dimensions: [selected],
    }, semanticLayer);

    expect(parseSemanticDimensionSelection(selected)).toEqual({
      reference: 'sm_consumption_daily_metrics_detail.report_as_of_dt',
      entityPath: ['bcm_ccu_pc'],
    });
    expect(request.dimensions).toEqual(['bcm_ccu_pc__bcm_dtl__report_as_of_dt']);
    expect(bindings[0]).toMatchObject({
      authoringReference: 'sm_consumption_daily_metrics_detail.report_as_of_dt',
      runtimeReference: 'bcm_ccu_pc__bcm_dtl__report_as_of_dt',
      entityPath: ['bcm_ccu_pc'],
      status: 'resolved',
    });
  });

  it('AGT-014/API-007 turns dbt Cloud path ambiguity into stable clarification candidates and a trace', async () => {
    const {
      semanticPathAmbiguityFromError,
      decodeSemanticPathEvidenceId,
    } = await import('./semantic-runtime.js');
    const authoringReference = 'sm_consumption_daily_metrics_detail.report_as_of_dt';
    const authoringRequest = {
      metrics: ['percent_dod_acm'],
      dimensions: [authoringReference],
    };
    const runtimeRequest = {
      metrics: ['percent_dod_acm'],
      dimensions: ['bcm_dtl__report_as_of_dt'],
    };
    const ambiguity = semanticPathAmbiguityFromError({
      adapter: 'dbt-cloud',
      error: new Error(`The given input is ambiguous and can't be resolved. The input could match:
[
  "TimeDimension('bcm_dtl__report_as_of_dt', 'day', entity_path=['bcm_ccu_pc'])",
  "TimeDimension('bcm_dtl__report_as_of_dt', 'day', entity_path=['bcm_tdp_pc'])"
]`),
      authoringRequest,
      runtimeRequest,
      bindings: [{
        role: 'dimension',
        authoringReference,
        runtimeReference: 'bcm_dtl__report_as_of_dt',
        entityPath: [],
        status: 'resolved',
      }],
      warnings: [],
    });

    expect(ambiguity?.code).toBe('SEMANTIC_PATH_AMBIGUOUS');
    expect(ambiguity?.details.candidates.map((candidate) => candidate.runtimeReference)).toEqual([
      'bcm_ccu_pc__bcm_dtl__report_as_of_dt',
      'bcm_tdp_pc__bcm_dtl__report_as_of_dt',
    ]);
    expect(ambiguity?.semanticTrace.steps.map((step) => step.status)).toEqual([
      'completed',
      'failed',
      'not_started',
      'not_started',
    ]);
    expect(decodeSemanticPathEvidenceId(ambiguity?.details.candidates[0]?.id)).toEqual({
      authoringReference,
      entityPath: ['bcm_ccu_pc'],
    });
  });
});

describe('saveSemanticRuntimePreference (Phase 4)', () => {
  it('persists a runtime preference with no dbt Cloud test required', async () => {
    const { saveSemanticRuntimePreference } = await import('./semantic-runtime-settings.js');
    const saved = saveSemanticRuntimePreference(root, 'metricflow-cli');
    expect(saved.preference).toBe('metricflow-cli');
    // Round-trips through the store.
    const { getSemanticRuntimeSettings } = await import('./semantic-runtime-settings.js');
    expect(getSemanticRuntimeSettings(root).preference).toBe('metricflow-cli');
  });
});

describe('explainMissingSemanticRuntime (actionable config diagnosis)', () => {
  it('tells the user MetricFlow is not found by the server, with fixes', async () => {
    const { explainMissingSemanticRuntime } = await import('./semantic-runtime.js');
    // beforeEach points ZLENS_METRICFLOW_BIN at a missing path → mf unresolvable,
    // and no dbt Cloud is configured → the PATH-guidance branch.
    writeFileSync(join(root, 'dbt_project.yml'), 'name: demo\n');
    const msg = await explainMissingSemanticRuntime(root);
    expect(msg).toContain('MetricFlow is not on this server’s PATH');
    expect(msg).toContain('ZLENS_METRICFLOW_BIN');
    expect(msg).toContain('restart');
    expect(msg).not.toContain('Configure dbt Cloud Semantic Layer or a compatible local MetricFlow runtime for derived metrics');
  });

  it('names a failing dbt Cloud connection when cloud is the configured runtime', async () => {
    // Configure dbt Cloud via env (configured=true, no stored pass) so the live
    // probe runs and fails against the fake host → configured-but-not-ready.
    const priorEnv = {
      host: process.env.DBT_CLOUD_SEMANTIC_LAYER_HOST,
      env: process.env.DBT_CLOUD_ENVIRONMENT_ID,
      token: process.env.DBT_CLOUD_SERVICE_TOKEN,
    };
    process.env.DBT_CLOUD_SEMANTIC_LAYER_HOST = 'fake.getdbt.invalid';
    process.env.DBT_CLOUD_ENVIRONMENT_ID = '123';
    process.env.DBT_CLOUD_SERVICE_TOKEN = 'nope';
    // The probe is answered in-process as an unreachable host: nothing is looked up or connected off this machine.
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      asked.push(new URL(String(input instanceof Request ? input.url : input)).hostname);
      throw new TypeError('fetch failed');
    }));
    try {
      const { explainMissingSemanticRuntime } = await import('./semantic-runtime.js');
      const msg = await explainMissingSemanticRuntime(root);
      expect(msg).toContain('dbt Cloud is configured');
      expect(msg).toContain('Test & save');
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((host) => host === 'fake.getdbt.invalid')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (priorEnv.host === undefined) delete process.env.DBT_CLOUD_SEMANTIC_LAYER_HOST; else process.env.DBT_CLOUD_SEMANTIC_LAYER_HOST = priorEnv.host;
      if (priorEnv.env === undefined) delete process.env.DBT_CLOUD_ENVIRONMENT_ID; else process.env.DBT_CLOUD_ENVIRONMENT_ID = priorEnv.env;
      if (priorEnv.token === undefined) delete process.env.DBT_CLOUD_SERVICE_TOKEN; else process.env.DBT_CLOUD_SERVICE_TOKEN = priorEnv.token;
    }
  });
})

describe('looksLikeAuthFailure (expired/invalid token detection)', () => {
  it('flags token/auth failures', async () => {
    const { looksLikeAuthFailure } = await import('./semantic-runtime.js');
    for (const d of [
      '401 Unauthorized',
      'HTTP 403 Forbidden',
      'the token is expired',
      'invalid token',
      'authentication failed',
      'permission denied',
    ]) expect(looksLikeAuthFailure(d)).toBe(true);
  });
  it('does NOT flag host/network errors', async () => {
    const { looksLikeAuthFailure } = await import('./semantic-runtime.js');
    for (const d of [
      'getaddrinfo ENOTFOUND fake.getdbt.invalid',
      'connect ETIMEDOUT',
      'Environment ID is missing',
    ]) expect(looksLikeAuthFailure(d)).toBe(false);
  });
})

/**
 * REPORTED (warehouse-first insurance project, no dbt): a loss ratio metric
 * failed with "dbt semantic execution requires target/semantic_manifest.json".
 * The project had no dbt project to parse. An `mf` on the PATH had made
 * MetricFlow the active runtime, and the native engine did not run ratios.
 */
describe('warehouse-first project (no dbt project)', () => {
  function insuranceLayer(): SemanticLayer {
    return new SemanticLayer({
      metrics: [
        { name: 'incurred_losses', label: 'Incurred losses', description: '', domain: 'claims', sql: 'claim_amount', type: 'sum', table: 'claim_amount' },
        { name: 'written_premium', label: 'Written premium', description: '', domain: 'policies', sql: 'policy_amount', type: 'sum', table: 'policy_amount' },
        {
          name: 'loss_ratio',
          label: 'Loss ratio',
          description: '',
          domain: 'claims',
          sql: 'loss_ratio',
          type: 'custom',
          table: '',
          metricType: 'ratio',
          // dbt's imported shape: numerator/denominator carry name + filter.
          typeParams: { numerator: { name: 'incurred_losses', filter: null }, denominator: { name: 'written_premium', filter: null } },
          source: { provider: 'dbt', objectType: 'metric', objectId: 'loss_ratio' },
        },
        {
          name: 'premium_growth',
          label: 'Premium growth',
          description: '',
          domain: 'policies',
          sql: 'premium_growth',
          type: 'custom',
          table: '',
          metricType: 'derived',
          // An offset window (prior period) is MetricFlow-only; arithmetic alone is native.
          typeParams: { expr: 'written_premium - prior_premium', metrics: ['written_premium', { name: 'written_premium', alias: 'prior_premium', offset_window: '1 year' }] },
          source: { provider: 'dbt', objectType: 'metric', objectId: 'premium_growth' },
        },
      ],
      dimensions: [],
    });
  }

  function installFakeMetricFlow(): void {
    const bin = join(root, 'mf');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.14.0"; exit 0; fi',
      'printf "%s\\n" "SELECT 1 FROM metricflow_compiled"',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.ZLENS_METRICFLOW_BIN = bin;
  }

  const warehouseFirstConfig = { semanticLayer: { provider: 'dql' } };

  it('does not make MetricFlow the active runtime just because mf is installed', async () => {
    installFakeMetricFlow();
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify(warehouseFirstConfig));
    const status = await getSemanticRuntimeStatus(root);
    expect(status.active).toBe('native');
    // Main's rule (projectHasDbtSemantics): mf is detected, but not used for a
    // semantic layer it cannot read.
    const metricFlow = status.adapters.find((adapter) => adapter.id === 'metricflow-cli');
    expect(metricFlow?.detail).toContain('Not used automatically');
    expect(status.setup).toContain('no dbt project');
    expect(status.setup).not.toContain('semantic_manifest');
  });

  it('still selects MetricFlow in a dbt project', async () => {
    installFakeMetricFlow();
    writeFileSync(join(root, 'dbt_project.yml'), 'name: insurance\n');
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify({ semantic_models: [{ name: 'policies' }], metrics: [{ name: 'written_premium' }] }));
    const status = await getSemanticRuntimeStatus(root);
    expect(status.active).toBe('metricflow-cli');
  });

  it('runs a ratio metric on the native compiler', async () => {
    installFakeMetricFlow();
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify(warehouseFirstConfig));
    const result = await compileSemanticRuntimeQuery({ metrics: ['loss_ratio'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: warehouseFirstConfig,
      semanticLayer: insuranceLayer(),
    });
    expect(result?.engine).toBe('native');
    expect(result?.sql).toContain('NULLIF(ratio_inputs.written_premium, 0) AS loss_ratio');
  });

  it('explains an explicitly selected MetricFlow without asking for dbt parse', async () => {
    installFakeMetricFlow();
    const { saveSemanticRuntimePreference } = await import('./semantic-runtime-settings.js');
    saveSemanticRuntimePreference(root, 'metricflow-cli');
    const error = await compileSemanticRuntimeQuery({ metrics: ['loss_ratio'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: warehouseFirstConfig,
      semanticLayer: insuranceLayer(),
    }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('no dbt project');
    expect(error?.message).not.toContain('semantic_manifest.json');
  });

  it('describes what the native engine cannot run instead of pointing at dbt', async () => {
    const { explainMissingSemanticRuntime } = await import('./semantic-runtime.js');
    const message = await explainMissingSemanticRuntime(root);
    expect(message).toContain('no dbt project');
    expect(message).toContain('ratios of two simple metrics');
    expect(insuranceLayer().explainNativeMetricGap('premium_growth')).toContain('derived metric');
  });
});
