import type { AgentProvider, AgentRouteExecutorResult, AgentRunArtifact, AgentRunEvaluation } from '@zlens/agent';
import {
  READER_TRUST_LABELS,
  readerTileTrust,
  type ReaderTrust,
  type ReaderTrustItem,
  type ReaderTrustState,
  type ReaderTrustTile,
} from '@zlens/core';

/**
 * "Ask about this App" answers from the App the person is looking at.
 *
 * The browser names the App, the page and the page run it is showing
 * (`dashboardRunId`); it never sends rows, sources or trust. The server reads
 * all three from its own, person-scoped evidence of that run (the same record
 * the page's story and signed snapshots read), so the answer reads exactly the
 * results the page shows, with each tile's source and its reader trust label.
 *
 * Trust is never upgraded here: an answer read from a tile that needs review
 * is review-required, and only an answer read entirely from certified tiles is
 * certified. Values reach a model only inside the privacy boundary (HH-5); a
 * person the host keeps needs-review figures from gets the answer withheld by
 * the run's ordinary rule (HH-14), because its trust says what it read.
 */

/** Rows of one tile kept for Ask: what the page shows, bounded. */
export const APP_VIEW_MAX_ROWS = 50;
export const APP_VIEW_MAX_COLUMNS = 30;

export interface AppViewTileSourceV1 {
  kind: 'block' | 'semantic' | 'dataset' | 'ai_pin' | 'draft_analysis' | 'other';
  /** The block (or source) name a reader recognises. */
  name?: string;
  /** Project-relative file of the source, when there is one. */
  path?: string;
}

export interface AppViewTileV1 {
  tileId: string;
  title: string;
  status: string;
  source: AppViewTileSourceV1;
  /** The reader trust label the tile shows on the page; null for a tile that carries no data. */
  trust: ReaderTrust | null;
  /** Filters this tile applied, and the ones it could not, by name. */
  appliedFilters?: string[];
  skippedFilters?: string[];
  /** The rows the tile shows, in display order; absent when it has none or its figures are withheld. */
  result?: { columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number; truncated?: boolean };
  /** The host keeps these figures from this person (HH-14): the tile is named, never its values. */
  figuresWithheld?: boolean;
}

export interface AppViewContextV1 {
  version: 1;
  appId: string;
  appName: string;
  dashboardId: string;
  dashboardTitle: string;
  /** The page run the answer reads. */
  runId: string;
  /** Filters with a value, as applied to that run. */
  filters: Array<{ label: string; value: string }>;
  tiles: AppViewTileV1[];
  /** The tables the page's tiles read; null when ZLens cannot list them all (the model boundary, HH-5). */
  relations: string[] | null;
}

type RunTile = ReaderTrustTile & {
  tileId: string;
  title?: unknown;
  blockId?: unknown;
  blockPath?: unknown;
  citation?: { kind?: unknown; name?: unknown; path?: unknown } | null;
  artifact?: (ReaderTrustTile['artifact'] & { name?: unknown; sourcePath?: unknown }) | null;
  result?: { columns?: unknown[]; rows?: unknown[]; rowCount?: unknown; truncated?: unknown } | null;
  filters?: { applied?: unknown[]; skipped?: unknown[] } | null;
  figuresWithheld?: unknown;
};

type LayoutItem = ReaderTrustItem & { i: string; title?: string; block?: unknown; semantic?: unknown; query?: unknown; sourceId?: unknown; text?: unknown };

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

function columnName(column: unknown): string {
  if (typeof column === 'string') return column;
  if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') return (column as { name: string }).name;
  return String(column);
}

function filterNames(entries: unknown[] | undefined): string[] {
  return (entries ?? []).flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const name = str(record.label) ?? str(record.filterId) ?? str(record.id) ?? str(record.filter) ?? str(record.field);
    return name ? [name] : [];
  }).slice(0, 20);
}

function sourceOf(item: LayoutItem | undefined, tile: RunTile | undefined): AppViewTileSourceV1 {
  const citation = tile?.citation ?? undefined;
  const artifact = tile?.artifact ?? undefined;
  const name = str(citation?.name) ?? str(tile?.blockId) ?? str(artifact?.name);
  const path = str(citation?.path) ?? str(tile?.blockPath) ?? str(artifact?.sourcePath);
  const kind: AppViewTileSourceV1['kind'] = tile?.aiPin || item?.aiPin ? 'ai_pin'
    : tile?.dataset || item?.query ? 'dataset'
      : tile?.tileType === 'semantic' || item?.semantic ? 'semantic'
        : item?.draftAnalysis || artifact?.sourceKind === 'draft_analysis' ? 'draft_analysis'
          : item?.block || str(tile?.blockId) ? 'block' : 'other';
  const blockRef = item?.block && typeof item.block === 'object' ? item.block as { blockId?: unknown; ref?: unknown } : undefined;
  return {
    kind,
    ...(name ?? str(blockRef?.blockId) ? { name: name ?? str(blockRef?.blockId) } : {}),
    ...(path ?? str(blockRef?.ref) ? { path: path ?? str(blockRef?.ref) } : {}),
  };
}

/**
 * The page's tiles as Ask may read them, from one settled run: each data
 * tile's source, its reader trust label (the same one the page shows) and the
 * rows it shows. Text tiles carry no data and are left out.
 */
export function buildAppViewTiles(items: ReadonlyArray<LayoutItem>, runTiles: ReadonlyArray<RunTile>): AppViewTileV1[] {
  return items.flatMap((item) => {
    if (item.text) return [];
    const tile = runTiles.find((candidate) => candidate.tileId === item.i);
    if (!tile || tile.tileType === 'text') return [];
    const trust = readerTileTrust(item, tile);
    if (!trust) return [];
    const withheld = tile.figuresWithheld === true;
    const rawRows = Array.isArray(tile.result?.rows) ? tile.result!.rows : [];
    const columns = (Array.isArray(tile.result?.columns) && tile.result!.columns.length
      ? tile.result!.columns.map(columnName)
      : Object.keys((rawRows[0] as Record<string, unknown> | undefined) ?? {}))
      .filter((column) => !column.startsWith('__'))
      .slice(0, APP_VIEW_MAX_COLUMNS);
    const rows = rawRows.slice(0, APP_VIEW_MAX_ROWS).flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const record = row as Record<string, unknown>;
      return [Object.fromEntries(columns.map((column) => [column, normalizeCell(record[column])]))];
    });
    const rowCount = typeof tile.result?.rowCount === 'number' ? tile.result.rowCount : rawRows.length;
    return [{
      tileId: item.i,
      title: str(item.title) ?? str(tile.title) ?? item.i,
      status: tile.status,
      source: sourceOf(item, tile),
      trust,
      ...(tile.filters?.applied?.length ? { appliedFilters: filterNames(tile.filters.applied) } : {}),
      ...(tile.filters?.skipped?.length ? { skippedFilters: filterNames(tile.filters.skipped) } : {}),
      ...(withheld ? { figuresWithheld: true } : {}),
      ...(!withheld && tile.status === 'ok' && rows.length > 0
        ? { result: { columns, rows, rowCount, ...(tile.result?.truncated === true || rowCount > rows.length ? { truncated: true } : {}) } }
        : {}),
    }];
  });
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 200);
  if (typeof value === 'string') return value.slice(0, 200);
  return value;
}

/**
 * A question about what the App shows ("ranked first in this App", "the
 * table on this page", "what is shown here"). Other questions asked from an
 * App go through Ask as usual, within the App's scope. Causal, predictive and
 * prescriptive questions need evidence a page's results do not hold.
 */
export function asksAboutAppView(question: string, options: { focusedTile?: boolean } = {}): boolean {
  const text = question.trim();
  if (!text) return false;
  if (/\b(?:why|cause[sd]?|drivers?|root\s+cause|forecast|predict(?:ion)?|recommend(?:ation)?|what\s+if)\b/i.test(text)) return false;
  if (/\b(?:this|current)\s+(?:app|page|dashboard|view|screen|tile|chart|table|story|report|result|ranking|list)s?\b/i.test(text)) return true;
  if (/\bthe\s+(?:app|page|dashboard|screen|view)\b/i.test(text)) return true;
  if (/\b(?:shown|displayed|visible|on\s+(?:the\s+)?(?:screen|page|dashboard))\b/i.test(text)) return true;
  if (/\b(?:in|on|from)\s+here\b/i.test(text)) return true;
  // Asked from one tile ("Ask AI about this"): "explain this", "what does this show".
  return Boolean(options.focusedTile) && /\b(?:this|these|it)\b/i.test(text);
}

const TRUST_ORDER: ReaderTrustState[] = ['blocked', 'review', 'governed', 'certified'];

/** The weakest trust among the tiles an answer read: one review tile makes the answer review-required. */
export function appViewAnswerTrust(tiles: ReadonlyArray<Pick<AppViewTileV1, 'trust'>>): ReaderTrustState {
  let weakest: ReaderTrustState = 'certified';
  for (const tile of tiles) {
    const state = tile.trust?.state ?? 'review';
    if (TRUST_ORDER.indexOf(state) < TRUST_ORDER.indexOf(weakest)) weakest = state;
  }
  return tiles.length === 0 ? 'review' : weakest;
}

/** One line naming a tile's source and the trust label it shows, as the answer cites it. */
export function appViewSourceLine(tile: AppViewTileV1): string {
  const label = tile.trust?.label ?? READER_TRUST_LABELS.review;
  // "Saved query" is the reader's word for a block (#165).
  const kind = tile.source.kind === 'block' || tile.source.kind === 'draft_analysis' ? 'saved query'
    : tile.source.kind === 'semantic' ? 'semantic query'
      : tile.source.kind === 'dataset' ? 'Dataset'
        : tile.source.kind === 'ai_pin' ? 'AI answer' : 'source';
  const source = tile.source.name
    ? `${kind} ${tile.source.name}${tile.source.path ? ` (${tile.source.path})` : ''}`
    : tile.source.path ? `${kind} ${tile.source.path}` : 'an unnamed source';
  return `“${tile.title}” reads ${source} — ${label}${tile.trust?.detail ? `: ${tile.trust.detail}` : '.'}`;
}

export type AppViewAnswerMode = 'provider' | 'deterministic_page_read' | 'no_results';

export interface AppViewAnswer {
  answer: string;
  mode: AppViewAnswerMode;
  /** The tiles the answer read. */
  tiles: AppViewTileV1[];
}

export interface AppViewProvider {
  provider: AgentProvider;
  /** True only when this App's values may reach the model (the privacy boundary, HH-5). */
  valuesMayReachProvider: boolean;
}

function describeRow(row: Record<string, unknown>, columns: string[]): string {
  return columns.slice(0, 8).map((column) => `${column} ${row[column] === null || row[column] === undefined ? 'unavailable' : String(row[column])}`).join(', ');
}

/** What the page shows, read without a model: each data tile's first rows, in display order. */
export function appViewPageRead(context: AppViewContextV1, why: string): AppViewAnswer {
  const withRows = context.tiles.filter((tile) => tile.result?.rows.length);
  if (withRows.length === 0) {
    return {
      mode: 'no_results',
      tiles: context.tiles,
      answer: `${why} No tile on “${context.dashboardTitle}” shows rows Ask may read in this run.`,
    };
  }
  const lines = withRows.slice(0, 4).map((tile) => {
    const result = tile.result!;
    const first = result.rows.slice(0, 3).map((row, index) => `${index + 1}. ${describeRow(row, result.columns)}`).join('; ');
    return `“${tile.title}” shows ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in this order: ${first}${result.rows.length > 3 ? '; …' : ''}.`;
  });
  return { mode: 'deterministic_page_read', tiles: withRows, answer: `${why} ${lines.join(' ')}` };
}

const SYSTEM_PROMPT = [
  'You answer one question about an App page a person is looking at, using only APP_VIEW_CONTEXT.',
  'APP_VIEW_CONTEXT lists the page\'s tiles: each tile\'s title, its source, its trust label, the filters it applied, and the rows it currently shows in display order.',
  'Use nothing else: do not retrieve data, write SQL, use outside knowledge, infer causes, forecast or recommend.',
  'For "first", "top" or "ranked" questions use a rank column when the tile has one, otherwise the order the rows are shown in.',
  'Keep values exactly as shown; an unavailable value stays unavailable.',
  'Reply with one JSON object only.',
  'When the shown results establish the answer: {"answerable": true, "answer": "<one or two plain sentences>", "tileIds": ["<id of each tile the answer reads>"]}.',
  'When they do not: {"answerable": false, "reason": "<what the page does not show>"}.',
  'Do not describe certification or trust in the answer; ZLens adds each tile\'s source and its trust label.',
].join(' ');

/** The model's JSON reply, tolerant of a thinking preamble or a code fence. */
export function parseAppViewReply(reply: string): { answerable: true; answer: string; tileIds: string[] } | { answerable: false; reason: string } | null {
  const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const candidates: string[] = [];
  for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) { candidates.push(cleaned.slice(start, index + 1)); break; }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed.answerable === true && typeof parsed.answer === 'string' && parsed.answer.trim()) {
        const tileIds = Array.isArray(parsed.tileIds) ? parsed.tileIds.filter((id): id is string => typeof id === 'string') : [];
        return { answerable: true, answer: parsed.answer.trim(), tileIds };
      }
      if (parsed.answerable === false) return { answerable: false, reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '' };
    } catch {
      // Not this one.
    }
  }
  return null;
}

/**
 * Answer a question about the App page from its current results. Returns
 * null when the page's results cannot establish the answer, so Ask answers it
 * the ordinary way (still scoped to the App).
 */
export async function answerFromAppView(input: {
  context: AppViewContextV1;
  question: string;
  resolveProvider: () => Promise<AppViewProvider | null>;
  signal?: AbortSignal;
}): Promise<AppViewAnswer | null> {
  const { context } = input;
  if (!context.tiles.some((tile) => tile.result?.rows.length)) return appViewPageRead(context, 'This page has not shown results Ask can read yet; run the page, then ask again.');
  let resolved: AppViewProvider | null = null;
  try { resolved = await input.resolveProvider(); } catch { resolved = null; }
  if (!resolved) return appViewPageRead(context, 'Read directly from this page (no AI model is configured, so no model wrote this).');
  if (!resolved.valuesMayReachProvider) {
    return appViewPageRead(context, 'Read directly from this page (this App\'s values stay out of the configured AI model, which is outside the privacy boundary, so no model wrote this).');
  }
  const promptContext = {
    app: context.appName,
    page: context.dashboardTitle,
    filters: context.filters,
    tiles: context.tiles.map((tile) => ({
      tileId: tile.tileId,
      title: tile.title,
      source: tile.source,
      trust: tile.trust?.label ?? null,
      status: tile.status,
      ...(tile.appliedFilters ? { appliedFilters: tile.appliedFilters } : {}),
      ...(tile.skippedFilters ? { filtersNotApplied: tile.skippedFilters } : {}),
      ...(tile.figuresWithheld ? { values: 'withheld from this person' } : {}),
      ...(tile.result ? { columns: tile.result.columns, rowCount: tile.result.rowCount, rowsShown: tile.result.rows } : {}),
    })),
  };
  let reply: string;
  try {
    reply = await resolved.provider.generate([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Question: ${input.question.trim()}\n\nAPP_VIEW_CONTEXT:\n${JSON.stringify(promptContext)}` },
    ], { maxTokens: 700, temperature: 0, ...(input.signal ? { signal: input.signal } : {}) });
  } catch {
    if (input.signal?.aborted) return null;
    return appViewPageRead(context, 'Read directly from this page (the AI model could not be reached, so no model wrote this).');
  }
  const parsed = parseAppViewReply(reply);
  if (!parsed) return appViewPageRead(context, 'Read directly from this page (the AI model\'s reply could not be used, so no model wrote this).');
  if (!parsed.answerable) return null;
  const named = context.tiles.filter((tile) => parsed.tileIds.includes(tile.tileId) && tile.result);
  // A reply that names no tile it read is held to every tile it could have read.
  const tiles = named.length > 0 ? named : context.tiles.filter((tile) => tile.result);
  return { mode: 'provider', answer: parsed.answer, tiles };
}

const READER_TO_RUN_TRUST = { certified: 'certified', governed: 'governed', review: 'review_required', blocked: 'blocked' } as const;

/** The Ask result for an answer read from the App page: its trust is the weakest tile it read, and it cites each one. */
export function appViewExecutorResult(runId: string, context: AppViewContextV1, answered: AppViewAnswer, startedAt: number): AgentRouteExecutorResult {
  const readerTrust = answered.mode === 'no_results' ? null : appViewAnswerTrust(answered.tiles);
  const trustState = readerTrust ? READER_TO_RUN_TRUST[readerTrust] : 'not_applicable';
  const sources = answered.tiles.map(appViewSourceLine);
  const text = answered.mode === 'no_results'
    ? answered.answer
    : `${answered.answer}\n\nSource${sources.length === 1 ? '' : 's'} on “${context.dashboardTitle}”: ${sources.join(' ')}`;
  const telemetry: AgentRouteExecutorResult['telemetry'] = {
    version: 1,
    stageDurationsMs: { total: Date.now() - startedAt },
    providerRoundTrips: answered.mode === 'provider' ? 1 : 0,
    toolCalls: 0,
    sqlExecutions: 0,
    repairs: 0,
    egressReceipts: 0,
  };
  const appView = {
    appId: context.appId,
    appName: context.appName,
    dashboardId: context.dashboardId,
    dashboardTitle: context.dashboardTitle,
    pageRunId: context.runId,
    filters: context.filters,
    mode: answered.mode,
    tiles: answered.tiles.map((tile) => ({
      tileId: tile.tileId,
      title: tile.title,
      source: tile.source,
      trust: tile.trust ? { state: tile.trust.state, label: tile.trust.label } : null,
    })),
  };
  if (answered.mode === 'no_results') {
    return {
      summary: text, answer: text, answerKind: 'conversational', status: 'completed', trustState: 'not_applicable', stopReason: 'conversational_reply', resolvedRoute: 'conversation',
      artifacts: [], evaluations: [], nextActions: [], telemetry,
    };
  }
  const first = answered.tiles[0];
  const result = answered.tiles.length === 1 && first?.result ? first.result : undefined;
  const certified = trustState === 'certified';
  const evaluations: AgentRunEvaluation[] = [
    { id: 'app-view-read', label: 'Read from this App', passed: true, severity: 'info', message: `Answered from the results “${context.dashboardTitle}” shows in ${context.appName} (page run ${context.runId}); no new query ran.${context.filters.length ? ` Filters: ${context.filters.map((filter) => `${filter.label} is ${filter.value}`).join('; ')}.` : ''}` },
    ...answered.tiles.map((tile, index) => ({
      id: `app-view-source-${index + 1}`,
      label: 'App tile source',
      passed: tile.trust?.state === 'certified',
      severity: tile.trust?.state === 'certified' ? 'info' as const : 'warning' as const,
      message: appViewSourceLine(tile),
    })),
    ...answered.tiles.filter((tile) => tile.result?.truncated).map((tile, index) => ({
      id: `app-view-truncated-${index + 1}`,
      label: 'Rows read',
      passed: true,
      severity: 'warning' as const,
      message: `“${tile.title}” has ${tile.result!.rowCount} rows; Ask read the first ${tile.result!.rows.length} as shown.`,
    })),
  ];
  const certifiedBlock = certified && answered.tiles.length === 1 && first?.source.kind === 'block' ? first.source.name : undefined;
  const shownResult = result ? { columns: result.columns, rows: result.rows, rowCount: result.rowCount, trustState, answerTier: 'app_view', ...(result.truncated ? { truncated: true } : {}) } : undefined;
  const artifact: AgentRunArtifact = {
    id: `${runId}:answer`,
    kind: 'answer',
    title: certified ? 'Answer from this App (certified tiles)' : trustState === 'governed' ? 'Answer from this App (governed tiles)' : 'Answer from this App (needs review)',
    trustState,
    payload: {
      kind: certified ? 'certified' : 'uncertified',
      route: { tier: 'app_view', label: 'This App’s current results' },
      sourceTier: certified ? 'certified_artifact' : 'app_view',
      certification: certified ? 'certified' : trustState === 'governed' ? 'governed' : 'review_required',
      reviewStatus: certified ? 'certified' : trustState === 'governed' ? 'governed' : 'review_required',
      text,
      answer: text,
      sources: answered.tiles.map((tile) => tile.source.path ?? tile.source.name ?? tile.tileId),
      appView,
      ...(shownResult ? { result: shownResult } : {}),
      ...(certifiedBlock ? { certifiedBlockRef: certifiedBlock } : {}),
    },
  };
  return {
    summary: text,
    answer: text,
    status: 'completed',
    trustState,
    stopReason: certified ? 'certified_answer_found' : trustState === 'governed' ? 'governed_semantic_answer' : 'generated_review_required',
    resolvedRoute: certified ? 'certified_answer' : trustState === 'governed' ? 'semantic_answer' : 'generated_answer',
    answerTier: 'app_view',
    ...(shownResult ? { result: shownResult } : {}),
    artifacts: [artifact],
    evaluations,
    nextActions: [
      { id: 'research-gap', label: 'Research deeper', route: 'research' },
    ],
    telemetry,
  };
}
