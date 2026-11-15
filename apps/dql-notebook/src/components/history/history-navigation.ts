import type { Dispatch } from 'react';
import { api } from '../../api/client';
import type { HistoryItemKind } from '../../api/history';
import type { NotebookAction, NotebookFile } from '../../store/types';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { requestBlockHistoryTab, setHistoryRoute, type HistoryRoute } from './history-route';

/** Opens the History page at `route`. */
export function openHistory(dispatch: Dispatch<NotebookAction>, route: HistoryRoute = { page: 'feed' }): void {
  setHistoryRoute(route);
  dispatch({ type: 'SET_MAIN_VIEW', view: 'history' });
}

/** The App id an item key names (`apps/<id>`, or a domain's `domains/<domain>/apps/<id>`). */
export function appIdOf(path: string): string | undefined {
  return /(?:^|\/)apps\/([^/]+)$/.exec(path)?.[1];
}

/** The History item of an App (V2: its App Studio saves and its published versions). */
export function appHistoryPath(appId: string): string {
  return `apps/${appId}`;
}

/**
 * Opens the item itself: a saved query in Block Studio (on its History tab when asked), an App on its History
 * section, a notebook in the editor. Anything else stays on History's page for the item.
 */
export async function openHistoryItem(
  dispatch: Dispatch<NotebookAction>,
  input: { kind: HistoryItemKind; path: string; files: NotebookFile[]; historyTab?: boolean; apps?: Array<{ id: string }> },
): Promise<void> {
  const { kind, path, files } = input;
  if (kind === 'saved_query') {
    const file: NotebookFile = { name: path.split('/').pop() ?? path, path, type: 'block', folder: 'blocks' };
    if (!files.some((candidate) => candidate.path === path)) dispatch({ type: 'FILE_ADDED', file });
    if (input.historyTab) requestBlockHistoryTab(path);
    const payload = await api.openBlockStudio(path);
    dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
    return;
  }
  const appId = kind === 'app' ? appIdOf(path) : undefined;
  if (appId && input.apps && !input.apps.some((app) => app.id === appId)) {
    // Not published (or not any more): the App is a draft in App Studio, when it has one.
    const { drafts } = await api.listAppBuilds().catch(() => ({ drafts: [] as Array<{ id: string; appId: string; state: string }> }));
    const draft = drafts.find((candidate) => candidate.appId === appId && candidate.state !== 'project_published');
    if (draft) {
      dispatch({ type: 'OPEN_APP_DRAFT', draftId: draft.id, appId });
      return;
    }
    openHistory(dispatch, { page: 'item', path });
    return;
  }
  if (appId) {
    dispatch({ type: 'OPEN_APP', appId, experience: 'build', ...(input.historyTab ? { section: 'history' as const } : {}) });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'apps' });
    return;
  }
  if (kind === 'notebook') {
    const file: NotebookFile = { name: path.split('/').pop() ?? path, path, type: 'notebook', folder: path.split('/').slice(0, -1).join('/') || 'notebooks' };
    if (!files.some((candidate) => candidate.path === path)) dispatch({ type: 'FILE_ADDED', file });
    const { content } = await api.readNotebook(path);
    const parsed = parseNotebookFile(path, content);
    dispatch({ type: 'OPEN_FILE', file, cells: parsed.cells, title: parsed.title, metadata: parsed.metadata });
    return;
  }
  openHistory(dispatch, { page: 'item', path });
}
