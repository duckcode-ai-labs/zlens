import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useNotebookStore } from '../../store/NotebookStore';
import type { MainView } from '../../store/types';

/** What each page is called, in the header and the browser tab. */
export const PAGE_NAMES: Record<MainView, string> = {
  home: 'Home',
  ask: 'Ask',
  ask_trace: 'How it was answered',
  ask_observability: 'Ask observability',
  notebook: 'Notebooks',
  block_studio: 'Saved queries',
  imports: 'Import SQL',
  business_artifact: 'Business definition',
  lineage: 'Lineage',
  lineage_detail: 'Lineage',
  connection: 'Settings',
  settings: 'Settings',
  git: 'Source control',
  apps: 'Apps',
  readiness: 'Readiness',
  skills: 'Modeling',
  domains: 'Modeling',
  modeling: 'Modeling',
  help: 'Help',
  host_page: 'ZLens',
};

/**
 * The browser tab's title: the page, then the product ("Ask · ZLens"). An open notebook or saved
 * query is named by its title, so several tabs can be told apart.
 */
export function pageTitle(input: { mainView: MainView; openTitle?: string | null }): string {
  const editor = input.mainView === 'notebook' || input.mainView === 'block_studio' || input.mainView === 'business_artifact';
  const name = (editor && input.openTitle?.trim()) || PAGE_NAMES[input.mainView];
  return name && name !== 'ZLens' ? `${name} · ZLens` : 'ZLens';
}

/**
 * The open file a page is about. Saved queries is about an open saved query only: a notebook left
 * open behind it (Notebooks, then Saved queries) is not named there (V14: the header kept saying
 * "NOTEBOOK v8-warriors-seasons-check" on Saved queries). Notebooks is about whatever file it opened.
 */
export function openFileFor<T extends { type: string }>(mainView: MainView, file: T | null | undefined): T | null {
  if (!file) return null;
  if (mainView === 'block_studio') return file.type === 'block' ? file : null;
  if (mainView === 'notebook' || mainView === 'business_artifact') return file;
  return null;
}

/** Keeps `document.title` on the page shown. */
export function usePageTitle(): void {
  const state = useNotebookStore(useShallow((store) => ({
    mainView: store.mainView,
    notebookTitle: store.notebookTitle,
    activeFile: store.activeFile,
  })));
  const file = openFileFor(state.mainView, state.activeFile);
  const openTitle = file ? (state.notebookTitle || file.name.replace(/\.(dqlnb|dql)$/i, '') || null) : null;
  const title = pageTitle({ mainView: state.mainView, openTitle });
  useEffect(() => {
    if (typeof document !== 'undefined') document.title = title;
  }, [title]);
}
