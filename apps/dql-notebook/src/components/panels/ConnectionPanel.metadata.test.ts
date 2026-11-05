import { describe, expect, it } from 'vitest';
import {
  additionalDiscoveredSchemaCount,
  formatMetadataScopeEditor,
  metadataScopeMode,
  metadataScopeIncludes,
  parseMetadataScopeEditor,
  toggleAdditionalMetadataScope,
} from './connection-metadata-scope';

describe('what Ask reads from a connection is chosen from what the project has (simplification plan Z2)', () => {
  const sales = [{ catalogOrDatabase: 'ANALYTICS', schemas: ['SALES'] }];
  it('reads the tables dbt builds, and adds the schemas listed', () => {
    expect(metadataScopeMode(true, [])).toBe('dbt_relations');
    expect(metadataScopeMode(true, sales)).toBe('dbt_plus_selected');
  });
  it('reads the schemas listed when there is no dbt', () => {
    expect(metadataScopeMode(false, sales)).toBe('selected_scopes');
    expect(metadataScopeMode(false, [])).toBe('selected_scopes');
  });
});

describe('ConnectionPanel metadata scope editor', () => {
  it('round-trips multiple databases and schemas in the compact editor format', () => {
    const scopes = [
      { catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES', 'FINANCE'] },
      { catalogOrDatabase: 'REFERENCE_DATA', schemas: ['SHARED'] },
    ];
    const text = formatMetadataScopeEditor(scopes);

    expect(text).toBe('ANALYTICS_PROD: SALES, FINANCE\nREFERENCE_DATA: SHARED');
    expect(parseMetadataScopeEditor(text)).toEqual(scopes);
  });

  it('drops incomplete lines instead of broadening metadata access', () => {
    expect(parseMetadataScopeEditor([
      'ANALYTICS_PROD:',
      ': SALES',
      'REFERENCE_DATA: SHARED',
    ].join('\n'))).toEqual([
      { catalogOrDatabase: 'REFERENCE_DATA', schemas: ['SHARED'] },
    ]);
  });

  it('adds and removes only explicitly selected additional scopes', () => {
    const added = toggleAdditionalMetadataScope([], 'REPORTING_PROD', 'GOLD', true);
    expect(added).toEqual([
      { catalogOrDatabase: 'REPORTING_PROD', schemas: ['GOLD'] },
    ]);
    expect(metadataScopeIncludes(added, 'reporting_prod', 'gold')).toBe(true);
    expect(toggleAdditionalMetadataScope(added, 'REPORTING_PROD', 'GOLD', false)).toEqual([]);
  });

  it('counts only discovered schemas outside the dbt project', () => {
    expect(additionalDiscoveredSchemaCount({
      version: 1,
      connectionId: 'default',
      driver: 'snowflake',
      discoveredAt: '2026-07-30T00:00:00.000Z',
      supported: true,
      scopes: [{
        catalogOrDatabase: 'ANALYTICS_PROD',
        schemas: [
          { name: 'DBT_MARTS', inDbtProject: true, dbtRelationCount: 12 },
          { name: 'GOLD', inDbtProject: false, dbtRelationCount: 0 },
        ],
      }],
      dbtScopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['DBT_MARTS'] }],
      queryCount: 1,
      truncated: false,
      message: 'Found 1 additional schema.',
    })).toBe(1);
  });
});
