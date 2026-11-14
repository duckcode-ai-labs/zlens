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

/** Keeps `document.title` on the page shown. */
export function usePageTitle(): void {
  const state = useNotebookStore(useShallow((store) => ({
    mainView: store.mainView,
    notebookTitle: store.notebookTitle,
    activeFileName: store.activeFile?.name,
  })));
  const openTitle = state.notebookTitle || state.activeFileName?.replace(/\.(dqlnb|dql)$/i, '') || null;
  const title = pageTitle({ mainView: state.mainView, openTitle });
  useEffect(() => {
    if (typeof document !== 'undefined') document.title = title;
  }, [title]);
}
