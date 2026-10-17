/**
 * GitPage — full-page Source Control view.
 *
 * Mirrors the New-UI/project/hex-git.jsx wireframe: top header (branch chip,
 * remote URL, sync status, Pull/Push), left file tree (search, filter,
 * Staged/Changes sections, file rows), right diff viewer, bottom commit bar.
 *
 * All write operations route through api.gitStage / gitCommit / gitPush etc.
 * which shell out to the system `git` binary on the backend.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GitBranch, GitCommit, RefreshCw, ArrowUp, ArrowDown,
  Search, ChevronDown, X, Plus, Check, ExternalLink,
  ShieldCheck, Sparkles, GitPullRequest, Link2,
} from 'lucide-react';
import { useNotebookStore } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { hostReadOnly, readOnlyReason, useHostUi } from '../../host/host-ui';
import { api, type GitGovernedContextGroup } from '../../api/client';
import { isNoRemoteFailure, remoteUrlInputProblem, REMOTE_URL_EXAMPLES } from './git-connect';

type Status = Awaited<ReturnType<typeof api.fetchGitStatus>>;
type RawChange = Status['changes'][number];
type GovernedContext = Awaited<ReturnType<typeof api.fetchGitGovernedContext>>;

interface FileEntry {
  path: string;
  /** Single-letter status: M / A / D / R / ? (untracked) */
  status: 'M' | 'A' | 'D' | 'R' | '?';
  staged: boolean;
  /** True when both index and worktree have changes (e.g. porcelain "MM"). */
  partiallyStaged: boolean;
}

type StatusFilter = 'all' | 'M' | 'A' | 'D' | 'R' | '?';

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All changes' },
  { key: 'M', label: 'Modified' },
  { key: 'A', label: 'Added' },
  { key: 'D', label: 'Deleted' },
  { key: 'R', label: 'Renamed' },
  { key: '?', label: 'Untracked' },
];

// Map first-char (index) and second-char (worktree) of porcelain status into
// our simplified single-letter category. We bucket renames-with-mods into 'R'
// and treat untracked as '?'.
function classify(code: string): 'M' | 'A' | 'D' | 'R' | '?' {
  const c = code;
  if (c.trim() === '??') return '?';
  if (c[0] === 'R' || c[1] === 'R') return 'R';
  if (c.includes('A')) return 'A';
  if (c.includes('D')) return 'D';
  return 'M';
}

function expandChanges(raw: RawChange[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const c of raw) {
    const idx = c.status[0] ?? ' ';
    const work = c.status[1] ?? ' ';
    const status = classify(c.status);
    if (c.status === '??') {
      out.push({ path: c.path, status: '?', staged: false, partiallyStaged: false });
      continue;
    }
    const indexDirty = idx !== ' ' && idx !== '?';
    const workDirty = work !== ' ' && work !== '?';
    if (indexDirty && workDirty) {
      // Same path appears in both lists so the user can stage/unstage each side.
      out.push({ path: c.path, status, staged: true, partiallyStaged: true });
      out.push({ path: c.path, status, staged: false, partiallyStaged: true });
    } else if (indexDirty) {
      out.push({ path: c.path, status, staged: true, partiallyStaged: false });
    } else {
      out.push({ path: c.path, status, staged: false, partiallyStaged: false });
    }
  }
  return out;
}

interface ToastMsg { kind: 'ok' | 'err'; text: string }

export function GitPage() {
  const t = themes[useNotebookStore((state) => state.themeMode)];
  // Under a host, anyone with project.read sees this page; only git.review may change anything.
  const hostUi = useHostUi();
  const readOnly = hostReadOnly(hostUi, 'git');

  const [status, setStatus] = useState<Status | null>(null);
  const [branchInfo, setBranchInfo] = useState<{ current: string | null; branches: string[] }>({ current: null, branches: [] });
  const [remote, setRemote] = useState<{ url: string | null; name: string | null }>({ url: null, name: null });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedStaged, setSelectedStaged] = useState(false);
  const [diff, setDiff] = useState<{ diff: string; before: string | null; after: string | null } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [governedContext, setGovernedContext] = useState<GovernedContext | null>(null);
  // Connecting the project to Git from the UI: initialize, then add a remote.
  const [initError, setInitError] = useState<string | null>(null);
  const [remoteFormOpen, setRemoteFormOpen] = useState(false);
  const [remoteUrlInput, setRemoteUrlInput] = useState('');
  const [remoteFormError, setRemoteFormError] = useState<string | null>(null);
  const remoteInputRef = useRef<HTMLInputElement>(null);
  // Redesigned guided flow (Source Control Redesign.dc.html): plain-language
  // diff view, share-rail phase, and the final description shown after share.
  const [diffView, setDiffView] = useState<'plain' | 'code'>('plain');
  const [sharedInfo, setSharedInfo] = useState<{ count: number; message: string; base: string } | null>(null);
  const [narrowLayout, setNarrowLayout] = useState(() => typeof window !== 'undefined' && window.innerWidth < 980);
  useEffect(() => {
    const onResize = () => setNarrowLayout(window.innerWidth < 980);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const branchMenuRef = useRef<HTMLDivElement>(null);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setLoadError(null);
    try {
      const [s, b, r, context] = await Promise.all([
        api.fetchGitStatus(),
        api.fetchGitBranches(),
        api.fetchGitRemote(),
        api.fetchGitGovernedContext(),
      ]);
      // Keep a background poll invisible when nothing actually changed. In
      // particular, do not replace the selected-file status every four seconds.
      setStatus((previous) => sameGitStatus(previous, s) ? previous : s);
      setBranchInfo((previous) => previous.current === b.current && sameStringList(previous.branches, b.branches)
        ? previous
        : { current: b.current, branches: b.branches });
      setRemote((previous) => previous.url === r.url && previous.name === r.name ? previous : { url: r.url, name: r.name });
      setGovernedContext(context);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setInitialLoadComplete(true);
      window.setTimeout(() => setRefreshing(false), 350);
    }
  }, []);

  useEffect(() => { void refreshAll(); }, [refreshAll]);

  // Quiet poll so external git activity (terminal commits, branch switches)
  // shows up in the UI without the user clicking refresh.
  useEffect(() => {
    let polling = false;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || polling) return;
      polling = true;
      void refreshAll().finally(() => { polling = false; });
    }, 4000);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  // Close the branch menu when clicking outside of it.
  useEffect(() => {
    if (!branchMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setBranchMenuOpen(false);
        setNewBranchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [branchMenuOpen]);

  const selectedFileStatus = useMemo(
    () => (status?.changes ?? []).find((change) => change.path === selectedPath)?.status ?? '',
    [selectedPath, status?.changes],
  );

  // A selected diff changes only when its file/status changes, not whenever the
  // quiet Git poll receives an identical status response. This removes the
  // distracting blank/loading flicker while someone is reviewing a file.
  useEffect(() => {
    if (!selectedPath) {
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    void api.fetchGitDiff(selectedPath, selectedStaged)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) setDiffError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedPath, selectedStaged, selectedFileStatus]);

  const entries = useMemo(() => expandChanges(status?.changes ?? []), [status?.changes]);
  const stagedFiles = entries.filter((e) => e.staged);
  const unstagedFiles = entries.filter((e) => !e.staged);

  const filterFn = useCallback((f: FileEntry) => {
    if (statusFilter !== 'all' && f.status !== statusFilter) return false;
    if (query && !f.path.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }, [statusFilter, query]);

  const filteredStaged = stagedFiles.filter(filterFn).sort(compareArtifactEntries);
  const filteredUnstaged = unstagedFiles.filter(filterFn).sort(compareArtifactEntries);

  // Auto-pick first file when none selected
  useEffect(() => {
    if (selectedPath) {
      const stillExists = entries.some((e) => e.path === selectedPath && e.staged === selectedStaged);
      if (stillExists) return;
    }
    const first = filteredUnstaged[0] ?? filteredStaged[0];
    if (first) {
      setSelectedPath(first.path);
      setSelectedStaged(first.staged);
    } else {
      setSelectedPath(null);
    }
  }, [entries, selectedPath, selectedStaged, filteredStaged, filteredUnstaged]);

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const runOp = useCallback(async <T,>(label: string, op: () => Promise<{ ok: boolean; error?: string } & T>, successMsg?: string) => {
    setBusy(label);
    try {
      const res = await op();
      if (res.ok) {
        if (successMsg) flash('ok', successMsg);
        await refreshAll();
      } else {
        flash('err', res.error ?? `${label} failed`);
      }
      return res;
    } finally {
      setBusy(null);
    }
  }, [flash, refreshAll]);

  const openRemoteForm = useCallback(() => {
    setRemoteFormOpen(true);
    window.setTimeout(() => remoteInputRef.current?.focus(), 0);
  }, []);
  /** Nothing can be sent without a remote: open the inline form instead of failing later. */
  const requestRemote = useCallback((message = 'Add a Git remote before sending changes.') => {
    setRemoteFormError(null);
    openRemoteForm();
    flash('err', message);
  }, [flash, openRemoteForm]);
  const onAddRemote = async () => {
    const problem = remoteUrlInputProblem(remoteUrlInput);
    if (problem) {
      setRemoteFormError(problem);
      return;
    }
    setRemoteFormError(null);
    setBusy('remote');
    try {
      const res = await api.gitAddRemote({ url: remoteUrlInput.trim() });
      if (!res.ok) {
        setRemoteFormError(res.error ?? 'Git could not save the remote.');
        return;
      }
      setRemoteUrlInput('');
      setRemoteFormOpen(false);
      flash('ok', 'Remote saved. ZLens stored the address only; it connects the first time you send changes.');
      await refreshAll();
    } finally {
      setBusy(null);
    }
  };
  const onInitRepo = async () => {
    setInitError(null);
    setBusy('init');
    try {
      const res = await api.gitInit();
      if (!res.ok) {
        setInitError(res.error ?? 'Git could not be initialized.');
        return;
      }
      flash('ok', 'Git is set up for this project. Add a remote when you are ready to share.');
      await refreshAll();
    } finally {
      setBusy(null);
    }
  };
  const pushOrAskForRemote = async (successMsg: string) => {
    const res = await runOp('push', () => api.gitPush(), successMsg);
    if (isNoRemoteFailure(res)) requestRemote(res.error);
    return res;
  };

  const onStage = (path: string) => runOp('stage', () => api.gitStage([path]));
  const onUnstage = (path: string) => runOp('unstage', () => api.gitUnstage([path]));
  const onDiscard = async (path: string) => {
    if (!window.confirm(`Discard changes to ${path}? A file that was never committed moves to a recovery folder you can restore from.`)) return;
    const res = await runOp('discard', () => api.gitDiscard([path]));
    if (!res.ok) return;
    flash('ok', res.recovered
      ? `Moved to ${res.recovered.trashPath} — restore it from there if you need it back`
      : res.skipped?.length
        ? 'Nothing to discard — that path is ignored by Git'
        : 'Reverted to the last committed version');
  };
  const onStageAll = () => runOp('stage', async () => {
    const paths = unstagedFiles.map((e) => e.path);
    if (paths.length === 0) return { ok: true };
    return api.gitStage(paths);
  });
  const onCommit = async () => {
    const msg = commitMsg.trim();
    if (!msg) return flash('err', 'Commit message required');
    // Commit exactly what this page lists. Falling back to "stage everything"
    // swept unrelated changes from a surrounding repository into the commit.
    const paths = stagedFiles.length > 0 ? undefined : unstagedFiles.map((entry) => entry.path);
    const res = await runOp('commit', () => api.gitCommit(msg, paths ? { paths } : {}), 'Committed');
    if (res.ok) setCommitMsg('');
  };
  const onCommitAndPush = async () => {
    const msg = commitMsg.trim();
    if (!msg) return flash('err', 'Commit message required');
    // Check before committing, so a commit is never left behind by a push that cannot happen.
    if (!remote.url) return requestRemote('Add a Git remote before committing and pushing.');
    const paths = stagedFiles.length > 0 ? undefined : unstagedFiles.map((entry) => entry.path);
    const c = await runOp('commit', () => api.gitCommit(msg, paths ? { paths } : {}));
    if (!c.ok) return;
    setCommitMsg('');
    await pushOrAskForRemote('Pushed to remote');
  };
  const onRequestReview = async () => {
    // After a share the composer is cleared — fall back to the shared message.
    const title = commitMsg.trim() || sharedInfo?.message || '';
    if (!title) return flash('err', 'Review title required');
    if (sharedInfo) {
      const review = await runOp('request review', () => api.gitOpenReview({
        title,
        body: 'Created from ZLens Source Control. Review the governed analytics changes before merging.',
        // No base: the server asks the remote for its default branch.
      }));
      if (!review.ok) return;
      setReviewUrl(review.prUrl ?? null);
      flash('ok', review.warning ?? 'Review request opened.');
      return;
    }
    const paths = Array.from(new Set(entries.map((entry) => entry.path)));
    if (paths.length === 0) return flash('err', 'No changes to request review for');
    const review = await runOp('request review', () => api.gitCreateReview({
      paths,
      title,
      body: 'Created from ZLens Source Control. Review the governed analytics changes before merging.',
      // No base: the server asks the remote for its default branch.
    }));
    if (!review.ok) return;
    setCommitMsg('');
    setReviewUrl(review.prUrl ?? null);
    flash('ok', review.warning ?? `Review branch ${review.branch ?? ''} is ready${review.prUrl ? '.' : '; create the PR from your Git host.'}`);
  };
  const onEnableGovernedTracking = async () => {
    const result = await runOp('enable governed tracking', () => api.enableGitGovernedContextTracking());
    if (result.ok) flash('ok', 'Governed project source and Hint Graph files are now visible to source control.');
  };
  const onPull = () => {
    if (!remote.url) return requestRemote('Add a Git remote before getting updates.');
    void runOp('pull', () => api.gitPull(), 'Pulled from remote').then((res) => {
      if (isNoRemoteFailure(res)) requestRemote(res.error);
    });
  };
  const onPush = () => {
    if (!remote.url) return requestRemote();
    void pushOrAskForRemote('Pushed to remote');
  };

  // ── Guided share-rail handlers (prototype: describe → share → review) ──────
  // "Write it for me from the changes": a deterministic plain-words summary
  // from the actual picked file names and statuses (no AI call needed).
  const suggestDescription = () => {
    const picked = stagedFiles;
    if (picked.length === 0) return flash('err', 'Include at least one change first');
    const verb: Record<FileEntry['status'], string> = { M: 'Updated', A: 'Added', D: 'Removed', R: 'Renamed', '?': 'Added' };
    const parts = picked.slice(0, 3).map((entry) => `${verb[entry.status]} ${entry.path.split('/').pop()?.replace(/\.(dql|md|json|ya?ml|sql)$/i, '') ?? entry.path}`);
    const rest = picked.length > 3 ? ` and ${picked.length - 3} more change${picked.length - 3 === 1 ? '' : 's'}` : '';
    setCommitMsg(`${parts.join(', ')}${rest}.`);
  };
  // Share = commit the picked changes + push to the branch, then remember the
  // description for the stepper's done state.
  const onShareToBranch = async () => {
    // UI-001, SEC-001, E2E-001: share only explicitly included files and never commit on main.
    const msg = commitMsg.trim();
    if (!msg) return flash('err', 'Describe your change first');
    if (stagedFiles.length === 0) return flash('err', 'Include at least one change first');
    if (!remote.url) return requestRemote('Add a Git remote before sharing changes.');
    const count = stagedFiles.length;
    const base = reviewBaseBranch(status);
    if (!branchInfo.current || branchInfo.current === 'HEAD' || branchInfo.current === base || branchInfo.current === 'main' || branchInfo.current === 'master') {
      const branch = guidedReviewBranchName(msg);
      const created = await runOp('branch', () => api.gitCreateBranch(branch, true));
      if (!created.ok) return;
    }
    const committed = await runOp('commit', () => api.gitCommit(msg, {}));
    if (!committed.ok) return;
    const pushed = await pushOrAskForRemote('Shared to your branch');
    if (pushed.ok) setSharedInfo({ count, message: msg, base });
    setCommitMsg('');
  };
  const onStartNewChange = () => {
    setSharedInfo(null);
    setReviewUrl(null);
    setCommitMsg('');
    void refreshAll();
  };
  const onCheckout = (name: string) => {
    setBranchMenuOpen(false);
    void runOp('checkout', () => api.gitCheckout(name), `Switched to ${name}`);
  };
  const onCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setBranchMenuOpen(false);
    setNewBranchOpen(false);
    setNewBranchName('');
    void runOp('branch', () => api.gitCreateBranch(name, true), `Created and switched to ${name}`);
  };

  const selectedEntry = entries.find((e) => e.path === selectedPath && e.staged === selectedStaged) ?? null;
  const prUrl = useMemo(
    () => reviewUrl ?? githubCompareUrl(remote.url, branchInfo.current),
    [remote.url, branchInfo.current, reviewUrl],
  );

  // Never render the null pre-fetch state as a real detached, clean
  // repository. That placeholder looked authoritative until the first request
  // completed and could hide dozens of real workspace changes.
  if (!initialLoadComplete) {
    return <GitStatusLoading t={t} />;
  }

  if (loadError && !status) {
    return <GitStatusError t={t} message={loadError} onRetry={() => void refreshAll()} />;
  }

  if (status && !status.inRepo && readOnly) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: t.appBg, color: t.textSecondary, fontSize: 12.5 }}>
        <span role="status">{readOnlyReason(hostUi, 'git')}</span>
      </div>
    );
  }

  if (status && !status.inRepo) {
    return <NotARepo t={t} onInit={() => void onInitRepo()} busy={busy === 'init'} error={initError} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: t.appBg }}>
      <TopBar
        t={t}
        readOnly={readOnly}
        branchCurrent={branchInfo.current}
        branches={branchInfo.branches}
        ahead={status?.ahead ?? 0}
        behind={status?.behind ?? 0}
        remoteUrl={remote.url}
        refreshing={refreshing}
        busy={busy}
        onPull={onPull}
        onPush={onPush}
        onRefresh={() => void refreshAll()}
        prUrl={prUrl}
        onCheckout={onCheckout}
        branchMenuOpen={branchMenuOpen}
        setBranchMenuOpen={setBranchMenuOpen}
        newBranchOpen={newBranchOpen}
        setNewBranchOpen={setNewBranchOpen}
        newBranchName={newBranchName}
        setNewBranchName={setNewBranchName}
        onCreateBranch={onCreateBranch}
        branchMenuRef={branchMenuRef}
      />

      {!remote.url && !readOnly && (
        <RemoteSetupBanner
          t={t}
          open={remoteFormOpen}
          onOpen={openRemoteForm}
          onClose={() => { setRemoteFormOpen(false); setRemoteFormError(null); }}
          value={remoteUrlInput}
          onChange={(value) => { setRemoteUrlInput(value); if (remoteFormError) setRemoteFormError(null); }}
          onSubmit={() => void onAddRemote()}
          error={remoteFormError}
          busy={busy === 'remote'}
          inputRef={remoteInputRef}
        />
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <FileTree
          t={t}
          readOnly={readOnly}
          stagedFiles={filteredStaged}
          unstagedFiles={filteredUnstaged}
          totalCount={entries.length}
          selectedPath={selectedPath}
          selectedStaged={selectedStaged}
          onSelect={(path, staged) => { setSelectedPath(path); setSelectedStaged(staged); }}
          query={query}
          setQuery={setQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          onStage={onStage}
          onUnstage={onUnstage}
          onStageAll={onStageAll}
          ahead={status?.ahead ?? 0}
          behind={status?.behind ?? 0}
          branchCurrent={branchInfo.current}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: t.appBg }}>
          {selectedEntry ? (
            <>
              <FileDiffHeader
                t={t}
                entry={selectedEntry}
                readOnly={readOnly}
                onStage={() => onStage(selectedEntry.path)}
                onUnstage={() => onUnstage(selectedEntry.path)}
                onDiscard={() => onDiscard(selectedEntry.path)}
                stagedView={selectedStaged}
                diffView={diffView}
                onDiffView={setDiffView}
              />
              {diffView === 'plain' && !diffLoading && !diffError ? (
                <PlainChangeView t={t} diff={diff?.diff ?? ''} entry={selectedEntry} />
              ) : (
                <DiffBody
                  t={t}
                  diff={diff?.diff ?? ''}
                  entry={selectedEntry}
                  loading={diffLoading}
                  error={diffError}
                />
              )}
            </>
          ) : (
            <DiffEmpty t={t} hasFiles={entries.length > 0} />
          )}
          {narrowLayout && !readOnly ? (
            <CommitBar
              t={t}
              commitMsg={commitMsg}
              setCommitMsg={setCommitMsg}
              stagedCount={stagedFiles.length}
              unstagedCount={unstagedFiles.length}
              onCommit={onCommit}
              onCommitAndPush={onCommitAndPush}
              onRequestReview={onRequestReview}
              advancedOpen={advancedOpen}
              onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
              busy={busy}
            />
          ) : null}
        </div>
        {!narrowLayout && !readOnly ? (
          <ShareRail
            t={t}
            branch={branchInfo.current}
            pickedCount={stagedFiles.length}
            totalCount={entries.length}
            commitMsg={commitMsg}
            setCommitMsg={setCommitMsg}
            busy={busy}
            sharedInfo={sharedInfo}
            reviewUrl={reviewUrl}
            onSuggest={suggestDescription}
            onShare={() => void onShareToBranch()}
            onRequestReview={() => void onRequestReview()}
            onStartNew={onStartNewChange}
            advancedOpen={advancedOpen}
            onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
            context={governedContext}
            onEnableTracking={onEnableGovernedTracking}
          />
        ) : null}
      </div>

      {toast && <Toast t={t} kind={toast.kind} text={toast.text} />}
    </div>
  );
}

function GitStatusLoading({ t }: { t: Theme }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: t.appBg, color: t.textSecondary }}>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5 }}>
        <RefreshCw size={15} strokeWidth={1.8} style={{ animation: 'dql-spin 0.8s linear infinite' }} />
        Loading current repository state…
      </div>
      <style>{`@keyframes dql-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function GitStatusError({ t, message, onRetry }: { t: Theme; message: string; onRetry: () => void }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: t.appBg, color: t.textSecondary }}>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 9, fontSize: 12.5 }}>
        <span>Source Control could not load the current repository state.</span>
        <span style={{ color: t.textMuted, fontSize: 11 }}>{message}</span>
        <button type="button" onClick={onRetry} style={miniBtn(t, 'primary')}>Retry</button>
      </div>
    </div>
  );
}

// ---------- Top Bar ----------

interface TopBarProps {
  t: Theme;
  readOnly: boolean;
  branchCurrent: string | null;
  branches: string[];
  ahead: number;
  behind: number;
  remoteUrl: string | null;
  refreshing: boolean;
  busy: string | null;
  onPull: () => void;
  onPush: () => void;
  onRefresh: () => void;
  prUrl: string | null;
  onCheckout: (name: string) => void;
  branchMenuOpen: boolean;
  setBranchMenuOpen: (v: boolean) => void;
  newBranchOpen: boolean;
  setNewBranchOpen: (v: boolean) => void;
  newBranchName: string;
  setNewBranchName: (v: string) => void;
  onCreateBranch: () => void;
  branchMenuRef: React.RefObject<HTMLDivElement>;
}

function TopBar(p: TopBarProps) {
  const { t } = p;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 20px',
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.appBg,
        flexShrink: 0, whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          fontFamily: t.fontMono, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          padding: '3px 7px', borderRadius: 3,
          background: `${t.accent}1f`, color: t.accent,
          border: `1px solid ${t.accent}40`,
        }}
      >
        GIT
      </span>
      <span style={{ fontSize: 14, fontWeight: 500, color: t.textPrimary }}>Source control</span>

      <div ref={p.branchMenuRef} style={{ position: 'relative' }}>
        <button
          onClick={() => p.setBranchMenuOpen(!p.branchMenuOpen)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            background: t.cellBg, border: `1px solid ${t.cellBorder}`,
            color: t.textPrimary, padding: '3px 8px', borderRadius: 4,
            fontSize: 11, fontFamily: t.fontMono, cursor: 'pointer',
          }}
        >
          <GitBranch size={11} strokeWidth={1.75} />
          {p.branchCurrent ?? 'detached'}
          <ChevronDown size={10} strokeWidth={1.75} style={{ opacity: 0.6 }} />
        </button>
        {p.branchMenuOpen && !p.readOnly && (
          <div
            style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0,
              minWidth: 220, maxHeight: 360, overflow: 'auto',
              background: t.cellBg, border: `1px solid ${t.cellBorder}`,
              borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
              padding: '6px 0', zIndex: 100,
            }}
          >
            {p.branches.map((b) => (
              <button
                key={b}
                onClick={() => p.onCheckout(b)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 10px',
                  background: 'transparent', border: 'none',
                  fontFamily: t.fontMono, fontSize: 12, color: t.textPrimary,
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.btnHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {b === p.branchCurrent
                  ? <Check size={11} strokeWidth={2} color={t.success} />
                  : <span style={{ width: 11, display: 'inline-block' }} />}
                {b}
              </button>
            ))}
            <div style={{ borderTop: `1px solid ${t.cellBorder}`, margin: '4px 0' }} />
            {p.newBranchOpen ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}>
                <input
                  autoFocus
                  value={p.newBranchName}
                  onChange={(e) => p.setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') p.onCreateBranch();
                    if (e.key === 'Escape') { p.setNewBranchOpen(false); p.setNewBranchName(''); }
                  }}
                  placeholder="new-branch-name"
                  style={{
                    flex: 1, background: t.appBg, color: t.textPrimary,
                    border: `1px solid ${t.cellBorder}`, borderRadius: 4,
                    padding: '4px 7px', fontSize: 12, fontFamily: t.fontMono, outline: 'none',
                  }}
                />
                <button onClick={p.onCreateBranch} style={miniBtn(t, 'primary')}>Create</button>
              </div>
            ) : (
              <button
                onClick={() => p.setNewBranchOpen(true)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px',
                  background: 'transparent', border: 'none',
                  fontSize: 12, color: t.accent,
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.btnHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Plus size={11} strokeWidth={1.75} />
                Create new branch…
              </button>
            )}
          </div>
        )}
      </div>

      {p.remoteUrl ? (
        <>
          <span style={{ fontSize: 11, color: t.textMuted }}>·</span>
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.remoteUrl}>
            {prettyRemote(p.remoteUrl)}
          </span>
        </>
      ) : (
        <>
          <span style={{ fontSize: 11, color: t.textMuted }}>·</span>
          <span style={{ fontSize: 11, color: t.textMuted }} title="No Git remote is configured. Changes stay on this computer.">
            no remote
          </span>
        </>
      )}

      <span style={{ fontSize: 11, color: t.textMuted }}>·</span>
      <span style={{ fontSize: 11, color: t.success, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.success }} />
        ready
      </span>

      <div style={{ flex: 1 }} />

      <button onClick={p.onRefresh} title="Refresh" style={{
        background: 'transparent', border: `1px solid ${t.btnBorder}`,
        padding: '6px 8px', borderRadius: 5, cursor: 'pointer', color: t.textMuted,
      }}>
        <RefreshCw size={12} strokeWidth={1.75} style={{ animation: p.refreshing ? 'dql-spin 0.6s linear' : undefined }} />
      </button>
      <style>{`@keyframes dql-spin { to { transform: rotate(360deg); } }`}</style>

      {!p.readOnly && (
        <>
          <button onClick={p.onPull} disabled={!!p.busy} style={topBtn(t)} title="Get updates from the shared project">
            <ArrowDown size={12} strokeWidth={1.75} color={t.warning} />
            Get updates
            {p.behind > 0 && <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, marginLeft: 2 }}>{p.behind}</span>}
          </button>
          <button onClick={p.onPush} disabled={!!p.busy} style={topBtn(t, true)} title="Send the current branch to the shared project">
            <ArrowUp size={12} strokeWidth={1.75} />
            Send branch
            {p.ahead > 0 && <span style={{ fontFamily: t.fontMono, fontSize: 10, opacity: 0.75, marginLeft: 2 }}>{p.ahead}</span>}
          </button>
        </>
      )}
      {p.prUrl && (
        <a
          href={p.prUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            ...topBtn(t),
            textDecoration: 'none',
          }}
        >
          <ExternalLink size={12} strokeWidth={1.75} />
          Open PR
        </a>
      )}
    </div>
  );
}

function topBtn(t: Theme, primary = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    background: primary ? t.accent : t.cellBg,
    color: primary ? '#fff' : t.textPrimary,
    border: `1px solid ${primary ? t.accent : t.btnBorder}`,
    padding: '5px 12px', borderRadius: 6,
    fontSize: 12, fontFamily: t.font, fontWeight: primary ? 500 : 400,
    cursor: 'pointer', whiteSpace: 'nowrap',
  };
}

function miniBtn(t: Theme, kind: 'primary' | 'default' = 'default'): React.CSSProperties {
  return {
    background: kind === 'primary' ? t.accent : t.cellBg,
    color: kind === 'primary' ? '#fff' : t.textPrimary,
    border: `1px solid ${kind === 'primary' ? t.accent : t.btnBorder}`,
    padding: '4px 9px', borderRadius: 4,
    fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: t.font,
  };
}

function prettyRemote(url: string): string {
  return url.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

function githubCompareUrl(remoteUrl: string | null, branch: string | null): string | null {
  if (!remoteUrl || !branch || branch === 'main' || branch === 'master' || branch === 'HEAD') return null;
  const pretty = prettyRemote(remoteUrl);
  const match = /(?:^|\/)github\.com\/([^/]+\/[^/]+)$/.exec(pretty);
  if (!match) return null;
  return `https://github.com/${match[1]}/compare/${encodeURIComponent(branch)}?expand=1`;
}

function guidedReviewBranchName(message: string): string {
  const slug = message.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46) || 'governed-update';
  return `dql/review/${slug}-${Date.now().toString(36)}`;
}

/** The branch reviews merge into: the remote's default branch, as the server reports it. */
function reviewBaseBranch(status: Status | null): string {
  return status?.baseBranch || 'main';
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameGitStatus(left: Status | null, right: Status): boolean {
  return Boolean(left)
    && left!.inRepo === right.inRepo
    && left!.branch === right.branch
    && left!.ahead === right.ahead
    && left!.behind === right.behind
    && left!.baseBranch === right.baseBranch
    && left!.changes.length === right.changes.length
    && left!.changes.every((change, index) => change.path === right.changes[index]?.path && change.status === right.changes[index]?.status);
}

// ---------- Share rail (prototype 4-step guided flow) ----------
// Pick → Describe → Share to your branch → Ask for review. Plain language
// only; each action routes through the real git handlers.

function StepDot({ t, state, index }: { t: Theme; state: 'done' | 'active' | 'todo'; index: number }) {
  const styles = state === 'done'
    ? { background: 'var(--status-success-bg)', color: 'var(--status-success)', border: '1.5px solid var(--status-success-border)' }
    : state === 'active'
      ? { background: 'var(--accent-dim)', color: t.accent, border: `1.5px solid ${t.accent}` }
      : { background: t.appBg, color: t.textMuted, border: `1.5px solid ${t.headerBorder}` };
  return (
    <span style={{ width: 24, height: 24, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0, ...styles }}>
      {state === 'done' ? <Check size={12} strokeWidth={3} /> : index}
    </span>
  );
}

function ShareRail({ t, branch, pickedCount, totalCount, commitMsg, setCommitMsg, busy, sharedInfo, reviewUrl, onSuggest, onShare, onRequestReview, onStartNew, advancedOpen, onToggleAdvanced, context, onEnableTracking }: {
  t: Theme;
  branch: string | null;
  pickedCount: number;
  totalCount: number;
  commitMsg: string;
  setCommitMsg: (value: string) => void;
  busy: string | null;
  sharedInfo: { count: number; message: string; base: string } | null;
  reviewUrl: string | null;
  onSuggest: () => void;
  onShare: () => void;
  onRequestReview: () => void;
  onStartNew: () => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  context: GovernedContext | null;
  onEnableTracking: () => void;
}) {
  const sharing = busy === 'commit' || busy === 'push';
  const shared = sharedInfo !== null;
  const prOpened = reviewUrl !== null && shared;
  const s1: 'done' | 'active' | 'todo' = pickedCount > 0 || shared ? 'done' : 'active';
  const s2: 'done' | 'active' | 'todo' = shared || commitMsg.trim() ? 'done' : pickedCount > 0 ? 'active' : 'todo';
  const s3: 'done' | 'active' | 'todo' = shared ? 'done' : commitMsg.trim() ? 'active' : 'todo';
  const s4: 'done' | 'active' | 'todo' = prOpened ? 'done' : shared ? 'active' : 'todo';
  const connector = <span style={{ width: 1.5, flex: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />;
  return (
    <aside style={{ width: 'clamp(280px, 26vw, 350px)', flexShrink: 0, background: t.cellBg, borderLeft: `1px solid ${t.headerBorder}`, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>Share your work</div>
        <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>Four steps — no git commands needed.</div>
      </div>
      <div style={{ padding: '14px 16px 20px', display: 'flex', flexDirection: 'column' }}>
        {/* Step 1 — pick */}
        <div style={{ display: 'flex', gap: 11 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <StepDot t={t} state={s1} index={1} />
            {connector}
          </div>
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 18 }}>
            <div style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary }}>Pick what to share</div>
            <div style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.5, marginTop: 2 }}>
              {shared ? `${sharedInfo.count} change${sharedInfo.count === 1 ? '' : 's'} shared.` : `${pickedCount} of ${totalCount} change${totalCount === 1 ? '' : 's'} selected in the left panel. Review each one before moving on.`}
            </div>
          </div>
        </div>
        {/* Step 2 — describe */}
        <div style={{ display: 'flex', gap: 11 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <StepDot t={t} state={s2} index={2} />
            {connector}
          </div>
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 18 }}>
            <div style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary }}>Describe your change</div>
            {shared ? (
              <div style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.5, marginTop: 2 }}>“{sharedInfo.message}”</div>
            ) : (
              <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <textarea
                  rows={2}
                  value={commitMsg}
                  onChange={(event) => setCommitMsg(event.target.value)}
                  placeholder="What did you change, in plain words?"
                  style={{ border: `1px solid ${t.headerBorder}`, background: t.appBg, borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.5, fontFamily: t.font, color: t.textPrimary, outline: 'none', resize: 'vertical' }}
                />
                <button type="button" onClick={onSuggest} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, width: 'fit-content', border: 'none', background: 'none', color: t.accent, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, padding: 0 }}>
                  <Sparkles size={11} /> Write it for me from the changes
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Step 3 — share */}
        <div style={{ display: 'flex', gap: 11 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <StepDot t={t} state={s3} index={3} />
            {connector}
          </div>
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 18 }}>
            <div style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary }}>Share to your branch</div>
            <div style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.5, marginTop: 2 }}>
              Saves your work to {branch && branch !== 'main' && branch !== 'master'
                ? <span style={{ fontFamily: t.fontMono, fontSize: 10.5 }}>{branch}</span>
                : 'a new review branch'} — main stays untouched.
            </div>
            {sharing ? (
              <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, backgroundImage: `linear-gradient(100deg, ${t.textPrimary} 25%, ${t.accent} 50%, ${t.textPrimary} 75%)`, backgroundSize: '220% 100%', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitTextFillColor: 'transparent', animation: 'dql-git-shimmer 2s linear infinite' }}>
                Sharing your changes…
              </div>
            ) : shared ? (
              <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--status-success)', fontWeight: 600 }}>
                <Check size={12} strokeWidth={2.5} /> Shared · {sharedInfo.count} change{sharedInfo.count === 1 ? '' : 's'} on your branch
              </div>
            ) : (
              <button type="button" onClick={onShare} disabled={!commitMsg.trim() || pickedCount === 0} style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 14px', borderRadius: 8, border: 'none', background: commitMsg.trim() && pickedCount > 0 ? t.accent : t.btnBg, color: commitMsg.trim() && pickedCount > 0 ? '#fff' : t.textMuted, fontSize: 12, fontWeight: 650, cursor: commitMsg.trim() && pickedCount > 0 ? 'pointer' : 'default', fontFamily: t.font, boxShadow: commitMsg.trim() && pickedCount > 0 ? '0 1px 4px rgba(107,93,211,0.25)' : 'none' }}>
                <ArrowUp size={12} strokeWidth={2} /> Share {pickedCount > 0 ? `${pickedCount} change${pickedCount === 1 ? '' : 's'}` : 'changes'}
              </button>
            )}
          </div>
        </div>
        {/* Step 4 — review */}
        <div style={{ display: 'flex', gap: 11 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <StepDot t={t} state={s4} index={4} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary }}>Ask for review</div>
            {prOpened ? (
              <>
                <div style={{ marginTop: 8, border: '1px solid var(--status-success-border)', background: 'var(--status-success-bg)', borderRadius: 10, padding: '11px 13px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <GitPullRequest size={13} color="var(--status-success)" />
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--status-success)' }}>Review request opened</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--status-success)', lineHeight: 1.55, marginTop: 5 }}>
                    “{sharedInfo?.message}” — you&apos;ll be notified on approval. Nothing reaches main until then.
                  </div>
                  <a href={reviewUrl!} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 9, fontSize: 11.5, fontWeight: 600, color: t.accent, textDecoration: 'none' }}>
                    View on GitHub <ExternalLink size={11} />
                  </a>
                </div>
                <button type="button" onClick={onStartNew} style={{ marginTop: 10, border: 'none', background: 'none', color: t.textMuted, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, padding: 0 }}>
                  Start a new change
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.5, marginTop: 2 }}>A teammate approves before anything reaches main.</div>
                {shared ? (
                  <button type="button" onClick={onRequestReview} disabled={busy === 'request review'} style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 14px', borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: t.font, width: 'fit-content', boxShadow: '0 1px 4px rgba(107,93,211,0.25)', opacity: busy === 'request review' ? 0.7 : 1 }}>
                    <GitPullRequest size={12} strokeWidth={1.75} /> {busy === 'request review' ? 'Opening…' : 'Open review request'}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-subtle)' }}>
        <button type="button" onClick={onToggleAdvanced} style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none', color: t.textMuted, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, padding: '10px 16px' }}>
          {advancedOpen ? '▾' : '▸'} Advanced
        </button>
        {advancedOpen && context ? (
          <div style={{ padding: '0 16px 14px' }}>
            <GovernedContextSummary t={t} context={context} onEnableTracking={onEnableTracking} />
          </div>
        ) : null}
      </div>
      <style>{'@keyframes dql-git-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }'}</style>
    </aside>
  );
}

function GitFlowGuide({
  t,
  changeCount,
  branch,
  advancedOpen,
  onToggleAdvanced,
  context,
  onEnableTracking,
}: {
  t: Theme;
  changeCount: number;
  branch: string | null;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  context: GovernedContext | null;
  onEnableTracking: () => void;
}) {
  const steps = [
    { label: 'Review changes', detail: changeCount === 0 ? 'Everything is up to date' : `${changeCount} change${changeCount === 1 ? '' : 's'} ready to review` },
    { label: 'Describe your update', detail: 'Use plain language' },
    { label: 'Request review', detail: 'Creates a branch and pull request' },
  ];
  return (
    <div style={{ display: 'grid', gap: 9, padding: '9px 20px', background: t.sidebarBg, borderBottom: `1px solid ${t.headerBorder}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 170 }}>
        <div style={{ fontSize: 12, fontWeight: 720, color: t.textPrimary }}>Share changes safely</div>
        <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>Nothing merges automatically.</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 300, flexWrap: 'wrap' }}>
        {steps.map((step, index) => (
          <React.Fragment key={step.label}>
            {index > 0 && <span style={{ color: t.textMuted, fontSize: 12 }}>→</span>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${t.accent}18`, color: t.accent, fontSize: 10, fontWeight: 750 }}>{index + 1}</span>
              <div>
                <div style={{ fontSize: 11, color: t.textPrimary, fontWeight: 650 }}>{step.label}</div>
                <div style={{ fontSize: 9, color: t.textMuted }}>{step.detail}</div>
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
      <button type="button" onClick={onToggleAdvanced} style={miniBtn(t)}>
        {advancedOpen ? 'Hide Git details' : 'Git details'}
      </button>
      {branch && branch !== 'main' && branch !== 'master' && <span style={{ fontSize: 10, color: t.success }}>Review branch: {branch}</span>}
      </div>
      {context && <GovernedContextSummary t={t} context={context} onEnableTracking={onEnableTracking} />}
    </div>
  );
}

function GovernedContextSummary({ t, context, onEnableTracking }: { t: Theme; context: GovernedContext; onEnableTracking: () => void }) {
  const groupSummary = (label: string, group: GitGovernedContextGroup) => {
    if (group.total === 0) return `${label}: none yet`;
    if (group.ignored > 0) return `${label}: ${group.total} found · ${group.ignored} hidden from Git`;
    if (group.changed > 0 || group.untracked > 0) return `${label}: ${group.total} · ${group.changed + group.untracked} need review`;
    return `${label}: ${group.total} tracked`;
  };
  const groups: Array<[string, GitGovernedContextGroup]> = [
    ['Domains', context.domains],
    ['Skills', context.skills],
    ['Project source', context.artifacts],
    ['Governed learning', context.learning],
  ];
  const needsRepair = !context.trackingReady;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: needsRepair ? `${t.warning}10` : `${t.success}0d`, border: `1px solid ${needsRepair ? `${t.warning}45` : `${t.success}35`}`, borderRadius: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10, fontWeight: 750, letterSpacing: '0.05em', textTransform: 'uppercase', color: needsRepair ? t.warning : t.success }}>Modeling &amp; skills</span>
      <span style={{ fontSize: 11, color: t.textPrimary }}>{groupSummary('Domains', context.domains)}</span>
      <span style={{ color: t.textMuted }}>·</span>
      <span style={{ fontSize: 11, color: t.textPrimary }}>{groupSummary('Skills', context.skills)}</span>
      <span style={{ color: t.textMuted }}>·</span>
      <span style={{ fontSize: 11, color: t.textPrimary }}>{groupSummary('Project source', context.artifacts)}</span>
      <span style={{ color: t.textMuted }}>·</span>
      <span style={{ fontSize: 11, color: t.textPrimary }}>{groupSummary('Governed learning', context.learning)}</span>
      <div style={{ flex: 1 }} />
      {needsRepair ? (
        <>
          <span style={{ fontSize: 10, color: t.textMuted }}>
            {context.legacyBroadIgnore ? 'A legacy .dql/ rule is hiding governed learning.' : 'Some shared project source is hidden from Git.'}
          </span>
          <button type="button" onClick={onEnableTracking} style={miniBtn(t, 'primary')}>Repair source-control tracking</button>
        </>
      ) : (
        <span style={{ fontSize: 10, color: t.textMuted }}>Shared project source</span>
      )}
      <details style={{ width: '100%', borderTop: `1px solid ${t.headerBorder}`, paddingTop: 5 }}>
        <summary style={{ cursor: 'pointer', fontSize: 10, color: t.textSecondary }}>View governed source inventory</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8, marginTop: 7 }}>
          {groups.map(([label, group]) => (
            <div key={label} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: t.textPrimary, marginBottom: 3 }}>{label}</div>
              {group.paths.length === 0 ? (
                <div style={{ fontSize: 10, color: t.textMuted }}>No files yet</div>
              ) : group.paths.map((entry) => (
                <div key={`${label}:${entry.path}`} title={entry.path} style={{ display: 'flex', gap: 5, minWidth: 0, fontSize: 9.5, lineHeight: 1.5 }}>
                  <span style={{ color: entry.state === 'ignored' ? t.error : entry.state === 'tracked' ? t.success : t.warning, flexShrink: 0 }}>{entry.state}</span>
                  <span style={{ color: t.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.path}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

type ArtifactGroupId = 'business' | 'apps' | 'notebooks' | 'generated' | 'local';

interface ArtifactGroup {
  id: ArtifactGroupId;
  label: string;
  tone: 'good' | 'neutral' | 'warn' | 'danger';
  rank: number;
}

function artifactGroupForPath(path: string): ArtifactGroup {
  if (path.startsWith('.dql/local/') || /ai[-_]?pin|saved[-_]?view|layout[-_]?override/i.test(path)) {
    return { id: 'local', label: 'Local/private', tone: 'danger', rank: 4 };
  }
  if (path.startsWith('.dql/cache/') || path.startsWith('.dql/imports/') || path.startsWith('data/') || path === 'dql-manifest.json' || /\.run\.json$/i.test(path) || /\.(sqlite|duckdb|duckdb\.wal)$/i.test(path)) {
    return { id: 'generated', label: 'Generated', tone: 'warn', rank: 3 };
  }
  if (/\.dqlnb$/i.test(path)) {
    return { id: 'notebooks', label: 'Curated notebook', tone: 'neutral', rank: 2 };
  }
  if (/\/apps\/[^/]+\/dql\.app\.json$/.test(path) || /^apps\/[^/]+\/dql\.app\.json$/.test(path) || /\/dashboards\/[^/]+\.dqld$/.test(path) || /^apps\/[^/]+\/dashboards\/[^/]+\.dqld$/.test(path)) {
    return { id: 'apps', label: 'Shared app', tone: 'neutral', rank: 1 };
  }
  if (
    path.startsWith('skills/')
    || path.startsWith('.dql/skills/')
    || /^domains\//i.test(path)
    || /^\.dql\/(hints|traces|evaluations|reviews)\//i.test(path)
  ) {
    return { id: 'business', label: 'Modeling & skills', tone: 'good', rank: 0 };
  }
  if (/\.dql$/i.test(path) || path.startsWith('semantic-layer/') || /\.(ya?ml)$/i.test(path) || path === 'dql.config.json' || path === 'package.json') {
    return { id: 'business', label: 'Business logic', tone: 'good', rank: 0 };
  }
  return { id: 'apps', label: 'Shared source', tone: 'neutral', rank: 1 };
}

function compareArtifactEntries(a: FileEntry, b: FileEntry): number {
  const groupA = artifactGroupForPath(a.path);
  const groupB = artifactGroupForPath(b.path);
  return groupA.rank - groupB.rank || a.path.localeCompare(b.path);
}

// ---------- File Tree ----------

interface FileTreeProps {
  t: Theme;
  readOnly: boolean;
  stagedFiles: FileEntry[];
  unstagedFiles: FileEntry[];
  totalCount: number;
  selectedPath: string | null;
  selectedStaged: boolean;
  onSelect: (path: string, staged: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onStageAll: () => void;
  ahead: number;
  behind: number;
  branchCurrent: string | null;
}

function FileTree(p: FileTreeProps) {
  const { t } = p;
  return (
    <div
      style={{
        width: 300, flexShrink: 0,
        background: t.sidebarBg,
        borderRight: `1px solid ${t.headerBorder}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: t.textMuted,
        }}>
          Source control
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary }}>
            Changes
          </span>
          <span style={{ fontSize: 11, color: t.textMuted }}>{p.totalCount} files</span>
          <div style={{ flex: 1 }} />
          {p.unstagedFiles.length > 0 && !p.readOnly && (
            <button onClick={p.onStageAll} style={miniBtn(t)}>Include all</button>
          )}
        </div>

        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: t.cellBg, border: `1px solid ${t.cellBorder}`,
            borderRadius: 6, padding: '5px 9px', marginBottom: 7,
          }}
        >
          <Search size={11} strokeWidth={1.75} color={t.textMuted} />
          <input
            value={p.query}
            onChange={(e) => p.setQuery(e.target.value)}
            placeholder="Filter by path…"
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              color: t.textPrimary, fontSize: 12, flex: 1, width: '100%',
              fontFamily: t.font,
            }}
          />
          {p.query && (
            <button
              onClick={() => p.setQuery('')}
              style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', padding: 0 }}
            >
              <X size={11} strokeWidth={1.75} />
            </button>
          )}
        </div>

        <select
          value={p.statusFilter}
          onChange={(e) => p.setStatusFilter(e.target.value as StatusFilter)}
          style={{
            width: '100%', background: t.cellBg, color: t.textPrimary,
            border: `1px solid ${t.cellBorder}`, borderRadius: 6,
            padding: '5px 9px', fontSize: 12, cursor: 'pointer',
            fontFamily: t.font,
          }}
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        <SectionHeader t={t} label="Included" count={p.stagedFiles.length} />
        {p.stagedFiles.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 10px', fontStyle: 'italic' }}>
            No files included yet
          </div>
        ) : (
          p.stagedFiles.map((f) => (
            <FileRow
              key={`staged-${f.path}`}
              t={t}
              file={f}
              active={p.selectedPath === f.path && p.selectedStaged === true}
              onClick={() => p.onSelect(f.path, true)}
              actionLabel="Remove"
              onAction={p.readOnly ? undefined : () => p.onUnstage(f.path)}
            />
          ))
        )}

        <div style={{ height: 8 }} />
        <SectionHeader t={t} label="Needs review" count={p.unstagedFiles.length} />
        {p.unstagedFiles.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 10px', fontStyle: 'italic' }}>
            {p.totalCount === 0 ? 'Everything is up to date' : 'No additional files to review'}
          </div>
        ) : (
          p.unstagedFiles.map((f) => (
            <FileRow
              key={`unstaged-${f.path}`}
              t={t}
              file={f}
              active={p.selectedPath === f.path && p.selectedStaged === false}
              onClick={() => p.onSelect(f.path, false)}
              actionLabel="Include"
              onAction={p.readOnly ? undefined : () => p.onStage(f.path)}
            />
          ))
        )}
      </div>

      {/* Prototype reassurance footer. */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-subtle)', fontSize: 10.5, color: t.textMuted, lineHeight: 1.5 }}>
        Unselected changes stay safely in your workspace — nothing is lost.
      </div>
      <div
        style={{
          padding: '8px 14px', borderTop: '1px solid var(--border-subtle)',
          fontSize: 10, color: t.textMuted,
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <GitBranch size={11} strokeWidth={1.75} />
        <span style={{ fontFamily: t.fontMono, color: t.textPrimary }}>
          {p.branchCurrent ?? 'detached'}
        </span>
        <span>·</span>
        {p.behind > 0 && <span style={{ color: t.warning }}>↓{p.behind}</span>}
        {p.ahead > 0 && <span style={{ color: t.success }}>↑{p.ahead}</span>}
        {p.behind === 0 && p.ahead === 0 && <span>up to date</span>}
      </div>
    </div>
  );
}

function SectionHeader({ t, label, count }: { t: Theme; label: string; count: number }) {
  return (
    <div style={{
      fontSize: 10, color: t.textMuted, fontWeight: 600,
      letterSpacing: '0.07em', textTransform: 'uppercase',
      padding: '6px 8px 4px',
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span>{label}</span>
      <span style={{ color: t.textMuted, opacity: 0.7 }}>·</span>
      <span style={{ color: t.textMuted }}>{count}</span>
    </div>
  );
}

interface FileRowProps {
  t: Theme;
  file: FileEntry;
  active: boolean;
  onClick: () => void;
  actionLabel: string;
  onAction?: () => void;
}

function FileRow({ t, file, active, onClick, actionLabel, onAction }: FileRowProps) {
  const [hover, setHover] = useState(false);
  const dir = file.path.split('/').slice(0, -1).join('/');
  const base = file.path.split('/').pop() ?? file.path;
  const group = artifactGroupForPath(file.path);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        borderRadius: 5, marginBottom: 1, cursor: 'pointer',
        background: active ? `${t.accent}18` : hover ? t.btnHover : 'transparent',
        border: active ? `1px solid ${t.accent}45` : '1px solid transparent',
      }}
    >
      <StatusBadge t={t} status={file.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: t.textPrimary, fontFamily: t.fontMono,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {base}
        </div>
        {dir && (
          <div style={{
            fontSize: 10, color: t.textMuted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {dir}
          </div>
        )}
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={artifactGroupPillStyle(t, group)}>{group.label}</span>
        </div>
      </div>
      {hover && onAction && (
        <button
          onClick={(e) => { e.stopPropagation(); onAction(); }}
          style={{
            background: t.cellBg, border: `1px solid ${t.btnBorder}`,
            color: t.textPrimary, padding: '2px 7px', borderRadius: 3,
            fontSize: 10, cursor: 'pointer', flexShrink: 0,
            fontFamily: t.font,
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function artifactGroupPillStyle(t: Theme, group: ArtifactGroup): React.CSSProperties {
  const color = group.tone === 'good'
    ? t.success
    : group.tone === 'warn'
      ? t.warning
      : group.tone === 'danger'
        ? t.error
        : t.textMuted;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '100%',
    border: `1px solid ${color}35`,
    background: `${color}12`,
    color,
    borderRadius: 3,
    padding: '1px 5px',
    fontSize: 9,
    fontWeight: 650,
    lineHeight: '14px',
    whiteSpace: 'nowrap',
  };
}

// Prototype status pills: plain words, never git letter codes.
function StatusBadge({ t, status }: { t: Theme; status: FileEntry['status'] }) {
  const map: Record<FileEntry['status'], { label: string; color: string }> = {
    M: { label: 'Edited', color: t.warning },
    A: { label: 'New', color: t.success },
    D: { label: 'Removed', color: t.error },
    R: { label: 'Renamed', color: t.accent },
    '?': { label: 'New', color: t.success },
  };
  const { label, color } = map[status];
  return (
    <span
      style={{
        flexShrink: 0,
        padding: '1.5px 7px',
        borderRadius: 999,
        background: `${color}1a`,
        color,
        fontSize: 9.5,
        fontWeight: 700,
        fontFamily: t.font,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

// ---------- File Diff Header ----------

interface FileDiffHeaderProps {
  t: Theme;
  entry: FileEntry;
  readOnly: boolean;
  stagedView: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  diffView: 'plain' | 'code';
  onDiffView: (view: 'plain' | 'code') => void;
}

function FileDiffHeader({ t, entry, readOnly, stagedView, onStage, onUnstage, onDiscard, diffView, onDiffView }: FileDiffHeaderProps) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 16px',
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        flexShrink: 0,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary, fontFamily: t.fontMono, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.path}
      </div>
      <StatusBadge t={t} status={entry.status} />
      {entry.partiallyStaged && <span style={{ fontSize: 10.5, color: t.warning, whiteSpace: 'nowrap' }}>partially included</span>}
      <div style={{ flex: 1 }} />
      {/* Prototype "What changed / Code view" toggle. */}
      <div role="group" aria-label="Diff view" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.appBg, flexShrink: 0 }}>
        <button type="button" onClick={() => onDiffView('plain')} style={{ border: 'none', borderRadius: 5, padding: '3.5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, background: diffView === 'plain' ? 'var(--accent-dim)' : 'transparent', color: diffView === 'plain' ? t.accent : t.textMuted }}>What changed</button>
        <button type="button" onClick={() => onDiffView('code')} style={{ border: 'none', borderRadius: 5, padding: '3.5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, background: diffView === 'code' ? 'var(--accent-dim)' : 'transparent', color: diffView === 'code' ? t.accent : t.textMuted }}>Code view</button>
      </div>
      {!readOnly && !stagedView && (
        <>
          <button onClick={onDiscard} style={miniBtn(t)}>Discard</button>
          <button onClick={onStage} style={miniBtn(t, 'primary')}>Include</button>
        </>
      )}
      {!readOnly && stagedView && (
        <button onClick={onUnstage} style={miniBtn(t)}>Remove</button>
      )}
    </div>
  );
}

// Prototype plain-language review: derive +/±/− bullets from the real diff
// hunks, with a reassurance banner. No git vocabulary.
function PlainChangeView({ t, diff, entry }: { t: Theme; diff: string; entry: FileEntry }) {
  const lines = parseDiff(diff);
  const bullets: Array<{ mark: '+' | '−' | '±'; text: string }> = [];
  let currentSection = '';
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'hunk') {
      const section = line.text.replace(/^@@[^@]*@@\s*/, '').trim();
      currentSection = section;
    }
    if (line.kind === 'add') added += 1;
    if (line.kind === 'del') removed += 1;
    if ((line.kind === 'add' || line.kind === 'del') && bullets.length < 5) {
      const text = line.text.replace(/^[+-]\s?/, '').trim();
      if (text && !bullets.some((b) => b.text.includes(text.slice(0, 40)))) {
        bullets.push({
          mark: line.kind === 'add' ? '+' : '−',
          text: `${line.kind === 'add' ? 'Added' : 'Removed'}${currentSection ? ` in ${currentSection}` : ''}: ${text.slice(0, 90)}`,
        });
      }
    }
  }
  const markStyles: Record<string, { bg: string; color: string }> = {
    '+': { bg: 'var(--status-success-bg)', color: 'var(--status-success)' },
    '−': { bg: 'var(--status-error-bg)', color: 'var(--status-error)' },
    '±': { bg: 'var(--status-warning-bg)', color: 'var(--status-warning)' },
  };
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>Summary of this change</div>
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, overflow: 'hidden' }}>
          {bullets.length === 0 ? (
            <div style={{ padding: '10px 13px', fontSize: 12.5, color: t.textMuted }}>
              {entry.status === '?' ? 'A brand-new file — everything in it is an addition.' : 'No line-level changes to summarize for this selection.'}
            </div>
          ) : bullets.map((bullet, index) => (
            <div key={index} style={{ display: 'flex', gap: 9, padding: '10px 13px', borderBottom: index < bullets.length - 1 ? '1px solid var(--border-subtle)' : 'none', alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: 5, background: markStyles[bullet.mark].bg, color: markStyles[bullet.mark].color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{bullet.mark}</span>
              <span style={{ fontSize: 12.5, color: t.textPrimary, lineHeight: 1.5, fontFamily: t.fontMono, overflowWrap: 'anywhere' }}>{bullet.text}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: t.textMuted }}>{added} addition{added === 1 ? '' : 's'} · {removed} removal{removed === 1 ? '' : 's'} — switch to Code view for the full detail.</div>
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', border: '1px solid var(--status-success-border)', background: 'var(--status-success-bg)', borderRadius: 10, padding: '10px 13px' }}>
          <ShieldCheck size={13} color="var(--status-success)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--status-success)', lineHeight: 1.55 }}>Nothing reaches main until a reviewer approves — your workspace stays safe.</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Diff Pane ----------

function DiffBody({
  t,
  diff,
  entry,
  loading,
  error,
}: {
  t: Theme;
  diff: string;
  entry: FileEntry;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return <DiffStatus t={t} title="Loading diff" body="Preparing the selected change for review." />;
  }
  if (error) {
    return <DiffStatus t={t} title="Could not load diff" body={error} tone="error" />;
  }
  return <DiffPane t={t} diff={diff} entry={entry} />;
}

function DiffPane({ t, diff, entry }: { t: Theme; diff: string; entry: FileEntry }) {
  if (!diff.trim()) {
    return (
      <DiffStatus
        t={t}
        title="No text hunks to review"
        body={
          entry.status === '?'
            ? 'This untracked item does not expose a readable text diff yet. Stage it to include it in the next commit.'
            : 'Git reports this file changed, but there are no line-level text hunks for this selection.'
        }
      />
    );
  }
  return (
    <div
      style={{
        flex: 1, overflow: 'auto', background: t.cellBg,
        fontFamily: t.fontMono, fontSize: 12, lineHeight: '20px',
      }}
    >
      {parseDiff(diff).map((line, i) => (
        <DiffLine key={i} t={t} line={line} />
      ))}
    </div>
  );
}

function DiffStatus({
  t,
  title,
  body,
  tone = 'muted',
}: {
  t: Theme;
  title: string;
  body: string;
  tone?: 'muted' | 'error';
}) {
  const color = tone === 'error' ? t.error : t.textMuted;
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: t.appBg,
      padding: 32,
    }}>
      <div style={{
        maxWidth: 420,
        border: `1px solid ${tone === 'error' ? `${t.error}55` : t.cellBorder}`,
        background: t.cellBg,
        borderRadius: 8,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: tone === 'error' ? t.error : t.textPrimary }}>
          {title}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, color }}>
          {body}
        </div>
      </div>
    </div>
  );
}

interface ParsedLine {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldNum: number | null;
  newNum: number | null;
}

function parseDiff(diff: string): ParsedLine[] {
  // We skip the diff/index/+++/--- headers (kind 'meta' is filtered out).
  // Hunks reset old/new line counters; subsequent lines increment them
  // per their kind. Stops at 1000 lines so a giant diff doesn't tank
  // rendering — users with huge diffs can fall back to terminal git.
  const out: ParsedLine[] = [];
  let oldN = 0, newN = 0;
  const lines = diff.split('\n');
  let count = 0;
  for (const line of lines) {
    if (count++ > 1000) {
      out.push({ kind: 'meta', text: '… diff truncated (over 1000 lines)', oldNum: null, newNum: null });
      break;
    }
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('+++ ') || line.startsWith('--- ')) {
      continue;
    }
    if (
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('Binary file ') ||
      line.startsWith('# ')
    ) {
      out.push({ kind: 'meta', text: line, oldNum: null, newNum: null });
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldN = Number(m[1]); newN = Number(m[2]); }
      out.push({ kind: 'hunk', text: line, oldNum: null, newNum: null });
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), oldNum: null, newNum: newN++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNum: oldN++, newNum: null });
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'meta', text: line, oldNum: null, newNum: null });
    } else {
      out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNum: oldN++, newNum: newN++ });
    }
  }
  return out;
}

function DiffLine({ t, line }: { t: Theme; line: ParsedLine }) {
  if (line.kind === 'hunk') {
    return (
      <div
        style={{
          display: 'grid', gridTemplateColumns: '80px 1fr',
          background: `${t.accent}14`,
          borderTop: `1px solid ${t.accent}30`,
          borderBottom: `1px solid ${t.accent}30`,
          color: t.accent,
        }}
      >
        <div style={{ padding: '2px 10px', textAlign: 'right', borderRight: `1px solid ${t.accent}30`, color: t.textMuted }}>⋯</div>
        <div style={{ padding: '2px 12px', whiteSpace: 'pre' }}>{line.text}</div>
      </div>
    );
  }
  if (line.kind === 'meta') {
    return <div style={{ padding: '2px 12px', color: t.textMuted, fontStyle: 'italic' }}>{line.text}</div>;
  }
  const colors = {
    add: { bg: `${t.success}18`, gutter: `${t.success}55`, ch: '+', chColor: t.success },
    del: { bg: `${t.error}18`, gutter: `${t.error}55`, ch: '−', chColor: t.error },
    ctx: { bg: 'transparent', gutter: t.cellBorder, ch: ' ', chColor: t.textMuted },
  }[line.kind];
  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: '40px 40px 20px 1fr',
        background: colors.bg,
        borderLeft: `3px solid ${colors.gutter}`,
      }}
    >
      <div style={{ padding: '0 6px', color: t.textMuted, textAlign: 'right', userSelect: 'none' }}>
        {line.oldNum ?? ''}
      </div>
      <div style={{ padding: '0 6px', color: t.textMuted, textAlign: 'right', userSelect: 'none', borderRight: `1px solid ${t.cellBorder}` }}>
        {line.newNum ?? ''}
      </div>
      <div style={{ padding: '0 4px', color: colors.chColor, textAlign: 'center', userSelect: 'none' }}>
        {colors.ch}
      </div>
      <div style={{ padding: '0 10px', whiteSpace: 'pre', color: t.textPrimary, overflow: 'hidden' }}>
        {line.text}
      </div>
    </div>
  );
}

function DiffEmpty({ t, hasFiles }: { t: Theme; hasFiles: boolean }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 8,
      color: t.textMuted, fontSize: 13, background: t.appBg,
    }}>
      <GitCommit size={28} strokeWidth={1.5} color={t.textMuted} style={{ opacity: 0.4 }} />
      {hasFiles ? 'Select a file to view its diff' : 'Working tree clean — no changes to review'}
    </div>
  );
}

// ---------- Commit Bar ----------

interface CommitBarProps {
  t: Theme;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  stagedCount: number;
  unstagedCount: number;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onRequestReview: () => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  busy: string | null;
}

function CommitBar({ t, commitMsg, setCommitMsg, stagedCount, unstagedCount, onCommit, onCommitAndPush, onRequestReview, advancedOpen, onToggleAdvanced, busy }: CommitBarProps) {
  const willStageAll = stagedCount === 0 && unstagedCount > 0;
  const noChanges = stagedCount === 0 && unstagedCount === 0;
  const hint = willStageAll
    ? `${unstagedCount} change${unstagedCount === 1 ? '' : 's'} will be included in the review request`
    : stagedCount > 0
      ? `${stagedCount} change${stagedCount === 1 ? '' : 's'} prepared for review`
      : 'No changes to share';
  return (
    <div
      style={{
        padding: '12px 20px',
        borderTop: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 11, color: t.textMuted, flex: 1 }}>{hint}</div>
        <span style={{ fontSize: 10, color: t.textMuted }}>A review branch is created when needed.</span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onRequestReview();
            }
          }}
          placeholder="Describe this update for your reviewer…"
          style={{
            flex: 1,
            background: t.appBg, color: t.textPrimary,
            border: `1px solid ${t.cellBorder}`, borderRadius: 6,
            padding: '7px 10px', fontSize: 12, outline: 'none',
            fontFamily: t.font,
          }}
        />
        <button
          onClick={onRequestReview}
          disabled={!!busy || noChanges || !commitMsg.trim()}
          style={{
            background: t.accent, color: '#fff',
            border: `1px solid ${t.accent}`,
            padding: '7px 14px', borderRadius: 6,
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
            opacity: (noChanges || !commitMsg.trim()) ? 0.5 : 1,
            fontFamily: t.font,
          }}
        >
          Request review
        </button>
        <button onClick={onToggleAdvanced} style={miniBtn(t)}>{advancedOpen ? 'Hide details' : 'More options'}</button>
      </div>
      {advancedOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
          <span style={{ fontSize: 10, color: t.textMuted, flex: 1 }}>Advanced Git actions are optional. They do not merge changes.</span>
          <button onClick={onCommit} disabled={!!busy || noChanges || !commitMsg.trim()} style={{ ...miniBtn(t), opacity: noChanges || !commitMsg.trim() ? 0.45 : 1 }}>Save locally</button>
          <button onClick={onCommitAndPush} disabled={!!busy || noChanges || !commitMsg.trim()} style={{ ...miniBtn(t), opacity: noChanges || !commitMsg.trim() ? 0.45 : 1 }}>Commit & push</button>
        </div>
      )}
    </div>
  );
}

// ---------- Toast / NotARepo ----------

function Toast({ t, kind, text }: { t: Theme; kind: 'ok' | 'err'; text: string }) {
  const color = kind === 'ok' ? t.success : t.error;
  return (
    <div style={{
      position: 'absolute', bottom: 80, right: 24,
      background: t.cellBg, border: `1px solid ${color}55`,
      borderLeft: `3px solid ${color}`, borderRadius: 6,
      padding: '8px 14px', fontSize: 12, color: t.textPrimary,
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)', maxWidth: 420, zIndex: 200,
    }}>
      {text}
    </div>
  );
}

function NotARepo({ t, onInit, busy, error }: { t: Theme; onInit: () => void; busy: boolean; error: string | null }) {
  return (
    <div style={{
      flex: 1, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 12, padding: 40, background: t.appBg,
    }}>
      <GitBranch size={36} strokeWidth={1.5} color={t.textMuted} style={{ opacity: 0.5 }} />
      <div style={{ fontSize: 16, fontWeight: 600, color: t.textPrimary }}>Not a Git repository yet</div>
      <div style={{ fontSize: 13, color: t.textMuted, maxWidth: 440, textAlign: 'center', lineHeight: 1.5 }}>
        Initialize Git to track changes to blocks, notebooks, and apps, see each block&apos;s version history, and share work for review. Nothing is sent anywhere until you add a remote.
      </div>
      <button
        type="button"
        onClick={onInit}
        disabled={busy}
        style={{ ...topBtn(t, true), opacity: busy ? 0.7 : 1, cursor: busy ? 'default' : 'pointer' }}
      >
        <GitBranch size={12} strokeWidth={1.75} />
        {busy ? 'Initializing…' : 'Initialize Git for this project'}
      </button>
      {error && (
        <div role="alert" style={{ fontSize: 12, color: t.error, maxWidth: 440, textAlign: 'center', lineHeight: 1.5 }}>
          {error}
        </div>
      )}
      <div style={{ fontSize: 11, color: t.textMuted }}>
        Prefer the terminal? Run <code style={{ fontFamily: t.fontMono }}>git init</code> in the project folder, then refresh.
      </div>
    </div>
  );
}

function RemoteSetupBanner({ t, open, onOpen, onClose, value, onChange, onSubmit, error, busy, inputRef }: {
  t: Theme;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  error: string | null;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div style={{ display: 'grid', gap: 8, padding: '9px 20px', background: t.sidebarBg, borderBottom: `1px solid ${t.headerBorder}`, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Link2 size={13} strokeWidth={1.75} color={t.warning} />
        <span style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary }}>No Git remote yet</span>
        <span style={{ fontSize: 11, color: t.textMuted }}>
          Changes are saved on this computer only. Add the repository address from GitHub, GitLab, or your Git server to share them.
        </span>
        <div style={{ flex: 1 }} />
        {!open && (
          <button type="button" onClick={onOpen} style={miniBtn(t, 'primary')}>Add remote</button>
        )}
      </div>
      {open && (
        <form
          onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
        >
          <label htmlFor="dql-git-remote-url" style={{ fontSize: 11, color: t.textSecondary }}>Remote URL (origin)</label>
          <input
            id="dql-git-remote-url"
            ref={inputRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
            placeholder="https://github.com/org/repo.git"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby="dql-git-remote-url-help"
            style={{
              flex: '1 1 320px', minWidth: 0, background: t.appBg, color: t.textPrimary,
              border: `1px solid ${error ? t.error : t.cellBorder}`, borderRadius: 4,
              padding: '5px 8px', fontSize: 12, fontFamily: t.fontMono, outline: 'none',
            }}
          />
          <button type="submit" disabled={busy} style={{ ...miniBtn(t, 'primary'), opacity: busy ? 0.7 : 1 }}>
            {busy ? 'Saving…' : 'Save remote'}
          </button>
          <button type="button" onClick={onClose} style={miniBtn(t)}>Cancel</button>
          <div
            id="dql-git-remote-url-help"
            role={error ? 'alert' : undefined}
            style={{ width: '100%', fontSize: 10.5, lineHeight: 1.5, color: error ? t.error : t.textMuted }}
          >
            {error ?? `Accepts ${REMOTE_URL_EXAMPLES}. ZLens only saves the address; it does not connect until you send changes.`}
          </div>
        </form>
      )}
    </div>
  );
}
