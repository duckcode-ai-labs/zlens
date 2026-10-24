import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  GitBranch, GitCommit, RefreshCw, ArrowUp, ArrowDown,
  FileEdit, FilePlus, FileX, FileQuestion, ArrowRightLeft, FileCheck,
} from 'lucide-react';
import { PanelFrame, PanelToolbar, PanelEmpty } from '@zlens/ui';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { DiffReport } from '@zlens/core/format';
import { GitDiffView } from './GitDiffView';

type Status = Awaited<ReturnType<typeof api.fetchGitStatus>>;
type LogResult = Awaited<ReturnType<typeof api.fetchGitLog>>;
type Change = Status['changes'][number];

type Tab = 'status' | 'log' | 'diff';

const STATUS_POLL_MS = 2000;

// Group definitions for the Status view. Each change is bucketed by its
// first non-space char in the porcelain status code.
type Group = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

const GROUP_META: Record<Group, { label: string; color: (t: Theme) => string; Icon: React.ComponentType<any> }> = {
  modified:  { label: 'Modified',  color: (t) => t.warning, Icon: FileEdit },
  added:     { label: 'Added',     color: (t) => t.success, Icon: FilePlus },
  deleted:   { label: 'Deleted',   color: (t) => t.error,   Icon: FileX },
  renamed:   { label: 'Renamed',   color: (t) => t.accent,  Icon: ArrowRightLeft },
  untracked: { label: 'Untracked', color: (t) => t.textMuted, Icon: FileQuestion },
};

const GROUP_ORDER: Group[] = ['modified', 'added', 'renamed', 'deleted', 'untracked'];

function groupOf(code: string): Group {
  const c = code.trim();
  if (c === '??') return 'untracked';
  if (c.startsWith('R')) return 'renamed';
  if (c.includes('D')) return 'deleted';
  if (c.includes('A')) return 'added';
  return 'modified';
}

export function GitPanel() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [tab, setTab] = useState<Tab>('status');
  const [status, setStatus] = useState<Status | null>(null);
  const [log, setLog] = useState<LogResult | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [diffReport, setDiffReport] = useState<DiffReport | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setRefreshing(true);
    try {
      if (tab === 'status') {
        setStatus(await api.fetchGitStatus());
      } else if (tab === 'log') {
        setLog(await api.fetchGitLog(30));
      } else {
        const result = await api.fetchGitDiff(diffPath ?? undefined);
        setDiff(result.diff);
        setDiffReport(result.diffReport);
      }
      setLoadError(null);
    } catch (error) {
      // A server or network failure is not "Not a git repository".
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      window.setTimeout(() => setRefreshing(false), 400);
    }
  }, [tab, diffPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Quiet poll on the status tab so the file list reflects terminal-side
  // edits within 2s without the user clicking refresh.
  useEffect(() => {
    if (tab !== 'status') return;
    const id = window.setInterval(() => {
      void api.fetchGitStatus().then((next) => {
        setStatus((prev) => (statusEqual(prev, next) ? prev : next));
        setLoadError(null);
      }).catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    }, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [tab]);

  const activeFilePath = state.activeFile?.path ?? null;

  const actions = (
    <button
      onClick={() => void refresh()}
      title="Refresh"
      aria-label="Refresh"
      style={{
        background: 'transparent', border: `1px solid ${t.btnBorder}`, cursor: 'pointer',
        color: t.textMuted, padding: '3px 6px', borderRadius: 4, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <RefreshCw
        size={12}
        strokeWidth={1.75}
        style={{ animation: refreshing ? 'dql-spin 0.6s linear' : undefined }}
      />
      <style>{`@keyframes dql-spin { to { transform: rotate(360deg); } }`}</style>
    </button>
  );

  const toolbar = (
    <PanelToolbar>
      <TabButton t={t} active={tab === 'status'} onClick={() => setTab('status')}>Status</TabButton>
      <TabButton t={t} active={tab === 'log'} onClick={() => setTab('log')}>History</TabButton>
      <TabButton t={t} active={tab === 'diff'} onClick={() => setTab('diff')}>Diff</TabButton>
    </PanelToolbar>
  );

  return (
    <PanelFrame title="Git" actions={actions} toolbar={toolbar} bodyPadding={12}>
      {loading && !status && !log && !loadError && <PanelEmpty title="Loading…" />}

      {loadError && (
        <LoadErrorCard t={t} message={loadError} onRetry={() => void refresh()} />
      )}

      {tab === 'status' && status && (
        <StatusView status={status} t={t} onInitialized={() => void refresh()} />
      )}

      {tab === 'log' && log && (
        <LogView log={log} t={t} onInitialized={() => void refresh()} />
      )}

      {tab === 'diff' && (
        <GitDiffView
          diff={diff}
          diffReport={diffReport}
          activeFilePath={activeFilePath}
          diffPath={diffPath}
          onScopeToFile={() => setDiffPath(activeFilePath)}
          onClearScope={() => setDiffPath(null)}
          t={t}
        />
      )}
    </PanelFrame>
  );
}

function statusEqual(a: Status | null, b: Status): boolean {
  if (!a) return false;
  if (a.inRepo !== b.inRepo || a.branch !== b.branch || a.ahead !== b.ahead || a.behind !== b.behind) return false;
  if (a.changes.length !== b.changes.length) return false;
  const ak = a.changes.map((c) => `${c.path}\0${c.status}`).sort();
  const bk = b.changes.map((c) => `${c.path}\0${c.status}`).sort();
  for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
  return true;
}

// ---------- Status View ----------

function StatusView({ status, t, onInitialized }: { status: Status; t: Theme; onInitialized: () => void }) {
  const grouped = useMemo(() => {
    const map: Record<Group, Change[]> = {
      modified: [], added: [], deleted: [], renamed: [], untracked: [],
    };
    for (const c of status.changes) map[groupOf(c.status)].push(c);
    for (const g of GROUP_ORDER) map[g].sort((a, b) => a.path.localeCompare(b.path));
    return map;
  }, [status.changes]);

  if (!status.inRepo) {
    return <NotARepoCard t={t} onInitialized={onInitialized} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <BranchCard status={status} t={t} />

      {status.changes.length === 0 ? (
        <CleanCard t={t} />
      ) : (
        GROUP_ORDER.map((g) => {
          const items = grouped[g];
          if (items.length === 0) return null;
          return <ChangeGroup key={g} group={g} items={items} t={t} />;
        })
      )}
    </div>
  );
}

function BranchCard({ status, t }: { status: Status; t: Theme }) {
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderLeft: `3px solid ${t.accent}`,
        borderRadius: 7,
      }}
    >
      <GitBranch size={16} strokeWidth={1.75} color={t.accent} />
      <span style={{ fontSize: 13, fontWeight: 600, color: t.textPrimary, fontFamily: t.fontMono }}>
        {status.branch ?? 'detached'}
      </span>
      <div style={{ flex: 1 }} />
      {ahead > 0 && (
        <span title={`${ahead} commit(s) ahead of upstream`} style={badge(t.success, t)}>
          <ArrowUp size={11} strokeWidth={2} /> {ahead}
        </span>
      )}
      {behind > 0 && (
        <span title={`${behind} commit(s) behind upstream`} style={badge(t.warning, t)}>
          <ArrowDown size={11} strokeWidth={2} /> {behind}
        </span>
      )}
      {ahead === 0 && behind === 0 && (
        <span style={{ ...badge(t.textMuted, t), opacity: 0.7 }}>up to date</span>
      )}
    </div>
  );
}

function CleanCard({ t }: { t: Theme }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '14px 12px',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 7,
        color: t.textMuted, fontSize: 12, fontFamily: t.font,
      }}
    >
      <FileCheck size={14} strokeWidth={1.75} color={t.success} />
      Working tree clean
    </div>
  );
}

function NotARepoCard({ t, onInitialized }: { t: Theme; onInitialized: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialize = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.gitInit();
      if (result.ok) onInitialized();
      else setError(result.error ?? 'Git could not be initialized.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      style={{
        padding: '14px 12px',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 7,
        color: t.textMuted, fontSize: 12, fontFamily: t.font,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ color: t.textPrimary, fontWeight: 600 }}>Not a Git repository yet</div>
      <div style={{ lineHeight: 1.45 }}>
        Initialize Git to track changes to saved queries, notebooks, and apps. Nothing is sent anywhere until you add a remote.
      </div>
      <button
        type="button"
        onClick={() => void initialize()}
        disabled={busy}
        style={{
          alignSelf: 'flex-start',
          background: t.accent, color: '#fff', border: `1px solid ${t.accent}`,
          padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600,
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1, fontFamily: t.font,
        }}
      >
        {busy ? 'Initializing…' : 'Initialize Git for this project'}
      </button>
      {error && <div role="alert" style={{ color: t.error, lineHeight: 1.45 }}>{error}</div>}
    </div>
  );
}

function LoadErrorCard({ t, message, onRetry }: { t: Theme; message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        padding: '10px 12px', marginBottom: 12,
        background: t.cellBg,
        border: `1px solid ${t.error}55`,
        borderLeft: `3px solid ${t.error}`,
        borderRadius: 7,
        fontSize: 12, fontFamily: t.font,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ color: t.textPrimary, fontWeight: 600 }}>Git status could not be loaded</div>
      <div style={{ color: t.textMuted, lineHeight: 1.45, wordBreak: 'break-word' }}>{message}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          alignSelf: 'flex-start', background: 'transparent', color: t.textPrimary,
          border: `1px solid ${t.btnBorder}`, padding: '3px 9px', borderRadius: 4,
          fontSize: 11, cursor: 'pointer', fontFamily: t.font,
        }}
      >
        Retry
      </button>
    </div>
  );
}

function ChangeGroup({ group, items, t }: { group: Group; items: Change[]; t: Theme }) {
  const meta = GROUP_META[group];
  const color = meta.color(t);
  const Icon = meta.Icon;
  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: t.textMuted, fontFamily: t.font,
        }}
      >
        <Icon size={11} strokeWidth={1.75} />
        <span>{meta.label}</span>
        <span style={{
          marginLeft: 2, padding: '0 5px', borderRadius: 8,
          background: `${color}1a`, color, fontWeight: 700,
          fontSize: 9, letterSpacing: '0.04em',
        }}>
          {items.length}
        </span>
      </div>
      <div
        style={{
          display: 'flex', flexDirection: 'column',
          background: t.cellBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 7,
          overflow: 'hidden',
        }}
      >
        {items.map((c, i) => (
          <ChangeRow key={c.path} change={c} t={t} color={color} divider={i < items.length - 1} />
        ))}
      </div>
    </div>
  );
}

function ChangeRow({ change, t, color, divider }: { change: Change; t: Theme; color: string; divider: boolean }) {
  const code = change.status.trim() || '??';
  return (
    <div
      title={change.path}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        borderBottom: divider ? `1px solid ${t.cellBorder}` : 'none',
        fontFamily: t.fontMono, fontSize: 11,
      }}
    >
      <span
        style={{
          width: 22, textAlign: 'center', flexShrink: 0,
          color, fontWeight: 700, fontSize: 10, letterSpacing: '0.02em',
        }}
      >
        {code}
      </span>
      <span style={{
        color: t.textPrimary, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
      }}>
        {change.path}
      </span>
    </div>
  );
}

// ---------- Log View ----------

function LogView({ log, t, onInitialized }: { log: LogResult; t: Theme; onInitialized: () => void }) {
  if (!log.inRepo) return <NotARepoCard t={t} onInitialized={onInitialized} />;
  if (log.commits.length === 0) {
    return (
      <div style={{
        padding: '14px 12px', background: t.cellBg, border: `1px solid ${t.cellBorder}`,
        borderRadius: 7, color: t.textMuted, fontSize: 12, fontFamily: t.font,
      }}>
        No commits yet
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 7,
        overflow: 'hidden',
      }}
    >
      {log.commits.map((c, i) => (
        <div
          key={c.hash}
          style={{
            display: 'flex', gap: 10, padding: '8px 12px',
            borderBottom: i < log.commits.length - 1 ? `1px solid ${t.cellBorder}` : 'none',
          }}
        >
          <GitCommit size={13} strokeWidth={1.75} color={t.accent} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              color: t.textPrimary, fontSize: 12, fontFamily: t.font,
              fontWeight: 500, lineHeight: 1.35, wordBreak: 'break-word',
            }}>
              {c.subject}
            </div>
            <div style={{
              color: t.textMuted, fontSize: 10, marginTop: 3,
              display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
            }}>
              <span style={{ fontFamily: t.fontMono, color: t.accent }}>{c.hash.slice(0, 7)}</span>
              <span>·</span>
              <span style={{ fontFamily: t.font }}>{c.author}</span>
              <span>·</span>
              <span style={{ fontFamily: t.fontMono }}>{c.date}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Tabs ----------

function TabButton({ active, onClick, children, t }: { active: boolean; onClick: () => void; children: React.ReactNode; t: Theme }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? t.btnHover : 'transparent',
        color: active ? t.textPrimary : t.textMuted,
        border: 'none',
        padding: '4px 12px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        cursor: 'pointer',
        fontFamily: t.font,
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {children}
    </button>
  );
}

function badge(color: string, t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 3,
    padding: '1px 7px',
    fontSize: 10, fontWeight: 600, letterSpacing: '0.02em',
    borderRadius: 10,
    background: `${color}1a`,
    color,
    fontFamily: t.font,
  };
}
