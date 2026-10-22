import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppBlockRecommendation, CertifyReview } from '../../../api/client';
import { proposeTableDataset } from '@zlens/core/datasets/table-draft';
import { allDataCertifiedLabel, appCertificationRollup } from '../app-certification';
import { AddDataBrowser } from './AddDataBrowser';
import { CertifyReviewDialog } from './CertifyReviewDialog';
import { CheckedReceiptNote } from './CertifiedReceiptNote';
import { DataPanel } from './DataPanel';
import { DuplicateColumnQuestions } from './TableDatasetDialog';
import { orderLinesDataset } from './app-data.fixtures';
import {
  CHECKED_NEEDS_CERTIFYING,
  addNeedsReviewChoice,
  appDataSourceFromCandidate,
  canCertifyAppData,
  checkedByLabel,
  dataTrustLabel,
  isCheckedNeedsCertifying,
  planAddDataSource,
} from './app-data';

/**
 * Design Q1, "Certified feels like a self-stamp": checking a table makes it
 * Checked · Needs certifying; certifying is a deliberate review before
 * publishing; readers see who certified, "you" included.
 */
const today = new Date().toISOString();
const checkedOrders = {
  ...orderLinesDataset,
  id: 'app:block:shop/orders', sourceId: 'app:block:shop/orders', name: 'orders', tags: ['app-datasets', 'from-table'],
  status: 'review', lifecycle: 'review', trust: 'review_required',
  eligibility: { discoverable: true, localPreview: true, projectPublish: false, reasonCodes: ['CHECKED_NEEDS_CERTIFYING'] },
  check: { by: 'kranthi@example.test', name: 'Kranthi', at: today, byYou: true, checks: ['Row key: each row is one order (order_id is filled and different on all 3 rows)'] },
} as unknown as AppBlockRecommendation;
const reviewOrders = { ...checkedOrders, check: undefined } as unknown as AppBlockRecommendation;

describe('Checked · Needs certifying (design Q1)', () => {
  it('names checked data apart from certified data and plain data that needs review', () => {
    expect(isCheckedNeedsCertifying(checkedOrders)).toBe(true);
    expect(isCheckedNeedsCertifying(reviewOrders)).toBe(false);
    expect(isCheckedNeedsCertifying(orderLinesDataset)).toBe(false);
    expect(dataTrustLabel(checkedOrders)).toBe(CHECKED_NEEDS_CERTIFYING);
    expect(dataTrustLabel(reviewOrders)).toBe('Needs review');
    expect(checkedByLabel(checkedOrders.check)).toMatch(/^Checked by you · \d{1,2} [A-Z][a-z]{2}$/);
    expect(checkedByLabel({ by: 'maria@acme.com', at: today })).toMatch(/^Checked by Maria · /);
  });

  it('adds checked data under "Only certified data" without changing the data rule; tiles work right away', () => {
    expect(addNeedsReviewChoice(checkedOrders, 'governed_only')).toBe(false);
    expect(addNeedsReviewChoice(reviewOrders, 'governed_only')).toBe(true);
    const plan = planAddDataSource({ sourcePolicy: 'governed_only' }, checkedOrders);
    expect(plan).toEqual({ ok: true, operations: [{ type: 'upsert_source', source: expect.objectContaining({ id: 'app:block:shop/orders', checked: true, trustState: 'review_required' }) }] });
    expect(appDataSourceFromCandidate(orderLinesDataset).checked).toBeUndefined();
  });

  it('offers certify for a row-level Dataset nobody certified, never for Metrics, saved queries or certified data', () => {
    expect(canCertifyAppData(checkedOrders)).toBe(true);
    expect(canCertifyAppData(reviewOrders)).toBe(true);
    expect(canCertifyAppData(orderLinesDataset)).toBe(false);
    const savedQuery = { ...reviewOrders, capabilities: { ...reviewOrders.capabilities!, dataset: undefined } } as unknown as AppBlockRecommendation;
    expect(canCertifyAppData(savedQuery)).toBe(false);
  });

  it('says what "Check and use" left behind: checked, by whom, and certify before publishing', () => {
    const html = renderToStaticMarkup(<CheckedReceiptNote name="Orders" check={checkedOrders.check!} />);
    expect(html).toContain('Orders · Checked · Needs certifying');
    expect(html).toMatch(/Checked by you · \d{1,2} [A-Z][a-z]{2}\. Build tiles now; certify it before you publish\./);
    expect(html).toContain('<li>Row key: each row is one order (order_id is filled and different on all 3 rows)</li>');
    expect(html).not.toContain('Certified by');
  });

  it('shows the trust word on Add data rows and offers Certify… under ⋯', () => {
    const html = renderToStaticMarkup(<AddDataBrowser draftId="build_1" draft={{ sources: [], pages: [] }} sourcePolicy="governed_only" initialItems={[checkedOrders]} initialTables={[]} onAdd={vi.fn(async () => true)} onRemove={vi.fn()} onChangePolicy={vi.fn()} />);
    expect(html).toContain('Table · Checked · Needs certifying');
    expect(html).toContain('aria-label="More for Orders"');
    // Checked data adds with the plain button: the data rule stays "Only certified data".
    expect(html).toContain('aria-label="Add to App: Orders"');
    expect(html).not.toContain('Allow data that needs review &amp; add');
  });

  it('shows the trust word in the Data list and offers Certify… in its ⋯ menu', () => {
    const html = renderToStaticMarkup(
      <DataPanel appData={[checkedOrders]} active={checkedOrders} target={{ kind: 'none' }} disabled={false} onChoose={vi.fn()} onPickField={vi.fn()} onAddData={vi.fn()} onAddSavedQuery={vi.fn()} onAddContent={vi.fn()} onCertify={vi.fn()} />,
    );
    expect(html).toContain('Table · Checked · Needs certifying');
    expect(html).toContain('aria-label="More for Orders"');
  });
});

describe('Duplicate columns, one question (design Q1.4)', () => {
  const proposal = proposeTableDataset({
    table: 'orders', relation: 'orders', convertMinorUnits: true,
    columns: [{ name: 'order_id', type: 'VARCHAR' }, { name: 'order_total', type: 'DOUBLE' }, { name: 'order_total_cents', type: 'INTEGER' }],
  });

  it('asks "Use Order total in dollars?" once, with the cents column recommended', () => {
    const html = renderToStaticMarkup(<DuplicateColumnQuestions proposal={proposal} choices={[]} onChoice={vi.fn()} />);
    expect(html).toContain('Use Order total in dollars?');
    expect(html).toContain('Yes, use order_total_cents in dollars</strong> <em>Recommended</em>');
    expect(html).toContain('No, use order_total as it is');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/<input type="radio" name="duplicate-order_total" checked=""/);
    expect(renderToStaticMarkup(<DuplicateColumnQuestions proposal={{ ...proposal, duplicates: undefined }} choices={[]} onChoice={vi.fn()} />)).toBe('');
  });
});

describe('The short review before certifying (design Q1)', () => {
  const review: CertifyReview = {
    sourceId: 'app:block:shop/orders', sourceRevision: 'sha256:r', name: 'Orders', kind: 'dataset', origin: 'table', lifecycle: 'review', certified: false,
    check: { by: 'kranthi@example.test', at: today, byYou: true },
    row: 'Each row is one order (order_id).',
    keyCheck: { ok: true, sentence: 'order_id is filled and different on every row, checked just now.' },
    numbers: [{ name: 'order_total', label: 'Order total', format: 'Money (USD)', aggregation: 'sum', note: 'shown in dollars (stored as cents)' }, { name: 'order_count', label: 'Order count', format: 'Number', aggregation: 'count_distinct' }],
    joins: [{ label: 'Customer', sentence: 'each order has one customer', trust: 'certified' }],
    hiddenColumns: [{ column: 'order_total', keptColumn: 'order_total_cents', reason: 'Order total uses order_total_cents, shown in dollars; order_total holds the same number, so it is hidden.' }],
    checks: [],
    canVouch: true,
  };

  it('shows what one row is, the key check, number formats with cents, joins, hidden duplicates and one button', () => {
    const html = renderToStaticMarkup(<CertifyReviewDialog sourceId={review.sourceId} initialReview={review} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(html).toContain('Certify Orders');
    expect(html).toMatch(/Checked by you · /);
    expect(html).toContain('Each row is one order (order_id).');
    expect(html).toContain('order_id is filled and different on every row, checked just now.');
    expect(html).toContain('<strong>Order total</strong>: Money (USD) · shown in dollars (stored as cents)');
    expect(html).toContain('each order has one customer');
    expect(html).toContain('Order total uses order_total_cents, shown in dollars; order_total holds the same number, so it is hidden.');
    expect(html).toContain('I vouch for this — certify');
    expect(html).not.toMatch(/<button type="button" class="primary" disabled=""/);
  });

  it('will not vouch for data whose row key check fails, and sends a saved query to Block Studio', () => {
    const failing = renderToStaticMarkup(<CertifyReviewDialog sourceId={review.sourceId} initialReview={{ ...review, keyCheck: { ok: false, error: 'order_id did not pass its check: it repeats.' } }} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(failing).toContain('order_id did not pass its check: it repeats.');
    expect(failing).toMatch(/<button type="button" class="primary" disabled="">I vouch for this — certify<\/button>/);
    const query = renderToStaticMarkup(<CertifyReviewDialog sourceId="q" initialReview={{ ...review, kind: 'saved_query', origin: 'saved_query', canVouch: false, blockStudioPath: 'domains/shop/blocks/top.dql' }} onClose={vi.fn()} onCertified={vi.fn()} onOpenBlockStudio={vi.fn()} />);
    expect(query).toContain('A saved query is certified in Block Studio');
    expect(query).toContain('Open in Block Studio');
    expect(query).not.toContain('I vouch for this');
  });
});

describe('Who certified, from the reader\'s side (design Q1)', () => {
  it('says "All data certified by you" when the reader certified it, and names anyone else', () => {
    expect(allDataCertifiedLabel('Certified by you · 22 Oct')).toBe('All data certified by you · 22 Oct');
    const item = { i: 'kpi', query: {} } as never;
    const tile = (certification: Record<string, unknown>) => ({ tileId: 'kpi', status: 'ok', dataset: { trust: 'certified' }, certification });
    expect(appCertificationRollup([item], 0, [tile({ by: 'kranthi@example.test', name: 'Kranthi', at: today, byYou: true })] as never).label).toMatch(/^All data certified by you · /);
    expect(appCertificationRollup([item], 0, [tile({ by: 'maria@example.test', name: 'Maria', at: today })] as never).label).toMatch(/^All data certified by Maria · /);
  });

  it('says a checked tile needs certifying, not just review', () => {
    const item = { i: 'kpi', query: {} } as never;
    const rollup = appCertificationRollup([item], 0, [{ tileId: 'kpi', status: 'ok', dataset: { trust: 'review_required', checked: true } }] as never);
    expect(rollup.allCertified).toBe(false);
    expect(rollup.label).toBe('0 of 1 tile certified');
  });
});
