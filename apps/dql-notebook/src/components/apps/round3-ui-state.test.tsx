import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DatasetDescriptor, DatasetField } from '@zlens/core/datasets/descriptor';
import type { AppStudioBuildDraft, DashboardRunResponse } from '../../api/client';
import { appLibraryWords, withDraftListed } from './app-library-words';
import { NOT_PUBLISHED_YET, NO_UNPUBLISHED_CHANGES, UNPUBLISHED_CHANGES, draftStatusWords } from './app-studio-words';
import { ASK_NEEDS_AI_PROVIDER, AskAboutApp, askAboutAppScopeLine } from './AskAboutApp';
import { appCopilotAvailable, libraryCounts, mergeDraftsIntoAppCards } from './AppsView';
import { tableTrustLine, tableTrustWords } from './builder/app-data-names';
import { tableModelLabel } from './builder/AddDataBrowser';
import { orderLinesDataset } from './builder/app-data.fixtures';
import { changedFilterIds, filterChangeRerunTileIds, withUnrunTileFilterNotices } from './reader-filter-rerun';
import { ASK_NEEDS_AI_PROVIDER_HEADING, answerTrustBadge, answerTrustHeading, askNeedsAiProvider } from '../agent/answer-trust';
import type * as StudioModule from './AppStudioV2';
import type * as PanelModule from '../agent/UnifiedAgentRunPanel';

let tileFieldClickPatch: typeof StudioModule.tileFieldClickPatch;
let simpleRunTitle: typeof PanelModule.simpleRunTitle;

beforeAll(async () => {
  tileFieldClickPatch = (await import('./AppStudioV2')).tileFieldClickPatch;
  simpleRunTitle = (await import('../agent/UnifiedAgentRunPanel')).simpleRunTitle;
});

type Draft = AppStudioBuildDraft;
type Page = Draft['pages'][number];

function draft(id: string, extra: Partial<Draft> = {}): Draft {
  return { id, name: id, state: 'local_draft', updatedAt: '2026-10-22T10:00:00Z', pages: [], reviewTasks: [], frame: { goal: '' }, ...extra } as unknown as Draft;
}

describe('a new App is listed as soon as you go Back to Apps (round 3, problem 1)', () => {
  it('adds the draft just left to the cached list, newest first, before the list is read again', () => {
    const listed = withDraftListed({ ok: true, drafts: [draft('older')] }, draft('new-app'));
    expect(listed.drafts.map((item) => item.id)).toEqual(['new-app', 'older']);
  });

  it('replaces a draft already listed and starts a list that was never read', () => {
    const renamed = draft('a', { name: 'Sales Manager Manual' });
    expect(withDraftListed({ ok: true, drafts: [draft('a'), draft('b')] }, renamed).drafts.map((item) => item.name)).toEqual(['Sales Manager Manual', 'b']);
    expect(withDraftListed(undefined, draft('first')).drafts.map((item) => item.id)).toEqual(['first']);
  });

  it('never lists a published draft as unpublished', () => {
    expect(withDraftListed({ ok: true, drafts: [] }, draft('done', { state: 'project_published' })).drafts).toEqual([]);
  });
});

describe('one wording for unpublished Apps, and counters that count the cards (round 3, problem 5)', () => {
  it('says "Not published yet" for a new App and "Unpublished changes" for a published one, in Studio and after a save', () => {
    expect(draftStatusWords({ published: false })).toBe('Not published yet (only you can see it)');
    expect(draftStatusWords({ published: false, saved: true })).toBe('Saved · Not published yet (only you can see it)');
    expect(draftStatusWords({ published: true })).toBe(UNPUBLISHED_CHANGES);
    expect(draftStatusWords({ published: true, saved: true })).toBe('Saved · Unpublished changes (only you can see them)');
    expect(NO_UNPUBLISHED_CHANGES).toBe('No changes yet · readers see the published App');
    for (const words of [draftStatusWords({ published: false }), draftStatusWords({ published: true }), NOT_PUBLISHED_YET]) {
      expect(words).not.toMatch(/local|private draft/i);
    }
  });

  it('names the library tab and intro without "local drafts" or "private draft"', () => {
    const words = appLibraryWords(false);
    expect(words.label('drafts')).toBe('Not published yet');
    expect(`${words.intro} ${words.emptyDetail}`).not.toMatch(/local draft|private draft/i);
  });

  it('counts a published App with unpublished changes once, as its one card, never as a new App', () => {
    const apps = [{ id: 'jaffle-growth', visibility: 'shared' as const }, { id: 'sales', publicationIntent: 'local_private' as const }];
    const drafts = [
      draft('new-1', { appId: 'sales-manager-manual' }),
      draft('new-2', { appId: 'sales-quick' }),
      draft('edit-sales', { appId: 'sales', baseApp: { appId: 'sales', fingerprint: 'f' } }),
    ];
    const { standaloneDrafts, draftByAppId } = mergeDraftsIntoAppCards(drafts, apps);
    expect(standaloneDrafts.map((item) => item.id)).toEqual(['new-1', 'new-2']);
    expect(draftByAppId.get('sales')?.id).toBe('edit-sales');
    const counts = libraryCounts(apps as never, standaloneDrafts, new Set());
    expect(counts).toEqual({ all: 4, drafts: 2, private: 1, shared: 1, fav: 0 });
  });
});

describe('two trust words in the Data list (round 3, problem 5)', () => {
  it('labels every database table "Not certified yet", with a plain hint only where it helps', () => {
    expect(tableTrustLine({})).toBe('Not certified yet');
    expect(tableTrustLine({ modeled: { state: 'modeled' } } as never)).toBe('Not certified yet');
    expect(tableTrustLine({ modeled: { state: 'drafted' } } as never)).toBe('Not certified yet · drafted — review in Modeling');
    expect(tableTrustLine({}, { added: true })).toBe('Not certified yet · added');
    expect(tableModelLabel({ modeled: { state: 'drafted' } } as never)).toBe('Not certified yet · drafted — review in Modeling');
  });

  it('keeps how the model knows the table in the tooltip, never as another status word', () => {
    const words = [tableTrustWords({}), tableTrustWords({ modeled: { state: 'modeled' } } as never), tableTrustWords({ modeled: { state: 'drafted' } } as never), tableTrustWords({}, { added: true })];
    for (const word of words) {
      expect(`${word.label} ${word.hint ?? ''}`).not.toMatch(/\b(Modeled|Not checked yet|Checked|Governed)\b/);
      expect(word.detail.length).toBeGreaterThan(10);
    }
  });
});

describe('no AI controls and no "AI-generated" label without an AI provider (round 3, problem 6)', () => {
  it('the reader Ask box says plainly that Ask needs a provider, with no question box', () => {
    const html = renderToStaticMarkup(createElement(AskAboutApp, { scope: { appId: 'a', appName: 'Sales Manager Manual', filters: [] }, onAsk: () => undefined, aiConnected: false }));
    expect(html).toContain(ASK_NEEDS_AI_PROVIDER);
    expect(ASK_NEEDS_AI_PROVIDER).toBe('Ask needs an AI provider. The owner can connect one in Settings.');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('AI-generated');
  });

  it('keeps the question box with a provider, or while the settings load', () => {
    for (const aiConnected of [true, undefined]) {
      const html = renderToStaticMarkup(createElement(AskAboutApp, { scope: { appId: 'a', appName: 'Sales', filters: [] }, onAsk: () => undefined, aiConnected }));
      expect(html).toContain('<input');
      expect(html).not.toContain(ASK_NEEDS_AI_PROVIDER);
    }
  });

  const noModel = (marker: boolean) => ({
    id: 'run', status: 'blocked', route: 'generated_answer', trustState: 'blocked', stopReason: 'blocked',
    summary: 'No AI model is configured for this project, so the question could not be interpreted.',
    answer: 'No AI model is configured for this project, so the question could not be interpreted.',
    artifacts: [{ id: 'run:diagnostic', kind: 'answer', title: 'Ask needs an AI provider', trustState: 'blocked', payload: marker
      ? { kind: 'no_answer', text: 'No AI model is configured for this project.', refusalCode: 'provider_error', providerMissing: true }
      : { kind: 'no_answer', text: 'No AI model is configured for this project.', executionError: 'No AI model is configured for this project.' } }],
    nextActions: [], evaluations: [], events: [], steps: [],
  }) as any;

  it('never heads a refusal with no model run "AI-generated answer", new runs or old', () => {
    for (const run of [noModel(true), noModel(false)]) {
      expect(askNeedsAiProvider(run)).toBe(true);
      expect(answerTrustHeading(run)).toBe(ASK_NEEDS_AI_PROVIDER_HEADING);
      expect(answerTrustBadge(run)).toBe('Not answered');
      expect(simpleRunTitle(run)).toBe('Ask needs an AI provider');
      expect(`${answerTrustHeading(run)} ${answerTrustBadge(run)} ${simpleRunTitle(run)}`).not.toMatch(/AI-generated/);
    }
  });

  it('calls any other refusal "No answer · Refused", and an answered AI run still "AI-generated answer"', () => {
    const refused = { status: 'blocked', route: 'generated_answer', trustState: 'blocked', artifacts: [{ id: 'x', kind: 'answer', payload: { kind: 'no_answer', text: 'Outside the scope.' } }] } as any;
    expect(askNeedsAiProvider(refused)).toBe(false);
    expect(answerTrustHeading(refused)).toBe('No answer');
    expect(answerTrustBadge(refused)).toBe('Refused');
    const answered = { status: 'completed', route: 'generated_answer', trustState: 'review_required', artifacts: [] } as any;
    expect(answerTrustHeading(answered)).toBe('AI-generated answer');
    expect(answerTrustBadge(answered)).toBe('AI-generated');
  });
});

describe('a reader filter change re-runs only the linked tiles (round 3, problem 10)', () => {
  const page = {
    id: 'overview',
    metadata: { title: 'Overview' },
    datasets: [
      { id: 'orders', sourceId: 'app:orders', sourceRevision: 'r1' },
      { id: 'customers', sourceId: 'app:customers', sourceRevision: 'r1' },
    ],
    filters: [
      { id: 'ordered_at', type: 'daterange', label: 'Ordered At', datasetBindings: { orders: { field: 'ordered_at' } } },
      { id: 'customer_name', type: 'select', label: 'Customer Name', datasetBindings: { customers: { field: 'customer_name' }, orders: { field: 'customer_name' } } },
    ],
    layout: {
      kind: 'grid', cols: 12, rowHeight: 80,
      items: [
        { i: 'trend', sourceId: 'app:orders', sourceRevision: 'r1', query: { dimensions: [], measures: [] }, viz: { type: 'line' } },
        { i: 'top', sourceId: 'app:customers', sourceRevision: 'r1', query: { dimensions: [], measures: [] }, viz: { type: 'bar' } },
        { i: 'kpi', sourceId: 'app:customers', sourceRevision: 'r1', query: { dimensions: [], measures: [] }, viz: { type: 'single_value' } },
        { i: 'note', text: { markdown: 'Notes' }, viz: { type: 'text' } },
      ],
    },
  } as unknown as Page;

  it('names the tiles linked to the filters that changed, and nothing else', () => {
    expect(changedFilterIds({}, { ordered_at: { start: '2025-03-01' } })).toEqual(['ordered_at']);
    expect(filterChangeRerunTileIds(page, {}, { ordered_at: { start: '2025-03-01' } })).toEqual(['trend']);
    expect(filterChangeRerunTileIds(page, { ordered_at: { start: '2025-03-01' } }, { ordered_at: { start: '2025-03-01' }, customer_name: 'Aaron' })).toEqual(['kpi', 'top', 'trend']);
  });

  it('runs the whole page when nothing changed or a value is not one of the page filters', () => {
    expect(filterChangeRerunTileIds(page, { ordered_at: 'x' }, { ordered_at: 'x' })).toBeUndefined();
    expect(filterChangeRerunTileIds(page, {}, { something_else: 1 })).toBeUndefined();
  });

  it('tiles that did not run again say "Not filtered by" a filter that now has a value, and drop it once cleared', () => {
    const tile = (tileId: string, unbound: Array<{ filterId: string; code: string; message: string }> = []) => ({ tileId, status: 'ok', dataset: { unboundFilters: unbound } });
    const run = { runId: 'r2', partial: true, tiles: [tile('trend'), tile('top'), tile('kpi'), { tileId: 'note', status: 'ok', tileType: 'text' }] } as unknown as DashboardRunResponse;
    const set = withUnrunTileFilterNotices({ run, page, changedFilterIds: ['ordered_at'], values: { ordered_at: { start: '2025-03-01' } }, executedTileIds: ['trend'] });
    const unboundOf = (result: DashboardRunResponse, id: string) => (result.tiles.find((entry) => entry.tileId === id) as { dataset?: { unboundFilters?: Array<{ filterId: string; message: string }> } }).dataset?.unboundFilters ?? [];
    expect(unboundOf(set, 'trend')).toEqual([]);
    expect(unboundOf(set, 'top').map((issue) => issue.message)).toEqual(['Ordered At is not linked to this tile.']);
    expect(unboundOf(set, 'kpi').map((issue) => issue.filterId)).toEqual(['ordered_at']);
    const cleared = withUnrunTileFilterNotices({ run: set, page, changedFilterIds: ['ordered_at'], values: {}, executedTileIds: ['trend'] });
    expect(unboundOf(cleared, 'top')).toEqual([]);
  });
});

describe('a field click lands on the tile as saved, so quick clicks add up (round 3, problem 10)', () => {
  const base = orderLinesDataset.capabilities!.dataset as unknown as DatasetDescriptor;
  const descriptor = {
    ...base,
    fields: base.fields.map((candidate) => candidate.kind === 'measure'
      ? { ...candidate, qualifiedId: candidate.name, allowedAggs: ['sum'], additivity: { entities: 'additive', time: 'additive' } }
      : candidate),
  } as unknown as DatasetDescriptor;
  const field = (name: string) => descriptor.fields.find((candidate) => candidate.name === name) as DatasetField;
  const kpi = { i: 'kpi', sourceId: 'x', query: { dimensions: [], measures: [{ measure: 'revenue' }] }, viz: { type: 'single_value' }, title: 'Revenue' } as unknown as Page['layout']['items'][number];

  it('a second click works from the first click\'s result, not the screen before it', () => {
    const first = tileFieldClickPatch(kpi, field('region'), descriptor);
    expect('patch' in first).toBe(true);
    const afterFirst = { ...kpi, ...(first as { patch: object }).patch } as typeof kpi;
    expect(afterFirst.query?.dimensions.map((dimension) => dimension.field)).toEqual(['region']);
    // Clicking Region again takes it off, from the saved tile: back to one number.
    const second = tileFieldClickPatch(afterFirst, field('region'), descriptor);
    const afterSecond = { ...afterFirst, ...(second as { patch: object }).patch } as typeof kpi;
    expect(afterSecond.query?.dimensions).toEqual([]);
    expect(afterSecond.query?.measures.map((measure) => measure.measure)).toEqual(['revenue']);
  });

  it('refuses to take away the last measure', () => {
    expect(tileFieldClickPatch(kpi, field('revenue'), descriptor)).toEqual({ message: 'A tile needs at least one measure' });
  });
});

describe('0.2.4 Apps rough edges', () => {
  it('names the page in the Ask scope line only when it is not the App\'s own name', () => {
    // The Jaffle sample read "Scoped to Jaffle Growth Review · Jaffle Growth Review".
    expect(askAboutAppScopeLine('Jaffle Growth Review', 'Jaffle Growth Review')).toBe('Scoped to Jaffle Growth Review');
    expect(askAboutAppScopeLine('Jaffle Growth Review', ' jaffle growth review ')).toBe('Scoped to Jaffle Growth Review');
    expect(askAboutAppScopeLine('Jaffle Growth Review', 'Overview')).toBe('Scoped to Jaffle Growth Review · Overview');
    expect(askAboutAppScopeLine('Jaffle Growth Review')).toBe('Scoped to Jaffle Growth Review');
    const html = renderToStaticMarkup(createElement(AskAboutApp, { scope: { appId: 'a', appName: 'Sales', pageTitle: 'Sales', filters: [] }, onAsk: () => undefined, aiConnected: true }));
    expect(html).toContain('Scoped to Sales<');
    expect(html).not.toContain('Sales · Sales');
  });

  it('hides the "Show AI copilot" button when no AI provider is connected', () => {
    const base = { readOnlyLink: false, hasApp: true, section: 'dashboards' };
    expect(appCopilotAvailable({ ...base, aiConnected: false })).toBe(false);
    expect(appCopilotAvailable({ ...base, aiConnected: true })).toBe(true);
    // Settings still loading: keep it, like the other AI controls.
    expect(appCopilotAvailable({ ...base })).toBe(true);
    expect(appCopilotAvailable({ ...base, aiConnected: true, readOnlyLink: true })).toBe(false);
    expect(appCopilotAvailable({ ...base, aiConnected: true, section: 'settings' })).toBe(false);
    expect(appCopilotAvailable({ ...base, aiConnected: true, hasApp: false })).toBe(false);
  });
});
