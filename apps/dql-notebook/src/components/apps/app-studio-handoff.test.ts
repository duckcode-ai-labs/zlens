import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppBuildProposal, AppStudioBuildDraft } from '../../api/client';
import { notebookStoreApi } from '../../store/NotebookStore';
import { DARK } from '../../themes/notebook-theme';
import { AppBuildProposalPanel, OPEN_IN_APP_STUDIO_LABEL } from './AppBuildProposalPanel';
import { appStudioAiDataResume, openAppProposalInStudio } from './app-studio-handoff';
import { appStudioUncoveredRequirements } from './app-studio-ai-plan';

/** One AI engine for Apps (design D9): Ask and MCP builds open in App Studio at the AI Data step. */

function draft(overrides: Partial<AppStudioBuildDraft> = {}): AppStudioBuildDraft {
  return {
    version: 3,
    id: 'build_1_abc',
    appId: 'leadership-revenue',
    name: 'Leadership Revenue',
    revision: 1,
    proposalHash: 'sha256:draft',
    authoringMode: 'ai',
    template: 'blank',
    sourcePolicy: 'governed_only',
    state: 'local_draft',
    frame: { goal: 'Revenue for leadership', metrics: [], dimensions: [], filters: [] },
    requirements: [],
    coverage: [],
    sources: [
      { id: 'app:block:sales:revenue', kind: 'block', sourceRef: 'revenue', trustState: 'certified', reviewStatus: 'not_required' },
      { id: 'app:semantic:sales:orders', kind: 'governed_semantic', sourceRef: 'orders', trustState: 'certified', reviewStatus: 'not_required' },
      { id: 'text:ask-1', kind: 'text', sourceRef: 'ask:1', trustState: 'review_required', reviewStatus: 'required' },
    ],
    pages: [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview', domain: 'sales' },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
    }],
    reviewTasks: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  } as unknown as AppStudioBuildDraft;
}

function withTile(base: AppStudioBuildDraft, i: string): AppStudioBuildDraft {
  const page = base.pages[0]!;
  return { ...base, pages: [{ ...page, layout: { ...page.layout, items: [{ i, x: 0, y: 0, w: 6, h: 4, viz: { type: 'text' }, text: { markdown: 'x' } }] } }] } as AppStudioBuildDraft;
}

describe('App Studio opens an AI draft with no pages built at the AI Data step', () => {
  it('requires the App data Ask or an MCP client picked and plans from the App goal', () => {
    expect(appStudioAiDataResume(draft())).toEqual({
      prompt: 'Revenue for leadership',
      requiredSourceIds: ['app:block:sales:revenue', 'app:semantic:sales:orders'],
    });
    // A template introduction is not content the author built.
    expect(appStudioAiDataResume(withTile(draft(), 'template-introduction'))).not.toBeNull();
  });

  it('lists a question Ask could not cover once, even when the planner finds it uncovered again', () => {
    const requirement = (id: string, question: string) => ({ id, question, role: 'evidence', required: true, measures: [], dimensions: [], filters: [] });
    const proposal = {
      operations: [{
        type: 'set_requirements',
        requirements: [requirement('not-covered-1', 'Why is churn rising?'), requirement('requirement-1', 'why is churn rising?'), requirement('requirement-2', 'Revenue by month')],
        coverage: ['not-covered-1', 'requirement-1', 'requirement-2'].map((requirementId) => ({
          requirementId, status: requirementId === 'requirement-2' ? 'covered' : 'gap', sourceIds: [], componentIds: [], reasons: [],
        })),
      }],
    } as unknown as Parameters<typeof appStudioUncoveredRequirements>[0];
    expect(appStudioUncoveredRequirements(proposal)).toEqual([{ id: 'not-covered-1', question: 'Why is churn rising?' }]);
  });

  it('leaves manual drafts, edits of a published App and drafts with content on the canvas', () => {
    expect(appStudioAiDataResume(draft({ authoringMode: 'manual' }))).toBeNull();
    expect(appStudioAiDataResume(draft({ baseApp: { appId: 'sales', fingerprint: 'sha256:x' } }))).toBeNull();
    expect(appStudioAiDataResume(withTile(draft(), 'ask-123'))).toBeNull();
    expect(appStudioAiDataResume(draft({ state: 'project_published' }))).toBeNull();
  });
});

describe('Ask App proposal: Open in App Studio', () => {
  it('makes the App Studio draft from the kept tiles and opens Apps on it', async () => {
    const openInStudio = vi.fn(async () => ({ ok: true as const, draft: { id: 'build_9_xyz', appId: 'leadership-revenue', name: 'Leadership Revenue' } }));
    const onOpenApp = vi.fn();
    const result = await openAppProposalInStudio({
      sessionId: 'aib_1',
      selectedTileIds: new Set(['revenue', 'orders']),
      proposalHash: 'sha256:proposal',
      edits: { appName: 'Leadership Revenue' },
      openInStudio,
      onOpenApp,
    });
    expect(openInStudio).toHaveBeenCalledWith('aib_1', {
      selectedTileIds: ['revenue', 'orders'],
      expectedProposalHash: 'sha256:proposal',
      appName: 'Leadership Revenue',
    });
    // The third argument is the draft: the store opens it in App Studio (OPEN_APP_DRAFT).
    expect(onOpenApp).toHaveBeenCalledWith('leadership-revenue', undefined, 'build_9_xyz');
    expect(result).toEqual({ ok: true, draftId: 'build_9_xyz', appId: 'leadership-revenue', name: 'Leadership Revenue' });
  });

  it('stays on the card with the error when the proposal cannot be opened', async () => {
    const onOpenApp = vi.fn();
    const result = await openAppProposalInStudio({
      sessionId: 'aib_1',
      selectedTileIds: [],
      edits: {},
      openInStudio: async () => ({ ok: false as const, error: 'The App proposal changed or is stale.' }),
      onOpenApp,
    });
    expect(result).toEqual({ ok: false, error: 'The App proposal changed or is stale.' });
    expect(onOpenApp).not.toHaveBeenCalled();
  });

  it('opens the draft in App Studio build mode', () => {
    notebookStoreApi.getState().dispatch({ type: 'OPEN_APP_DRAFT', draftId: 'build_9_xyz', appId: 'leadership-revenue' });
    expect(notebookStoreApi.getState()).toMatchObject({ mainView: 'apps', activeAppDraftId: 'build_9_xyz', activeAppExperience: 'build' });
  });

  it('uses the App Studio words and one Open in App Studio action', () => {
    const proposal = {
      intent: { target: 'shared_project', initialVisibility: 'private' },
      buildFrame: { goal: 'Revenue', audience: 'leaders', metrics: [], dimensions: [], filters: [], desiredOutput: '' },
      tiles: [
        { id: 'revenue', source: 'certified_block', title: 'Revenue', blockId: 'revenue', viz: 'line', certification: 'certified', sourceClass: 'certified_block', reviewStatus: 'not_required', preflight: { status: 'passed', message: '' }, selectedByDefault: true },
        { id: 'orders', source: 'semantic_query', title: 'Orders', viz: 'bar', certification: 'reviewed_semantic', sourceClass: 'governed_semantic', reviewStatus: 'required', preflight: { status: 'review_required', message: '' }, selectedByDefault: true },
        { id: 'why', source: 'ai_generated', title: 'Why revenue moved', sql: 'select 1', viz: 'table', certification: 'ai_generated', sourceClass: 'exploratory_analysis', reviewStatus: 'required', preflight: { status: 'passed', message: '' }, selectedByDefault: false },
      ],
      gaps: [{ id: 'g1', question: 'Which customers churned?', reason: 'No certified block covers this question.' }],
      clarifications: [],
      followUps: [],
      coverage: { certifiedTiles: 1, semanticTiles: 1, generatedTiles: 1, gaps: 1 },
    } as unknown as AppBuildProposal;
    const markup = renderToStaticMarkup(createElement(AppBuildProposalPanel, {
      proposal,
      t: DARK,
      selected: new Set(['revenue', 'orders']),
      onToggle: () => undefined,
      onCreate: () => undefined,
      compact: true,
    }));
    expect(markup).toContain(OPEN_IN_APP_STUDIO_LABEL);
    expect(markup).toContain('Metrics · Needs review');
    expect(markup).toContain('Draft SQL · Needs review');
    expect(markup).toContain('Not covered yet');
    expect(markup).toContain('Nothing is written to your project until you publish.');
    expect(markup).not.toContain('Build draft (');
    expect(markup).not.toContain('governed semantic');
  });
});
