import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDbtDomains } from './domain-discovery.js';

describe('deterministic dbt domain discovery (DOM-001, AGT-002, API-001)', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-discovery-'));
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    manifestPath = join(projectRoot, 'target', 'manifest.json');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('applies the locked evidence precedence and retains lower-ranked conflicts', () => {
    mkdirSync(join(projectRoot, 'domains', 'operations'), { recursive: true });
    writeFileSync(join(projectRoot, 'domains', 'operations', 'domain.dql'), `domain "Operations" {
  id = "operations"
  owner = "ops@example.com"
  dbtPaths = ["models/ops/**"]
}
`);
    writeManifest({
      groups: {
        'group.demo.finance': { name: 'finance', owner: { email: 'finance@example.com' } },
      },
      nodes: {
        'model.demo.explicit': model('explicit', 'models/growth/explicit.sql', {
          meta: { dql: { domain: 'commerce' } }, group: 'finance', tags: ['sales'],
        }),
        'model.demo.grouped': model('grouped', 'models/growth/grouped.sql', {
          group: 'finance', tags: ['sales'],
        }),
        'model.demo.semantic': model('semantic', 'models/growth/semantic.sql', { tags: ['sales'] }),
        'model.demo.exposed': model('exposed', 'models/growth/exposed.sql', { tags: ['sales'] }),
        'model.demo.tagged': model('tagged', 'models/growth/tagged.sql', { tags: ['sales'] }),
        'model.demo.selected': model('selected', 'models/ops/selected.sql'),
        'model.demo.path_only': model('path_only', 'models/growth/acquisition/path_only.sql'),
      },
      exposures: {
        'exposure.demo.executive': {
          name: 'executive_dashboard',
          meta: { dql: { scope: 'customer_success' } },
          owner: { email: 'success@example.com' },
          depends_on: { nodes: ['model.demo.exposed'] },
        },
      },
    });
    writeFileSync(join(projectRoot, 'target', 'semantic_manifest.json'), JSON.stringify({
      semantic_models: [{
        name: 'semantic_orders',
        domain: 'marketing',
        depends_on: { nodes: ['model.demo.semantic'] },
      }],
    }));

    const report = discoverDbtDomains({ projectRoot, dbtManifestPath: manifestPath });
    const membership = Object.fromEntries(report.memberships.map((item) => [item.dbtUniqueId, item]));

    expect(membership['model.demo.explicit']).toMatchObject({
      proposedDomain: 'commerce', confidence: 'high', conflicts: ['finance', 'growth', 'sales'],
    });
    expect(membership['model.demo.explicit'].evidence.map((item) => item.kind)).toEqual([
      'explicit_meta', 'dbt_group', 'dbt_tag', 'model_path',
    ]);
    expect(membership['model.demo.grouped']).toMatchObject({
      proposedDomain: 'finance', owner: 'finance@example.com', confidence: 'high',
    });
    expect(membership['model.demo.semantic'].proposedDomain).toBe('marketing');
    expect(membership['model.demo.exposed']).toMatchObject({
      proposedDomain: 'customer_success', owner: 'success@example.com',
    });
    expect(membership['model.demo.tagged'].proposedDomain).toBe('sales');
    expect(membership['model.demo.selected']).toMatchObject({
      proposedDomain: 'operations', owner: 'ops@example.com',
    });
    expect(membership['model.demo.selected'].evidence.map((item) => item.kind)).toEqual([
      'configured_selector', 'model_path',
    ]);
    expect(membership['model.demo.path_only']).toMatchObject({
      proposedDomain: 'growth.acquisition', confidence: 'low',
    });
    expect(report.proposals.find((proposal) => proposal.id === 'growth.acquisition')).toMatchObject({
      proposedParent: 'growth', matchedDbtUniqueIds: ['model.demo.path_only'], requiresReview: true,
    });
  });

  it('leaves same-rank ambiguity and missing evidence unassigned', () => {
    writeManifest({
      nodes: {
        'model.demo.ambiguous': model('ambiguous', 'ambiguous.sql', { tags: ['finance', 'sales'] }),
        'model.demo.unknown': model('unknown', 'unknown.sql'),
      },
    });

    const report = discoverDbtDomains({ projectRoot, dbtManifestPath: manifestPath });
    expect(report.memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ dbtUniqueId: 'model.demo.ambiguous', proposedDomain: null, requiresReview: true }),
      expect.objectContaining({ dbtUniqueId: 'model.demo.unknown', proposedDomain: null, requiresReview: true }),
    ]));
    expect(report.unassignedModels).toEqual([
      expect.objectContaining({
        dbtUniqueId: 'model.demo.ambiguous',
        reason: 'ambiguous_membership',
        candidateDomains: ['finance', 'sales'],
      }),
      expect.objectContaining({ dbtUniqueId: 'model.demo.unknown', reason: 'no_evidence', candidateDomains: [] }),
    ]);
  });

  it('emits only review-required relationship and skill draft candidates', () => {
    writeManifest({
      nodes: {
        'model.demo.orders': model('orders', 'models/commerce/orders.sql', { meta: { dql: { domain: 'commerce' } } }),
        'model.demo.customers': model('customers', 'models/commerce/customers.sql', { meta: { dql: { domain: 'commerce' } } }),
        'test.demo.orders_customer': {
          resource_type: 'test',
          name: 'relationships_orders_customer_id',
          attached_node: 'model.demo.orders',
          column_name: 'customer_id',
          original_file_path: 'models/commerce/schema.yml',
          depends_on: { nodes: ['model.demo.orders', 'model.demo.customers'] },
          test_metadata: { name: 'relationships', kwargs: { field: 'customer_id' } },
        },
      },
    });

    const report = discoverDbtDomains({ projectRoot, dbtManifestPath: manifestPath });
    expect(report.relationshipDraftCandidates).toEqual([
      expect.objectContaining({
        lifecycle: 'draft', requiresReview: true, automaticJoinAllowed: false,
        fromDbtUniqueId: 'model.demo.orders', toDbtUniqueId: 'model.demo.customers',
        keys: [{ from: 'customer_id', to: 'customer_id' }],
      }),
    ]);
    expect(report.skillDraftCandidates).toEqual([
      expect.objectContaining({
        id: 'commerce_analyst', domain: 'commerce', lifecycle: 'draft',
        requiresReview: true, certificationAllowed: false,
      }),
    ]);
  });

  it('is byte-for-byte deterministic for unchanged artifacts', () => {
    writeManifest({
      nodes: {
        'model.demo.orders': model('orders', 'models/commerce/orders.sql', { group: 'commerce' }),
      },
    });
    const first = JSON.stringify(discoverDbtDomains({ projectRoot, dbtManifestPath: manifestPath }));
    const second = JSON.stringify(discoverDbtDomains({ projectRoot, dbtManifestPath: manifestPath }));
    expect(second).toBe(first);
  });

  it('never makes a layer folder a Domain; with nothing else to go on, the project is one Domain (RFC 0012)', () => {
    writeManifest({
      metadata: { project_name: 'nba_analysis' },
      nodes: {
        'model.nba_analysis.dim_teams': model('dim_teams', 'models/dim/dim_teams.sql'),
        'model.nba_analysis.fct_games': model('fct_games', 'models/fct/fct_games.sql'),
        'model.nba_analysis.stg_players': model('stg_players', 'models/stg/stg_players.sql'),
        'model.nba_analysis.local_player_game_facts': model('local_player_game_facts', 'models/local/local_player_game_facts.sql'),
      },
    });
    const report = discoverDbtDomains({ projectRoot, dbtManifestPath: manifestPath });
    expect(report.proposals.map((proposal) => proposal.id)).toEqual(['nba_analysis']);
    expect(report.proposals[0]).toMatchObject({ matchedDbtUniqueIds: expect.arrayContaining(['model.nba_analysis.local_player_game_facts']), requiresReview: true });
    expect(report.memberships.every((membership) => membership.evidence.every((item) => item.kind === 'dbt_project'))).toBe(true);
    expect(report.unassignedModels).toEqual([]);

    // A business folder still names a Domain, and then the rest stay for a person to place.
    writeManifest({
      nodes: {
        'model.demo.revenue': model('revenue', 'models/marts/finance/revenue.sql'),
        'model.demo.dim_teams': model('dim_teams', 'models/dim/dim_teams.sql'),
      },
    });
    const mixed = discoverDbtDomains({ projectRoot, dbtManifestPath: manifestPath });
    expect(mixed.proposals.map((proposal) => proposal.id)).toEqual(['finance']);
    expect(mixed.unassignedModels.map((item) => item.dbtUniqueId)).toEqual(['model.demo.dim_teams']);
  });

  function writeManifest(value: Record<string, unknown>): void {
    writeFileSync(manifestPath, JSON.stringify({
      metadata: { project_name: 'demo' },
      nodes: {},
      sources: {},
      exposures: {},
      semantic_models: {},
      groups: {},
      ...value,
    }, null, 2));
  }
});

function model(name: string, path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource_type: 'model',
    name,
    alias: name,
    original_file_path: path,
    depends_on: { nodes: [] },
    tags: [],
    ...extra,
  };
}
