import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TableDatasetProposal } from '@zlens/core/datasets/table-draft';
import type { SavedQueryDatasetDraft, SavedQueryDatasetResult } from '../../../api/client';
import { AddDataBrowser } from './AddDataBrowser';
import { DataPanel } from './DataPanel';
import { appDataItems, appDataSourceFromCandidate } from './app-data';
import { draftWith, orderLinesDataset, topCustomersQuery } from './app-data.fixtures';
import {
  ADD_FIELDS_SENDS_BACK_FOR_REVIEW,
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

describe('Add fields to a saved query (design D1)', () => {
  const draft = draftWith({ sources: [appDataSourceFromCandidate(orderLinesDataset), appDataSourceFromCandidate(topCustomersQuery)] });
  const appData = appDataItems(draft.sources, [orderLinesDataset, topCustomersQuery]);
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

  it('turns the saved query note in the Data pane into an Add fields button', () => {
    const onAddFields = vi.fn();
    const markup = renderToStaticMarkup(<DataPanel {...panel} active={appData[1]!} onAddFields={onAddFields} />);
    expect(markup).toContain('Saved queries have no fields. Add fields to build tiles by Measures and Dimensions.');
    expect(markup).toContain('aria-label="Add fields to Top Customers"');
    // Field tiles off: the note stays, with no button.
    expect(renderToStaticMarkup(<DataPanel {...panel} active={appData[1]!} />)).not.toContain('Add fields to Top Customers');
    // A Dataset already has fields: no button.
    expect(renderToStaticMarkup(<DataPanel {...panel} active={appData[0]!} onAddFields={onAddFields} />)).not.toContain('Add fields to');
  });

  it('offers Add fields on saved query rows in Add data, not on Datasets or when field tiles are off', () => {
    const props = { draftId: 'build_1', draft: draftWith(), sourcePolicy: 'governed_only' as const, initialItems: [orderLinesDataset, topCustomersQuery], onAdd: vi.fn(async () => true), onRemove: vi.fn(), onChangePolicy: vi.fn() };
    expect(renderToStaticMarkup(<AddDataBrowser {...props} initialTab="queries" />)).toContain('aria-label="Add fields to Top Customers"');
    expect(renderToStaticMarkup(<AddDataBrowser {...props} />)).not.toContain('Add fields to');
    expect(renderToStaticMarkup(<AddDataBrowser {...props} initialTab="queries" fieldsEnabled={false} />)).not.toContain('Add fields to');
  });

  it('shows the Check the numbers step and says a certified saved query goes back for review', () => {
    const markup = renderToStaticMarkup(<SavedQueryFieldsDialog sourceId={topCustomersQuery.sourceId!} name="top_customers" initialDraft={certifiedDraft} client={fakeClient([])} onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(markup).toContain('Check the numbers');
    expect(markup).toContain('Add fields to Top Customers · 10 rows');
    expect(markup).toContain(ADD_FIELDS_SENDS_BACK_FOR_REVIEW);
    expect(markup).toContain('Each row is one <strong>customer</strong>');
    expect(markup).toContain('Lifetime spend');
    expect(markup).toContain('Group and filter by');
    expect(markup).toContain('Customer name');
    expect(markup).toContain('Check and add fields');
    const draftQuery = renderToStaticMarkup(<SavedQueryFieldsDialog sourceId="x" name="draft_revenue" initialDraft={{ ...certifiedDraft, sendsBackForReview: false }} client={fakeClient([])} onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(draftQuery).not.toContain(ADD_FIELDS_SENDS_BACK_FOR_REVIEW);
  });

  it('sends the author’s numbers with the revision it read, and reports a certified Dataset', async () => {
    const client = fakeClient([{ ok: true, status: 'certified', previousStatus: 'certified', sourceId: 'app:block:orders/top_customers', blockers: [], keyChecked: true }]);
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
    expect(submission).toEqual({ kind: 'added', status: 'certified', sourceId: 'app:block:orders/top_customers', message: 'Top Customers has fields now and is certified: its checks passed.', blockers: [] });
  });

  it('asks before sending a certified saved query back for review when its check fails', async () => {
    const client = fakeClient([
      { ok: false, code: 'SAVED_QUERY_REVIEW_REQUIRED', blockers: ['All tests pass: row_count > 1000000 failed.'], error: 'x' },
      { ok: true, status: 'review', previousStatus: 'certified', sourceId: topCustomersQuery.sourceId!, blockers: ['All tests pass: row_count > 1000000 failed.'] },
    ]);
    const input = { sourceId: topCustomersQuery.sourceId!, name: 'Top Customers', draft: certifiedDraft, choices: initialNumberChoices(proposal) };
    const refused = await submitSavedQueryFields(client, input);
    expect(refused).toEqual({ kind: 'refused', message: 'Top Customers is certified, and with these fields it did not pass its checks, so nothing changed yet.', blockers: ['All tests pass: row_count > 1000000 failed.'] });
    const sent = await submitSavedQueryFields(client, { ...input, allowReview: true });
    expect(client.create).toHaveBeenLastCalledWith(expect.objectContaining({ allowReview: true }));
    expect(sent).toMatchObject({ kind: 'added', status: 'review', message: 'Top Customers has fields now. It needs review: it did not pass its checks yet.' });
  });

  it('says plainly when the server refuses', () => {
    expect(savedQueryFieldsOutcome({ ok: false, code: 'SAVED_QUERY_HAS_PARAMETERS', error: 'Top customers asks for values before it runs.' }, 'Top Customers'))
      .toEqual({ kind: 'error', message: 'Top customers asks for values before it runs.' });
    expect(savedQueryFieldsOutcome({ ok: true, status: 'draft' }, 'Draft revenue').kind).toBe('review');
  });
});
