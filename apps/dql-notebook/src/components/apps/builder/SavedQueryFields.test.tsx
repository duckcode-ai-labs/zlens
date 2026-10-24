import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TableDatasetProposal } from '@zlens/core/datasets/table-draft';
import type { SavedQueryDatasetDraft, SavedQueryDatasetResult } from '../../../api/client';
import { AddDataBrowser } from './AddDataBrowser';
import { DataPanel } from './DataPanel';
import { appDataItems, appDataSourceFromCandidate } from './app-data';
import { draftWith, monthlyRevenueQuery, orderLinesDataset, topCustomersQuery } from './app-data.fixtures';
import {
  MAKE_ROW_LEVEL_SENDS_BACK_FOR_REVIEW,
  SavedQueryFieldsDialog,
  savedQueryFieldsOutcome,
  submitSavedQueryFields,
  type SavedQueryFieldsApi,
} from './SavedQueryFieldsDialog';
import { initialNumberChoices } from './TableDatasetDialog';

const proposal: TableDatasetProposal = {
  name: 'Top customers',
  relation: '(SELECT 1) AS "dql_saved_query"',
  key: { column: 'customer_name', entity: 'customer' },
  keyCandidates: ['customer_name'],
  fields: [
    { name: 'customer_name', label: 'Customer name', role: 'key', type: 'string' },
    { name: 'lifetime_spend', label: 'Lifetime spend', role: 'attribute', type: 'number' },
  ],
  measures: [
    { name: 'customer_count', label: 'Customer count', aggregation: 'count_distinct', from: 'customer_name', format: 'number', include: true, reason: 'Counts customer rows by customer_name, which is different on every row.' },
    { name: 'lifetime_spend', label: 'Lifetime spend', aggregation: 'sum', from: 'lifetime_spend', format: 'currency', currency: 'USD', include: true, reason: 'Adds up lifetime spend across rows.' },
  ],
};

const certifiedDraft: SavedQueryDatasetDraft = {
  ok: true,
  source: { sourceId: topCustomersQuery.sourceId!, name: 'top_customers', sourceRevision: 'sha256:before', status: 'certified' },
  rows: 10,
  proposal,
  sendsBackForReview: true,
};

function fakeClient(results: SavedQueryDatasetResult[]): SavedQueryFieldsApi & { create: ReturnType<typeof vi.fn> } {
  const queue = [...results];
  return {
    draft: vi.fn(async () => certifiedDraft),
    create: vi.fn(async () => queue.shift() ?? { ok: false, error: 'no more results' }),
  };
}

describe('A saved query has fields; Make row-level is under ⋯ (design D1)', () => {
  const draft = draftWith({ sources: [appDataSourceFromCandidate(orderLinesDataset), appDataSourceFromCandidate(topCustomersQuery), appDataSourceFromCandidate(monthlyRevenueQuery)] });
  const appData = appDataItems(draft.sources, [orderLinesDataset, topCustomersQuery, monthlyRevenueQuery]);
  const panel = {
    appData,
    target: { kind: 'none' as const },
    disabled: false,
    onChoose: vi.fn(),
    onPickField: vi.fn(),
    onAddData: vi.fn(),
    onAddSavedQuery: vi.fn(),
    onAddContent: vi.fn(),
  };

  it('puts a saved query\'s result columns on the same shelves as a Dataset, with Make row-level under ⋯', () => {
    const onMakeRowLevel = vi.fn();
    const markup = renderToStaticMarkup(<DataPanel {...panel} active={appData[2]!} onMakeRowLevel={onMakeRowLevel} />);
    expect(markup).toContain('Saved query · Certified');
    expect(markup).toContain('<h3>Measures</h3>');
    expect(markup).toContain('<h3>Time</h3>');
    expect(markup).toContain('Gross Revenue');
    expect(markup).toContain('Month');
    expect(markup).toContain('Count Of Rows');
    expect(markup).toContain('Grouped by its own columns, values show as they are');
    expect(markup).toContain('aria-label="More for Monthly Revenue"');
    expect(markup).not.toContain('Add as it is');
    expect(markup).not.toContain('Saved queries have no fields');
    expect(markup).not.toContain('Add fields');
    // A Dataset that is already row-level has no ⋯ Make row-level.
    expect(renderToStaticMarkup(<DataPanel {...panel} active={appData[0]!} onMakeRowLevel={onMakeRowLevel} />)).not.toContain('More for Order Lines');
    // Field tiles off: the saved query is added as it is.
    const off = renderToStaticMarkup(<DataPanel {...panel} active={appData[2]!} datasetTilesEnabled={false} />);
    expect(off).toContain('Add as it is');
    expect(off).not.toContain('<h3>Measures</h3>');
  });

  it('reads a saved query\'s columns, and adds it as it is only when they can\'t be read', () => {
    const reading = renderToStaticMarkup(<DataPanel {...panel} active={appData[1]!} fieldsStatus={{ state: 'reading' }} />);
    expect(reading).toContain('Reading the columns of Top Customers…');
    expect(reading).not.toContain('Add as it is');
    const failed = renderToStaticMarkup(<DataPanel {...panel} active={appData[1]!} fieldsStatus={{ state: 'failed', error: 'Top customers asks for values before it runs.' }} />);
    expect(failed).toContain('ZLens couldn’t read its columns as fields: Top customers asks for values before it runs.');
    expect(failed).toContain('aria-label="Add Top Customers as Chart"');
  });

  it('opens Make row-level from a saved query row in the one Add data list', () => {
    const props = { draftId: 'build_1', draft: draftWith(), sourcePolicy: 'governed_only' as const, initialItems: [orderLinesDataset, topCustomersQuery, monthlyRevenueQuery], initialTables: [], onAdd: vi.fn(async () => true), onRemove: vi.fn(), onChangePolicy: vi.fn() };
    const markup = renderToStaticMarkup(<AddDataBrowser {...props} />);
    expect(markup).toContain('aria-label="More for Top Customers"');
    expect(markup).toContain('aria-label="More for Monthly Revenue"');
    expect(markup).not.toContain('aria-label="More for Order Lines"');
    expect(renderToStaticMarkup(<AddDataBrowser {...props} fieldsEnabled={false} />)).not.toContain('More for');
  });

  it('shows the Check the numbers step and says a certified saved query goes back for review', () => {
    const markup = renderToStaticMarkup(<SavedQueryFieldsDialog sourceId={topCustomersQuery.sourceId!} name="top_customers" initialDraft={certifiedDraft} client={fakeClient([])} onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(markup).toContain('Check the numbers');
    expect(markup).toContain('Make Top Customers row-level · 10 rows');
    expect(markup).toContain(MAKE_ROW_LEVEL_SENDS_BACK_FOR_REVIEW);
    expect(markup).toContain('Each row is one <strong>customer</strong>');
    expect(markup).toContain('Lifetime spend');
    expect(markup).toContain('Group and filter by');
    expect(markup).toContain('Customer name');
    expect(markup).toContain('Check and make row-level');
    const draftQuery = renderToStaticMarkup(<SavedQueryFieldsDialog sourceId="x" name="draft_revenue" initialDraft={{ ...certifiedDraft, sendsBackForReview: false }} client={fakeClient([])} onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(draftQuery).not.toContain(MAKE_ROW_LEVEL_SENDS_BACK_FOR_REVIEW);
  });

  it('sends the author’s numbers with the revision it read, and reports a checked Dataset that needs certifying (design Q1)', async () => {
    const client = fakeClient([{ ok: true, status: 'checked', previousStatus: 'certified', sourceId: 'app:block:orders/top_customers', blockers: [], keyChecked: true }]);
    const choices = initialNumberChoices(proposal).map((choice) => choice.name === 'lifetime_spend' ? { ...choice, format: 'number' as const } : choice);
    const submission = await submitSavedQueryFields(client, { sourceId: topCustomersQuery.sourceId!, name: 'Top Customers', draft: certifiedDraft, choices });
    expect(client.create).toHaveBeenCalledWith({
      sourceId: topCustomersQuery.sourceId,
      sourceRevision: 'sha256:before',
      measures: [
        { name: 'customer_count', include: true, format: 'number' },
        { name: 'lifetime_spend', include: true, format: 'number', currency: 'USD' },
      ],
    });
    expect(submission).toEqual({ kind: 'added', status: 'checked', sourceId: 'app:block:orders/top_customers', message: 'Top Customers is row-level now and checked. It is not certified yet: certify it when you are ready.', blockers: [] });
  });

  it('asks before sending a certified saved query back for review when its check fails', async () => {
    const client = fakeClient([
      { ok: false, code: 'SAVED_QUERY_REVIEW_REQUIRED', blockers: ['All tests pass: row_count > 1000000 failed.'], error: 'x' },
      { ok: true, status: 'review', previousStatus: 'certified', sourceId: topCustomersQuery.sourceId!, blockers: ['All tests pass: row_count > 1000000 failed.'] },
    ]);
    const input = { sourceId: topCustomersQuery.sourceId!, name: 'Top Customers', draft: certifiedDraft, choices: initialNumberChoices(proposal) };
    const refused = await submitSavedQueryFields(client, input);
    expect(refused).toEqual({ kind: 'refused', message: 'Top Customers is certified, and made row-level it did not pass its checks, so nothing changed yet.', blockers: ['All tests pass: row_count > 1000000 failed.'] });
    const sent = await submitSavedQueryFields(client, { ...input, allowReview: true });
    expect(client.create).toHaveBeenLastCalledWith(expect.objectContaining({ allowReview: true }));
    expect(sent).toMatchObject({ kind: 'added', status: 'review', message: 'Top Customers is row-level now. It is not certified yet: it did not pass its checks yet.' });
  });

  it('says plainly when the server refuses', () => {
    expect(savedQueryFieldsOutcome({ ok: false, code: 'SAVED_QUERY_HAS_PARAMETERS', error: 'Top customers asks for values before it runs.' }, 'Top Customers'))
      .toEqual({ kind: 'error', message: 'Top customers asks for values before it runs.' });
    expect(savedQueryFieldsOutcome({ ok: true, status: 'draft' }, 'Draft revenue').kind).toBe('review');
  });
});
