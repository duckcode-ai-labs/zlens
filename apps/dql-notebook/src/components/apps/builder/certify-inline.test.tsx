import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DatasetJoin } from '@zlens/core/datasets/descriptor';
import type { AppBlockRecommendation, CertifyReview, JoinCertifyReview } from '../../../api/client';
import { NotCertifiedTilesSection } from '../AppStudioV2';
import type { NotCertifiedPublicationTile } from '../app-studio-publish-readiness';
import { CertifyJoinDialog } from './CertifyJoinDialog';
import { CertifyReviewDialog, certifyReviewVouch } from './CertifyReviewDialog';
import { DataPanel } from './DataPanel';
import { orderLinesDataset } from './app-data.fixtures';
import { joinsToCertify } from './app-data';

/**
 * Certify everything from where you are (T4): a saved query and a join each
 * get the same short review as a table, with the same "I vouch for this —
 * certify" button, in the publish dialog and the Data list's ⋯ menu.
 */
const savedQueryReview: CertifyReview = {
  sourceId: 'app:block:shop:top', sourceRevision: 'sha256:r', name: 'top_customers', kind: 'saved_query', origin: 'saved_query', lifecycle: 'draft', certified: false,
  numbers: [], joins: [], hiddenColumns: [], checks: [], canVouch: true,
  blockStudioPath: 'domains/shop/blocks/top.dql',
  savedQuery: {
    runs: { ok: true, sentence: 'Ran just now: 12 rows.' },
    tests: [{ name: 'row_count > 0', passed: true }, { name: 'revenue >= 0', passed: true }],
    testsSentence: 'All 2 tests pass.',
    ownerRequired: true,
    row: 'One row for each customer.',
    blockers: [],
    checks: [],
  },
};

const joinReview: JoinCertifyReview = {
  sourceId: 'app:block:shop:orders', joinId: 'location', name: 'Orders → Location', from: 'orders', to: 'locations',
  keysSentence: 'orders.location_id = locations.location_id',
  checkedSentence: 'each order has one location — checked on 61,948 rows',
  checkLines: ['Every order with a key finds its location.'],
  doubleCount: 'If locations had two rows for one location_id, every order with that value would be joined twice, so totals such as order total would be counted more than once.',
  blockers: [],
  fills: [{ side: 'to', table: 'locations', grain: 'location_id', keys: ['location_id'], because: 'location_id is filled and different on every one of 6 rows of locations, checked just now.' }],
  canVouch: true, origin: 'drafted', relationshipId: 'shop::relationship::orders_to_locations', checkedAt: '2026-10-22T10:00:00.000Z',
};

describe('a saved query certifies in its own short review (T4)', () => {
  it('shows that it runs, its tests, who owns it and what one row is, with a link to the saved query editor', () => {
    const html = renderToStaticMarkup(<CertifyReviewDialog sourceId={savedQueryReview.sourceId} initialReview={savedQueryReview} onClose={vi.fn()} onCertified={vi.fn()} onOpenBlockStudio={vi.fn()} />);
    expect(html).toContain('Certify Top Customers');
    expect(html).toContain('A short review. Certifying says you looked at it and vouch for these numbers.');
    expect(html).toContain('aria-label="It runs"');
    expect(html).toContain('Ran just now: 12 rows.');
    expect(html).toContain('All 2 tests pass.');
    expect(html).toContain('row_count &gt; 0 · passed');
    expect(html).toContain('aria-label="Who owns it"');
    expect(html).toContain('Nobody owns it yet.');
    expect(html).toContain('aria-label="Owner"');
    expect(html).toContain('One row for each customer.');
    expect(html).toContain('Open in the saved query editor');
    // Nobody named yet: the button waits for an owner.
    expect(html).toMatch(/<button type="button" class="primary" disabled="">I vouch for this — certify<\/button>/);
    expect(html).not.toContain('Block Studio');
  });

  it('is ready once someone owns it, and sends the owner typed in only when the source names nobody', () => {
    expect(certifyReviewVouch(savedQueryReview, '')).toEqual({ enabled: false });
    expect(certifyReviewVouch(savedQueryReview, '  Maria Lopez ')).toEqual({ enabled: true, owner: 'Maria Lopez' });
    const owned = { ...savedQueryReview, savedQuery: { ...savedQueryReview.savedQuery!, ownerRequired: false, owner: 'Maria Lopez' } };
    expect(certifyReviewVouch(owned, 'ignored')).toEqual({ enabled: true });
    const html = renderToStaticMarkup(<CertifyReviewDialog sourceId={owned.sourceId} initialReview={owned} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(html).toContain('<p>Maria Lopez</p>');
    expect(html).not.toContain('aria-label="Owner"');
    expect(html).not.toMatch(/<button type="button" class="primary" disabled="">/);
  });

  it('will not vouch while a test fails or it does not run, and says why', () => {
    const failing = { ...savedQueryReview, canVouch: false, savedQuery: { ...savedQueryReview.savedQuery!, ownerRequired: false, owner: 'Maria', tests: [{ name: 'row_count > 1000000', passed: false, error: 'expected more rows' }], testsSentence: '1 of 1 test failed.', blockers: ['One or more declared tests did not pass against the latest preview result.'] } };
    expect(certifyReviewVouch(failing, '')).toEqual({ enabled: false });
    const html = renderToStaticMarkup(<CertifyReviewDialog sourceId={failing.sourceId} initialReview={failing} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(html).toContain('1 of 1 test failed.');
    expect(html).toContain('row_count &gt; 1000000 · failed: expected more rows');
    expect(html).toContain('Not ready to certify:');
    expect(html).toMatch(/<button type="button" class="primary" disabled="">I vouch for this — certify<\/button>/);
    const broken = { ...savedQueryReview, canVouch: false, savedQuery: { ...savedQueryReview.savedQuery!, runs: { ok: false as const, error: 'Table missing does not exist.' } } };
    expect(renderToStaticMarkup(<CertifyReviewDialog sourceId={broken.sourceId} initialReview={broken} onClose={vi.fn()} onCertified={vi.fn()} />)).toContain('Table missing does not exist.');
  });

  it('a table keeps its own review and button', () => {
    expect(certifyReviewVouch({ ...savedQueryReview, kind: 'dataset', savedQuery: undefined, keyCheck: { ok: true, sentence: 'ok' } }, '')).toEqual({ enabled: true });
    expect(certifyReviewVouch({ ...savedQueryReview, kind: 'dataset', savedQuery: undefined, keyCheck: { ok: false, error: 'repeats' } }, '')).toEqual({ enabled: false });
    expect(certifyReviewVouch({ ...savedQueryReview, kind: 'metrics', savedQuery: undefined }, '')).toEqual({ enabled: false });
  });
});

describe('a join certifies in its own short review (T4)', () => {
  it('shows the keys, the fresh check, what would double-count, what it fills, and one button', () => {
    const html = renderToStaticMarkup(<CertifyJoinDialog sourceId={joinReview.sourceId} joinId={joinReview.joinId} initialReview={joinReview} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(html).toContain('Certify the join Orders → Location');
    expect(html).toContain('orders.location_id = locations.location_id');
    expect(html).toContain('each order has one location — checked on 61,948 rows');
    expect(html).toContain('Every order with a key finds its location.');
    expect(html).toContain('What would double-count if it were wrong');
    expect(html).toContain('totals such as order total would be counted more than once');
    expect(html).toContain('Filled in the model from these checks');
    expect(html).toContain('locations: one row per location_id');
    expect(html).toContain('Modeling shows it certified');
    expect(html).toContain('I vouch for this join — certify');
    expect(html).not.toMatch(/<button type="button" class="primary" disabled="">/);
    expect(html).not.toMatch(/Open Modeling|set them in the model/i);
  });

  it('refuses a join whose check fails: it says why and the button waits', () => {
    const failing = { ...joinReview, checkedSentence: undefined, fills: [], canVouch: false, blockers: ['The check did not pass: The declared many_to_one does not hold: locations holds up to 2 rows for one key.'] };
    const html = renderToStaticMarkup(<CertifyJoinDialog sourceId={failing.sourceId} joinId={failing.joinId} initialReview={failing} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(html).toContain('Not certified:');
    expect(html).toContain('locations holds up to 2 rows for one key');
    expect(html).not.toContain('checked on');
    expect(html).not.toContain('Filled in the model');
    expect(html).toMatch(/<button type="button" class="primary" disabled="">I vouch for this join — certify<\/button>/);
  });

  it('says when the join changed since it was certified', () => {
    const html = renderToStaticMarkup(<CertifyJoinDialog sourceId={joinReview.sourceId} joinId={joinReview.joinId} initialReview={{ ...joinReview, previousCertification: { by: 'maria@example.test', at: '2026-10-22T09:00:00.000Z' } }} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(html).toContain('Changed since it was certified on 22 Oct');
  });

  it('says it is checking while the review loads', () => {
    const html = renderToStaticMarkup(<CertifyJoinDialog sourceId="s" joinId="j" name="Orders → Location" loadReview={() => new Promise(() => undefined)} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(html).toContain('Certify the join Orders → Location');
    expect(html).toContain('Checking the join on the data…');
    expect(html).not.toContain('I vouch for this join');
  });
});

/** The first element in a rendered tree whose aria-label matches. */
function byLabel(node: ReactNode, label: string): ReactElement<{ onClick?: () => void; children?: ReactNode }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = byLabel(child, label);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const props = node.props as { 'aria-label'?: string; children?: ReactNode };
  if (props['aria-label'] === label) return node as ReactElement<{ onClick?: () => void; children?: ReactNode }>;
  return byLabel(props.children, label);
}

describe('the publish dialog opens each review in place (T4)', () => {
  const join: DatasetJoin = { id: 'location', label: 'Location', table: 'locations', relation: '"main"."locations"', keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', trust: 'review_required', origin: 'drafted', relationshipId: 'p1:op1', uniqueness: 'recheck', sentence: 'each order has one location' };
  const savedQuerySource = { id: 'app:block:shop:top', kind: 'block', sourceRef: 'domains/shop/blocks/top.dql' } as never;
  const tiles: NotCertifiedPublicationTile[] = [
    { pageId: 'overview', tileId: 'store', title: 'Orders by store', detail: 'Uses a join nobody has certified.', sourceName: 'orders', action: { kind: 'join', joins: [join], review: { pageId: 'overview', tileId: 'store', sourceId: 'app:block:shop:orders', joins: [join], relatedFields: ['location__location_name'], filterIds: [] } } },
    { pageId: 'overview', tileId: 'top', title: 'Top customers', detail: 'Nobody has certified this saved query yet.', sourceName: 'top_customers', action: { kind: 'saved_query', source: savedQuerySource } },
  ];

  it('"Certify this join" opens the join review for that join and its Dataset; a saved query opens its own review', () => {
    const onCertifyJoin = vi.fn();
    const onOpenSavedQuery = vi.fn();
    const tree = NotCertifiedTilesSection({ title: '2 tiles not certified yet', tiles, required: false, busy: false, onCertifySource: vi.fn(), onOpenSavedQuery, onCertifyJoin, onRemoveRelatedFields: vi.fn(), onOpenFilters: vi.fn() });
    const joinButton = byLabel(tree, 'Certify the join for Orders by store');
    expect(joinButton?.props.children).toBe('Certify this join (recommended)');
    joinButton?.props.onClick?.();
    expect(onCertifyJoin).toHaveBeenCalledWith(join, 'app:block:shop:orders');
    byLabel(tree, 'Certify now: Top Customers')?.props.onClick?.();
    expect(onOpenSavedQuery).toHaveBeenCalledWith(savedQuerySource);
    expect(renderToStaticMarkup(tree)).not.toMatch(/Modeling|Block Studio/);
  });
});

describe('the Data list ⋯ menu offers the same reviews (T4)', () => {
  const join = (id: string, trust: DatasetJoin['trust']): DatasetJoin => ({ id, label: id, table: `${id}s`, relation: `${id}s`, keys: [{ from: `${id}_id`, to: `${id}_id` }], cardinality: 'many_to_one', trust, origin: 'model', relationshipId: id, uniqueness: 'current', sentence: `each order has one ${id}` });
  const orders = {
    ...orderLinesDataset,
    id: 'app:block:shop:orders', sourceId: 'app:block:shop:orders', name: 'orders', status: 'certified', lifecycle: 'certified', trust: 'certified',
    capabilities: { ...orderLinesDataset.capabilities!, dataset: { ...(orderLinesDataset.capabilities!.dataset as object), joins: [join('customer', 'certified'), join('location', 'review_required')] } },
  } as unknown as AppBlockRecommendation;

  it('lists the joins nobody certified yet, and shows ⋯ for certified data that has one', () => {
    expect(joinsToCertify(orders).map((item) => item.id)).toEqual(['location']);
    expect(joinsToCertify(orderLinesDataset)).toEqual([]);
    const html = renderToStaticMarkup(<DataPanel appData={[orders]} active={orders} target={{ kind: 'none' }} disabled={false} onChoose={vi.fn()} onPickField={vi.fn()} onAddData={vi.fn()} onAddSavedQuery={vi.fn()} onAddContent={vi.fn()} onCertify={vi.fn()} onCertifyJoin={vi.fn()} />);
    expect(html).toContain('aria-label="More for Orders"');
    const without = renderToStaticMarkup(<DataPanel appData={[orders]} active={orders} target={{ kind: 'none' }} disabled={false} onChoose={vi.fn()} onPickField={vi.fn()} onAddData={vi.fn()} onAddSavedQuery={vi.fn()} onAddContent={vi.fn()} onCertify={vi.fn()} />);
    expect(without).not.toContain('aria-label="More for Orders"');
  });
});
