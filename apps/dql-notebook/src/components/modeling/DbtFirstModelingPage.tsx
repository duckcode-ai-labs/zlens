import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, BookOpen, Boxes, CheckCircle2, Columns3, Download, EyeOff, FileSearch, FolderTree, GitBranch, GraduationCap, Link2, Maximize2, MessageCircle, Network, PanelRightClose, PanelRightOpen, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, XCircle } from 'lucide-react';
import { DEFAULT_MODEL_AREA_ID } from '@zlens/core/modeling-ids';
import type { DbtMetricAuthoringInput, DbtMetricPatchPreview, DbtNodeAuthoringDetail, DbtSourceAuthoringInput, DbtSourcePatchPreview, ManifestModelArea, ManifestModelEntity, ManifestModelRelationship, ModelingAuthoringChange, ModelingChangePreview } from '@zlens/core';
import { hostAllows, hostReadOnly, readOnlyReason, useHostUi, type HostUiState } from '../../host/host-ui';
import { api, type AgentRunArtifact, type ContextAuthoringProposalV1, type DbtFirstModelingResponse, type WaitingWarehouseDrafts } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { NotebookFile } from '../../store/types';
import { themes, type ThemeMode } from '../../themes/notebook-theme';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { SkillsPage } from '../skills/SkillsPage';
import { DomainSettingsDrawer, type DomainSettingsMode } from '../domains/DomainSettingsDrawer';
import { authoredDomainOptions } from '../domains/authored-domain-options';
import { TermsAndConceptsPanel } from './TermsAndConceptsPanel';
import { RelationshipBuilder } from './RelationshipBuilder';
import { AskImpactDrawer } from './AskImpactDrawer';
import { DomainModelingCanvas, type ColumnDisplayMode, type DiagramDensity, type DiagramLayoutMode, type ModelingViewMode, type RelationshipDraft } from './DomainModelingCanvas';
import { UnifiedAgentRunPanel, usePersistedAgentThreadId } from '../agent/UnifiedAgentRunPanel';
import { ContextProposalReviewDrawer } from './ContextProposalReviewDrawer';
import { stagingLeftOutSentence, waitingDraftsSentence } from './proposal-review-words';
import { AddModelsDrawer, ModelingYamlImportDrawer } from './ModelingStartDrawers';
import { DOMAIN_STUDIO_LOCATION_KEY, DOMAIN_STUDIO_NAVIGATION, domainEntityRecords, domainPackageTree, domainStudioLocationHref, entityKindColor, isDescriptiveOnlyChange, modelingThreadScope, resolveDomainStudioLocation, type DomainStudioSection } from './domain-studio-model';
import { domainStudioUnavailableState, type DomainStudioUnavailableState } from './domain-studio-readiness';
import type { ModelingSearchOption } from './modeling-search';
import { Modal, SearchPicker, iconButtonStyle, inputStyle, linkButton } from './modeling-controls';
import { RELATIONSHIP_LEGEND, relationshipDraftFromJoin, relationshipProfileLines, relationshipSentence, relationshipStatusView } from './relationship-builder-model';

type Theme = (typeof themes)['dark'];
type Tab = DomainStudioSection;
type Editor =
  | { kind: 'area'; area?: ManifestModelArea }
  | { kind: 'entity'; entity?: ManifestModelEntity; dbtUniqueId?: string; relationshipFrom?: { from: string; fromColumn?: string } }
  | {
      kind: 'relationship';
      relationship?: ManifestModelRelationship;
      draft?: RelationshipDraft;
    };

type DiagramSearchItem = { recordKey: string; type: 'model' | 'column'; label: string; sublabel: string; role: string | undefined };

export function DbtFirstModelingPage({ initialSection }: { initialSection?: DomainStudioSection } = {}) {
  // UI-001/UI-006: Modeling is one domain-scoped page. DQL-owned package
  // source is edited here; global Apps and Notebooks appear only as
  // ProductDomainContext backlinks ("Used by") and keep their root storage.
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [data, setData] = useState<DbtFirstModelingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<DomainStudioUnavailableState | null>(null);
  const hostUi = useHostUi();
  // Without dataset.author the person may read the model but not change it: every opener below is a no-op and its button is hidden.
  const readOnly = hostReadOnly(hostUi, 'domains');
  const [domainSettings, setDomainSettingsState] = useState<DomainSettingsMode | null>(null);
  const setDomainSettings = (next: DomainSettingsMode | null) => { if (!readOnly || !next) setDomainSettingsState(next); };
  const [impactOpen, setImpactOpen] = useState(false);
  const initialLocation = useMemo(() => {
    const location = readDomainStudioLocation();
    return initialSection ? { ...location, section: initialSection } : location;
  }, [initialSection]);
  const [tab, setTab] = useState<Tab>(initialLocation.section);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(initialLocation.domain);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(initialLocation.modelAreaId);
  const [selectedId, setSelectedId] = useState<string | null>(initialLocation.selectedId);
  const [nodeDetail, setNodeDetail] = useState<DbtNodeAuthoringDetail | null>(null);
  const [detailsByDbtId, setDetailsByDbtId] = useState<Record<string, DbtNodeAuthoringDetail | undefined>>({});
  const detailRequests = useRef(new Map<string, Promise<DbtNodeAuthoringDetail | undefined>>());
  const loadedDetailIds = useRef(new Set<string>());
  const savedDiagramPreferences = useMemo(() => readDiagramPreferences(), []);
  const [modelingView, setModelingView] = useState<ModelingViewMode>(savedDiagramPreferences.viewMode ?? 'business');
  const [columnMode, setColumnMode] = useState<ColumnDisplayMode>(savedDiagramPreferences.columnMode ?? 'relevant');
  const [diagramSearch, setDiagramSearch] = useState('');
  const [resetLayoutToken, setResetLayoutToken] = useState(0);
  // Bumped when a model/column is picked from search, so the canvas pans to it.
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | null>(null);
  const [layoutMode, setLayoutMode] = useState<DiagramLayoutMode>(savedDiagramPreferences.layoutMode ?? 'auto');
  const [diagramDensity, setDiagramDensity] = useState<DiagramDensity>(savedDiagramPreferences.density ?? 'normal');
  const [visibleLimit, setVisibleLimit] = useState(savedDiagramPreferences.visibleLimit ?? 50);
  const [dimUnrelated, setDimUnrelated] = useState(savedDiagramPreferences.dimUnrelated ?? true);
  const [showEdgeLabels, setShowEdgeLabels] = useState(savedDiagramPreferences.showEdgeLabels ?? true);
  const [showLegend, setShowLegend] = useState(false);
  const [diagramFullscreen, setDiagramFullscreen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [narrowLayout, setNarrowLayout] = useState(() => typeof window !== 'undefined' && window.innerWidth < 980);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [editor, setEditorState] = useState<Editor | null>(null);
  const setEditor = (next: Editor | null) => { if (!readOnly || !next) setEditorState(next); };
  const [pendingRelationshipFrom, setPendingRelationshipFrom] = useState<RelationshipDraft | null>(null);
  const [startDrawer, setStartDrawerState] = useState<'models' | 'yaml' | null>(null);
  const setStartDrawer = (next: 'models' | 'yaml' | null) => { if (!readOnly || !next) setStartDrawerState(next); };
  const [proposal, setProposal] = useState<ContextAuthoringProposalV1 | null>(null);
  const [aiDockOpen, setAiDockOpen] = useState(() => readDiagramPreferences().aiDockOpen === true);
  /**
   * A proposal previewed as ghost nodes and dashed edges on the live canvas.
   * Reviewing a model you can see beats reading a YAML diff, so the AI's output
   * lands on the diagram first and only then offers the exact source patches.
   */
  const [ghostProposal, setGhostProposal] = useState<ContextAuthoringProposalV1 | null>(null);
  const [modelingCorrection, setModelingCorrection] = useState<{ text: string; nonce: number; evidence: unknown } | null>(null);
  const [dbtSourceEntity, setDbtSourceEntity] = useState<ManifestModelEntity | null>(null);
  /**
   * Pending model deletion. Modeling authoring was upsert-only, so an entity or
   * relationship added by mistake could only be removed by hand-editing YAML.
   */
  const [pendingModelDelete, setPendingModelDelete] = useState<
    { kind: 'entity' | 'relationship'; id: string; domain: string; areaId?: string; label: string } | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useEffect(() => { localStorage.setItem('dql-modeling-preferences', JSON.stringify({ modelingView, columnMode, layoutMode, density: diagramDensity, visibleLimit, dimUnrelated, showEdgeLabels, aiDockOpen })); }, [modelingView, columnMode, layoutMode, diagramDensity, visibleLimit, dimUnrelated, showEdgeLabels, aiDockOpen]);
  useEffect(() => {
    const onResize = () => setNarrowLayout(window.innerWidth < 980);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const toggleInspector = useCallback(() => {
    setInspectorOpen((open) => {
      const next = !open;
      if (next) window.requestAnimationFrame(() => inspectorRef.current?.focus());
      else window.requestAnimationFrame(() => inspectorToggleRef.current?.focus());
      return next;
    });
  }, []);

  const selectSection = useCallback((section: Tab) => {
    setTab(section);
    writeDomainStudioLocation(selectedDomain, section, false, selectedAreaId, selectedId);
  }, [selectedAreaId, selectedDomain, selectedId]);
  const selectDomain = useCallback((domain: string | null) => {
    setSelectedDomain(domain);
    setSelectedAreaId(null);
    setSelectedId(null);
    writeDomainStudioLocation(domain, tab, false, null, null);
  }, [tab]);

  useEffect(() => {
    const onPopState = () => {
      const next = readDomainStudioLocation();
      setSelectedDomain(next.domain);
      setSelectedAreaId(next.modelAreaId);
      setSelectedId(next.selectedId);
      setTab(next.section);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    writeDomainStudioLocation(selectedDomain, tab, true, selectedAreaId, selectedId);
  }, [selectedAreaId, selectedDomain, selectedId, tab]);

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await api.getDbtFirstModeling();
      setData(result);
      setUnavailable(null);
      const nextDomain = selectedDomain && result.modeling.packages[selectedDomain]
        ? selectedDomain
        : null;
      if (nextDomain !== selectedDomain) {
        setSelectedDomain(nextDomain);
        writeDomainStudioLocation(nextDomain, tab, true);
      }
    } catch (error) {
      setData(null);
      setUnavailable(domainStudioUnavailableState(error));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    let proposalId: string | null = null;
    try {
      proposalId = window.sessionStorage.getItem('dql-context-proposal-handoff');
      if (proposalId) window.sessionStorage.removeItem('dql-context-proposal-handoff');
    } catch { /* best effort */ }
    if (!proposalId) return;
    void api.getContextProposal(proposalId).then((next) => {
      setProposal(next);
      setTab(next.impact.skillChanges > 0 && next.impact.modelingChanges === 0 ? 'skills' : 'diagram');
    }).catch(() => undefined);
  }, []);

  // "Save this join as a relationship" from an answer: open the builder with
  // the two models and keys the AI used, or say which table to add first.
  const [relationshipHandoff, setRelationshipHandoff] = useState<{ relations: string[]; keys: Array<{ from: string; to: string }> } | null>(() => {
    try {
      const raw = window.sessionStorage.getItem('dql-relationship-draft-handoff');
      if (!raw) return null;
      window.sessionStorage.removeItem('dql-relationship-draft-handoff');
      const parsed = JSON.parse(raw) as { relations?: unknown; keys?: unknown };
      if (!Array.isArray(parsed.relations) || parsed.relations.length !== 2) return null;
      const keys = Array.isArray(parsed.keys) ? parsed.keys.filter((key): key is { from: string; to: string } => typeof key?.from === 'string' && typeof key?.to === 'string') : [];
      return { relations: parsed.relations.map(String), keys };
    } catch {
      return null;
    }
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [draftingFromWarehouse, setDraftingFromWarehouse] = useState(false);
  // Drafts are kept automatically (new-user round 2, Q3): what "Draft my
  // models" drafted waits on the server until it is saved or discarded, so a
  // fresh browser, a reload or leaving without Save loses nothing.
  const [waitingDrafts, setWaitingDrafts] = useState<WaitingWarehouseDrafts | null>(null);
  const [stagingLeftOut, setStagingLeftOut] = useState<Array<{ relation: string; finalRelation: string }> | null>(null);
  const draftsMode = data?.modeling.mode;
  const loadWaitingDrafts = useCallback(async () => {
    if (draftsMode !== 'warehouse-first' && draftsMode !== 'hybrid') {
      setWaitingDrafts(null);
      return;
    }
    setWaitingDrafts(await api.getWaitingWarehouseDrafts().catch(() => null));
  }, [draftsMode]);
  useEffect(() => { void loadWaitingDrafts(); }, [loadWaitingDrafts]);
  const reviewWaitingDrafts = async () => {
    if (!waitingDrafts) return;
    try {
      setProposal(await api.getContextProposal(waitingDrafts.proposalId));
      setTab('diagram');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };
  const discardWaitingDrafts = async () => {
    if (!waitingDrafts) return;
    try {
      await api.discardContextProposal(waitingDrafts.proposalId);
      setStagingLeftOut(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
    await loadWaitingDrafts();
  };
  // Opt-in: learn joins from recent query history as well (RFC 0007).
  const [draftWithQueryHistory, setDraftWithQueryHistory] = useState(false);
  const [metricDrawerOpen, setMetricDrawerOpenState] = useState(false);
  const setMetricDrawerOpen = (open: boolean) => { if (!readOnly || !open) setMetricDrawerOpenState(open); };
  const [dbtMetricOpen, setDbtMetricOpenState] = useState(false);
  const setDbtMetricOpen = (open: boolean) => { if (!readOnly || !open) setDbtMetricOpenState(open); };
  /**
   * RFC 0007: draft domains, models and joins from the warehouse catalog,
   * checked on the warehouse, and open them in the ordinary review drawer.
   */
  const draftFromWarehouse = async (options: { includeStaging?: boolean } = {}) => {
    setDraftingFromWarehouse(true);
    setNotice(null);
    try {
      const result = await api.draftWarehouseModel({ expectedSnapshotId: data?.snapshotId, queryHistory: draftWithQueryHistory, ...(options.includeStaging ? { includeStaging: true } : {}) });
      const history = result.report.queryHistory;
      if (history && 'error' in history) setNotice(history.error);
      setStagingLeftOut(result.report.stagingHidden?.length ? result.report.stagingHidden : null);
      void loadWaitingDrafts();
      if (result.proposal) setProposal(result.proposal);
      else setNotice(`Nothing new to draft: the ${result.report.relations} table${result.report.relations === 1 ? '' : 's'} in the warehouse catalog and their joins are already modeled.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftingFromWarehouse(false);
    }
  };
  useEffect(() => {
    if (!data || !relationshipHandoff) return;
    const { draft, missing } = relationshipDraftFromJoin(relationshipHandoff, data.modeling.entities, data.dbtProvenance.nodes);
    setRelationshipHandoff(null);
    setTab('diagram');
    if (draft) setEditor({ kind: 'relationship', draft });
    else setNotice(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not on the map yet. Add ${missing.length === 1 ? 'it' : 'them'} with Add models, then connect the two models.`);
  }, [data, relationshipHandoff]);

  const ghostView = useMemo(
    () => applyGhostProposal(data?.modeling ?? { entities: {}, relationships: {} } as DbtFirstModelingResponse['modeling'], ghostProposal),
    [data?.modeling, ghostProposal],
  );
  const selectedEntity = data?.modeling.entities[selectedId ?? ''];
  const selectedRelationship = data?.modeling.relationships[selectedId ?? ''];
  const domainAreas = useMemo(
    () => data ? Object.values(data.modeling.areas).filter((area) => !selectedDomain || area.domain === selectedDomain).sort((a, b) => a.name.localeCompare(b.name)) : [],
    [data, selectedDomain],
  );
  const selectedArea = data?.modeling.areas[selectedAreaId ?? ''];
  useEffect(() => {
    if (!data) return;
    if (selectedAreaId && !domainAreas.some((area) => area.qualifiedId === selectedAreaId)) setSelectedAreaId(null);
  }, [data, domainAreas, selectedAreaId]);
  const loadNodeDetail = useCallback((uniqueId: string): Promise<DbtNodeAuthoringDetail | undefined> => {
    const active = detailRequests.current.get(uniqueId);
    if (active) return active;
    if (loadedDetailIds.current.has(uniqueId)) return Promise.resolve(undefined);
    const request = api
      .getDbtModelingNode(uniqueId)
      .then((detail) => {
        loadedDetailIds.current.add(uniqueId);
        setDetailsByDbtId((current) => ({ ...current, [uniqueId]: detail }));
        return detail;
      })
      .catch(() => {
        loadedDetailIds.current.add(uniqueId);
        return undefined;
      })
      .finally(() => detailRequests.current.delete(uniqueId));
    detailRequests.current.set(uniqueId, request);
    return request;
  }, []);
  useEffect(() => {
    if (!selectedEntity) {
      setNodeDetail(null);
      return;
    }
    const cached = detailsByDbtId[selectedEntity.dbtUniqueId];
    if (cached) {
      setNodeDetail(cached);
      return;
    }
    let cancelled = false;
    void loadNodeDetail(selectedEntity.dbtUniqueId).then((detail) => {
      if (!cancelled) setNodeDetail(detail ?? null);
    });
    return () => { cancelled = true; };
  }, [detailsByDbtId, loadNodeDetail, selectedEntity?.dbtUniqueId]);
  useEffect(() => {
    detailRequests.current.clear();
    loadedDetailIds.current.clear();
    setDetailsByDbtId({});
  }, [data?.dbtProvenance.manifestFingerprint]);

  const loadVisibleNodeDetails = useCallback((uniqueIds: string[]) => {
    // A graph may contain thousands of dbt models. Hydrate only a small visible
    // window; selecting any other node loads it immediately through the same cache.
    for (const uniqueId of uniqueIds.slice(0, 24)) void loadNodeDetail(uniqueId);
  }, [loadNodeDetail]);

  if (loading && !data) return <EmptyState t={t} title="Loading Modeling…" detail="Reading your dbt project and the domains, relationships, terms and skills built on it." />;
  if (!data) {
    const state = unavailable ?? domainStudioUnavailableState(null);
    return <EmptyState t={t} title={state.title} detail={state.detail} status={state.status} action={state.action === 'enable_warehouse' ? { label: 'Model my warehouse without dbt', run: async () => { await api.enableWarehouseModeling(); await refresh(); } } : undefined} />;
  }
  const warehouseModeling = data.modeling.mode === 'warehouse-first' || data.modeling.mode === 'hybrid';
  const warehouseRelationCount = Object.values(data.dbtProvenance.nodes).filter((node) => node.resourceType === 'warehouse').length;
  const dbtNodeCount = Object.keys(data.dbtProvenance.nodes).length - warehouseRelationCount;

  const relationByDbtId = Object.fromEntries(Object.values(data.dbtProvenance.nodes).map((node) => [node.uniqueId, node.relation]));
  // Searchable models + (already-hydrated) columns for the diagram search dropdown.
  const diagramSearchItems: DiagramSearchItem[] = Object.entries(data.modeling.entities).flatMap(([recordKey, entity]) => {
    const modelName = entity.businessName || entity.localId || entity.id;
    const items: DiagramSearchItem[] = [{ recordKey, type: 'model', label: modelName, sublabel: entity.domain, role: entity.analyticalRole }];
    for (const column of detailsByDbtId[entity.dbtUniqueId]?.columns ?? []) {
      items.push({ recordKey, type: 'column', label: column.name, sublabel: modelName, role: entity.analyticalRole });
    }
    return items;
  });
  const handlePickModel = (recordKey: string) => {
    setSelectedId(recordKey);
    setDiagramSearch('');
    setFocusRequest((previous) => ({ id: recordKey, token: (previous?.token ?? 0) + 1 }));
  };
  const selectedAreaEntityIds = selectedArea ? new Set([...selectedArea.entityIds, ...selectedArea.referencedEntityIds]) : undefined;
  const domainEntities = domainEntityRecords(data.modeling, selectedDomain).filter(({ recordKey }) => !selectedAreaEntityIds || selectedAreaEntityIds.has(recordKey));
  const domainRelationships = Object.values(data.modeling.relationships).filter((relationship) => {
    const from = data.modeling.entities[relationship.from];
    const to = data.modeling.entities[relationship.to];
    if (selectedArea) return selectedArea.relationshipIds.includes(relationship.qualifiedId);
    return !selectedDomain || from?.domain === selectedDomain || to?.domain === selectedDomain;
  });
  const unboundNodes = Object.values(data.dbtProvenance.nodes).filter((node) => !Object.values(data.modeling.entities).some((entity) => entity.dbtUniqueId === node.uniqueId));
  const inspectorVisible = inspectorOpen && tab === 'diagram';
  // With a domain chosen, the Skills tab shows that domain's Git-owned skills
  // (plus the project-wide ones every domain inherits, see SkillsPage). With
  // no domain it shows every skill in the project — there is no second list.
  const domainSkillPaths = selectedDomain
    ? [...new Set(data.domainAssets?.[selectedDomain]?.skills ?? [])].sort()
    : undefined;
  const domainRecord = selectedDomain
    ? state.authoredDomains.find((domain) => domain.id === selectedDomain)
      ?? { id: selectedDomain, name: selectedDomain, parent: data.modeling.packages[selectedDomain]?.parent, owner: data.modeling.packages[selectedDomain]?.owner }
    : undefined;
  const packageOptions = domainPackageTree(data.modeling.packages);
  const authoredLabels = new Map(authoredDomainOptions(state.authoredDomains).map((option) => [option.value, option.label]));
  const tabCounts: Partial<Record<Tab, number>> = {
    diagram: domainEntityRecords(data.modeling, selectedDomain).length,
    skills: selectedDomain ? (domainSkillPaths?.length ?? 0) : undefined,
    blocks: new Set(
      selectedDomain
        ? (data.domainAssets?.[selectedDomain]?.blocks ?? [])
        : Object.values(data.domainAssets ?? {}).flatMap((assets) => assets.blocks ?? []),
    ).size,
  };
  const openAsk = (objectId?: string) => {
    try { window.sessionStorage.setItem('dql-ask-domain-context', JSON.stringify({ domain: selectedDomain, modelAreaId: selectedArea?.qualifiedId, ...(objectId ? { objectId } : {}) })); } catch { /* best effort */ }
    dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' });
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: t.appBg,
        color: t.textPrimary,
      }}
    >
      {/* One header: which domain and subject area you are modeling, and the
          page-level actions. There is no second navigation rail — Notebooks,
          Blocks and Apps already live in the app rail. */}
      <header
        style={{
          minHeight: 52,
          padding: '8px 14px',
          borderBottom: `1px solid ${t.headerBorder}`,
          background: t.headerBg,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Boxes size={16} color={t.accent} />
          <h1 style={{ margin: 0, fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap' }}>Modeling</h1>
        </div>
        <ScopeSelect
          label="Domain"
          value={selectedDomain ?? ''}
          onChange={(value) => selectDomain(value || null)}
          options={[{ value: '', label: 'All domains' }, ...packageOptions.map((pkg) => ({ value: pkg.id, label: authoredLabels.get(pkg.id) ?? pkg.label }))]}
          t={t}
        />
        {!readOnly && (
          <IconButton t={t} title="New domain" onClick={() => setDomainSettings({ kind: 'create' })}>
            <Plus size={14} />
          </IconButton>
        )}
        {!readOnly && domainRecord ? (
          <IconButton t={t} title="Domain settings" onClick={() => setDomainSettings({ kind: 'edit', domain: domainRecord })}>
            <Settings2 size={14} />
          </IconButton>
        ) : null}
        {selectedDomain && (tab === 'diagram' || tab === 'skills') ? (
          <>
            <ScopeSelect
              label="Subject area"
              value={selectedAreaId ?? ''}
              onChange={(value) => { setSelectedAreaId(value || null); setSelectedId(null); }}
              options={[{ value: '', label: 'Whole domain' }, ...domainAreas.map((area) => ({ value: area.qualifiedId, label: area.name }))]}
              t={t}
            />
            {!readOnly && (
              <IconButton t={t} title="New subject area" onClick={() => setEditor({ kind: 'area' })}>
                <Plus size={14} />
              </IconButton>
            )}
          </>
        ) : null}
        <div style={{ display: 'flex', gap: 7, marginLeft: 'auto' }}>
          {selectedDomain && (
            <Button t={t} onClick={() => setImpactOpen(true)}>
              <ShieldCheck size={14} /> What Ask will do
            </Button>
          )}
          {selectedDomain && (
            <Button t={t} onClick={() => openAsk()}>
              <MessageCircle size={14} /> Ask about {authoredLabels.get(selectedDomain) ?? selectedDomain}
            </Button>
          )}
          {warehouseModeling && (
            <label
              title="Also count the joins in recent queries your warehouse role can see. Query text is read in memory and dropped; only which columns were joined, and how often, is kept."
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textSecondary, cursor: 'pointer' }}
            >
              <input type="checkbox" checked={draftWithQueryHistory} onChange={(event) => setDraftWithQueryHistory(event.target.checked)} />
              Use query history
            </label>
          )}
          {readOnly && <span style={{ fontSize: 11, color: t.textMuted, alignSelf: 'center' }}>{readOnlyReason(hostUi, 'domains')}</span>}
          {!readOnly && warehouseModeling && (
            <Button t={t} onClick={() => void draftFromWarehouse()} disabled={draftingFromWarehouse}>
              <Boxes size={14} /> {draftingFromWarehouse ? 'Drafting…' : 'Draft from warehouse'}
            </Button>
          )}
          {!readOnly && warehouseModeling && (
            <Button t={t} onClick={() => setMetricDrawerOpen(true)}>
              <Plus size={14} /> New metric
            </Button>
          )}
          {!warehouseModeling && canAddDbtMetric(hostUi) && (
            <Button t={t} onClick={() => setDbtMetricOpen(true)}>
              <Plus size={14} /> Add metric
            </Button>
          )}
          {!readOnly && <Button t={t} onClick={() => setStartDrawer('yaml')}><FileSearch size={14} /> Import YAML</Button>}
          <IconButton t={t} title="Recompile" onClick={() => void refresh()}>
            <RefreshCw size={15} />
          </IconButton>
        </div>
      </header>
      <nav
        role="tablist"
        aria-label="Modeling"
        style={{ minHeight: 40, display: 'flex', alignItems: 'center', gap: 2, padding: '0 10px', borderBottom: `1px solid ${t.headerBorder}`, background: t.headerBg, overflowX: 'auto' }}
      >
        {DOMAIN_STUDIO_NAVIGATION.flatMap((group) => group.items).map((item) => {
          const active = tab === item.id;
          return (
            <button key={item.id} type="button" role="tab" aria-selected={active} onClick={() => selectSection(item.id)} style={tabButton(t, active)}>
              {domainSectionIcon(item.id, 14, t, active)}
              {item.label}
              {tabCounts[item.id] !== undefined ? <small style={{ color: active ? t.accent : t.textMuted }}>{tabCounts[item.id]}</small> : null}
            </button>
          );
        })}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: t.textMuted, whiteSpace: 'nowrap', paddingLeft: 12 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--status-success)', flexShrink: 0 }} />
          {data.modeling.mode === 'warehouse-first'
            ? <>warehouse catalog · {warehouseRelationCount} table{warehouseRelationCount === 1 ? '' : 's'}</>
            : data.modeling.mode === 'hybrid'
              ? <>dbt · {dbtNodeCount} model{dbtNodeCount === 1 ? '' : 's'} · warehouse · {warehouseRelationCount} table{warehouseRelationCount === 1 ? '' : 's'}</>
              : <>dbt synced · {Object.keys(data.dbtProvenance.nodes).length} model{Object.keys(data.dbtProvenance.nodes).length === 1 ? '' : 's'}</>}
        </span>
        {tab === 'diagram' && <button ref={inspectorToggleRef} aria-expanded={inspectorOpen} aria-controls="domain-studio-inspector" aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} title={inspectorOpen ? 'Hide inspector' : 'Show inspector'} onClick={toggleInspector} style={{ ...iconButtonStyle(t), marginLeft: 8 }}>
          {inspectorOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>}
      </nav>
      {waitingDrafts && proposal?.id !== waitingDrafts.proposalId ? (
        <div role="status" aria-label="Drafted models waiting for review" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: `1px solid ${t.headerBorder}`, background: 'var(--accent-dim)', fontSize: 11.5, color: t.textPrimary }}>
          <span style={{ flex: 1 }}>{waitingDraftsSentence(waitingDrafts)}</span>
          {!readOnly && <Button t={t} onClick={() => void reviewWaitingDrafts()}>Review drafts</Button>}
          {!readOnly && <Button t={t} onClick={() => void discardWaitingDrafts()}>Discard</Button>}
        </div>
      ) : null}
      {stagingLeftOut && !readOnly ? (
        <div role="status" aria-label="Staging tables left out" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: `1px solid ${t.headerBorder}`, background: t.headerBg, fontSize: 11.5, color: t.textSecondary }}>
          <span style={{ flex: 1 }}>{stagingLeftOutSentence(stagingLeftOut)}</span>
          <Button t={t} onClick={() => { setStagingLeftOut(null); void draftFromWarehouse({ includeStaging: true }); }} disabled={draftingFromWarehouse}>Show staging tables</Button>
          <IconButton t={t} title="Dismiss" onClick={() => setStagingLeftOut(null)}><XCircle size={14} /></IconButton>
        </div>
      ) : null}
      {notice ? (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: `1px solid ${t.headerBorder}`, background: 'var(--accent-dim)', fontSize: 11.5, color: t.textPrimary }}>
          <span style={{ flex: 1 }}>{notice}</span>
          {!readOnly && <Button t={t} onClick={() => { setNotice(null); setStartDrawer('models'); }}>Add models</Button>}
          <IconButton t={t} title="Dismiss" onClick={() => setNotice(null)}><XCircle size={14} /></IconButton>
        </div>
      ) : null}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: inspectorVisible && !narrowLayout ? 'minmax(460px, 1fr) clamp(270px, 22vw, 380px)' : 'minmax(0, 1fr)',
        }}
      >
        <main
          style={{
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: 1, minHeight: 0 }}>
            {tab === 'diagram' && (
              <div id="dql-modeling-diagram"
                style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  ...(diagramFullscreen ? { position: 'fixed', inset: 0, zIndex: 90, background: t.appBg } : {}),
                }}
              >
                <LayerToolbar readOnly={readOnly} modelingView={modelingView} columnMode={columnMode} search={diagramSearch} layoutMode={layoutMode} density={diagramDensity} visibleLimit={visibleLimit} dimUnrelated={dimUnrelated} showEdgeLabels={showEdgeLabels} showLegend={showLegend} fullscreen={diagramFullscreen} aiOpen={aiDockOpen} onBindModel={() => setStartDrawer('models')} onRelationship={() => setEditor({ kind: 'relationship' })} onToggleAi={() => setAiDockOpen((value) => !value)} onModelingView={setModelingView} onColumnMode={setColumnMode} onSearch={setDiagramSearch} searchItems={diagramSearchItems} onPickModel={handlePickModel} onLayoutMode={setLayoutMode} onDensity={setDiagramDensity} onVisibleLimit={setVisibleLimit} onDimUnrelated={setDimUnrelated} onEdgeLabels={setShowEdgeLabels} onLegend={setShowLegend} onFullscreen={() => setDiagramFullscreen((value) => !value)} onExport={() => exportDiagramSvg()} onReset={() => setResetLayoutToken((value) => value + 1)} t={t} />
                {selectedArea ? <div style={{ padding: '7px 14px', borderBottom: `1px solid ${t.headerBorder}`, background: 'var(--accent-dim)', color: t.textSecondary, display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5 }}><Boxes size={13} color={t.accent} /><strong style={{ color: t.textPrimary }}>{selectedArea.name}</strong><span>{selectedArea.description ?? 'Focused business modeling area'}</span><span style={{ marginLeft: 'auto', color: t.textMuted }}>{selectedArea.entityIds.length} model{selectedArea.entityIds.length === 1 ? '' : 's'} · {selectedArea.intentExamples.length} example question{selectedArea.intentExamples.length === 1 ? '' : 's'}</span></div> : null}
                {showLegend && <DiagramLegend t={t} />}
                <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {domainEntities.length === 0 ? (readOnly ? <Blank t={t} title="No models on this map yet" detail={readOnlyReason(hostUi, 'domains')} /> : <ModelingEmptyWorkspace t={t} connectedModels={Object.keys(data.dbtProvenance.nodes).length} warehouse={warehouseModeling ? { tables: warehouseRelationCount, drafting: draftingFromWarehouse, onDraft: () => void draftFromWarehouse() } : undefined} onDbt={() => setStartDrawer('models')} onYaml={() => setStartDrawer('yaml')} onManual={() => setEditor({ kind: 'entity' })} />) : <DomainModelingCanvas modeling={ghostView.modeling} ghostEntityIds={ghostView.ghostEntityIds} ghostRelationshipIds={ghostView.ghostRelationshipIds} relationByDbtId={relationByDbtId} detailsByDbtId={detailsByDbtId} selectedDomain={selectedDomain} selectedAreaId={selectedAreaId} selectedId={selectedId} viewMode={modelingView} columnMode={columnMode} search={diagramSearch} layoutMode={layoutMode} density={diagramDensity} visibleLimit={visibleLimit} dimUnrelated={dimUnrelated} showEdgeLabels={showEdgeLabels} resetLayoutToken={resetLayoutToken} focusRequest={focusRequest ?? undefined} onVisibleDbtIdsChange={loadVisibleNodeDetails} onSelectEntity={setSelectedId} onSelectRelationship={setSelectedId} onEditRelationship={(recordKey) => { const relationship = data.modeling.relationships[recordKey]; if (relationship) setEditor({ kind: 'relationship', relationship }); }} onDraftRelationship={(draft) => setEditor({ kind: 'relationship', draft })} onAddRelatedModel={(origin) => setEditor({ kind: 'entity', relationshipFrom: origin })} onAddModel={() => setStartDrawer('models')} onCreateDomain={() => setDomainSettings({ kind: 'create' })} onEditEntity={(id) => { const entity = data.modeling.entities[id]; if (entity) setEditor({ kind: 'entity', entity, dbtUniqueId: entity.dbtUniqueId }); }} onOpenAi={(id) => {
                    setSelectedId(id);
                    openAsk(id);
                  }} theme={t} />}
                </div>
                {/* The AI docks beside the diagram it is editing, so a proposal
                    is reviewed against the model you can see rather than in a
                    separate tab. */}
                {aiDockOpen && (
                  <aside
                    aria-label="Modeling AI"
                    style={{ width: 'clamp(320px, 30vw, 460px)', borderLeft: `1px solid ${t.headerBorder}`, background: t.appBg, display: 'flex', flexDirection: 'column', minHeight: 0 }}
                  >
                    <ModelingAiPanel
                      domain={selectedDomain}
                      areaId={selectedAreaId}
                      selectedId={selectedId}
                      data={data}
                      themeMode={state.themeMode}
                      t={t}
                      correction={modelingCorrection}
                      onClose={() => setAiDockOpen(false)}
                      onCorrectionStarted={() => setModelingCorrection(null)}
                      onReviewProposal={setProposal}
                      onPreviewProposal={setGhostProposal}
                      onOpenSkills={() => selectSection('skills')}
                      onDraftRelationship={() => setEditor({ kind: 'relationship', draft: selectedEntity && selectedId ? { from: selectedId, to: '' } : undefined })}
                    />
                  </aside>
                )}
                </div>
              </div>
            )}
            {tab === 'terms' && <TermsAndConceptsPanel data={data} domain={selectedDomain} t={t} onProposal={setProposal} />}
            {tab === 'skills' && <SkillsPage embedded domainFilter={selectedDomain} modelAreaFilter={selectedAreaId} sourcePathFilter={domainSkillPaths} />}
            {tab === 'blocks' && <DomainBlocksPanel data={data} domain={selectedDomain} t={t} />}
            {tab === 'used_by' && (
              <ScrollPanel>
                <PanelHeader
                  title="Used by"
                  detail={selectedDomain
                    ? `Notebooks and apps that declare they use ${authoredLabels.get(selectedDomain) ?? selectedDomain}. They live in their own folders; this is a list of links, not copies.`
                    : 'Notebooks and apps across all domains. Choose a domain to see only what uses it.'}
                  t={t}
                />
                <RelatedProductsPanel data={data} domain={selectedDomain} kind="notebooks" t={t} />
                <RelatedProductsPanel data={data} domain={selectedDomain} kind="apps" t={t} />
              </ScrollPanel>
            )}
          </div>
        </main>

        {inspectorVisible && <aside
          id="domain-studio-inspector"
          ref={inspectorRef}
          role="complementary"
          aria-label="Modeling inspector"
          tabIndex={-1}
          onKeyDown={(event) => { if (event.key === 'Escape') toggleInspector(); }}
          style={{
            borderLeft: `1px solid ${t.headerBorder}`,
            overflow: 'auto',
            // The inspector is part of the same domain workspace context.
            background: t.appBg,
            minWidth: 0,
            ...(narrowLayout ? { position: 'fixed', inset: '0 0 0 auto', width: 'min(90vw, 380px)', zIndex: 95, boxShadow: '-12px 0 30px rgba(0,0,0,.18)' } : {}),
          }}
        >
          <SideHeading t={t}>Inspector</SideHeading>
          {selectedEntity ? (
            <EntityInspector
              entity={selectedEntity}
              detail={nodeDetail}
              relationships={domainRelationships}
              t={t}
              readOnly={readOnly}
              onEdit={() =>
                setEditor({
                  kind: 'entity',
                  entity: selectedEntity,
                  dbtUniqueId: selectedEntity.dbtUniqueId,
                })
              }
              onEditDbtSource={() => setDbtSourceEntity(selectedEntity)}
              onSelectRelationship={(relationship) => setSelectedId(relationshipRecordKey(data.modeling.relationships, relationship))}
              onDelete={() => {
                setDeleteError(null);
                setPendingModelDelete({
                  kind: 'entity',
                  id: selectedEntity.localId || selectedEntity.id,
                  domain: selectedEntity.domain,
                  areaId: selectedEntity.areaId,
                  label: selectedEntity.businessName || selectedEntity.localId || selectedEntity.id,
                });
              }}
            />
          ) : selectedRelationship ? (
            <RelationshipInspector
              entities={data.modeling.entities}
              relationship={selectedRelationship}
              t={t}
              readOnly={readOnly}
              onEdit={() =>
                setEditor({
                  kind: 'relationship',
                  relationship: selectedRelationship,
                })
              }
              onDelete={() => {
                setDeleteError(null);
                setPendingModelDelete({
                  kind: 'relationship',
                  id: selectedRelationship.localId || selectedRelationship.id,
                  // A relationship is authored in its OWNING domain's source,
                  // which for a cross-domain edge is not either endpoint's domain.
                  domain: selectedRelationship.ownerDomain ?? selectedRelationship.qualifiedId.split('::')[0],
                  areaId: selectedRelationship.areaId,
                  label: selectedRelationship.localId || selectedRelationship.id,
                });
              }}
            />
          ) : (
            <StudioSummary data={data} domainEntities={domainEntities.map(({ entity }) => entity)} domainRelationships={domainRelationships} t={t} onSelectRelationship={(relationship) => setSelectedId(relationshipRecordKey(data.modeling.relationships, relationship))} />
          )}
        </aside>}
      </div>

      {impactOpen && selectedDomain ? (
        <AskImpactDrawer domain={selectedDomain} area={selectedArea?.qualifiedId} areaName={selectedArea?.name} t={t} onClose={() => setImpactOpen(false)} />
      ) : null}
      {domainSettings ? (
        <DomainSettingsDrawer
          mode={domainSettings}
          domains={state.authoredDomains}
          t={t}
          onClose={() => setDomainSettings(null)}
          onSaved={(saved) => {
            setDomainSettings(null);
            void refresh().then(() => selectDomain(saved.id));
          }}
          onDeleted={() => {
            setDomainSettings(null);
            selectDomain(null);
            void refresh();
          }}
        />
      ) : null}
      {metricDrawerOpen ? (
        <NewMetricDrawer
          data={data}
          domain={selectedDomain}
          t={t}
          onClose={() => setMetricDrawerOpen(false)}
          onSaved={(path) => { setMetricDrawerOpen(false); setNotice(`Metric saved to ${path}. Ask and saved queries can use it now.`); }}
        />
      ) : null}
      {dbtMetricOpen ? (
        <AddDbtMetricDrawer
          data={data}
          domain={selectedDomain}
          snapshotId={data.snapshotId}
          t={t}
          onClose={() => setDbtMetricOpen(false)}
          onApplied={async (message) => { setDbtMetricOpen(false); setNotice(message); await refresh(); }}
        />
      ) : null}
      {startDrawer === 'models' ? <AddModelsDrawer data={data} domain={selectedDomain} areaId={selectedAreaId} theme={t} onClose={() => setStartDrawer(null)} onProposal={(next) => { setStartDrawer(null); setProposal(next); }} /> : null}
      {startDrawer === 'yaml' ? <ModelingYamlImportDrawer data={data} domain={selectedDomain} areaId={selectedAreaId} theme={t} onClose={() => setStartDrawer(null)} onProposal={(next) => { setStartDrawer(null); setProposal(next); }} /> : null}
      {proposal ? (
        <ContextProposalReviewDrawer
          proposal={proposal}
          theme={t}
          onClose={() => { setProposal(null); setPendingRelationshipFrom(null); void loadWaitingDrafts(); }}
          onDiscarded={() => { setProposal(null); setPendingRelationshipFrom(null); setStagingLeftOut(null); void loadWaitingDrafts(); }}
          onCommitted={() => {
            setProposal(null);
            setStagingLeftOut(null);
            void loadWaitingDrafts();
            void refresh().then(() => {
              if (!pendingRelationshipFrom) return;
              setEditor({ kind: 'relationship', draft: pendingRelationshipFrom });
              setPendingRelationshipFrom(null);
            });
          }}
        />
      ) : null}
      {editor?.kind === 'relationship' ? (
        <RelationshipBuilder
          data={data}
          relationship={editor.relationship}
          draft={editor.draft}
          selectedDomain={selectedDomain}
          selectedArea={selectedArea}
          t={t}
          onClose={() => setEditor(null)}
          onProposal={(next) => { setEditor(null); setProposal(next); }}
          onFixWithAi={(relationshipId, evidence) => {
            setEditor(null);
            if (relationshipId) setSelectedId(relationshipId);
            selectSection('diagram');
            setAiDockOpen(true);
            setModelingCorrection({ text: `Fix the failed relationship validation. Keep it draft, remove stale proof, and explain the corrected cardinality, fanout, or keys using the attached receipt.`, nonce: Date.now(), evidence });
          }}
        />
      ) : editor ? (
        <ModelingEditor
          editor={editor}
          data={data}
          selectedDomain={selectedDomain}
          selectedArea={selectedArea}
          t={t}
          onClose={() => setEditor(null)}
          onProposal={(next) => {
            // "+ Add a related model": once the new model is saved, the
            // relationship between it and the model the + was on opens next.
            if (editor.kind === 'entity' && editor.relationshipFrom) {
              for (const operation of next.operations) {
                if (operation.kind === 'modeling_change' && operation.change.operation === 'upsert_entity') {
                  setPendingRelationshipFrom({ ...editor.relationshipFrom, to: `${operation.change.value.domain}::entity::${operation.change.value.id}` });
                  break;
                }
              }
            }
            setEditor(null);
            setProposal(next);
          }}
          onApplied={async (applied) => {
            setEditor(null);
            await refresh();
            if (editor.kind === 'entity' && editor.relationshipFrom && applied.operation === 'upsert_entity') {
              setEditor({ kind: 'relationship', draft: { ...editor.relationshipFrom, to: `${applied.value.domain}::entity::${applied.value.id}` } });
            }
          }}
        />
      ) : null}
      {dbtSourceEntity && nodeDetail && (
        <DbtSourceEditor
          entity={dbtSourceEntity}
          detail={nodeDetail}
          snapshotId={data.snapshotId}
          t={t}
          onClose={() => setDbtSourceEntity(null)}
          onApplied={async () => { setDbtSourceEntity(null); await refresh(); }}
        />
      )}
      {pendingModelDelete && (
        <ConfirmModelDelete
          pending={pendingModelDelete}
          busy={deleting}
          error={deleteError}
          t={t}
          onCancel={() => { setPendingModelDelete(null); setDeleteError(null); }}
          onConfirm={async () => {
            setDeleting(true);
            setDeleteError(null);
            try {
              const change = {
                operation: pendingModelDelete.kind === 'entity' ? 'remove_entity' as const : 'remove_relationship' as const,
                value: {
                  id: pendingModelDelete.id,
                  domain: pendingModelDelete.domain,
                  ...(pendingModelDelete.areaId ? { areaId: pendingModelDelete.areaId } : {}),
                },
              };
              // Deletion is the one thing that used to bypass proposal review,
              // which had the destructive operation held to a weaker standard
              // than renaming a model. It now goes through the same reviewed,
              // atomic, fingerprint-guarded path as every other change.
              const nextProposal = await api.createContextProposal({
                origin: 'manual',
                expectedSnapshotId: data.snapshotId,
                operations: [{ id: `manual:${change.operation}:${pendingModelDelete.id}`, kind: 'modeling_change', change, evidence: ['manual Modeling workspace removal'] }],
              });
              if (!nextProposal.patches.some((patch) => patch.changed)) {
                throw new Error('Nothing to remove — it is no longer in the domain source.');
              }
              setPendingModelDelete(null);
              setSelectedId(null);
              setProposal(nextProposal);
            } catch (error) {
              setDeleteError(error instanceof Error ? error.message : String(error));
            } finally {
              setDeleting(false);
            }
          }}
        />
      )}
    </div>
  );
}

/** Confirm removing an authored model object, naming exactly what will go. */
function ConfirmModelDelete({ pending, busy, error, t, onCancel, onConfirm }: {
  pending: { kind: 'entity' | 'relationship'; id: string; domain: string; label: string };
  busy: boolean;
  error: string | null;
  t: Theme;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Delete ${pending.kind}`}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.34)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 130 }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}
    >
      <div style={{ width: 'min(92vw, 420px)', background: t.appBg, border: `1px solid ${t.headerBorder}`, borderRadius: 12, padding: 18, boxShadow: '0 18px 44px rgba(0,0,0,.22)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary, marginBottom: 6 }}>
          Delete this {pending.kind}?
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>
          <strong style={{ fontFamily: t.fontMono }}>{pending.label}</strong> will be removed from the
          {' '}<strong>{pending.domain}</strong> domain source. dbt models and warehouse data are not affected.
        </div>
        {pending.kind === 'entity' ? (
          <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 8, lineHeight: 1.5 }}>
            Relationships that reference it are left in place and will report a missing endpoint until you remove or repoint them.
          </div>
        ) : null}
        {error ? <div style={{ fontSize: 11.5, color: t.error, marginTop: 10, lineHeight: 1.5 }}>{error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button t={t} onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button t={t} danger onClick={onConfirm} disabled={busy}>{busy ? 'Deleting…' : `Delete ${pending.kind}`}</Button>
        </div>
      </div>
    </div>
  );
}

/** A labelled header picker: the domain and the subject area read as two plain choices. */
function ScopeSelect({ label, value, options, onChange, t }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; t: Theme }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: t.textMuted, fontSize: 10.5, fontWeight: 650 }}>
      {label}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} style={{ ...inputStyle(t), width: 'auto', minWidth: 150, maxWidth: 240, padding: '5px 7px', color: t.textPrimary }}>
        {options.map((option) => <option key={option.value || '__all'} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

const tabButton = (t: Theme, active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 40,
  padding: '0 11px',
  border: 'none',
  borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
  background: 'transparent',
  color: active ? t.textPrimary : t.textSecondary,
  fontSize: 11.5,
  fontWeight: active ? 750 : 600,
  fontFamily: t.font,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});

function domainSectionIcon(section: Tab, size: number, t: Theme, active = false) {
  const Icon = section === 'blocks'
    ? Blocks
    : section === 'diagram'
      ? GitBranch
      : section === 'skills'
        ? GraduationCap
        : section === 'terms'
          ? BookOpen
          : section === 'used_by'
            ? FolderTree
            : Boxes;
  return <Icon size={size} color={active ? t.accent : t.textMuted} />;
}

function readDomainStudioLocation(): { domain: string | null; section: Tab; modelAreaId: string | null; selectedId: string | null } {
  if (typeof window === 'undefined') return { domain: null, section: 'diagram', modelAreaId: null, selectedId: null };
  let mirrored: string | null = null;
  try { mirrored = window.localStorage.getItem(DOMAIN_STUDIO_LOCATION_KEY); } catch { mirrored = null; }
  return resolveDomainStudioLocation(window.location.href, mirrored);
}

function writeDomainStudioLocation(domain: string | null, section: Tab, replace = false, modelAreaId: string | null = null, selectedId: string | null = null) {
  if (typeof window === 'undefined') return;
  const next = domainStudioLocationHref(window.location.href, { domain, section, modelAreaId, selectedId });
  if (replace) window.history.replaceState(window.history.state, '', next);
  else window.history.pushState(window.history.state, '', next);
  // Mirror it: the shell strips these params when the user leaves the
  // workspace, so the URL alone cannot bring them back where they were.
  try {
    window.localStorage.setItem(DOMAIN_STUDIO_LOCATION_KEY, JSON.stringify({ domain, section, modelAreaId, selectedId }));
  } catch {
    // Private mode or a full quota: the URL still works for this session.
  }
}

/**
 * Overlay a write-free proposal onto the compiled modeling graph so it can be
 * previewed as ghost nodes and dashed edges on the live canvas.
 *
 * Nothing here touches source: the returned graph is render-only, and the
 * proposal still has to be committed through `ContextProposalReviewDrawer`.
 */
function applyGhostProposal(
  modeling: DbtFirstModelingResponse['modeling'],
  proposal: ContextAuthoringProposalV1 | null,
): { modeling: DbtFirstModelingResponse['modeling']; ghostEntityIds: Set<string>; ghostRelationshipIds: Set<string> } {
  const ghostEntityIds = new Set<string>();
  const ghostRelationshipIds = new Set<string>();
  if (!proposal) return { modeling, ghostEntityIds, ghostRelationshipIds };

  const entities = { ...modeling.entities };
  const relationships = { ...modeling.relationships };
  for (const operation of proposal.operations) {
    if (operation.kind !== 'modeling_change') continue;
    const change = operation.change;
    if (change.operation === 'upsert_entity') {
      const key = `${change.value.domain}::entity::${change.value.id}`;
      ghostEntityIds.add(key);
      entities[key] = {
        ...(entities[key] ?? {}),
        id: change.value.id, localId: change.value.id, qualifiedId: key,
        domain: change.value.domain, dbtUniqueId: change.value.dbtModel,
        businessName: change.value.businessName, businessContext: change.value.businessContext,
        grain: change.value.grain, keys: change.value.keys ?? [],
        analyticalRole: change.value.analyticalRole, status: 'draft',
        sourcePath: '(proposed)', identityFingerprint: `ghost:${key}`,
      } as ManifestModelEntity;
    } else if (change.operation === 'upsert_relationship') {
      const key = `${change.value.domain}::relationship::${change.value.id}`;
      ghostRelationshipIds.add(key);
      relationships[key] = {
        ...(relationships[key] ?? {}),
        id: change.value.id, localId: change.value.id, qualifiedId: key,
        from: `${change.value.domain}::entity::${change.value.from}`,
        to: `${change.value.domain}::entity::${change.value.to}`,
        keys: change.value.keys, cardinality: change.value.cardinality, fanout: change.value.fanout,
        status: 'draft', crossDomain: false, ownerDomain: change.value.domain,
        verb: change.value.verb, description: change.value.description, rationale: change.value.rationale,
        sourcePath: '(proposed)', fingerprint: `ghost:${key}`,
        staleCertification: false, automaticJoinAllowed: false,
      } as ManifestModelRelationship;
    }
  }
  return { modeling: { ...modeling, entities, relationships }, ghostEntityIds, ghostRelationshipIds };
}

/**
 * The Domain prefilled for a first-time author: the only existing Domain when
 * there is exactly one, otherwise a new one named after the dbt project.
 */
function defaultAuthoringDomain(data: DbtFirstModelingResponse): string {
  const packages = Object.keys(data.modeling.packages ?? {});
  if (packages.length === 1) return packages[0]!;
  const projectName = data.dbtProvenance?.projectName ?? '';
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'analytics';
}

function relationshipRecordKey(relationships: Record<string, ManifestModelRelationship>, relationship: ManifestModelRelationship): string {
  const exact = Object.entries(relationships).find(([, value]) => value === relationship);
  if (exact) return exact[0];
  return relationship.qualifiedId ?? relationship.id;
}

function ModelingEditor({ editor, data, selectedDomain, selectedArea, t, onClose, onProposal, onApplied }: { editor: Exclude<Editor, { kind: 'relationship' }>; data: DbtFirstModelingResponse; selectedDomain: string | null; selectedArea?: ManifestModelArea; t: Theme; onClose: () => void; onProposal: (proposal: ContextAuthoringProposalV1) => void; onApplied: (change: ModelingAuthoringChange) => Promise<void> }) {
  const existingEntity = editor.kind === 'entity' ? editor.entity : undefined;
  const existingArea = editor.kind === 'area' ? editor.area : undefined;
  // UI-019: prefill a usable scope rather than an empty one. The server creates
  // any Domain/subject area that does not exist yet inside the same proposal,
  // so a first-time author is never blocked on governance setup.
  const [domain, setDomain] = useState(
    existingArea?.domain
      ?? existingEntity?.domain
      ?? selectedDomain
      ?? Object.keys(data.modeling.packages)[0]
      ?? defaultAuthoringDomain(data),
  );
  const [areaId, setAreaId] = useState(
    existingArea?.localId
      ?? data.modeling.areas[existingEntity?.areaId ?? '']?.localId
      ?? selectedArea?.localId
      ?? DEFAULT_MODEL_AREA_ID,
  );
  const [id, setId] = useState(existingEntity?.localId ?? existingArea?.localId ?? '');
  const [owner, setOwner] = useState(existingEntity?.owner ?? '');
  const [dbtModel, setDbtModel] = useState(editor.kind === 'entity' ? (existingEntity?.dbtUniqueId ?? editor.dbtUniqueId ?? '') : '');
  const [businessName, setBusinessName] = useState(existingEntity?.businessName ?? '');
  const [businessContext, setBusinessContext] = useState(existingEntity?.businessContext ?? '');
  const [conceptRefs, setConceptRefs] = useState(existingEntity?.conceptRefs?.join(', ') ?? '');
  const [analyticalRole, setAnalyticalRole] = useState<NonNullable<ManifestModelEntity['analyticalRole']>>(existingEntity?.analyticalRole ?? 'unknown');
  const [entityStatus, setEntityStatus] = useState<NonNullable<ManifestModelEntity['status']>>(existingEntity?.status ?? 'draft');
  const [grain, setGrain] = useState(existingEntity?.grain ?? '');
  const [keys, setKeys] = useState(existingEntity?.keys.join(', ') ?? '');
  const [areaName, setAreaName] = useState(existingArea?.name ?? '');
  const [areaDescription, setAreaDescription] = useState(existingArea?.description ?? '');
  const [areaIntents, setAreaIntents] = useState(existingArea?.intentExamples.join(', ') ?? '');
  const [areaReferences, setAreaReferences] = useState(existingArea?.referencedEntityIds.map((reference) => data.modeling.entities[reference]?.localId ?? reference).join(', ') ?? '');
  const [change, setChange] = useState<ModelingAuthoringChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedDbtDetail, setSelectedDbtDetail] = useState<DbtNodeAuthoringDetail | null>(null);
  useEffect(() => {
    if (editor.kind !== 'entity' || id || !dbtModel) return;
    const name = data.dbtProvenance.nodes[dbtModel]?.name;
    if (name) setId(name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase());
  }, [editor.kind, id, dbtModel, data.dbtProvenance.nodes]);
  useEffect(() => {
    if (editor.kind !== 'entity' || !dbtModel) {
      setSelectedDbtDetail(null);
      return;
    }
    let cancelled = false;
    void api.getDbtModelingNode(dbtModel).then((detail) => {
      if (cancelled) return;
      setSelectedDbtDetail(detail);
      if (!businessName) setBusinessName(detail.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()));
      if (!grain && detail.dqlMeta?.grain) setGrain(detail.dqlMeta.grain);
      if (!keys && detail.dqlMeta?.keys.length) setKeys(detail.dqlMeta.keys.join(', '));
    }).catch(() => { if (!cancelled) setSelectedDbtDetail(null); });
    return () => { cancelled = true; };
  }, [dbtModel, editor.kind]);

  const buildChange = (): ModelingAuthoringChange => {
    if (editor.kind === 'area')
      return {
        operation: 'upsert_area',
        value: {
          id,
          domain,
          name: areaName || id,
          description: areaDescription || undefined,
          intentExamples: csv(areaIntents),
          references: csv(areaReferences),
        },
      };
    if (editor.kind === 'entity')
      return {
        operation: 'upsert_entity',
        value: {
          id,
          domain,
          dbtModel,
          areaId: areaId || undefined,
          businessName: businessName || undefined,
          businessContext: businessContext || undefined,
          conceptRefs: csv(conceptRefs),
          analyticalRole,
          status: entityStatus,
          owner: owner || undefined,
          grain: grain || undefined,
          keys: csv(keys).length > 0 ? csv(keys) : keysFromGrain(grain, selectedDbtDetail),
        },
      };
    // Relationships have their own builder (RelationshipBuilder.tsx).
    throw new Error('Unsupported modeling editor.');
  };
  /**
   * Two-tier write path.
   *
   * Editing a business name or description carries no join, lifecycle, or
   * authorization meaning, so it saves directly — routing every keystroke
   * through a hash-bound YAML diff review made describing your own models
   * feel like filing a change request. Anything structural (relationships,
   * bindings, lifecycle, cross-domain, dbt source) still goes through the full
   * `ContextAuthoringProposalV1` review. See `docs/specs/dql-2-domain-context/00-decisions.md`.
   */
  const saveChange = async () => {
    try {
      setBusy(true);
      setMessage(null);
      const next = buildChange();
      setChange(next);
      if (isDescriptiveOnlyChange(next, existingEntity, existingArea)) {
        const previewed = await api.previewModelingChange(next, data.snapshotId);
        await api.applyModelingChange(next, previewed.fingerprint, data.snapshotId);
        await onApplied(next);
        return;
      }
      const nextProposal = await api.createContextProposal({
        origin: 'manual',
        expectedSnapshotId: data.snapshotId,
        operations: [{ id: `manual:${next.operation}:${id || Date.now().toString(36)}`, kind: 'modeling_change', change: next, evidence: ['manual Modeling workspace authoring'] }],
      });
      onProposal(nextProposal);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const editorReady = editor.kind === 'entity' ? Boolean(domain && id && dbtModel) : true;
  // Drives the button label so the user knows before clicking whether this
  // saves straight away or opens a review.
  const descriptiveOnly = (() => {
    if (!editorReady) return false;
    try { return isDescriptiveOnlyChange(buildChange(), existingEntity, existingArea); } catch { return false; }
  })();
  // "+ Add a related model" starts from a model on the canvas. Say so, and say
  // what happens next, instead of showing the same blank "Add a dbt model".
  const relationshipOrigin = editor.kind === 'entity' && editor.relationshipFrom
    ? data.modeling.entities[editor.relationshipFrom.from]
    : undefined;
  const originName = relationshipOrigin?.businessName || relationshipOrigin?.localId || '';
  const title = editor.kind === 'area'
    ? (existingArea ? 'Edit subject area' : 'New subject area')
    : existingEntity ? 'Edit model' : relationshipOrigin ? `Add a model related to ${originName}` : 'Add a dbt model';
  return (
    <Modal title={title} t={t} onClose={onClose}>
      {(
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Domain">
            <Select value={domain} onChange={setDomain} values={Object.keys(data.modeling.packages)} t={t} />
          </Field>
          {editor.kind === 'area' && <Field label="Subject area id"><Input value={id} onChange={setId} t={t} placeholder="stable_snake_case_id" /></Field>}
          {editor.kind === 'area' && (
            <>
              <Message text="A subject area is a focused view of one part of this domain, like Customer lifecycle. It narrows the map and helps Ask pick the right skills; it never changes what Ask is allowed to use." t={t} />
              <Field label="Subject area name"><Input value={areaName} onChange={setAreaName} t={t} placeholder="Customer lifecycle" /></Field>
              <Field label="Business question or scope"><Input value={areaDescription} onChange={setAreaDescription} t={t} placeholder="How customers progress from first order to repeat purchase." /></Field>
              <Field label="Example questions (comma-separated)"><Input value={areaIntents} onChange={setAreaIntents} t={t} placeholder="Which customers made a second purchase?" /></Field>
              <Field label="Read-only boundary entities (comma-separated)"><Input value={areaReferences} onChange={setAreaReferences} t={t} placeholder="customer" /></Field>
            </>
          )}
          {editor.kind === 'entity' && (
            <>
              <WorkflowSteps current={dbtModel ? 2 : 1} labels={['Find dbt model', 'Add business meaning']} t={t} />
              {relationshipOrigin
                ? <Message text={`Pick the dbt model that ${originName} relates to. When you save it, the relationship builder opens with ${originName} on the left so you can match the columns.`} t={t} />
                : <Message text="Search by model name, relation, or source path. Results stay bounded even when the dbt project has thousands of models." t={t} />}
              <Field label="Subject area"><Select value={areaId} onChange={setAreaId} values={Object.values(data.modeling.areas).filter((area) => area.domain === domain).map((area) => area.localId)} labels={Object.fromEntries(Object.values(data.modeling.areas).filter((area) => area.domain === domain).map((area) => [area.localId, area.name]))} t={t} /></Field>
              <Field label="dbt model">
                <DbtModelPicker value={dbtModel} onChange={setDbtModel} selectedNode={data.dbtProvenance.nodes[dbtModel]} domain={domain} t={t} />
              </Field>
              {selectedDbtDetail && <SelectionSummary title={selectedDbtDetail.name} detail={`${selectedDbtDetail.relation ?? selectedDbtDetail.uniqueId} · ${selectedDbtDetail.columns.length} columns${selectedDbtDetail.dqlMeta?.grain ? ` · grain: ${selectedDbtDetail.dqlMeta.grain}` : ''}`} t={t} />}
              {dbtModel && <Field label="Model id"><Input value={id} onChange={setId} t={t} placeholder="stable_snake_case_id" /></Field>}
              <Field label="Business name"><Input value={businessName} onChange={setBusinessName} t={t} placeholder="Customer order" /></Field>
              <Field label="Business context"><Input value={businessContext} onChange={setBusinessContext} t={t} placeholder="One order used to understand repeat purchasing and revenue." /></Field>
              <div style={twoColumns}>
                <Field label="Business concepts">
                  <div style={{ display: 'grid', gap: 4 }}>
                    <Input value={conceptRefs} onChange={setConceptRefs} t={t} placeholder="customer, shopper" />
                    {Object.keys(data?.modeling.concepts ?? {}).length > 0 && (
                      <Select
                        value=""
                        onChange={(value) => {
                          if (!value) return;
                          const current = csv(conceptRefs);
                          if (!current.includes(value)) setConceptRefs([...current, value].join(', '));
                        }}
                        values={['', ...Object.values(data?.modeling.concepts ?? {}).map((concept) => concept.localId)]}
                        labels={{ '': 'Add a concept…', ...Object.fromEntries(Object.values(data?.modeling.concepts ?? {}).map((concept) => [concept.localId, `${concept.name} (${concept.domain}, ${concept.bindings.length} binding${concept.bindings.length === 1 ? '' : 's'})`])) }}
                        t={t}
                      />
                    )}
                  </div>
                </Field>
                <Field label="Analytical role"><Select value={analyticalRole} onChange={(value) => setAnalyticalRole(value as NonNullable<ManifestModelEntity['analyticalRole']>)} values={['event', 'dimension', 'snapshot', 'bridge', 'unknown']} t={t} /></Field>
              </div>
              <div style={twoColumns}>
                <Field label="Grain override (optional)">
                  <Input value={grain} onChange={setGrain} t={t} placeholder="Use dbt meta.dql by default" />
                </Field>
                <Field label="Key overrides (optional)">
                  <Input value={keys} onChange={setKeys} t={t} placeholder="Empty: the grain's columns" />
                </Field>
              </div>
              <div style={twoColumns}>
                <Field label="Lifecycle"><Select value={entityStatus === 'review' ? 'reviewed' : entityStatus} onChange={(value) => setEntityStatus(value as NonNullable<ManifestModelEntity['status']>)} values={['draft', 'evaluated', 'reviewed', 'certified', 'deprecated']} t={t} /></Field>
                <Field label="Owner"><Input value={owner} onChange={setOwner} t={t} placeholder="team@company.com" /></Field>
              </div>
            </>
          )}
          {message && <Message text={message} t={t} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button primary t={t} onClick={() => void saveChange()} disabled={busy || !editorReady}>
              {descriptiveOnly ? 'Save' : 'Preview source change'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Toolbar search that finds a specific model or column across the whole graph
// (even ones off-screen) and, on click, selects + pans the canvas to it.
function DiagramSearch({ search, onSearch, items, onPick, t }: { search: string; onSearch: (value: string) => void; items: DiagramSearchItem[]; onPick: (recordKey: string) => void; t: Theme }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLLabelElement>(null);
  const query = search.trim().toLowerCase();
  const results = query
    ? items
        .filter((item) => item.label.toLowerCase().includes(query) || item.sublabel.toLowerCase().includes(query))
        .sort((a, b) => (a.type === b.type ? a.label.localeCompare(b.label) : a.type === 'model' ? -1 : 1))
        .slice(0, 14)
    : [];
  const roleColor = (role: string | undefined) => role === 'dimension' ? 'var(--status-success)' : role === 'bridge' ? 'var(--status-warning)' : role === 'event' || role === 'snapshot' ? 'var(--accent)' : 'var(--text-tertiary)';
  // The toolbar has overflow:auto, so the results float in a fixed layer anchored
  // to the input rather than an absolutely-positioned (clipped) child.
  const rect = open && query ? anchorRef.current?.getBoundingClientRect() : undefined;
  return (
    <label ref={anchorRef} style={{ position: 'relative', width: 210, flex: '0 0 210px' }}>
      <Search size={12} style={{ position: 'absolute', left: 7, top: 8, color: t.textMuted }} />
      <input
        aria-label="Search diagram"
        value={search}
        onChange={(event) => { onSearch(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Find model or column"
        style={{ ...inputStyle(t), padding: '6px 7px 6px 24px' }}
      />
      {rect && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div style={{ position: 'fixed', top: rect.bottom + 5, left: rect.left, zIndex: 61, width: 300, maxHeight: 340, overflow: 'auto', background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 9, boxShadow: '0 12px 30px rgba(26,26,26,0.16)', padding: 4 }}>
            {results.length === 0 ? (
              <div style={{ padding: '10px 10px', fontSize: 11.5, color: t.textMuted, fontFamily: t.font }}>No matching model or column.</div>
            ) : (
              results.map((item, index) => (
                <button
                  key={`${item.type}-${item.recordKey}-${item.label}-${index}`}
                  type="button"
                  onMouseDown={(event) => { event.preventDefault(); onPick(item.recordKey); setOpen(false); }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '7px 8px', border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer', fontFamily: t.font }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: roleColor(item.role), flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: item.type === 'model' ? 650 : 500, color: t.textPrimary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                  <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.textMuted }}>{item.type === 'model' ? 'model' : item.sublabel}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </label>
  );
}

function LayerToolbar({ modelingView, columnMode, search, layoutMode, density, visibleLimit, dimUnrelated, showEdgeLabels, showLegend, fullscreen, aiOpen, readOnly = false, onBindModel, onRelationship, onToggleAi, onModelingView, onColumnMode, onSearch, searchItems, onPickModel, onLayoutMode, onDensity, onVisibleLimit, onDimUnrelated, onEdgeLabels, onLegend, onFullscreen, onExport, onReset, t }: { modelingView: ModelingViewMode; columnMode: ColumnDisplayMode; search: string; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; dimUnrelated: boolean; showEdgeLabels: boolean; showLegend: boolean; fullscreen: boolean; aiOpen: boolean; readOnly?: boolean; onBindModel: () => void; onRelationship: () => void; onToggleAi: () => void; onModelingView: (mode: ModelingViewMode) => void; onColumnMode: (mode: ColumnDisplayMode) => void; onSearch: (value: string) => void; searchItems: DiagramSearchItem[]; onPickModel: (recordKey: string) => void; onLayoutMode: (mode: DiagramLayoutMode) => void; onDensity: (density: DiagramDensity) => void; onVisibleLimit: (limit: number) => void; onDimUnrelated: (value: boolean) => void; onEdgeLabels: (value: boolean) => void; onLegend: (value: boolean) => void; onFullscreen: () => void; onExport: () => void; onReset: () => void; t: Theme }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 50,
        padding: '0 10px',
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.headerBg,
        flexWrap: 'nowrap',
        overflowX: 'auto',
        scrollbarWidth: 'thin',
      }}
    >
      {/* Prototype segmented Business/Data toggle. */}
      <div role="group" aria-label="Modeling view" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.appBg, flexShrink: 0 }}>
        <button type="button" onClick={() => onModelingView('business')} style={{ border: 'none', borderRadius: 5, padding: '4px 11px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, whiteSpace: 'nowrap', background: modelingView === 'business' ? 'var(--accent-dim)' : 'transparent', color: modelingView === 'business' ? t.accent : t.textMuted }}>Business modeling</button>
        <button type="button" onClick={() => onModelingView('data')} style={{ border: 'none', borderRadius: 5, padding: '4px 11px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, whiteSpace: 'nowrap', background: modelingView === 'data' ? 'var(--accent-dim)' : 'transparent', color: modelingView === 'data' ? t.accent : t.textMuted }}>Data modeling</button>
      </div>
      <DiagramSearch search={search} onSearch={onSearch} items={searchItems} onPick={onPickModel} t={t} />
      {!readOnly && <button type="button" onClick={onBindModel} style={toolbarAction(t, true)}><Plus size={13} /> Add models</button>}
      {!readOnly && <button type="button" onClick={onRelationship} style={toolbarAction(t)}><Link2 size={13} /> Connect</button>}
      {/* AI is an action on this canvas, not a separate destination. */}
      <button type="button" aria-pressed={aiOpen} onClick={onToggleAi} style={{ ...toolbarAction(t), ...(aiOpen ? { borderColor: t.accent, color: t.accent, background: 'var(--accent-dim)' } : {}) }}><Sparkles size={13} /> Build with AI</button>
      <details style={{ position: 'relative', flexShrink: 0 }}>
        <summary style={{ ...toolbarAction(t), listStyle: 'none' }}><SlidersHorizontal size={13} /> View</summary>
        <div role="group" aria-label="Modeling view options" style={{ position: 'fixed', zIndex: 70, width: 250, marginTop: 6, right: 12, padding: 10, display: 'grid', gap: 9, border: `1px solid ${t.headerBorder}`, borderRadius: 9, background: t.cellBg, boxShadow: '0 14px 34px rgba(0,0,0,.18)' }}>
          {modelingView === 'data' && <label style={viewOptionLabel(t)}><span><Columns3 size={13} /> Columns</span><select aria-label="Visible columns" value={columnMode} onChange={(event) => onColumnMode(event.target.value as ColumnDisplayMode)} style={{ ...inputStyle(t), width: 108, padding: '5px 6px' }}><option value="keys">Keys only</option><option value="relevant">Relevant</option><option value="all">All columns</option></select></label>}
          <label style={viewOptionLabel(t)}><span>Layout</span><select aria-label="Diagram layout" value={layoutMode} onChange={(event) => { onLayoutMode(event.target.value as DiagramLayoutMode); onReset(); }} style={{ ...inputStyle(t), width: 108, padding: '5px 6px' }}><option value="auto">Auto</option><option value="grid">Grid</option><option value="star">Star</option></select></label>
          <label style={viewOptionLabel(t)}><span>Density</span><select aria-label="Diagram density" value={density} onChange={(event) => onDensity(event.target.value as DiagramDensity)} style={{ ...inputStyle(t), width: 108, padding: '5px 6px' }}><option value="compact">Compact</option><option value="normal">Normal</option><option value="wide">Wide</option></select></label>
          <label style={viewOptionLabel(t)}><span>Canvas</span><select aria-label="Visible model limit" value={visibleLimit || 50} onChange={(event) => onVisibleLimit(Number(event.target.value))} style={{ ...inputStyle(t), width: 108, padding: '5px 6px' }}><option value={25}>25 models</option><option value={50}>50 models</option><option value={100}>100 models</option><option value={200}>200 max</option></select></label>
          <button type="button" onClick={() => onDimUnrelated(!dimUnrelated)} style={viewMenuButton(t, dimUnrelated)}><EyeOff size={14} /> Dim unrelated models</button>
          <button type="button" onClick={() => onEdgeLabels(!showEdgeLabels)} style={viewMenuButton(t, showEdgeLabels)}><Link2 size={14} /> Relationship labels</button>
          <button type="button" onClick={() => onLegend(!showLegend)} style={viewMenuButton(t, showLegend)}><Boxes size={14} /> Relationship legend</button>
          <button type="button" onClick={onExport} style={viewMenuButton(t)}><Download size={14} /> Export SVG</button>
          <button type="button" onClick={onFullscreen} style={viewMenuButton(t, fullscreen)}>{fullscreen ? <XCircle size={14} /> : <Maximize2 size={14} />} {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>
          <button type="button" onClick={onReset} style={viewMenuButton(t)}><RotateCcw size={14} /> Reset layout</button>
        </div>
      </details>
    </div>
  );
}

const viewOptionLabel = (t: Theme): React.CSSProperties => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, color: t.textSecondary, fontSize: 10.5 });
const viewMenuButton = (t: Theme, active = false): React.CSSProperties => ({ border: 'none', borderRadius: 6, padding: '6px 7px', display: 'flex', alignItems: 'center', gap: 7, background: active ? 'var(--accent-dim)' : 'transparent', color: active ? t.accent : t.textSecondary, fontSize: 10.5, textAlign: 'left', cursor: 'pointer' });

function DiagramLegend({ t }: { t: Theme }) { return <div style={{ display: 'flex', gap: 14, padding: '7px 12px', borderBottom: `1px solid ${t.headerBorder}`, background: t.headerBg, color: t.textSecondary, fontSize: 9.5 }}>{RELATIONSHIP_LEGEND.map(({ label, color }) => <span key={label} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><i style={{ display: 'inline-block', width: 18, height: 3, background: color, borderRadius: 2 }} />{label}</span>)}<span style={{ marginLeft: 'auto' }}>1:1 · 1:N · N:1 · N:N</span></div>; }

function ModelingEmptyWorkspace({ t, connectedModels, warehouse, onDbt, onYaml, onManual }: { t: Theme; connectedModels: number; warehouse?: { tables: number; drafting: boolean; onDraft: () => void }; onDbt: () => void; onYaml: () => void; onManual: () => void }) {
  // UI-019: all three doors are always live. A Domain and subject area are
  // prefilled and created as part of the proposal, so nothing here can
  // dead-end an author who has not set up governance objects yet.
  const actions = [
    // RFC 0007: a warehouse-first project starts from its own tables.
    ...(warehouse ? [{ icon: <Boxes size={20} />, title: warehouse.drafting ? 'Drafting from the warehouse…' : 'Draft from your warehouse', detail: warehouse.tables > 0 ? `${warehouse.tables} table${warehouse.tables === 1 ? '' : 's'} synced. DQL drafts models from their keys and joins from declared foreign keys, view SQL and column names, checks each join on the warehouse, and shows you every change to review.` : 'Sync schema in Settings → Connections first, so ZLens can read your tables, keys and comments.', action: warehouse.onDraft }] : []),
    { icon: <Boxes size={20} />, title: warehouse ? 'Pick tables' : 'Use connected dbt', detail: warehouse ? `${connectedModels} table${connectedModels === 1 ? '' : 's'} or model${connectedModels === 1 ? '' : 's'} available. Search, multi-select, confirm where they belong, then review the bindings.` : `${connectedModels} model${connectedModels === 1 ? '' : 's'} available. Search, multi-select, confirm where they belong, then review the bindings.`, action: onDbt },
    { icon: <FileSearch size={20} />, title: 'Import modeling YAML', detail: 'Discover DQL modeling or dbt YAML from this project, a safe local path, an upload, or pasted content. Relationships declared in dbt tests come across as draft edges.', action: onYaml },
    { icon: <Plus size={20} />, title: 'Add one model by hand', detail: 'Pick a single dbt model and describe what one of its rows means. Connect it to others afterwards.', action: onManual },
  ];
  return <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 28 }}><div style={{ width: 'min(840px, 100%)' }}><div style={{ textAlign: 'center', marginBottom: 18 }}><h2 style={{ margin: 0, fontSize: 18 }}>Start modeling domain context</h2><p style={{ margin: '7px 0 0', color: t.textMuted, fontSize: 11.5 }}>Choose the source you already have. Every path shows you the exact source change before anything is written.</p></div><div style={{ display: 'grid', gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))`, gap: 10 }}>{actions.map((item) => <button key={item.title} type="button" onClick={item.action} style={{ ...overviewCard(t), minHeight: 150, textAlign: 'left', cursor: 'pointer' }}><span style={{ width: 38, height: 38, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-dim)', color: t.accent }}>{item.icon}</span><b style={{ display: 'block', marginTop: 12 }}>{item.title}</b><span style={{ display: 'block', marginTop: 6, color: t.textSecondary, fontSize: 10.5, lineHeight: 1.5 }}>{item.detail}</span></button>)}</div></div></div>;
}

function exportDiagramSvg() {
  const source = document.querySelector('#dql-modeling-diagram .react-flow__renderer');
  if (!(source instanceof HTMLElement)) return;
  const clone = source.cloneNode(true) as HTMLElement;
  const rect = source.getBoundingClientRect();
  const serialized = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(rect.width)}" height="${Math.ceil(rect.height)}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${serialized}</div></foreignObject></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'dql-domain-model.svg'; anchor.click();
  URL.revokeObjectURL(url);
}

function DomainBlocksPanel({ data, domain, t }: { data: DbtFirstModelingResponse; domain: string | null; t: Theme }) {
  const { state, dispatch } = useNotebook();
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const paths = [...new Set(
    domain
      ? (data.domainAssets?.[domain]?.blocks ?? [])
      : Object.values(data.domainAssets ?? {}).flatMap((assets) => assets.blocks ?? []),
  )].sort();

  const openBlock = async (path: string) => {
    setOpeningPath(path);
    setOpenError(null);
    try {
      if (domain) {
        try { window.localStorage.setItem('dql.block-studio.domain', domain); } catch { /* best effort */ }
      }
      const file: NotebookFile = state.files.find((candidate) => candidate.path === path) ?? {
        name: path.split('/').at(-1) ?? path,
        path,
        type: 'block',
        folder: path.split('/').slice(0, -1).join('/'),
      };
      if (!state.files.some((candidate) => candidate.path === path)) dispatch({ type: 'FILE_ADDED', file });
      const payload = await api.openBlockStudio(path);
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningPath(null);
    }
  };

  return (
    <ScrollPanel>
      <PanelHeader
        title="Saved queries"
        detail={domain
          ? `Saved queries owned by ${domain}. Select one to open its source in Saved queries.`
          : 'All saved queries, grouped across all domains. Select one to open its source in Saved queries.'}
        t={t}
      />
      {openError ? <Message text={openError} t={t} /> : null}
      {paths.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {paths.map((path) => {
            const name = (path.split('/').at(-1) ?? path).replace(/\.dql$/i, '');
            const owningDomain = Object.entries(data.domainAssets ?? {})
              .find(([, assets]) => assets.blocks?.includes(path))?.[0];
            return (
              <button
                key={path}
                type="button"
                onClick={() => void openBlock(path)}
                aria-label={`Open saved query ${name}`}
                style={{ ...overviewCard(t), width: '100%', textAlign: 'left', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Blocks size={14} color={t.accent} />
                  <b>{name}</b>
                  {!domain ? <Badge t={t}>{owningDomain ?? 'shared'}</Badge> : null}
                  {openingPath === path ? <Badge t={t}>Opening…</Badge> : null}
                </div>
                <code style={{ display: 'block', marginTop: 7, color: t.textMuted, fontSize: 10 }}>{path}</code>
              </button>
            );
          })}
        </div>
      ) : (
        <Blank title="No saved queries in this domain yet" detail="Save a query in Saved queries and assign this domain to make it appear here." t={t} />
      )}
    </ScrollPanel>
  );
}

function RelatedProductsPanel({ data, domain, kind, t }: { data: DbtFirstModelingResponse; domain: string | null; kind: 'notebooks' | 'apps'; t: Theme }) {
  const { state, dispatch } = useNotebook();
  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void (domain ? api.getRelatedDomainProducts(domain) : api.getAllRelatedDomainProducts())
      .then((result) => { if (active) setProducts(result[kind] as unknown as Array<Record<string, unknown>>); })
      .catch(() => { if (active) setProducts([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [domain, kind]);
  const legacyPaths = domain
    ? (data.domainAssets?.[domain]?.[kind] ?? [])
    : Object.values(data.domainAssets ?? {}).flatMap((assets) => assets[kind] ?? []);
  const label = kind === 'notebooks' ? 'Notebooks' : 'Apps';
  const openProduct = async (product: Record<string, unknown>) => {
    const id = String(product.id ?? product.filePath ?? product.title ?? product.name ?? 'product');
    setOpeningId(id);
    setOpenError(null);
    try {
      if (kind === 'apps') {
        const appId = String(product.id ?? appIdFromPath(String(product.filePath ?? '')));
        if (!appId) throw new Error('This App has no stable id to open.');
        dispatch({ type: 'OPEN_APP', appId, experience: 'view', section: 'dashboards' });
        return;
      }
      const path = String(product.filePath ?? '');
      if (!path) throw new Error('This Notebook has no source path to open.');
      const file: NotebookFile = state.files.find((candidate) => candidate.path === path) ?? {
        name: path.split('/').at(-1) ?? String(product.title ?? id),
        path,
        type: 'notebook',
        folder: path.split('/').slice(0, -1).join('/'),
        ...(typeof product.ownerDomain === 'string' ? { ownerDomain: product.ownerDomain } : {}),
        usesDomains: Array.isArray(product.usesDomains) ? product.usesDomains.map(String) : [],
      };
      if (!state.files.some((candidate) => candidate.path === path)) dispatch({ type: 'FILE_ADDED', file });
      const { content } = await api.readNotebook(path);
      const parsed = parseNotebookFile(path, content);
      dispatch({ type: 'OPEN_FILE', file, cells: parsed.cells, title: parsed.title, metadata: parsed.metadata });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningId(null);
    }
  };
  return (
    <section aria-label={label} style={{ marginBottom: 22 }}>
      <h3 style={{ ...inspectorHeading(t), margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 6 }}>{label}{!loading ? <small style={{ color: t.textMuted, fontWeight: 600 }}>{products.length || legacyPaths.length}</small> : null}</h3>
      {openError ? <Message text={openError} t={t} /> : null}
      {loading ? <Blank title={`Loading related ${label.toLowerCase()}…`} detail="Resolving global product backlinks from the compiled project snapshot." t={t} /> : products.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {products.map((product) => {
            const id = String(product.id ?? product.filePath ?? product.title ?? 'product');
            const usesDomains = Array.isArray(product.usesDomains) ? product.usesDomains.map(String) : [];
            const productName = String(product.name ?? product.title ?? id);
            return <button key={id} type="button" onClick={() => void openProduct(product)} aria-label={`Open ${kind === 'notebooks' ? 'notebook' : 'app'} ${productName}`} style={{ ...overviewCard(t), width: '100%', textAlign: 'left', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FolderTree size={14} color={t.accent} />
                <b>{productName}</b>
                {product.lifecycle ? <Badge t={t}>{String(product.lifecycle)}</Badge> : null}
                {openingId === id ? <Badge t={t}>Opening…</Badge> : null}
              </div>
              <p style={{ color: t.textSecondary, fontSize: 11, margin: '7px 0 0' }}>{String(product.purpose ?? 'No analytical purpose declared yet.')}</p>
              <code style={{ display: 'block', marginTop: 7, color: t.textMuted, fontSize: 10 }}>{String(product.filePath ?? '')}</code>
              <div style={{ marginTop: 7, color: t.textMuted, fontSize: 10 }}>Owner: {String(product.ownerDomain ?? 'Shared')} · Uses: {usesDomains.join(', ') || 'none declared'}</div>
            </button>;
          })}
        </div>
      ) : legacyPaths.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <Message text="These paths use the legacy domain-local layout. They remain readable during migration, but new products should be global and declare ownerDomain / usesDomains." t={t} />
          {legacyPaths.map((path) => (
            <button key={path} type="button" onClick={() => void openProduct({ id: kind === 'apps' ? appIdFromPath(path) : path, filePath: path })} aria-label={`Open ${kind === 'notebooks' ? 'notebook' : 'app'} ${path}`} style={{ ...overviewCard(t), width: '100%', textAlign: 'left', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FolderTree size={14} color={t.accent} />
                <code style={{ color: t.textPrimary, fontSize: 11 }}>{path}</code>
              </div>
              <p style={{ color: t.textMuted, fontSize: 10, margin: '7px 0 0' }}>Legacy backlink · migrate without duplicating the product.</p>
            </button>
          ))}
        </div>
      ) : (
        <Blank title={`No ${label.toLowerCase()} use this domain yet`} detail={`Open a ${kind === 'notebooks' ? 'notebook' : 'app'} and add this domain to its context to list it here.`} t={t} />
      )}
    </section>
  );
}

function appIdFromPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const appsIndex = parts.indexOf('apps');
  return appsIndex >= 0 ? (parts[appsIndex + 1] ?? '') : '';
}

function ModelingAiPanel({ domain, areaId, selectedId, data, themeMode, t, correction, onClose, onCorrectionStarted, onReviewProposal, onPreviewProposal, onOpenSkills, onDraftRelationship }: { domain: string | null; areaId: string | null; selectedId: string | null; data: DbtFirstModelingResponse; themeMode: ThemeMode; t: Theme; correction?: { text: string; nonce: number; evidence: unknown } | null; onClose: () => void; onCorrectionStarted: () => void; onReviewProposal: (proposal: ContextAuthoringProposalV1) => void; onPreviewProposal: (proposal: ContextAuthoringProposalV1 | null) => void; onOpenSkills: () => void; onDraftRelationship: () => void }) {
  const { threadId, onThreadIdChange } = usePersistedAgentThreadId(modelingThreadScope(domain));
  const selectedRelationship = selectedId ? data.modeling.relationships[selectedId] : undefined;
  const selectedModel = selectedId ? data.modeling.entities[selectedId] : undefined;
  const selectedArea = areaId ? data.modeling.areas[areaId] : undefined;
  const selectedObject = selectedRelationship
    ? { kind: 'relationship' as const, id: selectedRelationship.qualifiedId, title: selectedRelationship.id }
    : selectedModel
      ? { kind: 'model' as const, id: selectedModel.qualifiedId, title: selectedModel.businessName || selectedModel.id }
      : selectedArea
        ? { kind: 'model_area' as const, id: selectedArea.qualifiedId, title: selectedArea.name }
        : domain
          ? { kind: 'domain' as const, id: domain, title: domain }
          : { kind: 'workspace' as const, title: 'New modeling draft' };
  const [preview, setPreview] = useState<ContextAuthoringProposalV1 | null>(null);
  // The canvas shows the proposal as ghost nodes and dashed edges the moment it
  // arrives; the exact source patches stay one explicit step away.
  const reviewArtifact = (artifact: AgentRunArtifact) => {
    const payload = artifact.payload as ContextAuthoringProposalV1 | undefined;
    if (payload?.version === 1 && payload.trustState === 'review_required') {
      setPreview(payload);
      onPreviewProposal(payload);
    }
  };
  const clearPreview = () => { setPreview(null); onPreviewProposal(null); };
  useEffect(() => () => onPreviewProposal(null), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <Sparkles size={14} color={t.accent} />
        <strong style={{ fontSize: 12 }}>Build with AI</strong>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" onClick={onOpenSkills} style={linkButton(t)}>Skills</button>
        <button type="button" onClick={onDraftRelationship} style={linkButton(t)}>Connect manually</button>
        <button type="button" aria-label="Close Modeling AI" onClick={onClose} style={{ ...iconButtonStyle(t), width: 26, height: 26 }}><XCircle size={14} /></button>
      </header>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${t.headerBorder}`, color: t.textMuted, fontSize: 10.5, lineHeight: 1.5 }}>
        {domain ?? 'new domain'}{areaId ? ` · ${areaId}` : ''}{selectedId ? ` · focused: ${selectedId}` : ''} · {Object.keys(data.modeling.entities).length} models · {Object.keys(data.modeling.relationships).length} relationships.
        Proposals are drafts: nothing is written, certified, or joinable until you save and validate it.
      </div>

      {preview ? (
        <div role="status" style={{ margin: '10px 12px 0', padding: '10px 11px', border: '1px solid var(--accent)', borderRadius: 9, background: 'var(--accent-dim)', fontSize: 11, lineHeight: 1.5 }}>
          <strong style={{ display: 'block', fontSize: 11.5 }}>Previewing on the canvas</strong>
          <span style={{ color: t.textSecondary }}>
            {preview.impact.modelingChanges} modeling change{preview.impact.modelingChanges === 1 ? '' : 's'} shown as dashed outlines. Nothing is saved yet.
          </span>
          <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
            <button type="button" onClick={() => { onReviewProposal(preview); }} style={{ ...toolbarAction(t, true), minHeight: 27 }}>Review exact changes</button>
            <button type="button" onClick={clearPreview} style={{ ...toolbarAction(t), minHeight: 27 }}>Discard</button>
          </div>
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, margin: '10px 12px 12px', border: `1px solid ${t.headerBorder}`, borderRadius: 10, overflow: 'hidden' }}>
        <UnifiedAgentRunPanel
          themeMode={themeMode}
          title="Modeling AI"
          scopeHint="Modeling proposal · metadata only · explicit draft save"
          composerPlaceholder="Describe the model you want…"
          initialMode="modeling"
          selectedObject={selectedObject}
          // `surface` names the thread's home. Without it these threads were
          // created as the generic 'agent' surface and appeared in no listing,
          // so a conversation whose id was lost became unreachable even though
          // its turns were still on the server.
          workspaceContext={{ surface: 'modeling', domain, modelAreaId: areaId, snapshotId: data.snapshotId, focusedObjectId: selectedId, providerSafety: 'no_query_rows', ...(correction ? { correction: true, validationReceipt: correction.evidence } : {}) }}
          threadId={threadId}
          onThreadIdChange={onThreadIdChange}
          autoRun={correction ? { text: correction.text, mode: 'modeling', nonce: correction.nonce } : undefined}
          onRunningChange={(running) => { if (running && correction) onCorrectionStarted(); }}
          onReviewAuthoringProposal={(artifact) => reviewArtifact(artifact)}
          emptyHint="Describe the models and relationships you want. Every model and column is checked against the current dbt snapshot before anything is proposed."
          examplePrompts={[
            { label: 'Model this area', prompt: 'Bind the relevant unbound dbt models for this area, write business context for each, and connect them with draft relationships.' },
            { label: 'Describe this model', prompt: 'Write the business context and grain for the focused model using only dbt metadata evidence.' },
            { label: 'Connect these models', prompt: 'Propose draft relationships between the models in this area and explain the evidence for each key pair.' },
          ]}
        />
      </div>
    </div>
  );
}

function AiCapability({ icon, title, detail, t, action }: { icon: React.ReactNode; title: string; detail: string; t: Theme; action?: React.ReactNode }) {
  return (
    <div style={overviewCard(t)}>
      <div style={{ display: 'flex', gap: 7, color: t.accent }}>
        {icon}
        <b style={{ color: t.textPrimary }}>{title}</b>
      </div>
      <p style={{ color: t.textSecondary, fontSize: 11, lineHeight: 1.5 }}>{detail}</p>
      {action}
    </div>
  );
}

// Prototype entity inspector: kind square + mono name + uppercase kind,
// description, dbt-binding mono box, columns with PK/FK glyphs, relationship
// click-through list, and an Edit entity action.
function EntityInspector({ entity, detail, relationships = [], t, readOnly = false, onEdit, onEditDbtSource, onSelectRelationship, onDelete }: { entity: ManifestModelEntity; detail: DbtNodeAuthoringDetail | null; relationships?: ManifestModelRelationship[]; t: Theme; readOnly?: boolean; onEdit: () => void; onEditDbtSource: () => void; onSelectRelationship?: (relationship: ManifestModelRelationship) => void; onDelete?: () => void }) {
  const kindColor = entityKindColor(entity.analyticalRole);
  const keys = new Set(entity.keys.length ? entity.keys : (detail?.dqlMeta?.keys ?? []));
  const heading: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, margin: '0 0 5px' };
  const related = relationships.filter((relationship) => relationship.from === entity.id || relationship.to === entity.id || relationship.from === entity.localId || relationship.to === entity.localId);
  return (
    <Inspector t={t}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2.5, background: kindColor, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 700, color: t.textPrimary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entity.businessName || entity.localId}</span>
        <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: kindColor }}>{entity.analyticalRole ?? 'entity'}</span>
      </div>
      <p style={{ margin: '0 0 12px', color: t.textSecondary, fontSize: 12, lineHeight: 1.6 }}>{entity.businessContext || `Add the DQL-owned business context for ${entity.localId}. dbt descriptions remain physical-source documentation.`}</p>
      <div style={{ marginBottom: 12 }}>
        <div style={heading}>dbt binding</div>
        <div style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textPrimary, background: 'var(--bg-1)', border: '1px solid var(--border-subtle)', borderRadius: 7, padding: '7px 9px', overflowWrap: 'anywhere' }}>
          {detail?.relation ?? entity.dbtUniqueId}
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={heading}>Columns · {detail?.columns.length ?? '…'}</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {detail?.columns.slice(0, 16).map((column) => (
            <div key={column.name} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 2px', borderBottom: '1px solid var(--border-subtle)', fontSize: 11.5 }}>
              <span style={{ flexShrink: 0, width: 17, fontSize: 8.5, fontWeight: 700, fontFamily: t.fontMono, color: keys.has(column.name) ? 'var(--pk)' : /(^|_)id$/.test(column.name) ? 'var(--fk)' : 'transparent' }}>
                {keys.has(column.name) ? 'PK' : /(^|_)id$/.test(column.name) ? 'FK' : '·'}
              </span>
              <span style={{ flex: 1, minWidth: 0, color: t.textSecondary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{column.name}</span>
              <span style={{ flexShrink: 0, fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>{column.type ?? '—'}</span>
            </div>
          ))}
        </div>
      </div>
      {related.length > 0 && onSelectRelationship ? (
        <div style={{ marginBottom: 12 }}>
          <div style={heading}>Relationships</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {related.map((relationship) => (
              <button
                key={relationship.qualifiedId ?? relationship.localId}
                type="button"
                onClick={() => onSelectRelationship(relationship)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', borderRadius: 7, border: '1px solid var(--border-subtle)', background: 'var(--bg-1)', cursor: 'pointer', textAlign: 'left', fontFamily: t.font, fontSize: 11, color: t.textSecondary }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{relationship.localId}</span>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{relationship.cardinality === 'one_to_one' ? '1:1' : relationship.cardinality === 'one_to_many' ? '1:N' : relationship.cardinality === 'many_to_one' ? 'N:1' : 'N:N'}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ ...heading, cursor: 'pointer' }}>More metadata</summary>
        <Property label="concepts" value={entity.conceptRefs?.join(', ') || 'Not mapped'} t={t} />
        <Property label="owner" value={entity.owner ?? 'Not declared'} t={t} />
        <Property label="grain" value={entity.grain ?? detail?.dqlMeta?.grain ?? 'Not declared'} t={t} />
        <Property label="keys" value={(entity.keys.length ? entity.keys : (detail?.dqlMeta?.keys ?? [])).join(', ') || 'Not declared'} t={t} />
        <Property label="source" value={detail?.sourcePath ?? entity.sourcePath} t={t} />
        <Property label="dbt description" value={detail?.description ?? 'Not declared'} t={t} />
      </details>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {!readOnly && <Button primary t={t} onClick={onEdit}>Edit entity</Button>}
        {!readOnly && <Button t={t} onClick={onEditDbtSource}>Preview dbt source patch</Button>}
        {!readOnly && onDelete ? <Button t={t} danger onClick={onDelete}>Delete entity</Button> : null}
      </div>
    </Inspector>
  );
}

function DbtSourceEditor({ entity, detail, snapshotId, t, onClose, onApplied }: {
  entity: ManifestModelEntity;
  detail: DbtNodeAuthoringDetail;
  snapshotId: string;
  t: Theme;
  onClose: () => void;
  onApplied: () => Promise<void>;
}) {
  const initialTests = detail.columns
    .filter((column) => column.tests.length > 0)
    .map((column) => `${column.name}: ${column.tests.join(', ')}`)
    .join('\n');
  const [description, setDescription] = useState(detail.description ?? '');
  const [tests, setTests] = useState(initialTests);
  const [preview, setPreview] = useState<(DbtSourcePatchPreview & { snapshotId: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const change = (): DbtSourceAuthoringInput => ({
    uniqueId: entity.dbtUniqueId,
    description,
    columns: tests.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf(':');
      if (separator < 1) return [];
      const name = line.slice(0, separator).trim();
      const dataTests = csv(line.slice(separator + 1));
      return name ? [{ name, tests: dataTests }] : [];
    }),
  });
  const previewPatch = async () => {
    try {
      setBusy(true);
      setMessage(null);
      setPreview(await api.previewDbtSourcePatch(change(), snapshotId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const applyPatch = async () => {
    if (!preview) return;
    try {
      setBusy(true);
      setMessage(null);
      await api.applyDbtSourcePatch(change(), preview.fingerprint, preview.snapshotId);
      await onApplied();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit dbt source · ${detail.name}`} t={t} onClose={onClose}>
      <Message text="dbt owns descriptions and tests. ZLens will preview a guarded patch to the dbt YAML source; no dbt metadata is copied into the domain folder." t={t} />
      {!preview ? <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Model description">
          <textarea aria-label="Model description" value={description} onChange={(event) => setDescription(event.target.value)} rows={5} style={{ ...inputStyle(t), resize: 'vertical' }} />
        </Field>
        <Field label="Column tests (one column per line)">
          <textarea aria-label="Column tests" value={tests} onChange={(event) => setTests(event.target.value)} rows={6} placeholder="order_id: unique, not_null" style={{ ...inputStyle(t), resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
        </Field>
        <p style={{ margin: 0, color: t.textMuted, fontSize: 10 }}>Descriptions/tests stay in dbt YAML. Business meaning, relationships, contracts, and policies stay in the DQL domain folder.</p>
        {message && <Message text={message} t={t} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}><Button t={t} onClick={onClose}>Cancel</Button><Button primary t={t} disabled={busy} onClick={() => void previewPatch()}>Preview source patch</Button></div>
      </div> : <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ color: t.textSecondary, fontSize: 11 }}>Source: <code>{preview.patch.path}</code></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <SourcePreview title="Current dbt YAML" source={preview.patch.before || '# New dbt schema YAML'} t={t} />
          <SourcePreview title="Proposed dbt YAML" source={preview.patch.after} t={t} />
        </div>
        {message && <Message text={message} t={t} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}><Button t={t} onClick={() => setPreview(null)}>Back</Button><Button primary t={t} disabled={busy || !preview.patch.changed} onClick={() => void applyPatch()}>{preview.patch.changed ? 'Apply dbt source patch' : 'No changes'}</Button></div>
      </div>}
    </Modal>
  );
}

function SourcePreview({ title, source, t }: { title: string; source: string; t: Theme }) {
  return <section><strong style={{ fontSize: 10 }}>{title}</strong><pre tabIndex={0} style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', background: t.appBg, border: `1px solid ${t.headerBorder}`, borderRadius: 6, padding: 10, fontSize: 9.5, color: t.textSecondary }}>{source}</pre></section>;
}

function RelationshipInspector({ relationship, entities, t, readOnly = false, onEdit, onDelete }: { relationship: ManifestModelRelationship; entities: DbtFirstModelingResponse['modeling']['entities']; t: Theme; readOnly?: boolean; onEdit: () => void; onDelete?: () => void }) {
  const status = relationshipStatusView(relationship);
  const nameOf = (ref: string) => entities[ref]?.businessName || entities[ref]?.localId || ref.split('::').pop() || ref;
  const fromName = nameOf(relationship.from);
  const toName = nameOf(relationship.to);
  return (
    <Inspector t={t}>
      <InspectorTitle title={relationshipSentence(relationship.cardinality, fromName, toName)} subtitle={relationship.localId} t={t} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        <span style={{ border: `1px solid ${status.color}`, color: status.color, borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 750 }}>{status.label}</span>
      </div>
      <p style={{ margin: '0 0 8px', color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>{status.meaning}</p>
      <h3 style={inspectorHeading(t)}>Matched on</h3>
      <Property label="keys" value={relationship.keys.map((key) => `${fromName}.${key.from} = ${toName}.${key.to}`).join(' and ')} t={t} />
      {relationship.description ? <p style={{ margin: '8px 0', color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>{relationship.description}</p> : null}
      <h3 style={inspectorHeading(t)}>Warehouse check</h3>
      {relationship.validation
        ? <Evidence evidence={relationship.validation} fromName={fromName} toName={toName} t={t} />
        : <Message text="Not checked in the warehouse yet. Open the relationship to run the check." t={t} />}
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', color: t.textMuted, fontSize: 10.5 }}>Details</summary>
        <Property label="cardinality" value={relationship.cardinality.replace(/_/g, ' ')} t={t} />
        <Property label="fanout" value={relationship.fanout} t={t} />
        <Property label="saved status" value={relationship.status} t={t} />
        <Property label="roles" value={[relationship.roles?.from, relationship.roles?.to].filter(Boolean).join(' → ') || 'Not declared'} t={t} />
        <Property label="allowed joins" value={relationship.joinTypes?.join(', ') || 'left'} t={t} />
      </details>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
        {!readOnly && <Button primary t={t} onClick={onEdit}>Edit relationship</Button>}
        {!readOnly && onDelete ? <Button t={t} danger onClick={onDelete}>Delete relationship</Button> : null}
      </div>
    </Inspector>
  );
}

// Prototype nothing-selected inspector: stat cards, guidance line, and a
// Model health checklist computed from real bindings/proofs/descriptions.
function StudioSummary({ data, domainEntities, domainRelationships, t, onSelectRelationship }: { data: DbtFirstModelingResponse; domainEntities: ManifestModelEntity[]; domainRelationships: ManifestModelRelationship[]; t: Theme; onSelectRelationship: (relationship: ManifestModelRelationship) => void }) {
  const domainLabel = domainEntities[0]?.domain ?? 'All domains';
  const provenCount = domainRelationships.filter((relationship) => relationship.validation?.status === 'passed').length;
  const boundCount = domainEntities.filter((entity) => Boolean(entity.dbtUniqueId)).length;
  const missingContext = domainEntities.filter((entity) => !entity.businessContext);
  const heading: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, margin: '14px 0 5px' };
  const statCard = (value: number, label: string) => (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 9, padding: '10px 12px', background: 'var(--bg-1)' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: t.textPrimary }}>{value}</div>
      <div style={{ fontSize: 10.5, color: t.textMuted }}>{label}</div>
    </div>
  );
  const check = (ok: boolean, text: string) => (
    <span key={text} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11.5, color: t.textSecondary, lineHeight: 1.45 }}>
      <span style={{ color: ok ? 'var(--status-success)' : 'var(--status-warning)', flexShrink: 0, fontWeight: 700 }}>{ok ? '✓' : '△'}</span>
      {text}
    </span>
  );
  return (
    <Inspector t={t}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>{domainLabel} model</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
        {statCard(domainEntities.length, domainEntities.length === 1 ? 'entity' : 'entities')}
        {statCard(domainRelationships.length, domainRelationships.length === 1 ? 'relationship' : 'relationships')}
      </div>
      <p style={{ margin: '12px 0 0', color: t.textSecondary, fontSize: 12, lineHeight: 1.6 }}>
        Select an entity to see its columns and dbt binding, or click a relationship label to review its join, cardinality, and business context.
      </p>
      <div style={heading}>Model health</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {domainRelationships.length > 0
          ? check(provenCount === domainRelationships.length, provenCount === domainRelationships.length ? 'All relationships have join proofs' : `${provenCount} of ${domainRelationships.length} relationships have join proofs`)
          : check(false, 'No relationships yet — drag between column handles to create one')}
        {check(boundCount === domainEntities.length && domainEntities.length > 0, domainEntities.length === 0 ? 'No models added yet — use Add models' : `${boundCount} of ${domainEntities.length} entities bound to dbt`)}
        {missingContext.length > 0
          ? check(false, `${missingContext[0].localId}${missingContext.length > 1 ? ` and ${missingContext.length - 1} more` : ''} ha${missingContext.length > 1 ? 've' : 's'} no business description`)
          : domainEntities.length > 0 ? check(true, 'Every entity has a business description') : null}
      </div>
      <div style={heading}>Relationships</div>
      {domainRelationships.length ? domainRelationships.map((relationship) => (
        <button
          key={relationship.qualifiedId}
          onClick={() => onSelectRelationship(relationship)}
          style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', border: '1px solid var(--border-subtle)', borderRadius: 7, background: 'var(--bg-1)', color: t.textSecondary, padding: '6px 8px', marginBottom: 4, cursor: 'pointer', fontSize: 11, fontFamily: t.font }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{relationship.localId}</span>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{relationship.cardinality === 'one_to_one' ? '1:1' : relationship.cardinality === 'one_to_many' ? '1:N' : relationship.cardinality === 'many_to_one' ? 'N:1' : 'N:N'}</span>
        </button>
      )) : <p style={{ color: t.textMuted, fontSize: 10.5, margin: 0 }}>Drag between two column handles to create the first relationship.</p>}
      <div style={heading}>Ownership boundary</div>
      <p style={{ color: t.textSecondary, fontSize: 11, lineHeight: 1.55, margin: 0 }}>dbt owns tables, columns, descriptions, tests, and metrics. DQL owns domain membership, analytical identity, safe relationship proof, contracts, certified saved queries, and agent policy. Shared apps and notebooks reference this domain without moving inside it.</p>
    </Inspector>
  );
}

export function Evidence({ evidence, t, onFixWithAi, fromName = 'source', toName = 'target' }: { evidence: NonNullable<ManifestModelRelationship['validation']>; t: Theme; onFixWithAi?: () => void; fromName?: string; toName?: string }) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        border: `1px solid ${evidence.status === 'passed' ? '#2e9b6355' : '#c94b5555'}`,
        background: evidence.status === 'passed' ? '#2e9b630d' : '#c94b550d',
        borderRadius: 7,
        fontSize: 11,
      }}
    >
      <b style={{ color: evidence.status === 'passed' ? '#2e9b63' : '#c94b55' }}>{evidence.status === 'passed' ? 'Safe to join' : 'Not safe to join as declared'}</b>
      <span style={{ color: t.textMuted, marginLeft: 6, fontSize: 10 }}>checked {evidence.checkedAt.slice(0, 10)}</span>
      <ul style={{ color: t.textSecondary, margin: '7px 0 0', paddingLeft: 16, lineHeight: 1.55 }}>
        {relationshipProfileLines(evidence, fromName, toName).map((line) => <li key={line}>{line}</li>)}
      </ul>
      {onFixWithAi ? <button type="button" onClick={onFixWithAi} style={{ ...linkButton(t), marginTop: 9 }}><Sparkles size={13} /> Fix with Modeling AI</button> : null}
    </div>
  );
}

function EmptyState({ t, title, detail, status, action }: { t: Theme; title: string; detail: string; status?: string; action?: { label: string; run: () => Promise<void> } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        background: t.appBg,
        color: t.textPrimary,
      }}
    >
      <div style={{ maxWidth: 560, textAlign: 'center' }}>
        <Boxes size={34} color={t.accent} />
        <h1 style={{ fontSize: 20 }}>{title}</h1>
        <p style={{ color: t.textSecondary, lineHeight: 1.6 }}>{detail}</p>
        {status && <code style={{ fontSize: 12 }}>{status}</code>}
        {action && (
          <div style={{ marginTop: 16 }}>
            <Button t={t} disabled={busy} onClick={() => { setBusy(true); setError(null); void action.run().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)); }}>
              <Boxes size={14} /> {busy ? 'Setting up…' : action.label}
            </Button>
            {error && <p role="alert" style={{ color: 'var(--status-error)', fontSize: 11.5 }}>{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
function WorkflowSteps({ current, labels, t }: { current: number; labels: string[]; t: Theme }) {
  return (
    <div aria-label={`Step ${current} of ${labels.length}`} style={{ display: 'grid', gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))`, gap: 6 }}>
      {labels.map((label, index) => {
        const step = index + 1;
        const active = step === current;
        const complete = step < current;
        return <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, color: active ? t.textPrimary : t.textMuted, fontSize: 10, fontWeight: active ? 700 : 550 }}><span style={{ display: 'grid', placeItems: 'center', width: 20, height: 20, flex: '0 0 auto', borderRadius: 999, border: `1px solid ${active || complete ? t.accent : t.headerBorder}`, background: complete ? t.accent : active ? 'var(--accent-dim)' : t.appBg, color: complete ? '#fff' : active ? t.accent : t.textMuted }}>{complete ? '✓' : step}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span></div>;
      })}
    </div>
  );
}

function SelectionSummary({ title, detail, t }: { title: string; detail: string; t: Theme }) {
  return <div style={{ display: 'grid', gap: 3, padding: '9px 11px', border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.cellBg }}><strong style={{ fontSize: 11 }}>{title}</strong><span style={{ color: t.textMuted, fontSize: 9.5, overflowWrap: 'anywhere' }}>{detail}</span></div>;
}


function DbtModelPicker({ value, onChange, selectedNode, t }: { value: string; onChange: (value: string) => void; selectedNode?: { name: string; relation?: string; sourcePath?: string }; domain: string; t: Theme }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [options, setOptions] = useState<ModelingSearchOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api.getDbtModelInventory({ q: query, limit: 50 }).then((result) => {
        if (cancelled) return;
        setTotal(result.total);
        setOptions(result.items.map((raw) => {
          const item = raw as { uniqueId?: string; name?: string; relation?: string; sourcePath?: string; binding?: { domain?: string; businessName?: string } };
          return {
            value: item.uniqueId ?? '',
            label: item.name ?? item.uniqueId ?? 'Unnamed model',
            description: `${item.relation ?? item.sourcePath ?? item.uniqueId}${item.binding ? ` · already bound to ${item.binding.domain ?? 'a domain'}` : ' · unbound'}`,
            keywords: [item.sourcePath ?? '', item.binding?.businessName ?? ''],
          };
        }).filter((option) => option.value));
      }).catch(() => { if (!cancelled) setOptions([]); }).finally(() => { if (!cancelled) setLoading(false); });
    }, 140);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <Search size={13} aria-hidden="true" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: t.textMuted, pointerEvents: 'none' }} />
        <input role="combobox" aria-label="Search dbt models" aria-expanded={open} value={open ? query : (selectedNode?.name ?? value)} placeholder="Search model, relation, or path…" onFocus={() => { setOpen(true); setQuery(''); }} onBlur={() => { setOpen(false); setQuery(''); }} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }} style={{ ...inputStyle(t), paddingLeft: 29, paddingRight: value ? 29 : 8 }} />
        {value && <button type="button" aria-label="Clear dbt model" onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(''); setOpen(true); }} style={{ ...iconButtonStyle(t), position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)', width: 24, height: 24, border: 'none' }}><XCircle size={13} /></button>}
      </div>
      {open && <div role="listbox" style={{ position: 'absolute', zIndex: 90, top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: 260, overflowY: 'auto', border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.cellBg, boxShadow: '0 12px 32px #0004', padding: 4 }}>
        {loading && <div style={{ padding: 10, color: t.textMuted, fontSize: 10 }}>Searching project inventory…</div>}
        {!loading && options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(option.value); setOpen(false); setQuery(''); }} style={{ display: 'grid', width: '100%', gap: 2, padding: '8px 9px', border: 'none', borderRadius: 5, textAlign: 'left', background: option.value === value ? 'var(--accent-dim)' : 'transparent', color: t.textPrimary, cursor: 'pointer' }}><strong style={{ fontSize: 10.5 }}>{option.label}</strong><span style={{ color: t.textMuted, fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.description}</span></button>)}
        {!loading && !options.length && <div style={{ padding: 10, color: t.textMuted, fontSize: 10 }}>No dbt models match this search.</div>}
        {!loading && total > options.length && <div style={{ padding: '6px 9px 4px', borderTop: `1px solid ${t.headerBorder}`, color: t.textMuted, fontSize: 9 }}>Showing 50 of {total.toLocaleString()}. Keep typing to narrow the inventory.</div>}
      </div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6, fontSize: 11, fontWeight: 650 }}>
      {label}
      {children}
    </label>
  );
}
function Input({ value, onChange, t, placeholder }: { value: string; onChange: (v: string) => void; t: Theme; placeholder?: string }) {
  return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={inputStyle(t)} />;
}
function Select({ value, onChange, values, labels, t }: { value: string; onChange: (v: string) => void; values: string[]; labels?: Record<string, string>; t: Theme }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle(t)}>
      <option value="">Select…</option>
      {values.map((item) => (
        <option key={item} value={item}>
          {labels?.[item] ?? item}
        </option>
      ))}
    </select>
  );
}
function Button({ children, t, onClick, primary, disabled, danger }: { children: React.ReactNode; t: Theme; onClick: () => void; primary?: boolean; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        border: `1px solid ${danger ? t.error : primary ? t.accent : t.headerBorder}`,
        background: danger ? `${t.error}12` : primary ? t.accent : t.appBg,
        color: danger ? t.error : primary ? '#fff' : t.textPrimary,
        borderRadius: 6,
        padding: '7px 10px',
        fontSize: 11,
        fontWeight: 650,
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.65 : 1,
      }}
    >
      {children}
    </button>
  );
}
function IconButton({ children, title, t, onClick }: { children: React.ReactNode; title: string; t: Theme; onClick: () => void }) {
  return (
    <button aria-label={title} title={title} onClick={onClick} style={iconButtonStyle(t)}>
      {children}
    </button>
  );
}
function Badge({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <span
      style={{
        marginLeft: 5,
        border: `1px solid ${t.accent}55`,
        color: t.accent,
        background: `${t.accent}10`,
        borderRadius: 999,
        padding: '3px 7px',
        fontSize: 9,
        fontWeight: 750,
      }}
    >
      {children}
    </span>
  );
}
function SideHeading({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <div
      style={{
        padding: '15px 12px 8px',
        color: t.textMuted,
        fontSize: 10,
        fontWeight: 750,
        textTransform: 'uppercase',
        letterSpacing: '.07em',
      }}
    >
      {children}
    </div>
  );
}
function ScrollPanel({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', overflow: 'auto', padding: 20 }}>{children}</div>;
}
function PanelHeader({ title, detail, t, action }: { title: string; detail: string; t: Theme; action?: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 20,
        alignItems: 'start',
        marginBottom: 18,
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        <p style={{ margin: '5px 0 0', color: t.textSecondary, fontSize: 11 }}>{detail}</p>
      </div>
      {action}
    </div>
  );
}
function Blank({ title, detail, t }: { title: string; detail: string; t: Theme }) {
  return (
    <div
      style={{
        border: `1px dashed ${t.headerBorder}`,
        borderRadius: 10,
        padding: 30,
        textAlign: 'center',
      }}
    >
      <strong>{title}</strong>
      <p style={{ color: t.textSecondary, fontSize: 12 }}>{detail}</p>
    </div>
  );
}
function Inspector({ children }: { children: React.ReactNode; t: Theme }) {
  return <div style={{ padding: '4px 14px 20px' }}>{children}</div>;
}
function InspectorTitle({ title, subtitle, t }: { title: string; subtitle: string; t: Theme }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
      <div style={{ color: t.textMuted, fontSize: 11, marginTop: 4 }}>{subtitle}</div>
    </div>
  );
}
function Property({ label, value, t }: { label: string; value: string; t: Theme }) {
  return (
    <div style={{ padding: '9px 0', borderBottom: `1px solid ${t.headerBorder}` }}>
      <div
        style={{
          color: t.textMuted,
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 11, marginTop: 4, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}
function Metric({ value, label, color, t }: { value: number; label: string; color: string; t: Theme }) {
  return (
    <div
      style={{
        border: `1px solid ${t.headerBorder}`,
        borderLeft: `3px solid ${color}`,
        background: t.cellBg,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 750 }}>{value}</div>
      <div style={{ color: t.textSecondary, fontSize: 10, marginTop: 3 }}>{label}</div>
    </div>
  );
}
function Status({ status, t }: { status: string; t: Theme }) {
  const color = status === 'certified' ? '#2e9b63' : status === 'deprecated' ? t.textMuted : (status === 'review' || status === 'reviewed') ? '#377cc8' : '#9a6b2f';
  return (
    <span
      style={{
        color,
        background: `${color}15`,
        borderRadius: 999,
        padding: '3px 7px',
        fontSize: 10,
      }}
    >
      {status}
    </span>
  );
}
function Message({ text, t }: { text: string; t: Theme }) {
  return (
    <div
      style={{
        borderLeft: `3px solid ${t.accent}`,
        background: `${t.accent}0d`,
        padding: '9px 10px',
        color: t.textSecondary,
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  );
}
function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '9px 10px',
        fontSize: 9,
        textTransform: 'uppercase',
        letterSpacing: '.05em',
        opacity: 0.65,
      }}
    >
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: '11px 10px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: 11,
      }}
    >
      {children}
    </td>
  );
}
/** A grain written as the model's column names ("team_id, season") names its key columns too. */
function keysFromGrain(grain: string, detail: DbtNodeAuthoringDetail | null): string[] {
  const columns = new Set((detail?.columns ?? []).map((column) => column.name.toLowerCase()));
  const parts = csv(grain);
  return parts.length > 0 && parts.every((part) => columns.has(part.toLowerCase())) ? parts : [];
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
type DiagramPreferences = Partial<{
  viewMode: ModelingViewMode; columnMode: ColumnDisplayMode; layoutMode: DiagramLayoutMode;
  density: DiagramDensity; visibleLimit: number; dimUnrelated: boolean; showEdgeLabels: boolean;
  /** Whether the Modeling AI dock was open. Restored so a round trip through
   *  another page does not silently close the conversation. */
  aiDockOpen: boolean;
}>;
function readDiagramPreferences(): DiagramPreferences {
  try { return JSON.parse(localStorage.getItem('dql-modeling-preferences') ?? '{}') as DiagramPreferences; }
  catch { return {}; }
}
const twoColumns: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};
const toolbarAction = (t: Theme, primary = false): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  flex: '0 0 auto',
  border: `1px solid ${primary ? t.accent : t.headerBorder}`,
  borderRadius: 6,
  background: primary ? 'var(--accent-dim)' : t.appBg,
  color: primary ? t.accent : t.textSecondary,
  padding: '5px 8px',
  fontSize: 10.5,
  fontWeight: 650,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};
const sourcePreview = (t: Theme): React.CSSProperties => ({
  whiteSpace: 'pre-wrap',
  maxHeight: 300,
  overflow: 'auto',
  padding: 12,
  borderRadius: 7,
  background: t.activityBarBg,
  color: t.textSecondary,
  fontSize: 10,
  lineHeight: 1.5,
});
const treeButton = (t: Theme, active: boolean): React.CSSProperties => ({
  width: 'calc(100% - 12px)',
  margin: '2px 6px',
  padding: '8px 7px',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  border: 0,
  borderRadius: 6,
  background: active ? `${t.accent}18` : 'transparent',
  color: active ? t.accent : t.textPrimary,
  fontSize: 11,
  textAlign: 'left',
  cursor: 'pointer',
});
const workspaceNavButton = (t: Theme, active: boolean, nested: boolean): React.CSSProperties => ({
  width: '100%',
  minHeight: 30,
  padding: nested ? '6px 8px 6px 14px' : '7px 8px',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  border: 0,
  borderRadius: 6,
  background: active ? `${t.accent}18` : 'transparent',
  color: active ? t.accent : t.textSecondary,
  fontSize: 10.5,
  fontWeight: active ? 700 : 500,
  textAlign: 'left',
  cursor: 'pointer',
});
const inspectorHeading = (t: Theme): React.CSSProperties => ({
  margin: '18px 0 7px',
  paddingBottom: 7,
  borderBottom: `1px solid ${t.headerBorder}`,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: t.textMuted,
});
const sectionHeading = (t: Theme): React.CSSProperties => ({
  margin: '22px 0 10px',
  paddingBottom: 8,
  borderBottom: `1px solid ${t.headerBorder}`,
  fontSize: 12,
  color: t.textPrimary,
});
const overviewCard = (t: Theme): React.CSSProperties => ({
  border: `1px solid ${t.headerBorder}`,
  background: t.cellBg,
  borderRadius: 9,
  padding: 14,
});
const domainActionCard = (t: Theme): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  minHeight: 58,
  border: `1px solid ${t.headerBorder}`,
  background: t.cellBg,
  borderRadius: 8,
  padding: '9px 10px',
  color: t.textPrimary,
  cursor: 'pointer',
  fontFamily: t.font,
});
const flowRow = (t: Theme): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  overflowX: 'auto',
  border: `1px solid ${t.headerBorder}`,
  borderRadius: 9,
  padding: 12,
  background: t.cellBg,
});
const flowStep = (t: Theme): React.CSSProperties => ({
  minWidth: 118,
  display: 'grid',
  gap: 5,
  padding: 9,
  borderRadius: 7,
  background: t.appBg,
  color: t.textSecondary,
  fontSize: 10,
  lineHeight: 1.35,
});

/**
 * RFC 0007: without dbt, metrics live in DQL's own semantic layer
 * (semantic-layer/metrics). A metric is an aggregation of a column of one
 * table; the table and column come from the synced warehouse catalog.
 */
function NewMetricDrawer({ data, domain, t, onClose, onSaved }: { data: DbtFirstModelingResponse; domain: string | null; t: Theme; onClose: () => void; onSaved: (path: string) => void }) {
  const tables = useMemo(() => Object.values(data.dbtProvenance.nodes)
    .filter((node) => Boolean(node.relation))
    .sort((a, b) => (a.relation ?? '').localeCompare(b.relation ?? '')), [data.dbtProvenance.nodes]);
  const domains = Object.keys(data.modeling.packages ?? {});
  const [nodeId, setNodeId] = useState('');
  const [columns, setColumns] = useState<Array<{ name: string; type?: string }>>([]);
  const [aggregation, setAggregation] = useState('sum');
  const [column, setColumn] = useState('');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [metricDomain, setMetricDomain] = useState(domain ?? domains[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setColumns([]);
    setColumn('');
    if (!nodeId) return;
    let active = true;
    void api.getDbtModelingNode(nodeId)
      .then((detail) => { if (active) setColumns(detail.columns.map((item) => ({ name: item.name, type: item.type }))); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [nodeId]);
  const relation = tables.find((node) => node.uniqueId === nodeId)?.relation ?? '';
  const expression = aggregation === 'count' && !column ? '*' : column;
  const slugName = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const ready = Boolean(relation && slugName && expression && metricDomain.trim());
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createMetric({ name: slugName, label: label.trim() || titleCase(slugName), description: description.trim(), domain: metricDomain.trim(), sql: expression, type: aggregation, table: relation, ifAbsent: true });
      if (!result.ok || !result.path) throw new Error(result.error ?? 'The metric could not be saved.');
      await api.reloadSemanticLayer().catch(() => undefined);
      onSaved(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div onClick={() => !busy && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.34)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div role="dialog" aria-modal="true" aria-label="New metric" onClick={(event) => event.stopPropagation()} style={{ width: 'min(560px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 48px)', overflow: 'auto', background: t.appBg, color: t.textPrimary, border: `1px solid ${t.headerBorder}`, borderRadius: 12, padding: 20, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <b style={{ flex: 1, fontSize: 15 }}>New metric</b>
          <IconButton t={t} title="Close" onClick={onClose}><XCircle size={15} /></IconButton>
        </div>
        <Message text="A metric aggregates one column of one table. It is saved to semantic-layer/metrics as a reviewable file, and Ask and saved queries can use it as soon as it is saved." t={t} />
        <Field label="Table">
          <Select value={nodeId} onChange={setNodeId} values={tables.map((node) => node.uniqueId)} labels={Object.fromEntries(tables.map((node) => [node.uniqueId, node.relation ?? node.name]))} t={t} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 10 }}>
          <Field label="Aggregation">
            <Select value={aggregation} onChange={(value) => setAggregation(value || 'sum')} values={['sum', 'count', 'count_distinct', 'avg', 'min', 'max']} labels={{ sum: 'Sum', count: 'Count rows', count_distinct: 'Count distinct', avg: 'Average', min: 'Minimum', max: 'Maximum' }} t={t} />
          </Field>
          <Field label={aggregation === 'count' ? 'Column (optional)' : 'Column'}>
            <Select value={column} onChange={setColumn} values={columns.map((item) => item.name)} labels={Object.fromEntries(columns.map((item) => [item.name, item.type ? `${item.name} (${item.type})` : item.name]))} t={t} />
          </Field>
        </div>
        <Field label="Metric name"><Input value={name} onChange={setName} t={t} placeholder="total_revenue" /></Field>
        <Field label="Label"><Input value={label} onChange={setLabel} t={t} placeholder="Total revenue" /></Field>
        <Field label="What it measures"><Input value={description} onChange={setDescription} t={t} placeholder="Sum of order amounts, before refunds." /></Field>
        <Field label="Domain"><Input value={metricDomain} onChange={setMetricDomain} t={t} placeholder="sales" /></Field>
        {relation && expression ? <code style={{ fontSize: 11, color: t.textSecondary }}>{`${aggregation === 'count_distinct' ? 'COUNT(DISTINCT ' : `${aggregation.toUpperCase()}(`}${expression}) FROM ${relation}`}</code> : null}
        {error ? <p role="alert" style={{ margin: 0, color: 'var(--status-error)', fontSize: 11.5 }}>{error}</p> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button t={t} onClick={onClose} disabled={busy}>Cancel</Button>
          <Button t={t} primary onClick={() => void save()} disabled={!ready || busy}>{busy ? 'Saving…' : 'Save metric'}</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * dbt-first: a metric belongs to dbt/MetricFlow, so this writes the metric, its measure, any dimensions and its
 * synonyms (`config.meta.synonyms`) into the dbt project's YAML in one patch, through the same preview → apply
 * flow as "Preview dbt source patch". Nothing else is saved, so the preview shows everything that will change.
 */
/**
 * "Add metric" writes git-tracked dbt YAML, so it needs project.write as well as the authoring the page already
 * needs (dataset.author). Production follows main and refuses project.write: read-only there, editable in a draft space.
 */
export function canAddDbtMetric(hostUi: HostUiState): boolean {
  return !hostReadOnly(hostUi, 'domains') && hostAllows(hostUi, 'project.write');
}

export function AddDbtMetricDrawer({ data, domain, snapshotId, t, onClose, onApplied }: { data: DbtFirstModelingResponse; domain: string | null; snapshotId: string; t: Theme; onClose: () => void; onApplied: (message: string) => Promise<void> }) {
  const models = useMemo(() => Object.values(data.dbtProvenance.nodes)
    .filter((node) => node.resourceType === 'model')
    .sort((a, b) => a.name.localeCompare(b.name)), [data.dbtProvenance.nodes]);
  const [nodeId, setNodeId] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [semanticModel, setSemanticModel] = useState('');
  const [aggregation, setAggregation] = useState('average');
  const [column, setColumn] = useState('');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [synonyms, setSynonyms] = useState('');
  const [entity, setEntity] = useState('');
  const [entityColumn, setEntityColumn] = useState('');
  const [timeColumn, setTimeColumn] = useState('');
  const [preview, setPreview] = useState<(DbtMetricPatchPreview & { snapshotId: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setColumns([]);
    setColumn('');
    if (!nodeId) return;
    let active = true;
    void api.getDbtModelingNode(nodeId)
      .then((detail) => { if (active) setColumns(detail.columns.map((item) => item.name)); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [nodeId]);
  const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const metricName = slug(name);
  const csvList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
  const change = (): DbtMetricAuthoringInput => ({
    mode: 'add',
    semanticModel: slug(semanticModel) || slug(models.find((node) => node.uniqueId === nodeId)?.name ?? ''),
    modelUniqueId: nodeId,
    ...(entity.trim() && entityColumn.trim() ? { primaryEntity: { name: slug(entity), column: entityColumn.trim() } } : {}),
    ...(timeColumn.trim() ? { timeDimension: { name: slug(timeColumn), column: timeColumn.trim() } } : {}),
    metric: { name: metricName, label: label.trim() || titleCase(metricName), description: description.trim(), aggregation, column, ...(domain ? { domain } : {}), ...(csvList(synonyms).length ? { synonyms: csvList(synonyms) } : {}) },
    dimensions: csvList(dimensions).map((item) => ({ name: slug(item), column: item, type: 'categorical' as const })),
  });
  const ready = Boolean(nodeId && metricName && column);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const previewPatch = () => run(async () => setPreview(await api.previewDbtMetricPatch(change(), snapshotId)));
  const applyPatch = () => run(async () => {
    if (!preview) return;
    const result = await api.applyDbtMetricPatch(change(), preview.fingerprint, preview.snapshotId);
    let message = `Metric ${metricName} written to ${result.applied.patches.filter((patch) => patch.changed).map((patch) => patch.path).join(', ')}.`;
    if (!result.manifestRefresh.refreshed) message += ` ${result.manifestRefresh.reason ?? ''}`;
    await onApplied(message);
  });
  return (
    <Modal title="Add metric" t={t} onClose={onClose}>
      <Message text="The metric lives in your dbt project's YAML, where dbt/MetricFlow owns it. ZLens previews the exact change first; nothing is written until you apply." t={t} />
      {!preview ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="dbt model"><Select value={nodeId} onChange={(value) => { setNodeId(value); setSemanticModel(''); }} values={models.map((node) => node.uniqueId)} labels={Object.fromEntries(models.map((node) => [node.uniqueId, node.name]))} t={t} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 10 }}>
            <Field label="Aggregation"><Select value={aggregation} onChange={(value) => setAggregation(value || 'average')} values={['sum', 'count', 'count_distinct', 'average', 'min', 'max']} labels={{ sum: 'Sum', count: 'Count', count_distinct: 'Count distinct', average: 'Average', min: 'Minimum', max: 'Maximum' }} t={t} /></Field>
            <Field label="Column"><Select value={column} onChange={setColumn} values={columns} t={t} /></Field>
          </div>
          <Field label="Metric name"><Input value={name} onChange={setName} t={t} placeholder="average_claimed_amount" /></Field>
          <Field label="Label"><Input value={label} onChange={setLabel} t={t} placeholder="Average claimed amount" /></Field>
          <Field label="What it measures"><Input value={description} onChange={setDescription} t={t} placeholder="Mean amount claimed per claim." /></Field>
          <Field label="Dimensions to add (columns, comma separated)"><Input value={dimensions} onChange={setDimensions} t={t} placeholder="product, region" /></Field>
          <Field label="Also known as (synonyms, comma separated; saved in the dbt YAML)"><Input value={synonyms} onChange={setSynonyms} t={t} placeholder="avg claim, mean claim size" /></Field>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: t.textMuted }}>This dbt model has no semantic model yet</summary>
            <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
              <Field label="Semantic model name"><Input value={semanticModel} onChange={setSemanticModel} t={t} placeholder="claims" /></Field>
              <Field label="Primary entity name"><Input value={entity} onChange={setEntity} t={t} placeholder="claim" /></Field>
              <Field label="Primary entity column"><Select value={entityColumn} onChange={setEntityColumn} values={columns} t={t} /></Field>
              <Field label="Time column"><Select value={timeColumn} onChange={setTimeColumn} values={columns} t={t} /></Field>
            </div>
          </details>
          {error ? <p role="alert" style={{ margin: 0, color: 'var(--status-error)', fontSize: 11.5 }}>{error}</p> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}><Button t={t} onClick={onClose}>Cancel</Button><Button primary t={t} disabled={!ready || busy} onClick={() => void previewPatch()}>Preview dbt YAML</Button></div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {preview.patches.map((patch) => (
            <div key={patch.path} style={{ display: 'grid', gap: 6 }}>
              <div style={{ color: t.textSecondary, fontSize: 11 }}>Source: <code>{patch.path}</code></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <SourcePreview title="Current dbt YAML" source={patch.before || '# New dbt YAML file'} t={t} />
                <SourcePreview title="Proposed dbt YAML" source={patch.after} t={t} />
              </div>
            </div>
          ))}
          {preview.warnings.map((warning) => <Message key={warning} text={warning} t={t} />)}
          {error ? <p role="alert" style={{ margin: 0, color: 'var(--status-error)', fontSize: 11.5 }}>{error}</p> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}><Button t={t} onClick={() => setPreview(null)}>Back</Button><Button primary t={t} disabled={busy || !preview.patches.some((patch) => patch.changed)} onClick={() => void applyPatch()}>{busy ? 'Applying…' : 'Apply to dbt'}</Button></div>
        </div>
      )}
    </Modal>
  );
}

function titleCase(value: string): string {
  return value.split('_').filter(Boolean).map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ');
}
