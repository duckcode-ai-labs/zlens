import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContextAuthoringProposalV1 } from '../../api/client';
import { themes } from '../../themes/notebook-theme';
import { ContextProposalReviewDrawer, proposalNeedsUpdate, updateProposalLabel } from './ContextProposalReviewDrawer';
import { DqlApiError } from '../../api/client';
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

describe('a drafted model reviews by group (RFC 0012, P5)', () => {
  it('shows the tables, look-alikes, joins with their checks and measured rules, and offers to accept what passed', () => {
    const drafted = {
      ...firstRun,
      operations: [
        ...firstRun.operations,
        { id: 'warehouse:entity:jaffle_shop:stg_orders', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'stg_orders', domain: 'jaffle_shop', dbtModel: 'warehouse.jaffle_shop.dev.stg_orders', businessName: 'Stg Order', status: 'draft', useInstead: { entity: 'orders', reason: 'a staging table (named stg_…); orders is the final table with the same rows' } } } },
        { id: 'warehouse:relationship:jaffle_shop:order_to_customer', kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'order_to_customer', domain: 'jaffle_shop', from: 'orders', to: 'customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'draft', validation: { status: 'passed' } } } },
        { id: 'warehouse:relationship:jaffle_shop:order_to_store', kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'order_to_store', domain: 'jaffle_shop', from: 'orders', to: 'stores', keys: [{ from: 'store_id', to: 'id' }], cardinality: 'many_to_many', fanout: 'forbidden', status: 'draft', validation: { status: 'failed', message: 'stores holds up to 2 rows for one key' } } } },
        { id: 'warehouse:rule:jaffle_shop:order_repeats', kind: 'modeling_change', change: { operation: 'upsert_rule', value: { id: 'order_repeats', domain: 'jaffle_shop', expression: 'orders holds 12 rows for 10 distinct order_id: 2 rows repeat.', status: 'draft', evidence: { query: 'SELECT COUNT(*) FROM orders', measured: { rows: 12 } } } } },
      ],
    } as unknown as ContextAuthoringProposalV1;
    const html = renderToStaticMarkup(<ContextProposalReviewDrawer proposal={drafted} theme={themes.paper} onClose={() => undefined} onCommitted={() => undefined} onDiscarded={() => undefined} />);
    expect(html).toContain('2 tables to answer from · 1 look-alike to skip · 2 joins (1 passed) · 1 measured rule. 1 join needs a look before you keep it.');
    for (const title of ['Tables to answer from', 'Look-alikes Ask will skip', 'Joins', 'Rules measured on the data', 'Other changes']) expect(html).toContain(`>${title}</strong>`);
    expect(html).toContain('Use orders instead.');
    expect(html).toContain('Passed');
    expect(html).toContain('Needs a look');
    expect(html).toContain('stores holds up to 2 rows for one key');
    expect(html).toContain('The query that measured it');
    expect(html).toContain('Accept all that passed');
    // A new Domain reads in words, not as an operation name.
    expect(html).not.toContain('upsert domain');
  });

  it('keeps the plain list for a proposal that drafts no tables or joins', () => {
    const html = renderToStaticMarkup(<ContextProposalReviewDrawer proposal={{ ...firstRun, operations: firstRun.operations.slice(0, 2) }} theme={themes.paper} onClose={() => undefined} onCommitted={() => undefined} onDiscarded={() => undefined} />);
    expect(html).not.toContain('Accept all that passed');
    expect(html).not.toContain('Tables to answer from');
  });
});

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

// New-user round 2, problem 4: the first Save failed with "Rebase proposal".
describe('a reviewed proposal whose files changed', () => {
  it('offers "Update drafts and review again" only for a change to what it writes, never "Rebase"', () => {
    expect(updateProposalLabel('warehouse_discovery')).toBe('Update drafts and review again');
    expect(updateProposalLabel('ai')).toBe('Update and review again');
    expect(proposalNeedsUpdate(new DqlApiError({ message: 'Part of the project these drafts change was edited after you reviewed them (Orders).', status: 409, code: 'PROPOSAL_STALE' }))).toBe(true);
    expect(proposalNeedsUpdate(new DqlApiError({ message: 'Source changed after preview', status: 409, code: 'SOURCE_CHANGED' }))).toBe(true);
    expect(proposalNeedsUpdate(new DqlApiError({ message: 'Resolve all blocking proposal diagnostics before saving.', status: 422, code: 'PROPOSAL_BLOCKED' }))).toBe(false);
    expect(proposalNeedsUpdate(new Error('offline'))).toBe(false);
    const html = renderToStaticMarkup(<ContextProposalReviewDrawer proposal={firstRun} theme={themes.paper} onClose={() => undefined} onCommitted={() => undefined} onDiscarded={() => undefined} />);
    expect(html).not.toMatch(/rebase/i);
  });
});
