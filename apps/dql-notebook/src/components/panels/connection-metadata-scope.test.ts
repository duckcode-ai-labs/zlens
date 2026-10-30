import { describe, expect, it } from 'vitest';
import type { WarehouseMetadataDiscovery } from '../../api/client';
import { onlyDiscoveredSchema } from './connection-metadata-scope';

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
