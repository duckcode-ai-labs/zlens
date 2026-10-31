import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSemanticLayerFromDir } from '@zlens/core';

import { listProposals } from '../list-proposals.js';
import { makeCtx } from './_helpers.js';

interface DraftSourceDqlMetadata {
  kind: string;
  name: string;
  path: string;
  hash: string;
  metrics?: string[];
  dimensions?: string[];
}

interface DraftFields {
  question: string;
  askedTimes?: number;
  lastAsked?: string;
  domain?: string;
  entity?: string;
  sourceDql?: DraftSourceDqlMetadata;
}

function writeDraft(
  root: string,
  slug: string,
  fields: DraftFields,
) {
  writeDraftAt(root, join(root, 'blocks', '_drafts'), slug, fields);
}

function writeDomainDraft(
  root: string,
  domain: string,
  slug: string,
  fields: Omit<DraftFields, 'domain'>,
) {
  writeDraftAt(root, join(root, 'domains', domain, 'blocks', '_drafts'), slug, { ...fields, domain });
}

function writeDraftAt(
  root: string,
  draftDir: string,
  slug: string,
  fields: DraftFields,
) {
  mkdirSync(draftDir, { recursive: true });
  const askedTimes = fields.askedTimes ?? 1;
  const lastAsked = fields.lastAsked ?? '2026-05-01T12:00:00Z';
  const domain = fields.domain ?? 'misc';
  const entity = fields.entity ?? 'Unknown';
  const proposedId = `${domain}.${entity}.${slug}`;
  const sourceDql = fields.sourceDql
    ? `
        source_dql_kind = "${fields.sourceDql.kind}"
        source_dql_name = "${fields.sourceDql.name}"
        source_dql_path = "${fields.sourceDql.path}"
        source_dql_hash = "${fields.sourceDql.hash}"
        source_dql_metrics = [${(fields.sourceDql.metrics ?? []).map((metric) => `"${metric}"`).join(', ')}]
        source_dql_dimensions = [${(fields.sourceDql.dimensions ?? []).map((dimension) => `"${dimension}"`).join(', ')}]`
    : '';
  writeFileSync(
    join(draftDir, `${slug}.dql`),
    `block "${slug}" {
    domain = "${domain}"
    type = "custom"
    status = "draft"
    description = """${fields.question}"""
    datalex_contract = ""

    _proposed {
        asked_times = ${askedTimes}
        first_asked = "2026-04-01T00:00:00Z"
        last_asked = "${lastAsked}"
        proposed_contract_id = "${proposedId}"
        proposed_domain = "${domain}"
        proposed_entity = "${entity}"
        upstream_refs = ["fct_orders", "dim_customers"]
${sourceDql}
    }

    query = """SELECT 1"""
}
`,
  );
}

describe('listProposals', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'dql-list-'));
  });
  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('returns an empty list when blocks/_drafts/ does not exist', () => {
    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));
    expect(out.proposals).toEqual([]);
  });

  it('parses proposal fields out of the _proposed block', () => {
    writeDraft(tmpProject, 'monthly_active_customers', {
      question: 'How many active customers each month?',
      askedTimes: 4,
      domain: 'customer',
      entity: 'Customer',
    });
    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      slug: 'monthly_active_customers',
      askedTimes: 4,
      proposedDomain: 'customer',
      proposedEntity: 'Customer',
      proposedContractId: 'customer.Customer.monthly_active_customers',
      upstreamRefs: ['fct_orders', 'dim_customers'],
    });
    expect(out.proposals[0].certifyHint).toContain('zlens certify --from-draft');
    expect(out.proposals[0].certifyHint).toContain('--domain customer');
  });

  it('surfaces generated draft source DQL lineage for proposal review', () => {
    writeDraft(tmpProject, 'product_supply_value', {
      question: 'Can you include the product details with previous results?',
      askedTimes: 2,
      domain: 'supply_chain',
      entity: 'ProductSupply',
      sourceDql: {
        kind: 'certified_block',
        name: 'product_supply_breakdown',
        path: 'domains/supply_chain/blocks/product_supply_breakdown.dql',
        hash: 'abc123',
        metrics: ['supply_cost'],
        dimensions: ['product_id', 'supply_id'],
      },
    });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));

    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].sourceDqlArtifact).toEqual({
      kind: 'certified_block',
      name: 'product_supply_breakdown',
      path: 'domains/supply_chain/blocks/product_supply_breakdown.dql',
      hash: 'abc123',
      metrics: ['supply_cost'],
      dimensions: ['product_id', 'supply_id'],
    });
  });

  it('includes domain-first draft proposals in the review queue', () => {
    writeDomainDraft(tmpProject, 'finance', 'enterprise_revenue_by_week', {
      question: 'Break enterprise revenue by week',
      askedTimes: 6,
      entity: 'Revenue',
    });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));

    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      draftPath: 'domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql',
      slug: 'enterprise_revenue_by_week',
      askedTimes: 6,
      proposedDomain: 'finance',
      proposedEntity: 'Revenue',
    });
    expect(out.proposals[0].certifyHint).toContain('zlens certify --from-draft domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql');
  });

  it('ranks by askedTimes DESC, then lastAsked DESC', () => {
    writeDraft(tmpProject, 'high', { question: 'frequent', askedTimes: 9, lastAsked: '2026-04-30T00:00:00Z' });
    writeDraft(tmpProject, 'low_recent', { question: 'rare but recent', askedTimes: 1, lastAsked: '2026-05-01T18:00:00Z' });
    writeDraft(tmpProject, 'medium', { question: 'middle', askedTimes: 3, lastAsked: '2026-04-15T00:00:00Z' });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));
    expect(out.proposals.map((p) => p.slug)).toEqual(['high', 'medium', 'low_recent']);
  });

  it('honors askedAtLeastTimes filter', () => {
    writeDraft(tmpProject, 'a', { question: 'a', askedTimes: 1 });
    writeDraft(tmpProject, 'b', { question: 'b', askedTimes: 5 });
    writeDraft(tmpProject, 'c', { question: 'c', askedTimes: 3 });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never), {
      askedAtLeastTimes: 3,
    });
    expect(out.proposals.map((p) => p.slug).sort()).toEqual(['b', 'c']);
  });

  it('honors since filter (drops drafts whose lastAsked is older)', () => {
    writeDraft(tmpProject, 'old', { question: 'old', lastAsked: '2026-04-01T00:00:00Z' });
    writeDraft(tmpProject, 'new', { question: 'new', lastAsked: '2026-05-01T18:00:00Z' });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never), {
      since: '2026-05-01T00:00:00Z',
    });
    expect(out.proposals.map((p) => p.slug)).toEqual(['new']);
  });

  it('surfaces semantic definitions marked pending_recertification in the proposal queue', () => {
    const semanticDir = join(tmpProject, 'semantic-layer');
    mkdirSync(join(semanticDir, 'metrics'), { recursive: true });
    mkdirSync(join(semanticDir, 'dimensions'), { recursive: true });
    writeFileSync(join(semanticDir, 'metrics', 'revenue.yaml'), [
      'name: total_revenue',
      'label: Total Revenue',
      'description: Revenue requiring recertification',
      'domain: finance',
      'status: pending_recertification',
      'owner: finance@example.com',
      'sql: SUM(amount)',
      'type: sum',
      'table: mart.orders',
      '',
    ].join('\n'));
    writeFileSync(join(semanticDir, 'dimensions', 'segment.yaml'), [
      'name: customer_segment',
      'label: Customer Segment',
      'description: Certified dimension that is not pending',
      'domain: finance',
      'status: certified',
      'sql: segment',
      'type: string',
      'table: mart.orders',
      '',
    ].join('\n'));

    const out = listProposals(makeCtx({}, {
      projectRoot: tmpProject,
      semanticLayer: loadSemanticLayerFromDir(semanticDir),
    } as never));

    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      kind: 'semantic_recertification',
      artifactType: 'metric',
      draftPath: 'semantic-layer/metrics/revenue.yaml',
      slug: 'total_revenue',
      proposedContractId: 'semantic.metric.total_revenue',
      proposedDomain: 'finance',
      proposedEntity: 'total_revenue',
      upstreamRefs: ['mart.orders'],
      status: 'pending_recertification',
    });
    expect(out.proposals[0].certifyHint).toContain('set status to "certified"');
  });

  it('surfaces composted semantic metric drafts in the proposal queue', () => {
    const semanticDir = join(tmpProject, 'semantic-layer');
    mkdirSync(join(semanticDir, 'metrics', '_drafts', 'sales'), { recursive: true });
    writeFileSync(join(semanticDir, 'metrics', '_drafts', 'sales', 'completed_revenue.yaml'), [
      'name: completed_revenue',
      'label: Completed Revenue',
      'description: Draft metric composted from recurring certified blocks.',
      'domain: sales',
      'status: draft',
      'owner: sales@example.com',
      'sql: SUM(amount)',
      'type: sum',
      'table: analytics.orders',
      "filter: status = 'completed'",
      'source:',
      '  provider: dql',
      '  objectType: composted_metric',
      '  objectId: composted:completed_revenue',
      '  objectName: Completed Revenue',
      '  importedAt: "2026-05-03T12:00:00.000Z"',
      '  extra:',
      '    support: 3',
      '    donorBlocks:',
      '      - Revenue by Product',
      '      - Revenue by Region',
      '      - Revenue by Channel',
      '    donorPaths:',
      '      - blocks/revenue_by_product.dql',
      '      - blocks/revenue_by_region.dql',
      '      - blocks/revenue_by_channel.dql',
      '',
    ].join('\n'));

    const out = listProposals(makeCtx({}, {
      projectRoot: tmpProject,
      semanticLayer: loadSemanticLayerFromDir(semanticDir),
    } as never), {
      askedAtLeastTimes: 2,
      since: '2026-05-01T00:00:00Z',
    });

    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      kind: 'semantic_metric_draft',
      artifactType: 'metric',
      draftPath: 'semantic-layer/metrics/_drafts/sales/completed_revenue.yaml',
      slug: 'completed_revenue',
      askedTimes: 3,
      lastAsked: '2026-05-03T12:00:00.000Z',
      proposedContractId: 'semantic.metric.completed_revenue',
      proposedDomain: 'sales',
      proposedEntity: 'completed_revenue',
      upstreamRefs: expect.arrayContaining([
        'analytics.orders',
        'blocks/revenue_by_product.dql',
        'Revenue by Product',
      ]),
      status: 'draft',
    });
    expect(out.proposals[0].certifyHint).toContain('zlens semantic approve completed_revenue');
  });
});
