import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddDbtMetricDrawer, semanticModelsOnDbtModel } from '../components/modeling/DbtFirstModelingPage';
import type { DbtFirstModelingResponse } from '../api/client';
import { themes } from '../themes/notebook-theme';
import { hostReadOnly, readOnlyReason, type HostUi } from './host-ui';

const data = {
  snapshotId: 'snapshot-1',
  dbtProvenance: { nodes: { 'model.harbor.claims': { uniqueId: 'model.harbor.claims', name: 'claims', resourceType: 'model' } } },
  modeling: { packages: {} },
} as unknown as DbtFirstModelingResponse;

const hosted = (capabilities: Record<string, boolean>, refusals?: HostUi['refusals']): HostUi => (
  { host: true, person: { id: 'u1', name: 'Cleo', kind: 'person' }, capabilities, links: [], answerActions: [], ...(refusals ? { refusals } : {}) }
);

const drawer = (props: { semanticModels?: DbtFirstModelingResponse['semanticModels']; initialNodeId?: string }) => renderToStaticMarkup(
  <AddDbtMetricDrawer data={{ ...data, semanticModels: props.semanticModels }} domain="claims" snapshotId="snapshot-1" initialNodeId={props.initialNodeId} t={themes.paper} onClose={() => undefined} onApplied={async () => undefined} />,
);

describe('Add metric on a dbt model that may already have a semantic model', () => {
  const inSemanticLayer = { name: 'claims', dbtModel: 'claims', path: 'semantic-layer/semantic_models/claims.yaml', owner: 'semantic-layer' as const };
  const inDbt = { name: 'claims_mf', dbtModel: 'claims', path: 'models/claims_semantic.yml', owner: 'dbt' as const };

  it('pre-selects the semantic model on the dbt model and asks for nothing a new one needs', () => {
    const html = drawer({ semanticModels: [inSemanticLayer], initialNodeId: 'model.harbor.claims' });
    expect(html).toContain('Semantic model');
    expect(html).toContain('claims (semantic-layer/semantic_models/claims.yaml)');
    expect(html).toContain('selected=""');
    expect(html).not.toContain('This dbt model has no semantic model yet');
    expect(html).not.toContain('Primary entity');
  });

  it('says the metric goes to the semantic layer when that is where the model lives', () => {
    const html = drawer({ semanticModels: [inSemanticLayer], initialNodeId: 'model.harbor.claims' });
    expect(html).toContain('this project&#x27;s semantic layer');
    expect(html).not.toContain('dbt/MetricFlow owns it');
    expect(html).toContain('Preview the change');
  });

  it('keeps the dbt words when dbt owns the semantic model', () => {
    const html = drawer({ semanticModels: [inDbt], initialNodeId: 'model.harbor.claims' });
    expect(html).toContain('dbt/MetricFlow owns it');
    expect(html).toContain('Preview dbt YAML');
    expect(html).not.toContain('This dbt model has no semantic model yet');
  });

  it('offers a new semantic model only for a dbt model that truly has none', () => {
    const html = drawer({ semanticModels: [{ ...inSemanticLayer, name: 'payments', dbtModel: 'claim_payments' }], initialNodeId: 'model.harbor.claims' });
    expect(html).toContain('This dbt model has no semantic model yet');
    expect(html).toContain('Primary entity name');
    expect(drawer({ semanticModels: [] })).not.toContain('This dbt model has no semantic model yet');
  });

  it('matches by dbt model name, whatever the case', () => {
    expect(semanticModelsOnDbtModel([inSemanticLayer, inDbt], 'CLAIMS').map((model) => model.name)).toEqual(['claims', 'claims_mf']);
    expect(semanticModelsOnDbtModel([inSemanticLayer], 'members')).toEqual([]);
    expect(semanticModelsOnDbtModel(undefined, 'claims')).toEqual([]);
    expect(semanticModelsOnDbtModel([inSemanticLayer], undefined)).toEqual([]);
  });
});

describe('Add metric (dbt-first Modeling)', () => {
  it('opens on a form that previews the dbt YAML first and says dbt owns the metric', () => {
    const html = renderToStaticMarkup(
      <AddDbtMetricDrawer data={data} domain="claims" snapshotId="snapshot-1" t={themes.paper} onClose={() => undefined} onApplied={async () => undefined} />,
    );
    expect(html).toContain('Add metric');
    expect(html).toContain('dbt/MetricFlow owns it');
    expect(html).toContain('Preview dbt YAML');
    expect(html).not.toContain('Apply to dbt');
    expect(html).toContain('>claims<');
    for (const label of ['Aggregation', 'Column', 'Metric name', 'Also known as']) expect(html).toContain(label);
  });

  it('is read-only when the host refuses dataset.author, the action its routes are checked as (see dbt-metric-routes.test.ts)', () => {
    const draft = { label: 'Open my draft space', href: '/e/draft' };
    const production = hosted({ 'project.read': true }, { 'dataset.author': { reason: 'Production follows main.', next: draft } });
    expect(hostReadOnly(production, 'domains')).toBe(true);
    expect(readOnlyReason(production, 'domains')).toBe('Production follows main.');
    // In a draft space the same person may author, so the button is offered.
    expect(hostReadOnly(hosted({ 'project.read': true, 'dataset.author': true }), 'domains')).toBe(false);
    // Without a host (local OSS) it is always editable.
    expect(hostReadOnly({ host: false }, 'domains')).toBe(false);
  });
});
