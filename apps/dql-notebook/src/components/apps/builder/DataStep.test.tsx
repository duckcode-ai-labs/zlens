import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DataStep, type DataStepAiProps } from './DataStep';
import { DataPanel } from './DataPanel';
import { AddDataBrowser, RemoveDataButton } from './AddDataBrowser';
import { appDataItems, appDataSourceFromCandidate } from './app-data';
import { aiProposal, draftWith, marginMetrics, orderLinesDataset, topCustomersQuery } from './app-data.fixtures';
import { APP_STUDIO_AI_ACTIVITY_LABELS } from '../app-studio-ai-activity';
import {
  appStudioAiComposeRequest,
  appStudioAiDataModel,
  appStudioPickedDraftSources,
  appStudioProposalRequiredSourceIds,
  appStudioProposalSourceAddMode,
  summarizeAppStudioAiPlan,
} from '../app-studio-ai-plan';

const browser = { onAdd: vi.fn(async () => true), onRemove: vi.fn(), onChangePolicy: vi.fn() };

describe('Data step (design D3)', () => {
  it('asks for the App data before the canvas, with Open canvas and Skip', () => {
    const markup = renderToStaticMarkup(<DataStep draft={draftWith()} known={[]} onBack={vi.fn()} onOpenCanvas={vi.fn()} onSkip={vi.fn()} browser={browser} />);
    expect(markup).toContain('Data for this App');
    expect(markup).toContain('Pick the data this App will use. You can add more later from the Data panel.');
    expect(markup).toContain('This App&#x27;s data');
    expect(markup).toContain('No data yet');
    expect(markup).toContain('Skip, start empty');
    expect(markup).toContain('Open blank Studio');
    expect(markup).not.toContain('Open canvas with');
    expect(markup).toContain('aria-label="Kind of data"');
  });

  it('lists the App data with type, trust and domain, and counts it on Open canvas', () => {
    const draft = draftWith({ sources: [appDataSourceFromCandidate(orderLinesDataset)] });
    const markup = renderToStaticMarkup(<DataStep draft={draft} known={[orderLinesDataset]} onBack={vi.fn()} onOpenCanvas={vi.fn()} onSkip={vi.fn()} browser={browser} />);
    expect(markup).toContain('Open Studio with 1 source');
    // The origin label: a Dataset written in DQL is a saved query made row-level.
    expect(markup).toContain('Saved query · Certified · Commerce');
    expect(markup).toContain('aria-label="Remove Order Lines from this App"');
    expect(markup).toContain('1 source');
  });
});

describe('Data pane: this App data and + Add data (design D5)', () => {
  const draft = draftWith({ sources: [appDataSourceFromCandidate(orderLinesDataset), appDataSourceFromCandidate(topCustomersQuery)] });
  const appData = appDataItems(draft.sources, [orderLinesDataset, topCustomersQuery]);
  const props = {
    appData,
    target: { kind: 'none' as const },
    disabled: false,
    onChoose: vi.fn(),
    onPickField: vi.fn(),
    onAddData: vi.fn(),
    onAddSavedQuery: vi.fn(),
    onAddContent: vi.fn(),
  };

  it('lists the App data first, then + Add data, with no separate table or all-sources entries', () => {
    const markup = renderToStaticMarkup(<DataPanel {...props} active={appData[0]!} defaultPickerOpen />);
    expect(markup).toContain('This App&#x27;s data');
    expect(markup.indexOf('Order Lines')).toBeLessThan(markup.indexOf('+ Add data…'));
    expect(markup.indexOf('Top Customers')).toBeLessThan(markup.indexOf('+ Add data…'));
    expect(markup).toContain('Saved query · Certified');
    expect(markup).not.toContain('Start from a table…');
    expect(markup).not.toContain('Saved queries and all sources…');
    expect(markup).not.toContain('Browse all sources');
    expect(markup).not.toContain('Use a saved query instead');
  });

  it('builds tiles from a Dataset by its fields', () => {
    const markup = renderToStaticMarkup(<DataPanel {...props} active={appData[0]!} />);
    expect(markup).toContain('Measures');
    expect(markup).toContain('Revenue');
    expect(markup).toContain('Click a field to start a new tile.');
  });

  it('adds a saved query whose columns are not read yet as it is, with no "no fields" note', () => {
    const markup = renderToStaticMarkup(<DataPanel {...props} active={appData[1]!} />);
    expect(markup).toContain('Add as it is');
    expect(markup).toContain('aria-label="Add Top Customers as Table"');
    expect(markup).toContain('aria-label="Add Top Customers as Chart"');
    expect(markup).toContain('aria-label="Add Top Customers as KPI"');
    expect(markup).not.toContain('Saved queries have no fields');
    expect(markup).not.toContain('Search fields');
  });

  it('starts an App with no data from + Add data', () => {
    const markup = renderToStaticMarkup(<DataPanel {...props} appData={[]} active={null} />);
    expect(markup).toContain('This App has no data yet');
    expect(markup).toContain('Add data</button>');
  });
});

// ── AI mode (design D3, AI path) ─────────────────────────────────────────────

type Tree = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

/** Expand hook-free components into host elements; AddDataBrowser stays one element. */
function flatten(node: unknown, out: Tree[] = []): Tree[] {
  if (Array.isArray(node)) { node.forEach((child) => flatten(child, out)); return out; }
  if (!node || typeof node !== 'object' || !('props' in node)) return out;
  const element = node as Tree;
  if (typeof element.type === 'function' && element.type !== AddDataBrowser && element.type !== RemoveDataButton) {
    return flatten((element.type as (props: unknown) => unknown)(element.props), out);
  }
  out.push(element);
  flatten(element.props.children, out);
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as Tree).props.children);
  return '';
}

function button(tree: Tree[], name: string | RegExp): Tree {
  const match = tree.find((element) => element.type === 'button'
    && [String(element.props['aria-label'] ?? ''), textOf(element.props.children)].some((label) => (typeof name === 'string' ? label === name : name.test(label))));
  if (!match) throw new Error(`No button ${String(name)}`);
  return match;
}

function aiProps(overrides: Partial<DataStepAiProps> = {}, selected?: Set<string>): DataStepAiProps {
  const proposal = aiProposal();
  const summary = summarizeAppStudioAiPlan(proposal);
  const picks = selected ?? new Set(proposal.defaultSelectedSourceIds);
  return {
    status: 'ready',
    goal: summary.frame!.goal,
    model: appStudioAiDataModel(proposal, summary, picks, [orderLinesDataset, marginMetrics]),
    activitySteps: APP_STUDIO_AI_ACTIVITY_LABELS,
    activityIndex: 0,
    plannerLabel: 'Deterministic planner fallback',
    sourcePolicy: 'governed_only',
    busy: false,
    pickedSources: appStudioPickedDraftSources(proposal, picks),
    onRemovePick: vi.fn(),
    onAddBack: vi.fn(),
    onGenerateGap: vi.fn(),
    onAnswer: vi.fn(),
    onRevise: vi.fn(),
    onRetry: vi.fn(),
    onBuildPages: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  };
}

function renderAi(ai: DataStepAiProps, aiBrowser = browser) {
  const props = { draft: draftWith(), known: [], onBack: vi.fn(), onOpenCanvas: vi.fn(), onSkip: vi.fn(), browser: aiBrowser, ai };
  return { markup: renderToStaticMarkup(<DataStep {...props} />), tree: flatten(<DataStep {...props} />) };
}

describe('AI Data step (design D3, AI path)', () => {
  const ordersId = orderLinesDataset.sourceId!;
  const marginId = marginMetrics.sourceId!;

  it('shows the picks with type, trust, domain, the planner reason and their tiles', () => {
    const { markup } = renderAi(aiProps());
    expect(markup).toContain('AI picked 2 sources');
    expect(markup).toContain('For: <strong>Weekly revenue health for finance</strong>');
    expect(markup).toContain('Check the data before AI builds pages. Remove anything you don’t trust.');
    expect(markup).toContain('Deterministic planner fallback');
    expect(markup).toContain('Table · Certified · Commerce');
    expect(markup).toContain('Metrics · Certified · Finance');
    expect(markup).toContain('Why: Order lines carries revenue by order date.');
    expect(markup).toContain('Why: Margin metrics answer profitability.');
    expect(markup).toContain('Creates 1 tile');
    expect(markup).toContain('Build pages with 2 sources');
    expect(markup).toContain('>Discard</button>');
    // The Add data browser is on the right; picked data shows as Added.
    expect(markup).toContain('aria-label="Kind of data"');
  });

  it('lists the planner notes and the requirements not covered yet, with the review-required DQL action', () => {
    const governed = renderAi(aiProps()).markup;
    expect(governed).toContain('Notes from AI');
    expect(governed).toContain('Revenue by channel was not added because no Dataset has a channel field.');
    expect(governed).toContain('Not covered yet');
    expect(governed).toContain('Which channel drives revenue?');
    expect(governed).toContain('Allow data that needs review to generate');
    const review = renderAi(aiProps({ sourcePolicy: 'include_review_required' }));
    expect(review.markup).toContain('Generate draft DQL that needs review');
    const generate = vi.fn();
    const withGenerate = renderAi(aiProps({ sourcePolicy: 'include_review_required', onGenerateGap: generate }));
    (button(withGenerate.tree, 'Generate draft DQL that needs review').props.onClick as () => void)();
    expect(generate).toHaveBeenCalledWith('channel');
  });

  it('moves a removed pick to AI suggestions, and adds it back', () => {
    const onRemovePick = vi.fn();
    const picked = renderAi(aiProps({ onRemovePick }));
    (button(picked.tree, 'Remove Margin from the AI picks').props.onClick as () => void)();
    expect(onRemovePick).toHaveBeenCalledWith(marginId);

    const onAddBack = vi.fn();
    const removed = renderAi(aiProps({ onAddBack }, new Set([ordersId])));
    expect(removed.markup).toContain('AI picked 1 source');
    expect(removed.markup).toContain('AI suggestions');
    expect(removed.markup).toContain('Build pages with 1 source');
    (button(removed.tree, 'Add back Margin').props.onClick as () => void)();
    expect(onAddBack).toHaveBeenCalledWith(marginId, false);
  });

  it('adds data from the browser as a required source that re-plans, and marks picks Added', () => {
    const onAdd = vi.fn(async () => true);
    const { tree } = renderAi(aiProps(), { ...browser, onAdd });
    const addData = tree.find((element) => element.type === AddDataBrowser)!;
    expect((addData.props.draft as { sources: Array<{ id: string }> }).sources.map((source) => source.id)).toEqual([ordersId, marginId]);
    void (addData.props.onAdd as (id: string, options: { allowReview: boolean }) => Promise<boolean>)(topCustomersQuery.sourceId!, { allowReview: false });
    expect(onAdd).toHaveBeenCalledWith(topCustomersQuery.sourceId, { allowReview: false });
    // A source the proposal did not pick is planned again with every kept pick required.
    const kept = new Set([ordersId, marginId]);
    expect(appStudioProposalSourceAddMode({ alreadyProposed: false, reviewRequired: false, sourcePolicy: 'governed_only' })).toBe('replan');
    expect(appStudioProposalRequiredSourceIds(kept, topCustomersQuery.sourceId)).toEqual([ordersId, marginId, topCustomersQuery.sourceId]);
  });

  it('shows the activity steps while AI re-plans and locks the picks', () => {
    const { markup, tree } = renderAi(aiProps({ status: 'running', activityIndex: 1 }));
    expect(markup).toContain('Updating the plan with your data');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain(APP_STUDIO_AI_ACTIVITY_LABELS[1]);
    expect(button(tree, /Build pages with/).props.disabled).toBe(true);
    expect(button(tree, 'Remove Margin from the AI picks').props.disabled).toBe(true);
  });

  it('shows the Data step skeleton with the activity steps while the first proposal runs', () => {
    const { markup, tree } = renderAi(aiProps({ status: 'running', model: undefined, pickedSources: [], goal: 'Revenue health' }));
    expect(markup).toContain('AI is picking data');
    expect(markup).toContain('For: <strong>Revenue health</strong>');
    expect(markup).toContain('Preparing the plan');
    expect(markup).toContain('data-step-skeleton');
    for (const step of APP_STUDIO_AI_ACTIVITY_LABELS) expect(markup).toContain(step);
    expect(button(tree, /Build pages with 0 sources/).props.disabled).toBe(true);
  });

  it('asks the clarification in the Data step and builds pages only once it is answered', () => {
    const proposal = aiProposal({ clarify: true });
    const summary = summarizeAppStudioAiPlan(proposal);
    const onAnswer = vi.fn();
    const { markup, tree } = renderAi(aiProps({ model: appStudioAiDataModel(proposal, summary, new Set(proposal.defaultSelectedSourceIds)), onAnswer }));
    expect(markup).toContain('AI needs one more decision');
    expect(markup).toContain('Which period should the App open on?');
    expect(markup).toContain('Re-run proposal');
    expect(button(tree, /Build pages with/).props.disabled).toBe(true);
    (button(tree, /Last month/).props.onClick as () => void)();
    expect(onAnswer).toHaveBeenCalledWith('period', 'month');
  });

  it('Build pages applies the kept sources through the one compose call, with skipped tiles', () => {
    const onBuildPages = vi.fn();
    const { tree } = renderAi(aiProps({ onBuildPages }, new Set([ordersId])));
    (button(tree, /Build pages with 1 source/).props.onClick as () => void)();
    expect(onBuildPages).toHaveBeenCalledTimes(1);
    // The canvas then reviews tiles; Apply sends the Data step selection.
    expect(appStudioAiComposeRequest(draftWith(), 'proposal-1', new Set([ordersId]))).toEqual({
      mode: 'ai', expectedRevision: 3, expectedProposalHash: 'hash', proposalId: 'proposal-1', selectedSourceIds: [ordersId],
    });
    expect(appStudioAiComposeRequest(draftWith(), 'proposal-1', new Set([ordersId]), new Set(['revenue-trend'])).rejectedTileIds).toEqual(['revenue-trend']);
  });
});
