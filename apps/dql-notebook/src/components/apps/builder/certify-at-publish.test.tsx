import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppBlockRecommendation, CertifyReview } from '../../../api/client';
import { applyTableDuplicateChoices, proposeTableDataset, withDuplicateUnitRelations } from '@zlens/core/datasets/table-draft';
import { allDataCertifiedLabel, appCertificationRollup } from '../app-certification';
import { AddDataBrowser } from './AddDataBrowser';
import { CertifyReviewDialog } from './CertifyReviewDialog';
import { CheckedReceiptNote } from './CertifiedReceiptNote';
import { DataPanel } from './DataPanel';
import { readerTileTrust } from '../reader-trust';
import { DuplicateColumnQuestions, duplicateChoicesFor, numberChoicesFor } from './TableDatasetDialog';
import { orderLinesDataset } from './app-data.fixtures';
import {
  CHECKED_NEEDS_CERTIFYING,
  addNeedsReviewChoice,
  appDataSourceFromCandidate,
  canCertifyAppData,
  checkedByLabel,
  dataTrustDetail,
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

describe('Checked, not certified yet (design Q1, T1)', () => {
  it('says Not certified yet for checked data and for data nobody checked; being checked is detail (T1)', () => {
    expect(isCheckedNeedsCertifying(checkedOrders)).toBe(true);
    expect(isCheckedNeedsCertifying(reviewOrders)).toBe(false);
    expect(isCheckedNeedsCertifying(orderLinesDataset)).toBe(false);
    expect(dataTrustLabel(checkedOrders)).toBe('Not certified yet');
    expect(CHECKED_NEEDS_CERTIFYING).toBe('Not certified yet');
    expect(dataTrustLabel(reviewOrders)).toBe('Not certified yet');
    expect(dataTrustDetail(checkedOrders)).toBe('Checked by you, not certified yet.');
    expect(dataTrustDetail(reviewOrders)).toBe('Nobody has certified it yet.');
    expect(dataTrustDetail(orderLinesDataset)).toBeUndefined();
    expect(checkedByLabel(checkedOrders.check)).toMatch(/^Checked by you · \d{1,2} [A-Z][a-z]{2}$/);
    expect(checkedByLabel({ by: 'maria@acme.com', at: today })).toMatch(/^Checked by Maria · /);
  });

  it('adds checked data and data nobody checked the same way, with no data rule (T3); tiles work right away', () => {
    expect(addNeedsReviewChoice(checkedOrders, 'governed_only')).toBe(false);
    expect(addNeedsReviewChoice(reviewOrders, 'governed_only')).toBe(false);
    expect(planAddDataSource({ sourcePolicy: 'governed_only' }, reviewOrders)).toMatchObject({ ok: true, operations: [{ type: 'upsert_source' }] });
    const plan = planAddDataSource({ sourcePolicy: 'governed_only' }, checkedOrders);
    expect(plan).toEqual({ ok: true, operations: [{ type: 'upsert_source', source: expect.objectContaining({ id: 'app:block:shop/orders', checked: true, trustState: 'review_required' }) }] });
    expect(appDataSourceFromCandidate(orderLinesDataset).checked).toBeUndefined();
  });

  it('offers certify for data and saved queries nobody certified (T4), never for Metrics or certified data', () => {
    expect(canCertifyAppData(checkedOrders)).toBe(true);
    expect(canCertifyAppData(reviewOrders)).toBe(true);
    expect(canCertifyAppData(orderLinesDataset)).toBe(false);
    const savedQuery = { ...reviewOrders, capabilities: { ...reviewOrders.capabilities!, dataset: undefined } } as unknown as AppBlockRecommendation;
    expect(canCertifyAppData(savedQuery)).toBe(true);
    expect(canCertifyAppData({ ...savedQuery, kind: 'semantic' } as unknown as AppBlockRecommendation)).toBe(false);
    expect(canCertifyAppData({ ...savedQuery, lifecycle: 'deprecated' } as unknown as AppBlockRecommendation)).toBe(false);
  });

  it('says what "Check and use" left behind: checked, by whom, and not certified yet', () => {
    const html = renderToStaticMarkup(<CheckedReceiptNote name="Orders" check={checkedOrders.check!} />);
    expect(html).toContain('Orders · Not certified yet');
    expect(html).toMatch(/Checked by you · \d{1,2} [A-Z][a-z]{2}, not certified yet\. Build tiles now; certify it when you are ready\./);
    expect(html).toContain('<li>Row key: each row is one order (order_id is filled and different on all 3 rows)</li>');
    expect(html).not.toContain('Certified by');
  });

  it('shows the trust word on Add data rows and offers Certify… under ⋯', () => {
    const html = renderToStaticMarkup(<AddDataBrowser draftId="build_1" draft={{ sources: [], pages: [] }} sourcePolicy="governed_only" initialItems={[checkedOrders]} initialTables={[]} onAdd={vi.fn(async () => true)} onRemove={vi.fn()} onChangePolicy={vi.fn()} />);
    expect(html).toContain('Table · Not certified yet');
    expect(html).toContain('title="Checked by you, not certified yet."');
    expect(html).toContain('aria-label="More for Orders"');
    // Checked data adds with the plain button.
    expect(html).toContain('aria-label="Add to App: Orders"');
    expect(html).not.toContain('Allow data that needs review &amp; add');
  });

  it('shows the trust word in the Data list and offers Certify… in its ⋯ menu', () => {
    const html = renderToStaticMarkup(
      <DataPanel appData={[checkedOrders]} active={checkedOrders} target={{ kind: 'none' }} disabled={false} onChoose={vi.fn()} onPickField={vi.fn()} onAddData={vi.fn()} onAddSavedQuery={vi.fn()} onAddContent={vi.fn()} onCertify={vi.fn()} />,
    );
    expect(html).toContain('Table · Not certified yet');
    expect(html).toContain('aria-label="More for Orders"');
  });
});

describe('Duplicate columns, one question per table (design Q1.4, new-user round 3 problem 8)', () => {
  const proposal = proposeTableDataset({
    table: 'orders', relation: 'orders', convertMinorUnits: true,
    columns: [{ name: 'order_id', type: 'VARCHAR' }, { name: 'subtotal', type: 'DOUBLE' }, { name: 'subtotal_cents', type: 'INTEGER' }, { name: 'order_total', type: 'DOUBLE' }, { name: 'order_total_cents', type: 'INTEGER' }],
  });
  const checked = withDuplicateUnitRelations(proposal, { subtotal: 'hundredths', order_total: 'hundredths' });

  it('asks once for every column stored twice, with OK and Show both, never a Yes/No per column', () => {
    const html = renderToStaticMarkup(<DuplicateColumnQuestions proposal={checked} mode="ok" onMode={vi.fn()} />);
    expect(html).toContain('These columns are stored twice, in dollars and in cents: Subtotal and Order total.');
    expect(html).toContain('ZLens will use the dollar columns and hide the cents copies.');
    expect(html).toContain('aria-pressed="true" class="on">OK</button>');
    expect(html).toContain('>Show both</button>');
    expect(html).not.toMatch(/Yes, use|No, use|type="radio"/);
    expect(html.match(/stored twice/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<DuplicateColumnQuestions proposal={checked} mode="both" onMode={vi.fn()} />)).toContain('Both copies stay: the cents columns as plain numbers');
    expect(renderToStaticMarkup(<DuplicateColumnQuestions proposal={{ ...proposal, duplicates: undefined }} mode="ok" onMode={vi.fn()} />)).toBe('');
  });

  it('OK uses the dollar columns; Show both adds the cents copies to the numbers', () => {
    expect(duplicateChoicesFor(checked, 'ok')).toEqual([{ name: 'subtotal', use: 'plain' }, { name: 'order_total', use: 'plain' }]);
    expect(duplicateChoicesFor(checked, 'both').every((choice) => choice.use === 'both')).toBe(true);
    const both = applyTableDuplicateChoices(checked, duplicateChoicesFor(checked, 'both'));
    const choices = numberChoicesFor(both, [{ name: 'subtotal', include: false, format: 'currency', currency: 'USD' }]);
    expect(choices.find((choice) => choice.name === 'subtotal')?.include).toBe(false);
    expect(choices.find((choice) => choice.name === 'subtotal_cents')).toMatchObject({ include: true, format: 'number' });
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
    expect(html).toContain('<strong>Order Total</strong>: Money (USD) · shown in dollars (stored as cents)');
    expect(html).toContain('each order has one customer');
    expect(html).toContain('Order total uses order_total_cents, shown in dollars; order_total holds the same number, so it is hidden.');
    expect(html).toContain('I vouch for this — certify');
    expect(html).not.toMatch(/<button type="button" class="primary" disabled=""/);
  });

  it('will not vouch for data whose row key check fails; a saved query ZLens cannot run here opens in its editor', () => {
    const failing = renderToStaticMarkup(<CertifyReviewDialog sourceId={review.sourceId} initialReview={{ ...review, keyCheck: { ok: false, error: 'order_id did not pass its check: it repeats.' } }} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(failing).toContain('order_id did not pass its check: it repeats.');
    expect(failing).toMatch(/<button type="button" class="primary" disabled="">I vouch for this — certify<\/button>/);
    const query = renderToStaticMarkup(<CertifyReviewDialog sourceId="q" initialReview={{ ...review, kind: 'saved_query', origin: 'saved_query', canVouch: false, blockStudioPath: 'domains/shop/blocks/top.dql' }} onClose={vi.fn()} onCertified={vi.fn()} onOpenBlockStudio={vi.fn()} />);
    expect(query).toContain('A saved query ZLens cannot run here is certified in the saved query editor.');
    expect(query).toContain('Open in the saved query editor');
    expect(query).not.toContain('I vouch for this');
  });

  it('says when data changed since it was certified (T4)', () => {
    const html = renderToStaticMarkup(<CertifyReviewDialog sourceId={review.sourceId} initialReview={{ ...review, check: undefined, previousCertification: { by: 'maria@example.test', at: '2026-10-22T09:00:00.000Z' } }} onClose={vi.fn()} onCertified={vi.fn()} />);
    expect(html).toContain('Changed since it was certified on 22 Oct');
  });
});

describe('Who certified, from the reader\'s side (design Q1)', () => {
  it('the header says the count; who certified it is on the tile, by you or by name (T2)', () => {
    expect(allDataCertifiedLabel('Certified by you · 22 Oct')).toBe('All tiles certified');
    const item = { i: 'kpi', query: {} } as never;
    const tile = (certification: Record<string, unknown>) => ({ tileId: 'kpi', status: 'ok', dataset: { trust: 'certified' }, certification });
    const mine = appCertificationRollup([item], 0, [tile({ by: 'kranthi@example.test', name: 'Kranthi', at: today, byYou: true })] as never);
    expect(mine.label).toBe('All tiles certified');
    expect(mine.byline).toMatch(/^Certified by you · /);
    expect(appCertificationRollup([item], 0, [tile({ by: 'maria@example.test', name: 'Maria', at: today })] as never).byline).toMatch(/^Certified by Maria · /);
    expect(readerTileTrust(item, tile({ by: 'maria@example.test', name: 'Maria', at: today }) as never)?.byline).toMatch(/^Certified by Maria · /);
  });

  it('counts a checked tile as not certified', () => {
    const item = { i: 'kpi', query: {} } as never;
    const rollup = appCertificationRollup([item], 0, [{ tileId: 'kpi', status: 'ok', dataset: { trust: 'review_required', checked: true } }] as never);
    expect(rollup.allCertified).toBe(false);
    expect(rollup.label).toBe('0 of 1 tile certified');
  });
});
