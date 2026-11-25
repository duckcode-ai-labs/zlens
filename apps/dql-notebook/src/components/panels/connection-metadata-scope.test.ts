import { describe, expect, it } from 'vitest';
import type { WarehouseMetadataDiscovery } from '../../api/client';
import { compactCount, onlyDiscoveredSchema, preselectedScopes, schemaSizeWords, scopeOverLimits, selectedScopeTotals, selectedScopeWords, setupEstimates } from './connection-metadata-scope';

const discovery = (scopes: WarehouseMetadataDiscovery['scopes'], dbtScopes: WarehouseMetadataDiscovery['dbtScopes'] = []): WarehouseMetadataDiscovery => ({
  version: 1, connectionId: 'default', driver: 'file', discoveredAt: '2026-10-30T00:00:00Z', supported: true,
  scopes, dbtScopes, queryCount: 1, truncated: false, message: '',
});
const schema = (name: string) => ({ name, inDbtProject: false, dbtRelationCount: 0 });

describe('the schema Guided Setup ticks by itself', () => {
  it('is the only one there is (a folder of files, a SQLite file)', () => {
    expect(onlyDiscoveredSchema(discovery([{ catalogOrDatabase: 'memory', schemas: [schema('main')] }]))).toEqual({ catalogOrDatabase: 'memory', schema: 'main' });
  });

  it('is none when there is a choice to make, or a dbt project reads the warehouse', () => {
    expect(onlyDiscoveredSchema(discovery([{ catalogOrDatabase: 'jaffle_shop', schemas: [schema('dev'), schema('main')] }]))).toBeNull();
    expect(onlyDiscoveredSchema(discovery([{ catalogOrDatabase: 'a', schemas: [schema('x')] }, { catalogOrDatabase: 'b', schemas: [schema('y')] }]))).toBeNull();
    expect(onlyDiscoveredSchema(discovery([{ catalogOrDatabase: 'memory', schemas: [schema('main')] }], [{ catalogOrDatabase: 'memory', schemas: ['main'] }]))).toBeNull();
    expect(onlyDiscoveredSchema(discovery([]))).toBeNull();
  });
});

describe('sizes in the schema picker (onboarding design P1)', () => {
  const sized = (name: string, size: NonNullable<WarehouseMetadataDiscovery['scopes'][number]['schemas'][number]['size']>, inDbtProject = false) => ({ name, inDbtProject, dbtRelationCount: inDbtProject ? 3 : 0, size });
  const limits = { tables: 10_000, columnsPerDatabase: 50_000, checkRowBudget: 10_000_000 };

  it('says a schema\'s size in a few words', () => {
    expect(schemaSizeWords({ tables: 42, views: 2, rows: 31_000_000, bytes: 2_400_000_000, tablesWithKeys: 30, foreignKeys: 12 })).toBe('42 tables (2 views) · 31M rows · 2.2 GB · 30 with keys declared');
    expect(schemaSizeWords({ tables: 3, views: 3, tablesWithKeys: 0, foreignKeys: 0 })).toBe('3 tables (views)');
    expect(schemaSizeWords({ tables: 1, views: 0, rows: 0, tablesWithKeys: 0, foreignKeys: 0 })).toBe('1 table');
    expect(compactCount(9_999)).toBe('9,999');
    expect(compactCount(3_140_000_000)).toBe('3.1B');
    expect(compactCount(125_400)).toBe('125K');
  });

  it('adds up what is ticked, leaving out the schemas a dbt project reads', () => {
    const found = { ...discovery([
      { catalogOrDatabase: 'ANALYTICS', schemas: [sized('SALES', { tables: 40, views: 0, rows: 3e9, bytes: 4e11, tablesWithKeys: 10, foreignKeys: 4, largeTables: 26, columns: 900 }), sized('MARTS', { tables: 7, views: 0, tablesWithKeys: 0, foreignKeys: 0, columns: 80 }, true), sized('HR', { tables: 5, views: 0, tablesWithKeys: 0, foreignKeys: 0 })] },
    ]), limits };
    const totals = selectedScopeTotals(found, [{ catalogOrDatabase: 'analytics', schemas: ['sales', 'MARTS'] }]);
    expect(totals).toMatchObject({ schemas: 1, sized: 1, tables: 40, rows: 3e9, largeTables: 26, columnsByDatabase: [{ catalogOrDatabase: 'ANALYTICS', columns: 900 }] });
    expect(selectedScopeWords(totals, limits.checkRowBudget)).toBe('Selected: 1 schema · 40 tables · 3B rows · 373 GB · 26 over 10M rows');
    expect(scopeOverLimits(totals, limits)).toBeNull();
    expect(selectedScopeWords(selectedScopeTotals(found, []))).toBe('Nothing selected yet.');
  });

  it('says before anything runs when a choice is more than one read takes', () => {
    const found = { ...discovery([
      { catalogOrDatabase: 'BIG', schemas: [sized('A', { tables: 900, views: 0, tablesWithKeys: 0, foreignKeys: 0, columns: 40_000 }), sized('B', { tables: 400, views: 0, tablesWithKeys: 0, foreignKeys: 0, columns: 22_000 })] },
      { catalogOrDatabase: 'WIDE', schemas: [sized('C', { tables: 9_500, views: 0, tablesWithKeys: 0, foreignKeys: 0, columns: 30_000 })] },
    ]), limits };
    expect(scopeOverLimits(selectedScopeTotals(found, [{ catalogOrDatabase: 'BIG', schemas: ['A', 'B'] }]), limits))
      .toBe('These schemas in BIG hold 62,000 columns; ZLens reads up to 50,000 per database at once. Choose fewer schemas.');
    expect(scopeOverLimits(selectedScopeTotals(found, [{ catalogOrDatabase: 'BIG', schemas: ['A'] }, { catalogOrDatabase: 'WIDE', schemas: ['C'] }]), limits))
      .toBe('These schemas hold 10,400 tables; ZLens reads up to 10,000 at once. Choose fewer schemas.');
    expect(scopeOverLimits(selectedScopeTotals(found, [{ catalogOrDatabase: 'BIG', schemas: ['A'] }]), limits)).toBeNull();
    // Without limits (an older server), nothing is said.
    expect(scopeOverLimits(selectedScopeTotals(found, [{ catalogOrDatabase: 'BIG', schemas: ['A', 'B'] }]), undefined)).toBeNull();
  });
});

describe('two-stage setup in the picker (onboarding design P3)', () => {
  const sized = (name: string, tables: number) => ({ name, inDbtProject: false, dbtRelationCount: 0, size: { tables, views: 0, tablesWithKeys: 0, foreignKeys: 0 } });

  it('ticks every schema when they hold 100 tables or fewer in all (decision D4), else none', () => {
    expect(preselectedScopes(discovery([{ catalogOrDatabase: 'SALES', schemas: [sized('A', 60), sized('B', 40)] }])))
      .toEqual([{ catalogOrDatabase: 'SALES', schemas: ['A', 'B'] }]);
    expect(preselectedScopes(discovery([{ catalogOrDatabase: 'SALES', schemas: [sized('A', 60), sized('B', 41)] }]))).toEqual([]);
    // Sizes unknown for one: the person chooses.
    expect(preselectedScopes(discovery([{ catalogOrDatabase: 'SALES', schemas: [sized('A', 6), schema('B')] }]))).toEqual([]);
    // The one schema there is, whatever its size.
    expect(preselectedScopes(discovery([{ catalogOrDatabase: 'SALES', schemas: [sized('A', 900)] }]))).toEqual([{ catalogOrDatabase: 'SALES', schemas: ['A'] }]);
  });

  it('estimates reading names and the background checks, and says they are estimates', () => {
    const totals = { schemas: 3, sized: 3, tables: 1240, rows: 3.1e9, bytes: 0, tablesWithKeys: 200, largeTables: 26, columnsByDatabase: [{ catalogOrDatabase: 'SALES', columns: 31_000 }] };
    const estimate = setupEstimates(totals, { credits: true });
    expect(estimate.names).toBe('Reading names: about 15 s.');
    expect(estimate.checks).toMatch(/^Checking the data in the background: about \d+ min, about [\d.]+ credits on the app's X-Small warehouse \(estimate\)\.$/);
    expect(setupEstimates({ ...totals, tables: 5, tablesWithKeys: 5, rows: 1000, columnsByDatabase: [] }, { credits: true }).checks)
      .toBe("Checking the data in the background: about 5 s, under 0.05 credits on the app's X-Small warehouse (estimate).");
    expect(setupEstimates(totals).checks).not.toContain('credits');
  });
});
