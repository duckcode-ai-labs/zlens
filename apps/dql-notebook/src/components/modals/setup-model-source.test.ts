import { describe, expect, it, vi } from 'vitest';
import type { ContextAuthoringProposalV1, DbtOnboardingStatusResponse, WarehouseDiscoveryReport } from '../../api/client';
import {
  setupFinishTarget,
  DATABASE_ONLY_DBT_PROJECT,
  databaseOnlyUnavailable,
  draftErrorMessage,
  draftOutcome,
  draftsFromWarehouse,
  existingProjectFromStatus,
  initialModelSource,
  missingEnvironment,
  modelingModeForSource,
  PROPOSAL_HANDOFF_KEY,
  rememberProposalForModeling,
  setupStepTitles,
  stepOneBlocker,
  stepTwoCopy,
  synchronizeExistingProject,
  type ProjectSyncApi,
} from './setup-model-source';

const fresh: DbtOnboardingStatusResponse = { dbt: { configured: false, projectFound: false }, modeling: { enabled: false } };
const dbtProject: DbtOnboardingStatusResponse = { dbt: { configured: true, projectDir: '../jaffle-shop', projectFound: true }, modeling: { enabled: false } };
const warehouseProject: DbtOnboardingStatusResponse = { dbt: { configured: false }, modeling: { enabled: true, mode: 'warehouse-first' } };
const hybridProject: DbtOnboardingStatusResponse = { dbt: { configured: true, projectDir: '.' }, modeling: { enabled: true, mode: 'hybrid' } };
const connections = { default: 'warehouse', connections: { warehouse: { driver: 'postgres', password: '${PG_PASSWORD}' } } };

function report(overrides: Partial<WarehouseDiscoveryReport> = {}): WarehouseDiscoveryReport {
  return {
    catalogFingerprint: 'abc',
    capturedAt: '2026-10-15T00:00:00Z',
    relations: 6,
    domains: [{ id: 'main', name: 'main', existing: false }],
    entities: [
      { id: 'customers', domain: 'main', relation: 'main.customers', grain: 'customer_id' },
      { id: 'orders', domain: 'main', relation: 'main.orders', grain: 'order_id' },
      { id: 'items', domain: 'main', relation: 'main.items', existing: 'items' },
    ],
    relationships: [{ id: 'orders_customers', domain: 'main', from: 'orders', to: 'customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', evidence: [] }],
    existingRelationships: 0,
    validated: true,
    ...overrides,
  };
}

describe('where the data model lives', () => {
  it('a fresh folder asks; a detected dbt project keeps the dbt card', () => {
    expect(existingProjectFromStatus(fresh)).toBeNull();
    expect(initialModelSource({ existing: null })).toBeNull();
    expect(initialModelSource({ existing: null, dbtProjectFound: true })).toBe('dbt');
  });

  it('dbt project: an existing dbt project sees the dbt card, and continuing turns nothing on', () => {
    const existing = existingProjectFromStatus(dbtProject, connections);
    expect(existing).toMatchObject({ mode: 'dbt-first', label: 'dbt project', dbtConfigured: true, warehouseModeling: false });
    expect(existing?.detail).toBe('dbt project at ../jaffle-shop · connection "warehouse" (postgres)');
    expect(initialModelSource({ existing })).toBe('dbt');
    expect(modelingModeForSource('dbt')).toBeNull();
    expect(draftsFromWarehouse('dbt')).toBe(false);
    expect(stepTwoCopy('dbt', existing).title).toBe('Connect your database');
  });

  it('Database only turns on warehouse-first and drafts models after the sync', () => {
    expect(modelingModeForSource('warehouse')).toBe('warehouse-first');
    expect(draftsFromWarehouse('warehouse')).toBe(true);
    expect(stepOneBlocker({ source: 'warehouse', requiresDbtReapply: false, dbtConfigured: false })).toBeNull();
    expect(stepTwoCopy('warehouse', null).description).toContain('Apply and synchronize');
    expect(stepTwoCopy('warehouse', null).description).toContain('Draft my models');
    const existing = existingProjectFromStatus(warehouseProject);
    expect(existing).toMatchObject({ mode: 'warehouse-first', label: 'Database only', warehouseModeling: true });
    expect(initialModelSource({ existing })).toBe('warehouse');
  });

  it('Database only is unavailable for a folder that already reads dbt, and says to choose Both', () => {
    const dbtExisting = existingProjectFromStatus(dbtProject);
    const hybridExisting = existingProjectFromStatus(hybridProject);
    const warehouseExisting = existingProjectFromStatus(warehouseProject);
    expect(databaseOnlyUnavailable(null)).toBeNull();
    expect(databaseOnlyUnavailable(warehouseExisting)).toBeNull();
    expect(databaseOnlyUnavailable(dbtExisting)).toBe(DATABASE_ONLY_DBT_PROJECT);
    expect(databaseOnlyUnavailable(hybridExisting)).toBe(DATABASE_ONLY_DBT_PROJECT);
    expect(DATABASE_ONLY_DBT_PROJECT).toContain('Choose Both');
    expect(DATABASE_ONLY_DBT_PROJECT).toContain('create-zlens-app my-analytics --warehouse');
    expect(stepOneBlocker({ source: 'warehouse', requiresDbtReapply: false, dbtConfigured: true, existing: dbtExisting })).toBe(DATABASE_ONLY_DBT_PROJECT);
    expect(stepOneBlocker({ source: 'warehouse', requiresDbtReapply: false, dbtConfigured: false, existing: warehouseExisting })).toBeNull();
    // Both stays the way to add warehouse tables to a dbt project.
    expect(stepOneBlocker({ source: 'both', requiresDbtReapply: false, dbtConfigured: true, existing: dbtExisting })).toBeNull();
  });

  it('Both turns on hybrid, only once the dbt project is applied', () => {
    expect(modelingModeForSource('both')).toBe('hybrid');
    expect(draftsFromWarehouse('both')).toBe(true);
    expect(stepOneBlocker({ source: 'both', requiresDbtReapply: false, dbtConfigured: false })).toMatch(/Apply the dbt project first/);
    expect(stepOneBlocker({ source: 'both', requiresDbtReapply: false, dbtConfigured: true })).toBeNull();
    const existing = existingProjectFromStatus(hybridProject);
    expect(existing).toMatchObject({ mode: 'hybrid', label: 'dbt project and database', dbtConfigured: true, warehouseModeling: true });
    expect(initialModelSource({ existing })).toBe('both');
  });

  it('Open an existing project asks for credentials and skips modeling', () => {
    const existing = existingProjectFromStatus(warehouseProject, connections);
    expect(initialModelSource({ requested: 'existing', existing })).toBe('existing');
    expect(modelingModeForSource('existing')).toBeNull();
    expect(draftsFromWarehouse('existing')).toBe(false);
    expect(setupStepTitles('existing')).toBe('Data model → Credentials and sync → optional AI → Finish');
    const copy = stepTwoCopy('existing', existing);
    expect(copy.title).toBe('Connect and synchronize');
    expect(copy.description).toContain('${NAME}');
    // Nothing to open in a folder without a data model: fall back to asking.
    expect(initialModelSource({ requested: 'existing', existing: null })).toBeNull();
  });

  it('an update that must reapply dbt stays on the dbt card', () => {
    expect(initialModelSource({ requiresDbtReapply: true, requested: 'warehouse', existing: null })).toBe('dbt');
    expect(stepOneBlocker({ source: 'dbt', requiresDbtReapply: true, dbtConfigured: true })).toMatch(/Reapply/);
    expect(stepOneBlocker({ source: null, requiresDbtReapply: false, dbtConfigured: false })).toBe('Choose where your data model lives.');
  });
});

describe('Draft my models', () => {
  it('describes a drafted proposal and hands it to Modeling', () => {
    const outcome = draftOutcome({ report: report(), proposal: { id: 'proposal-1' } as ContextAuthoringProposalV1 });
    expect(outcome).toEqual({
      ok: true,
      proposalId: 'proposal-1',
      message: 'Drafted 2 models and 1 join from 6 tables, each join checked on the data. Nothing is saved until you review and certify them in Modeling.',
    });
    const storage = { setItem: vi.fn() };
    rememberProposalForModeling('proposal-1', storage);
    expect(storage.setItem).toHaveBeenCalledWith(PROPOSAL_HANDOFF_KEY, 'proposal-1');
  });

  it('says when there is nothing new to draft', () => {
    expect(draftOutcome({ report: report({ relations: 1 }), proposal: null }).message).toBe('Nothing new to draft: the 1 table in the warehouse catalog and their joins are already modeled.');
  });

  it('turns a missing catalog into the next step', () => {
    expect(draftErrorMessage(Object.assign(new Error('x'), { code: 'WAREHOUSE_CATALOG_MISSING' }))).toBe('Choose schemas and Apply and synchronize first; drafting reads the synchronized tables.');
    expect(draftErrorMessage(new Error('boom'))).toBe('boom');
  });
});

describe('synchronize an existing project', () => {
  const scope = (mode: 'dbt_relations' | 'selected_scopes' | 'dbt_plus_selected', schemas: string[]) => ({
    scope: { version: 1 as const, connectionId: 'warehouse', driver: 'postgres', mode, scopes: schemas.length ? [{ catalogOrDatabase: 'analytics', schemas }] : [], relations: [], scopeFingerprint: 'f' },
    status: { state: 'ready' as const, relationCount: 12, columnCount: 80, scopes: [] },
  });
  const fakeApi = (overrides: Partial<ProjectSyncApi> = {}): ProjectSyncApi => ({
    previewDbtOnboarding: vi.fn(async () => ({ fingerprint: 'fp', counts: { models: 9 } })),
    refreshDbtOnboarding: vi.fn(async () => ({})),
    getConnectionMetadataScope: vi.fn(async () => scope('selected_scopes', ['sales'])),
    refreshConnectionMetadata: vi.fn(async () => ({ status: scope('selected_scopes', ['sales']).status, warehouseCatalog: { path: '.dql/warehouse-catalog.json', relations: 12 } })),
    ...overrides,
  });

  it('a warehouse-first project re-reads its saved schemas only', async () => {
    const syncApi = fakeApi();
    const steps = await synchronizeExistingProject(existingProjectFromStatus(warehouseProject)!, 'warehouse', syncApi);
    expect(steps).toEqual([{ kind: 'warehouse', ok: true, message: 'Warehouse synchronized · 12 tables and views.' }]);
    expect(syncApi.previewDbtOnboarding).not.toHaveBeenCalled();
    expect(syncApi.refreshConnectionMetadata).toHaveBeenCalledWith('warehouse');
  });

  it('a dbt project rebuilds its snapshot from the configured project', async () => {
    const syncApi = fakeApi();
    const steps = await synchronizeExistingProject(existingProjectFromStatus(dbtProject)!, 'warehouse', syncApi);
    expect(steps).toEqual([{ kind: 'dbt', ok: true, message: 'dbt project synchronized · 9 models. Search indexes update in the background.' }]);
    expect(syncApi.refreshDbtOnboarding).toHaveBeenCalledWith({ expectedFingerprint: 'fp' });
    expect(syncApi.refreshConnectionMetadata).not.toHaveBeenCalled();
  });

  it('a hybrid project does both, and one failure does not hide the other', async () => {
    const syncApi = fakeApi({ previewDbtOnboarding: vi.fn(async () => { throw new Error('dbt manifest.json is missing'); }) });
    const steps = await synchronizeExistingProject(existingProjectFromStatus(hybridProject)!, 'warehouse', syncApi);
    expect(steps).toEqual([
      { kind: 'dbt', ok: false, message: 'dbt project: dbt manifest.json is missing' },
      { kind: 'warehouse', ok: true, message: 'Warehouse synchronized · 12 tables and views.' },
    ]);
  });

  it('asks for schemas when none are saved yet', async () => {
    const syncApi = fakeApi({ getConnectionMetadataScope: vi.fn(async () => scope('selected_scopes', [])) });
    const steps = await synchronizeExistingProject(existingProjectFromStatus(warehouseProject)!, 'warehouse', syncApi);
    expect(steps[0]).toMatchObject({ kind: 'warehouse', ok: false });
    expect(steps[0]!.message).toContain('Apply and synchronize');
    expect(syncApi.refreshConnectionMetadata).not.toHaveBeenCalled();
  });

  it('asks for unset environment variables before reading anything', async () => {
    const syncApi = fakeApi();
    const steps = await synchronizeExistingProject(existingProjectFromStatus(warehouseProject)!, 'warehouse', syncApi, [
      { name: 'PGHOST', set: true },
      { name: 'PGPASSWORD', set: false },
    ]);
    expect(steps).toEqual([{ kind: 'warehouse', ok: false, message: 'Set PGPASSWORD in the shell that starts zlens notebook, restart it, then synchronize.' }]);
    expect(syncApi.getConnectionMetadataScope).not.toHaveBeenCalled();
    expect(missingEnvironment([{ name: 'A', set: true }, { name: 'B', set: false }])).toEqual(['B']);
    expect(missingEnvironment(undefined)).toEqual([]);
  });

  it('needs a connection for the warehouse part', async () => {
    const steps = await synchronizeExistingProject(existingProjectFromStatus(warehouseProject)!, null, fakeApi());
    expect(steps).toEqual([{ kind: 'warehouse', ok: false, message: 'Add and test a database connection first.' }]);
  });
});

describe('where Finish setup goes', () => {
  it('goes where the highlighted start card says: Apps unless models were drafted', () => {
    expect(setupFinishTarget({ drafted: false })).toEqual({ target: 'apps', action: 'Build an App' });
    expect(setupFinishTarget({ drafted: true })).toEqual({ target: 'domains', action: 'Open Modeling' });
  });
});
