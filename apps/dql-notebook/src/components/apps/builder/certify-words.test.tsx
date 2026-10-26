import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DatasetJoin } from '@zlens/core/datasets/descriptor';
import type { AppBlockRecommendation, CertifyReview, JoinCertifyReview } from '../../../api/client';
import { HostUiProvider, type HostUi, type HostUiState } from '../../../host/host-ui';
import { NotCertifiedTilesSection } from '../AppStudioV2';
import type { NotCertifiedPublicationTile } from '../app-studio-publish-readiness';
import { CertifyJoinDialog } from './CertifyJoinDialog';
import { CertifyReviewDialog } from './CertifyReviewDialog';
import { DataPanel } from './DataPanel';
import { certifyWords } from './certify-words';
import { orderLinesDataset } from './app-data.fixtures';

/**
 * RFC 0010 HH-9 `certification: 'proposes'`: under a host where certifying only
 * proposes certification (the host certifies through its own review), every
 * certify word a person reads in the App Studio says "propose" instead. Without
 * a host, and under a host that does not set it, the words are unchanged.
 */
const NO_HOST: HostUiState = { host: false };
function hosted(overrides: Partial<HostUi> = {}): HostUi {
  return { host: true, person: { id: 'u_priya', name: 'Priya Shah', kind: 'person' }, capabilities: { 'dataset.certify': true }, links: [], answerActions: [], ...overrides };
}
const PROPOSES = hosted({ certification: 'proposes' });

function render(state: HostUiState, node: JSX.Element): string {
  return renderToStaticMarkup(<HostUiProvider initial={state}>{node}</HostUiProvider>);
}

const today = new Date().toISOString();
const datasetReview: CertifyReview = {
  sourceId: 'app:block:shop/orders', sourceRevision: 'sha256:r', name: 'Orders', kind: 'dataset', origin: 'table', lifecycle: 'review', certified: false,
  check: { by: 'kranthi@example.test', at: today, byYou: true },
  row: 'Each row is one order (order_id).',
  keyCheck: { ok: true, sentence: 'order_id is filled and different on every row, checked just now.' },
  numbers: [], joins: [], hiddenColumns: [], checks: [], canVouch: true,
};
const savedQueryReview: CertifyReview = {
  sourceId: 'app:block:shop:top', sourceRevision: 'sha256:r', name: 'top_customers', kind: 'saved_query', origin: 'saved_query', lifecycle: 'draft', certified: false,
  numbers: [], joins: [], hiddenColumns: [], checks: [], canVouch: true,
  blockStudioPath: 'domains/shop/blocks/top.dql',
  savedQuery: {
    runs: { ok: true, sentence: 'Ran just now: 12 rows.' },
    tests: [], testsSentence: 'No tests.', ownerRequired: true, row: 'One row for each customer.', blockers: ['It declares no grain.'], checks: [],
  },
};
const joinReview: JoinCertifyReview = {
  sourceId: 'app:block:shop:orders', joinId: 'location', name: 'Orders → Location', from: 'orders', to: 'locations',
  keysSentence: 'orders.location_id = locations.location_id',
  checkedSentence: 'each order has one location — checked on 61,948 rows',
  checkLines: [], doubleCount: 'Totals would be counted more than once.', blockers: [], fills: [],
  canVouch: true, origin: 'drafted', relationshipId: 'shop::relationship::orders_to_locations', checkedAt: '2026-10-22T10:00:00.000Z',
};

describe('the certify words follow the host (RFC 0010 HH-9 certification: proposes)', () => {
  it('without a host, or under a host that does not say, the words certify; under `proposes` they propose', () => {
    expect(certifyWords(NO_HOST).proposes).toBe(false);
    expect(certifyWords(hosted()).proposes).toBe(false);
    expect(certifyWords(NO_HOST)).toBe(certifyWords(hosted()));
    expect(certifyWords(PROPOSES).proposes).toBe(true);
    // No word a person reads under `proposes` claims they certify.
    const words = certifyWords(PROPOSES);
    const everyWord = [
      words.review.heading('Orders'), words.review.intro, words.review.button, words.review.saving, words.review.record, words.review.notReady, words.review.ownerAsk, words.review.couldNot,
      words.join.heading('Orders → Location'), words.join.intro, words.join.button, words.join.saving, words.join.record, words.join.couldNot,
      words.menu.certify, words.menu.certifyHint, words.menu.join('Location'), words.menu.joinHint('each order has one location'),
      words.publish.recommended, words.publish.now, words.publish.nowAria('Orders'), words.publish.join, words.publish.joinAria('Orders by store'),
    ];
    for (const word of everyWord) {
      expect(word, word).not.toMatch(/I vouch|Certifying|Certify |certified it|^Certify/);
      expect(word, word).toMatch(/[Pp]ropos|certification/);
    }
  });

  it('the data review: "I vouch for this — certify" and who certified it, or "Propose for certification" and who proposed it', () => {
    const dialog = <CertifyReviewDialog sourceId={datasetReview.sourceId} initialReview={datasetReview} onClose={vi.fn()} onCertified={vi.fn()} />;
    for (const state of [NO_HOST, hosted()]) {
      const html = render(state, dialog);
      expect(html).toContain('<h2 id="certify-review-title">Certify Orders</h2>');
      expect(html).toContain('A short review. Certifying says you looked at it and vouch for these numbers.');
      expect(html).toContain('ZLens records you as the person who certified it, with the date and what was checked.');
      expect(html).toMatch(/<button type="button" class="primary">I vouch for this — certify<\/button>/);
      expect(html).not.toContain('propose');
    }
    const html = render(PROPOSES, dialog);
    expect(html).toContain('<h2 id="certify-review-title">Propose Orders for certification</h2>');
    expect(html).toContain('A short review. Proposing says you looked at it and vouch for these numbers; a steward certifies it through review.');
    expect(html).toContain('ZLens records you as the person who proposed it, with the date and what was checked; a steward certifies it through review.');
    expect(html).toMatch(/<button type="button" class="primary">Propose for certification<\/button>/);
    expect(html).not.toContain('I vouch');
    expect(html).not.toContain('certified it');
  });

  it('a saved query\'s review asks for its owner and names its blockers in the same voice', () => {
    const dialog = <CertifyReviewDialog sourceId={savedQueryReview.sourceId} initialReview={savedQueryReview} onClose={vi.fn()} onCertified={vi.fn()} onOpenBlockStudio={vi.fn()} />;
    const certifies = render(NO_HOST, dialog);
    expect(certifies).toContain('ZLens writes it into the saved query when you certify.');
    expect(certifies).toContain('<p>Not ready to certify:</p>');
    const proposes = render(PROPOSES, dialog);
    expect(proposes).toContain('Propose Top Customers for certification');
    expect(proposes).toContain('ZLens writes it into the saved query when you propose it.');
    expect(proposes).toContain('<p>Not ready to propose:</p>');
    // The saved query editor link and the rest of the review are the same.
    expect(proposes).toContain('Open in the saved query editor');
    expect(proposes).toContain('One row for each customer.');
  });

  it('the join review: "I vouch for this join — certify", or "Propose this join for certification" with a steward certifying', () => {
    const dialog = <CertifyJoinDialog sourceId={joinReview.sourceId} joinId={joinReview.joinId} initialReview={joinReview} onClose={vi.fn()} onCertified={vi.fn()} />;
    for (const state of [NO_HOST, hosted()]) {
      const html = render(state, dialog);
      expect(html).toContain('<h2 id="certify-join-title">Certify the join Orders → Location</h2>');
      expect(html).toContain('A short review, here. Certifying says you checked how these tables join and vouch for it.');
      expect(html).toContain('ZLens records you as the person who certified it, with the date and the check; Modeling shows it certified.');
      expect(html).toMatch(/<button type="button" class="primary">I vouch for this join — certify<\/button>/);
    }
    const html = render(PROPOSES, dialog);
    expect(html).toContain('<h2 id="certify-join-title">Propose the join Orders → Location for certification</h2>');
    expect(html).toContain('A short review, here. Proposing says you checked how these tables join and vouch for it; a steward certifies it through review.');
    expect(html).toContain('ZLens records you as the person who proposed it, with the date and the check; a steward certifies it through review.');
    expect(html).toMatch(/<button type="button" class="primary">Propose this join for certification<\/button>/);
    expect(html).not.toContain('I vouch');
    // The check itself reads the same.
    expect(html).toContain('each order has one location — checked on 61,948 rows');
  });

  it('the Data list ⋯ menu: "Certify…" and "Certify the join to Location…", or "Propose certification…" and "Propose certification of the join to Location…"', () => {
    const join = (id: string, trust: DatasetJoin['trust']): DatasetJoin => ({ id, label: id, table: `${id}s`, relation: `${id}s`, keys: [{ from: `${id}_id`, to: `${id}_id` }], cardinality: 'many_to_one', trust, origin: 'model', relationshipId: id, uniqueness: 'current', sentence: `each order has one ${id}` });
    const orders = {
      ...orderLinesDataset,
      id: 'app:block:shop:orders', sourceId: 'app:block:shop:orders', name: 'orders', status: 'review', lifecycle: 'review', trust: 'review_required',
      capabilities: { ...orderLinesDataset.capabilities!, dataset: { ...(orderLinesDataset.capabilities!.dataset as object), joins: [join('location', 'review_required')] } },
    } as unknown as AppBlockRecommendation;
    const panel = <DataPanel appData={[orders]} active={orders} target={{ kind: 'none' }} disabled={false} onChoose={vi.fn()} onPickField={vi.fn()} onAddData={vi.fn()} onAddSavedQuery={vi.fn()} onAddContent={vi.fn()} onCertify={vi.fn()} onCertifyJoin={vi.fn()} defaultMoreOpen />;
    for (const state of [NO_HOST, hosted()]) {
      const html = render(state, panel);
      expect(html).toContain('<strong>Certify…</strong><small>A short review, then “I vouch for this — certify”.</small>');
      expect(html).toContain('<strong>Certify the join to Location…</strong><small>each order has one location: a fresh check, then “I vouch for this join — certify”.</small>');
    }
    const html = render(PROPOSES, panel);
    expect(html).toContain('<strong>Propose certification…</strong><small>A short review, then “Propose for certification”.</small>');
    expect(html).toContain('<strong>Propose certification of the join to Location…</strong><small>each order has one location: a fresh check, then “Propose this join for certification”.</small>');
    expect(html).not.toContain('I vouch');
    expect(html).not.toContain('Certify…');
    // The menu stays closed by default, as before.
    expect(render(PROPOSES, <DataPanel appData={[orders]} active={orders} target={{ kind: 'none' }} disabled={false} onChoose={vi.fn()} onPickField={vi.fn()} onAddData={vi.fn()} onAddSavedQuery={vi.fn()} onAddContent={vi.fn()} onCertify={vi.fn()} onCertifyJoin={vi.fn()} />)).not.toContain('role="menuitem"');
  });

  it('the publish check: "Certify now (recommended)" and "Certify this join", or "Propose certification now" and "Propose this join for certification"', () => {
    const join: DatasetJoin = { id: 'location', label: 'Location', table: 'locations', relation: 'locations', keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', trust: 'review_required', origin: 'drafted', relationshipId: 'p1:op1', uniqueness: 'recheck', sentence: 'each order has one location' };
    const tiles: NotCertifiedPublicationTile[] = [
      { pageId: 'overview', tileId: 'store', title: 'Orders by store', detail: 'Uses a join nobody has certified.', sourceName: 'orders', action: { kind: 'join', joins: [join], review: { pageId: 'overview', tileId: 'store', sourceId: 'app:block:shop:orders', joins: [join], relatedFields: [], filterIds: [] } } },
      { pageId: 'overview', tileId: 'top', title: 'Top customers', detail: 'Nobody has certified this saved query yet.', sourceName: 'top_customers', action: { kind: 'saved_query', source: { id: 'app:block:shop:top', kind: 'block', sourceRef: 'domains/shop/blocks/top.dql' } as never } },
    ];
    // The publish dialog reads the host and hands the section its words (the section itself stays a plain function, as its tests call it).
    const section = (state: HostUiState) => <NotCertifiedTilesSection title="2 tiles not certified yet" tiles={tiles} required={false} busy={false} onCertifySource={vi.fn()} onOpenSavedQuery={vi.fn()} onCertifyJoin={vi.fn()} onRemoveRelatedFields={vi.fn()} onOpenFilters={vi.fn()} words={certifyWords(state).publish} />;
    for (const state of [NO_HOST, hosted()]) {
      const html = render(state, section(state));
      expect(html).toContain('Readers see “Not certified yet” on these tiles. Certifying is recommended, not required.');
      expect(html).toContain('aria-label="Certify now: Top Customers">Certify now (recommended)</button>');
      expect(html).toContain('aria-label="Certify the join for Orders by store">Certify this join (recommended)</button>');
    }
    // Without the prop (the section called alone), the words certify, as before.
    expect(renderToStaticMarkup(<NotCertifiedTilesSection title="2 tiles not certified yet" tiles={tiles} required={false} busy={false} onCertifySource={vi.fn()} onOpenSavedQuery={vi.fn()} onCertifyJoin={vi.fn()} onRemoveRelatedFields={vi.fn()} onOpenFilters={vi.fn()} />)).toContain('Certify now (recommended)');
    const html = render(PROPOSES, section(PROPOSES));
    expect(html).toContain('Readers see “Not certified yet” on these tiles. Proposing certification is recommended, not required.');
    expect(html).toContain('aria-label="Propose certification now: Top Customers">Propose certification now (recommended)</button>');
    expect(html).toContain('aria-label="Propose the join for Orders by store">Propose this join for certification (recommended)</button>');
    expect(html).not.toContain('Certify now');
    expect(html).not.toContain('Certify this join');
  });
});
