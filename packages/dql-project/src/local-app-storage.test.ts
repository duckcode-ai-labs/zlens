import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAppBuildDraftOperations, createAppBuildDraft, type DashboardDocument } from '@zlens/core';
import { LocalAppStorage } from './local-app-storage.js';

let dir: string;
let store: LocalAppStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dql-local-apps-'));
  store = new LocalAppStorage(join(dir, '.dql', 'local', 'apps.sqlite'));
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalAppStorage', () => {
  it('stores local-only App Studio drafts and append-only typed operation history', () => {
    const draft = createAppBuildDraft({
      id: 'build-revenue', appId: 'revenue-studio', name: 'Revenue Studio', authoringMode: 'manual',
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
      now: '2026-08-08T00:00:00.000Z',
    });
    store.saveAppBuildDraft(draft);
    const operations = [{ type: 'set_name' as const, name: 'Revenue Health' }];
    const next = applyAppBuildDraftOperations(draft, draft.revision, operations, '2026-08-08T00:01:00.000Z');
    store.saveAppBuildDraft(next, { expectedRevision: draft.revision, operations });

    expect(store.getAppBuildDraft(draft.id)).toMatchObject({
      version: 3,
      name: 'Revenue Health',
      revision: 2,
      state: 'local_draft',
    });
    expect(store.listAppBuildOperations(draft.id)).toEqual([
      expect.objectContaining({ revision: 2, operations }),
    ]);
    expect(() => store.saveAppBuildDraft(next, { expectedRevision: 1 })).toThrow(/APP_BUILD_REVISION_CONFLICT/);
  });

  it('atomically records an App Autopilot Apply decision across a marker-write failure and reopen', () => {
    const draft = createAppBuildDraft({
      id: 'build-autopilot-atomic', appId: 'autopilot-atomic', name: 'Autopilot Atomic', authoringMode: 'manual',
      frame: { goal: 'Exercise durable App Autopilot Apply recovery', metrics: [], dimensions: [], filters: [] },
      now: '2026-09-11T12:00:00.000Z',
    });
    const operations = [{ type: 'set_name' as const, name: 'Applied once' }];
    const next = applyAppBuildDraftOperations(draft, draft.revision, operations, '2026-09-11T12:01:00.000Z');
    const proposal = {
      id: 'proposal_atomic_1',
      draftId: draft.id,
      proposalHash: 'sha256:atomic-proposal',
      runId: 'run_atomic_1',
      artifactId: 'artifact_atomic_1',
    };
    store.saveAppBuildDraft(draft);
    store.saveAppAutopilotChange({
      ...proposal,
      payload: { version: 1, id: proposal.id, operations },
      createdAt: '2026-09-11T12:00:30.000Z',
    });

    // This trigger fails only the durable marker write, after the draft and
    // operation statements have been attempted. The surrounding SQLite
    // transaction must roll every earlier statement back.
    const internal = store as unknown as { db: { exec: (sql: string) => void } };
    internal.db.exec(`
      CREATE TRIGGER fail_autopilot_marker
      BEFORE UPDATE OF applied_at ON app_autopilot_changes
      WHEN NEW.id = 'proposal_atomic_1'
      BEGIN SELECT RAISE(ABORT, 'simulated marker failure'); END;
    `);
    expect(() => store.applyAppBuildDraftWithAutopilotChange(next, {
      expectedRevision: draft.revision,
      operations,
      proposal,
      appliedAt: '2026-09-11T12:01:00.000Z',
    })).toThrow('simulated marker failure');

    store.close();
    store = new LocalAppStorage(join(dir, '.dql', 'local', 'apps.sqlite'));
    expect(store.getAppBuildDraft(draft.id)).toMatchObject({ revision: draft.revision, name: draft.name });
    expect(store.getAppAutopilotChange(draft.id, proposal.id)).not.toHaveProperty('appliedRevision');

    const reopenedInternal = store as unknown as { db: { exec: (sql: string) => void } };
    reopenedInternal.db.exec('DROP TRIGGER fail_autopilot_marker');
    expect(store.applyAppBuildDraftWithAutopilotChange(next, {
      expectedRevision: draft.revision,
      operations,
      proposal,
      appliedAt: '2026-09-11T12:01:01.000Z',
    })).toMatchObject({ draft: { revision: next.revision, name: 'Applied once' }, deduped: false });

    store.close();
    store = new LocalAppStorage(join(dir, '.dql', 'local', 'apps.sqlite'));
    expect(store.applyAppBuildDraftWithAutopilotChange(next, {
      expectedRevision: draft.revision,
      operations,
      proposal,
      appliedAt: '2026-09-11T12:01:02.000Z',
    })).toMatchObject({ draft: { revision: next.revision, name: 'Applied once' }, deduped: true });
    expect(() => store.saveAppAutopilotChange({
      ...proposal,
      payload: { version: 1, id: proposal.id, operations: [] },
      createdAt: '2026-09-11T12:00:30.000Z',
    })).toThrow('APP_AUTOPILOT_CHANGE_CONFLICT');
  });

  it('round-trips exact Dataset filter component selections, including an explicit empty set', () => {
    const page: DashboardDocument = {
      version: 3,
      id: 'overview',
      metadata: { title: 'Overview' },
      datasets: [{
        id: 'orders-dataset',
        sourceId: 'source:orders',
        sourceRevision: 'source-v1',
        snapshotId: 'snapshot-v1',
        contractFingerprint: 'contract-v1',
      }],
      filters: [{
        id: 'region',
        type: 'multiselect',
        scope: { app: true },
        datasetBindings: { 'orders-dataset': { field: 'region', tileIds: [] } },
      }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          {
            i: 'revenue', x: 0, y: 0, w: 6, h: 3,
            sourceId: 'source:orders', sourceRevision: 'source-v1',
            query: { dimensions: [], measures: [{ measure: 'revenue' }] },
            viz: { type: 'kpi' },
          },
          {
            i: 'monthly-revenue', x: 6, y: 0, w: 6, h: 3,
            sourceId: 'source:orders', sourceRevision: 'source-v1',
            query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] },
            viz: { type: 'bar' },
          },
        ],
      },
    };
    const draft = createAppBuildDraft({
      id: 'build-component-scope',
      appId: 'component-scope',
      authoringMode: 'manual',
      frame: { goal: 'Inspect component filter scope', metrics: ['revenue'], dimensions: ['region'], filters: ['region'] },
      sources: [{
        id: 'source:orders', kind: 'certified_block', sourceRef: 'orders', sourceRevision: 'source-v1',
        trustState: 'certified', reviewStatus: 'not_required',
      }],
      pages: [page],
    });
    store.saveAppBuildDraft(draft);
    store.close();
    store = new LocalAppStorage(join(dir, '.dql', 'local', 'apps.sqlite'));

    expect(store.getAppBuildDraft(draft.id)?.pages[0]?.filters?.[0]?.datasetBindings).toEqual({
      'orders-dataset': { field: 'region', tileIds: [] },
    });
  });

  it('stores AI pins and refresh metadata locally', () => {
    const pin = store.createAiPin({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      title: 'AI summary',
      answer: 'Deposits are growing.',
      question: 'Why did deposits grow?',
      sql: 'SELECT 1 AS value',
      chartConfig: { chart: 'single_value' },
      result: { columns: ['value'], rows: [{ value: 1 }], rowCount: 1 },
      analysisPlan: { intent: 'ad_hoc_analysis', candidateTables: [{ relation: 'dev.deposits' }] },
      evidence: { validation: { status: 'warning' } },
      followUps: ['Show deposits by segment'],
    });

    expect(pin.reviewStatus).toBe('needs_review');
    const listed = store.listAiPins('executive-cockpit', 'bank-overview');
    expect(listed).toHaveLength(1);
    expect(listed[0].question).toBe('Why did deposits grow?');
    expect(listed[0].analysisPlan).toMatchObject({ intent: 'ad_hoc_analysis' });
    expect(listed[0].followUps).toEqual(['Show deposits by segment']);

    const refreshed = store.updateAiPinResult(pin.id, { columns: ['value'], rows: [{ value: 2 }], rowCount: 1 });
    expect(refreshed?.lastRefreshedAt).toBeTruthy();
    expect(refreshed?.lastRefreshError).toBeUndefined();

    const promoted = store.markAiPinPromoted(pin.id, 'apps/executive-cockpit/drafts/ai_summary.dql');
    expect(promoted?.reviewStatus).toBe('draft_created');
    expect(promoted?.promotedBlockPath).toBe('apps/executive-cockpit/drafts/ai_summary.dql');
  });

  it('restores App preview trust evidence after the local runtime restarts', () => {
    store.saveAppPreviewEvidence({
      runId: 'app_run_restart',
      draftId: 'build-revenue',
      dashboardId: 'overview',
      intentFingerprint: 'intent-1',
      snapshotId: 'snapshot-1',
      filterFingerprint: 'filters-1',
      resultFingerprint: 'result-1',
      personaFingerprint: 'persona-1',
      successfulTileIds: ['revenue', 'orders'],
      semanticApprovalEligibleTileIds: ['revenue'],
      datasetBindingEligibleTileIds: ['revenue'],
      datasetBindings: [{
        tileId: 'revenue',
        kind: 'block',
        sourceId: 'app:block:growth:orders',
        sourceRevision: 'sha256:source-v1',
        contractFingerprint: 'sha256:contract-v1',
        targetFingerprint: 'sha256:target-v1',
        executionTarget: { target: 'connection', connectionName: 'default' },
        grainProof: {
          id: 'proof.orders',
          sourceSqlFingerprint: 'sha256:source-sql-v1',
          parameterFingerprint: 'sha256:params-v1',
          queryFingerprint: 'sha256:query-v1',
          keyFingerprint: 'sha256:key-v1',
          scopeSnapshotId: 'dataset-scope:orders-v1',
          scopeSnapshotFingerprint: 'sha256:scope-v1',
        },
      }],
      createdAt: '2026-08-10T00:00:00.000Z',
    });
    store.close();
    store = new LocalAppStorage(join(dir, '.dql', 'local', 'apps.sqlite'));

    expect(store.getAppPreviewEvidence('app_run_restart')).toEqual({
      runId: 'app_run_restart',
      draftId: 'build-revenue',
      dashboardId: 'overview',
      intentFingerprint: 'intent-1',
      snapshotId: 'snapshot-1',
      filterFingerprint: 'filters-1',
      resultFingerprint: 'result-1',
      personaFingerprint: 'persona-1',
      successfulTileIds: ['revenue', 'orders'],
      semanticApprovalEligibleTileIds: ['revenue'],
      datasetBindingEligibleTileIds: ['revenue'],
      datasetBindings: [{
        tileId: 'revenue',
        kind: 'block',
        sourceId: 'app:block:growth:orders',
        sourceRevision: 'sha256:source-v1',
        contractFingerprint: 'sha256:contract-v1',
        targetFingerprint: 'sha256:target-v1',
        executionTarget: { target: 'connection', connectionName: 'default' },
        grainProof: {
          id: 'proof.orders',
          sourceSqlFingerprint: 'sha256:source-sql-v1',
          parameterFingerprint: 'sha256:params-v1',
          queryFingerprint: 'sha256:query-v1',
          keyFingerprint: 'sha256:key-v1',
          scopeSnapshotId: 'dataset-scope:orders-v1',
          scopeSnapshotFingerprint: 'sha256:scope-v1',
        },
      }],
      createdAt: '2026-08-10T00:00:00.000Z',
    });
  });

  it('restores the binding of a tile over a saved query result, which has no grain proof (design D1)', () => {
    const binding = {
      tileId: 'monthly',
      kind: 'block' as const,
      sourceId: 'app:block:commerce:monthly',
      sourceRevision: 'sha256:source-v1',
      contractFingerprint: 'sha256:result-contract-v1',
      targetFingerprint: 'sha256:target-v1',
      executionTarget: { target: 'local' as const },
      savedQueryResult: true as const,
    };
    const evidence = {
      runId: 'app_run_saved_query',
      draftId: 'build-revenue',
      dashboardId: 'overview',
      intentFingerprint: 'intent-1',
      snapshotId: 'snapshot-1',
      filterFingerprint: 'filters-1',
      resultFingerprint: 'result-1',
      personaFingerprint: 'persona-1',
      successfulTileIds: ['monthly'],
      semanticApprovalEligibleTileIds: [],
      datasetBindingEligibleTileIds: ['monthly'],
      datasetBindings: [binding],
      createdAt: '2026-10-21T00:00:00.000Z',
    };
    store.saveAppPreviewEvidence(evidence);
    store.close();
    store = new LocalAppStorage(join(dir, '.dql', 'local', 'apps.sqlite'));
    expect(store.getAppPreviewEvidence('app_run_saved_query')).toEqual(evidence);
    // A saved query result binding never carries a grain proof.
    store.saveAppPreviewEvidence({ ...evidence, runId: 'app_run_forged', datasetBindings: [{ ...binding, grainProof: { id: 'p', sourceSqlFingerprint: 'a', parameterFingerprint: 'b', queryFingerprint: 'c', keyFingerprint: 'd', scopeSnapshotId: 'e', scopeSnapshotFingerprint: 'f' } }] });
    expect(store.getAppPreviewEvidence('app_run_forged')?.datasetBindings).toEqual([]);
  });

  it('stores private App conversations locally', () => {
    const created = store.createAppConversation({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      title: 'Weekly review',
      context: {
        activeSurface: 'app',
        sourceCertifiedBlock: 'monthly_revenue',
        sourceQuestion: 'What changed?',
        trustLabel: 'certified',
        contextPackId: 'ctx_123',
      },
      messages: [
        { role: 'user', content: 'What changed?' },
        { role: 'assistant', content: 'Deposits grew.' },
      ],
    });

    expect(created.messageCount).toBe(2);
    expect(created.context?.sourceCertifiedBlock).toBe('monthly_revenue');
    expect(store.listAppConversations('executive-cockpit')).toHaveLength(1);

    const updated = store.updateAppConversation(created.id, {
      context: {
        activeSurface: 'app',
        sourceCertifiedBlock: 'card_approval_rate',
        sourceQuestion: 'Why did approvals soften?',
        reviewStatus: 'draft_ready',
        draftBlockPath: 'blocks/_drafts/card_approval_rate.dql',
      },
      messages: [
        { role: 'user', content: 'What changed?' },
        { role: 'assistant', content: 'Deposits grew and card approvals softened.' },
      ],
    });
    expect(updated?.lastMessage).toContain('card approvals');
    expect(updated?.context?.sourceCertifiedBlock).toBe('card_approval_rate');

    const full = store.getAppConversation(created.id);
    expect(full?.messages?.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(full?.context?.draftBlockPath).toBe('blocks/_drafts/card_approval_rate.dql');
    expect(store.deleteAppConversation(created.id)).toBe(true);
    expect(store.listAppConversations('executive-cockpit')).toHaveLength(0);
  });

  it('stores App research investigations locally', () => {
    const created = store.createAppInvestigation({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      sourceTileId: 'revenue-trend',
      sourceBlockId: 'monthly_revenue',
      question: 'Why did revenue drop in February?',
      intent: 'diagnose_change',
      context: { selectedBlock: { blockId: 'monthly_revenue', rowCount: 3 } },
      generatedSql: 'SELECT 1 AS revenue',
    });

    expect(created.reviewStatus).toBe('needs_review');
    expect(created.status).toBe('draft');
    expect(store.listAppInvestigations('executive-cockpit')).toHaveLength(1);

    const updated = store.updateAppInvestigation(created.id, {
      status: 'ready',
      summary: 'Revenue dropped because enterprise renewals slipped.',
      recommendation: 'Review the enterprise renewal cohort.',
      metrics: { currentValue: 10, baselineValue: 15, delta: -5 },
      driverCards: [{ title: 'Enterprise', contribution: '-5' }],
      resultPreviews: [{ result: { columns: ['segment', 'revenue'], rows: [{ segment: 'Enterprise', revenue: 10 }] } }],
      evidence: { trustStatus: { uncertified: true } },
      reportSections: [{
        id: 'executive-answer',
        kind: 'executive_answer',
        title: 'Executive answer',
        body: 'Enterprise renewals explain the drop.',
        tone: 'answer',
        bullets: ['Delta is -5'],
      }],
      lastRunAt: '2026-02-01T00:00:00.000Z',
    });

    expect(updated?.status).toBe('ready');
    expect(updated?.metrics).toMatchObject({ delta: -5 });
    expect(updated?.driverCards).toHaveLength(1);
    expect(updated?.resultPreviews).toHaveLength(1);
    expect(updated?.reportSections?.[0]).toMatchObject({
      kind: 'executive_answer',
      title: 'Executive answer',
      body: 'Enterprise renewals explain the drop.',
    });

    const pinned = store.markAppInvestigationPinned(created.id, 'pin_revenue_drop');
    expect(pinned?.pinnedAiPinId).toBe('pin_revenue_drop');
    expect(store.listAppInvestigations('executive-cockpit', 'bank-overview')[0].sourceBlockId).toBe('monthly_revenue');
  });

  it('finds reusable App investigations for the same question and stable context', () => {
    const created = store.createAppInvestigation({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      sourceTileId: 'revenue-trend',
      sourceBlockId: 'monthly_revenue',
      question: 'Why did revenue drop in February?',
      intent: 'diagnose_change',
      context: {
        updatedAt: '2026-01-01T00:00:00.000Z',
        activeFilters: { segment: 'enterprise', period: '2026-02' },
        selectedBlock: { rowCount: 3, blockId: 'monthly_revenue' },
      },
    });

    const reusable = store.findReusableAppInvestigation({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      sourceTileId: 'revenue-trend',
      sourceBlockId: 'monthly_revenue',
      question: '  Why did revenue   drop in February? ',
      intent: 'diagnose_change',
      context: {
        selectedBlock: { blockId: 'monthly_revenue', rowCount: 3 },
        activeFilters: { period: '2026-02', segment: 'enterprise' },
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    });

    expect(reusable?.id).toBe(created.id);

    const differentFilter = store.findReusableAppInvestigation({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      sourceTileId: 'revenue-trend',
      sourceBlockId: 'monthly_revenue',
      question: 'Why did revenue drop in February?',
      intent: 'diagnose_change',
      context: {
        activeFilters: { period: '2026-03', segment: 'enterprise' },
        selectedBlock: { blockId: 'monthly_revenue', rowCount: 3 },
      },
    });

    expect(differentFilter).toBeNull();
  });

  it('collapses duplicate App investigation rows on list reads without deleting history rows', () => {
    vi.useFakeTimers();
    const input = {
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      sourceTileId: 'revenue-trend',
      sourceBlockId: 'monthly_revenue',
      question: 'Why did revenue drop in February?',
      intent: 'diagnose_change' as const,
      context: {
        activeFilters: { period: '2026-02', segment: 'enterprise' },
        selectedBlock: { blockId: 'monthly_revenue', rowCount: 3 },
      },
    };
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
    store.createAppInvestigation(input);
    vi.setSystemTime(new Date('2026-02-01T00:01:00.000Z'));
    const duplicate = store.createAppInvestigation({
      ...input,
      title: 'Updated title from rerun',
    });
    vi.setSystemTime(new Date('2026-02-01T00:02:00.000Z'));
    store.createAppInvestigation({
      ...input,
      question: 'Why did revenue drop in March?',
      context: {
        activeFilters: { period: '2026-03', segment: 'enterprise' },
        selectedBlock: { blockId: 'monthly_revenue', rowCount: 3 },
      },
    });

    const listed = store.listAppInvestigations('executive-cockpit', 'bank-overview');

    expect(listed).toHaveLength(2);
    expect(listed.find((item) => item.question === 'Why did revenue drop in February?')?.id).toBe(duplicate.id);
    expect(listed.map((item) => item.question)).toEqual(expect.arrayContaining([
      'Why did revenue drop in February?',
      'Why did revenue drop in March?',
    ]));
  });

  it('archives every app-scoped local artifact and restores the exact bundle', () => {
    const appId = 'executive-cockpit';
    store.createAiPin({
      appId,
      dashboardId: 'overview',
      title: 'Review pin',
      answer: 'A review-required answer.',
    });
    store.createAppInvestigation({
      appId,
      dashboardId: 'overview',
      question: 'Why did revenue change?',
      intent: 'diagnose_change',
    });
    store.createAppConversation({
      appId,
      dashboardId: 'overview',
      title: 'App discussion',
      messages: [{ role: 'user', content: 'What changed?' }],
    });
    store.saveAppBuildDraft(createAppBuildDraft({
      id: 'build-executive', appId, name: 'Executive Cockpit', authoringMode: 'manual',
      frame: { goal: 'Monitor executive metrics', metrics: [], dimensions: [], filters: [] },
    }));
    store.saveAppPreviewEvidence({
      runId: 'app_run_archive', draftId: 'build-executive', dashboardId: 'overview',
      intentFingerprint: 'intent-archive',
      snapshotId: 'snapshot-1', filterFingerprint: 'filters-1', resultFingerprint: 'result-1',
      personaFingerprint: 'persona-1', successfulTileIds: ['revenue'],
      semanticApprovalEligibleTileIds: ['revenue'], datasetBindingEligibleTileIds: ['revenue'], createdAt: '2026-08-08T00:00:00.000Z',
      datasetBindings: [],
    });

    const archive = store.archiveAndDeleteAppState(appId, '2026-08-08T00:00:00.000Z');
    expect(archive.rows.aiPins).toHaveLength(1);
    expect(archive.rows.investigations).toHaveLength(1);
    expect(archive.rows.conversations).toHaveLength(1);
    expect(archive.rows.conversationMessages).toHaveLength(1);
    expect(archive.rows.buildDrafts).toHaveLength(1);
    expect(archive.rows.previewEvidence).toHaveLength(1);
    expect(store.listAiPins(appId)).toEqual([]);
    expect(store.listAppInvestigations(appId)).toEqual([]);
    expect(store.listAppConversations(appId)).toEqual([]);
    expect(store.listAppBuildDrafts(appId)).toEqual([]);
    expect(store.getAppPreviewEvidence('app_run_archive')).toBeNull();

    store.restoreAppState(archive);
    expect(store.listAiPins(appId)).toHaveLength(1);
    expect(store.listAppInvestigations(appId)).toHaveLength(1);
    expect(store.listAppConversations(appId)).toHaveLength(1);
    expect(store.listAppBuildDrafts(appId)).toHaveLength(1);
    expect(store.getAppPreviewEvidence('app_run_archive')?.snapshotId).toBe('snapshot-1');
  });

  it('keeps analysis memos and App conversations for their owner, as the caller says (RFC 0010)', () => {
    const path = join(dir, '.dql', 'local', 'apps.sqlite');
    const legacy = store.createAppInvestigation({ appId: 'claims', question: 'From before the host' });
    const asPriya = new LocalAppStorage(path, { owner: 'u-priya' });
    const asDan = new LocalAppStorage(path, { owner: 'u-dan' });
    const asNobody = new LocalAppStorage(path, { owner: null });
    try {
      const memo = asPriya.createAppInvestigation({ appId: 'claims', question: 'Why West?' });
      const talk = asPriya.createAppConversation({ appId: 'claims', title: 'West' });
      expect(memo.ownerId).toBe('u-priya');
      expect(asPriya.listAppInvestigations('claims').map((item) => item.id)).toEqual([memo.id]);
      expect(asPriya.findReusableAppInvestigation({ appId: 'claims', question: 'Why West?' })?.id).toBe(memo.id);
      expect(asDan.listAppInvestigations('claims')).toEqual([]);
      expect(asDan.getAppInvestigation(memo.id)).toBeNull();
      expect(asDan.updateAppInvestigation(memo.id, { title: 'taken' })).toBeNull();
      expect(asDan.findReusableAppInvestigation({ appId: 'claims', question: 'Why West?' })).toBeNull();
      expect(asDan.listAppConversations('claims')).toEqual([]);
      expect(asDan.getAppConversation(talk.id)).toBeNull();
      expect(asDan.deleteAppConversation(talk.id)).toBe(false);
      expect(asNobody.listAppInvestigations('claims')).toEqual([]);
      expect(asNobody.getAppInvestigation(legacy.id)).toBeNull();
      expect(asPriya.getAppInvestigation(legacy.id)).toBeNull();
      // Without an owner (no host): every record, as before.
      expect(store.listAppInvestigations('claims').map((item) => item.id).sort()).toEqual([legacy.id, memo.id].sort());
      expect(asPriya.getAppConversation(talk.id)?.title).toBe('West');
    } finally {
      asPriya.close();
      asDan.close();
      asNobody.close();
    }
  });
});
