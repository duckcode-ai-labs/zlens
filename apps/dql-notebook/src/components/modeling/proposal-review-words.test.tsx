import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContextAuthoringProposalV1 } from '../../api/client';
import { themes } from '../../themes/notebook-theme';
import { ContextProposalReviewDrawer } from './ContextProposalReviewDrawer';
import {
  describeProposalOperation,
  groupProposalDiagnostics,
  proposalReviewTitle,
  proposalScopeNames,
  stagingLeftOutSentence,
  waitingDraftsSentence,
} from './proposal-review-words';

const entity = (table: string, name: string) => ({
  id: `warehouse:entity:jaffle_shop:${table}`,
  kind: 'modeling_change' as const,
  change: { operation: 'upsert_entity', value: { id: table, domain: 'jaffle_shop', areaId: 'core', dbtModel: `warehouse.jaffle_shop.dev.${table}`, businessName: name, status: 'draft' } },
});

/** A database-only first run: thirteen tables placed in the default area, as an older server wrote it (one line each). */
const firstRun = {
  version: 1,
  id: 'proposal-1',
  origin: 'warehouse_discovery',
  status: 'proposed',
  trustState: 'review_required',
  createdAt: '2026-10-21T00:00:00Z',
  baseSnapshotId: 'snap',
  dependencyFingerprints: {},
  operations: [
    { id: 'scope:domain:jaffle_shop', kind: 'modeling_change', change: { operation: 'upsert_domain', value: { id: 'jaffle_shop', name: 'Jaffle shop' } } },
    { id: 'scope:area:jaffle_shop:core', kind: 'modeling_change', change: { operation: 'upsert_area', value: { id: 'core', domain: 'jaffle_shop', name: 'Core models' } } },
    entity('customers', 'Customer'),
    entity('orders', 'Order'),
  ],
  patches: [{ path: 'domains/jaffle-shop/domain.dql', before: '', after: 'domain', changed: true, owner: 'dql', operationId: 'scope:domain:jaffle_shop' }],
  diagnostics: Array.from({ length: 13 }, (_, index) => ({ code: 'MODEL_AREA_DEFAULTED', severity: 'info', operationId: `op-${index}`, message: 'No subject area was selected, so these models were placed in "core". You can rename or move them later.' })),
  impact: { files: 1, modelingChanges: 4, skillChanges: 0, dbtSourceChanges: 0, datasetChanges: 0 },
  proposalHash: 'abcdef0123456789',
} as unknown as ContextAuthoringProposalV1;

describe('the proposal review in plain words (new-user round 2, Q3)', () => {
  it('groups repeated notes into one plain line, keeping each one for the technical details', () => {
    const groups = groupProposalDiagnostics(firstRun.diagnostics, 'warehouse_discovery');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ code: 'MODEL_AREA_DEFAULTED', count: 13, summary: '13 tables placed in the default area. You can rename or move them later.' });
    expect(groups[0]!.details).toHaveLength(13);
  });

  it('keeps a note the server already grouped, and puts blocking notes first', () => {
    const groups = groupProposalDiagnostics([
      { code: 'MODEL_AREA_DEFAULTED', severity: 'info', message: '3 tables placed in the default area. You can rename or move them later.', operationIds: ['a', 'b', 'c'] },
      { code: 'AI_DELETE_FORBIDDEN', severity: 'blocking', message: 'Modeling AI cannot delete governed source.' },
      { code: 'AI_DELETE_FORBIDDEN', severity: 'blocking', message: 'Modeling AI cannot delete governed source.' },
    ], 'ai');
    expect(groups.map((group) => group.summary)).toEqual([
      'Modeling AI cannot delete governed source. (and 1 more note like this)',
      '3 tables placed in the default area. You can rename or move them later.',
    ]);
  });

  it('says what each change does, in the Domain name, never an internal id', () => {
    const names = proposalScopeNames(firstRun);
    expect(firstRun.operations.map((operation) => describeProposalOperation(operation, names))).toEqual([
      'Create the Domain Jaffle shop',
      'Create the area Core models in Jaffle shop',
      'Add customers as Customer in Jaffle shop / Core models',
      'Add orders as Order in Jaffle shop / Core models',
    ]);
    expect(proposalReviewTitle('warehouse_discovery')).toBe('Review the models ZLens drafted');
  });

  it('renders one grouped line and hides codes and ids under Technical details', () => {
    const html = renderToStaticMarkup(<ContextProposalReviewDrawer proposal={firstRun} theme={themes.paper} onClose={() => undefined} onCommitted={() => undefined} onDiscarded={() => undefined} />);
    expect(html).toContain('Review the models ZLens drafted');
    expect(html).toContain('Drafted from your database · needs review');
    expect(html).not.toContain('immutable revision');
    expect(html.match(/13 tables placed in the default area/g)).toHaveLength(1);
    expect(html).toContain('kept until you save or discard them');
    expect(html).toContain('>Keep for later</button>');
    expect(html).toContain('Discard drafts');
    // Codes and ids appear only inside the Technical details disclosure.
    const technical = html.indexOf('Technical details');
    expect(technical).toBeGreaterThan(0);
    for (const internal of ['MODEL_AREA_DEFAULTED', 'scope:domain:jaffle_shop', 'abcdef012345']) {
      expect(html.indexOf(internal), internal).toBeGreaterThan(technical);
    }
  });

  it('says how many drafts wait, and which staging tables were left out', () => {
    expect(waitingDraftsSentence({ models: 9, joins: 12, domains: ['Jaffle shop'] })).toBe('9 drafted models waiting for review in Jaffle shop. They are kept until you save or discard them.');
    expect(waitingDraftsSentence({ models: 1, joins: 0, domains: [] })).toBe('1 drafted model waiting for review. They are kept until you save or discard them.');
    expect(stagingLeftOutSentence([{ relation: 'dev.stg_a' }, { relation: 'dev.stg_b' }, { relation: 'dev.stg_c' }, { relation: 'dev.stg_d' }])).toBe('Left out 4 staging tables (stg_a, stg_b, stg_c, +1 more): a final table holds the same data.');
  });
});
