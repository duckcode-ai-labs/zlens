import { requestJson } from './client';

/**
 * History in the ZLens app for Snowflake (V15): every save is a version, with the Snowflake user who made it.
 * The server's API is apps/cli/src/history/history-routes.ts.
 */
export type HistoryItemKind = 'saved_query' | 'app' | 'notebook' | 'semantic' | 'model';
export type HistoryChangeKind = 'started' | 'created' | 'drafted' | 'edited' | 'renamed' | 'certified' | 'removed' | 'restored';

export interface HistoryAuthor {
  name: string;
  kind: 'person' | 'ai' | 'zlens';
  askedBy?: string;
}

export interface HistoryFeedItem {
  key: string;
  current: string;
  name: string;
  kind: HistoryItemKind;
  version: number;
  certified: boolean;
  removed: boolean;
  isCurrentVersion: boolean;
}

export type HistoryAction = 'start' | 'found' | 'upgrade' | 'setup' | 'save' | 'certify' | 'clear-drafts' | 'delete' | 'ask' | 'restore';

export interface HistoryFeedEntry {
  id: string;
  commit: string;
  at: string;
  by: HistoryAuthor;
  action: HistoryAction;
  change: HistoryChangeKind;
  kind: HistoryItemKind;
  items: HistoryFeedItem[];
  count: number;
  version?: number;
  certified: boolean;
  detail?: string;
  canCompare: boolean;
  canRestore: boolean;
}

export interface HistoryFeed {
  entries: HistoryFeedEntry[];
  total: number;
  people: string[];
}

export interface HistoryFeedFilters {
  kind?: 'all' | HistoryItemKind;
  by?: string;
  days?: number;
  certifiedOnly?: boolean;
  q?: string;
  limit?: number;
}

export interface HistoryVersionRow {
  version: number;
  commit: string;
  path?: string;
  at: string;
  by: HistoryAuthor;
  change: HistoryChangeKind;
  detail?: string;
  state: 'certified' | 'draft' | 'saved' | 'removed';
  current: boolean;
  canRestore: boolean;
}

export interface HistoryItem {
  item: { key: string; kind: HistoryItemKind; name: string; removed: boolean; currentVersion: number };
  versions: HistoryVersionRow[];
  banner: { draft: number; certified: number } | null;
}

export interface HistoryDiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface HistoryVersionCard {
  version: number;
  commit: string;
  path?: string;
  at: string;
  by: HistoryAuthor;
  state: HistoryVersionRow['state'];
  certifiedBy?: string;
  oldReport?: string;
}

export interface HistoryFieldChange {
  field: 'name' | 'description' | 'owner' | 'domain' | 'tags' | 'chart' | 'status';
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface HistoryCompare {
  item: HistoryItem['item'];
  from: HistoryVersionCard;
  to: HistoryVersionCard;
  sql?: { lines: HistoryDiffLine[]; changed: number };
  fields?: HistoryFieldChange[];
  files: Array<{ path: string; status: 'added' | 'removed' | 'changed' | 'same'; lines: HistoryDiffLine[]; changed: number }>;
}

export interface HistoryRunCompare {
  from: { columns: string[]; rowCount: number; error?: string };
  to: { columns: string[]; rowCount: number; error?: string };
  keyColumns: string[];
  valueColumns: string[];
  rows: Array<{ key: unknown[]; from: unknown[] | null; to: unknown[] | null; state: 'same' | 'changed' | 'new' | 'removed' }>;
  summary: { same: number; changed: number; new: number; removed: number };
}

export interface HistoryRestoreResult {
  ok: true;
  item: string;
  restored: number;
  version: number;
  message: string;
  paths: string[];
  status: 'draft';
}

export interface HistoryStatus {
  enabled: true;
  versions: number;
  items: number;
  sizeBytes: number;
  warnAtBytes: number;
  sizeWarning: boolean;
  sqlLog: { state: 'off' | 'waiting' | 'written' | 'skipped' | 'nothing'; table: string | null; pending: number; lastWrittenAt?: string };
}

const q = (value: string) => encodeURIComponent(value);

export const historyApi = {
  changes(filters: HistoryFeedFilters = {}): Promise<HistoryFeed> {
    const params = new URLSearchParams();
    if (filters.kind && filters.kind !== 'all') params.set('kind', filters.kind);
    if (filters.by && filters.by !== 'anyone') params.set('by', filters.by);
    if (filters.days) params.set('days', String(filters.days));
    if (filters.certifiedOnly) params.set('certified', '1');
    if (filters.q?.trim()) params.set('q', filters.q.trim());
    if (filters.limit) params.set('limit', String(filters.limit));
    const query = params.toString();
    return requestJson<HistoryFeed>(`/api/history/changes${query ? `?${query}` : ''}`);
  },
  item(path: string): Promise<HistoryItem> {
    return requestJson<HistoryItem>(`/api/history/item?path=${q(path)}`);
  },
  version(path: string, version: number): Promise<{ version: number; files: Array<{ path: string; content: string }> }> {
    return requestJson(`/api/history/version?path=${q(path)}&version=${version}`);
  },
  compare(path: string, from: number, to: number): Promise<HistoryCompare> {
    return requestJson<HistoryCompare>(`/api/history/compare?path=${q(path)}&from=${from}&to=${to}`);
  },
  runBoth(path: string, from: number, to: number): Promise<HistoryRunCompare> {
    return requestJson<HistoryRunCompare>('/api/history/compare/run', { method: 'POST', body: JSON.stringify({ path, from, to }) });
  },
  restore(path: string, version: number): Promise<HistoryRestoreResult> {
    return requestJson<HistoryRestoreResult>('/api/history/restore', { method: 'POST', body: JSON.stringify({ path, version }) });
  },
  status(): Promise<HistoryStatus> {
    return requestJson<HistoryStatus>('/api/history/status');
  },
};
