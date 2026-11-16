import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDispatch } from '../store/NotebookStore';
import { api } from '../api/client';
import { isViewerLink } from '../api/server-auth';
import { followServerEvents } from '../api/follow-server-events';

interface WatchEvent {
  type: 'file-changed' | 'file-added' | 'file-deleted' | 'semantic-reload';
  path?: string;
}

/**
 * Connects to the server's SSE /api/watch endpoint and reacts to
 * file-system changes in the project's notebook directories.
 *
 * - file-added / file-deleted → refresh the file list
 * - file-changed → if it's the active file, re-read and prompt user
 */
export function useHotReload() {
  const dispatch = useDispatch();
  const queryClient = useQueryClient();

  useEffect(() => {
    // A read-only link reads one App; it does not follow project files.
    if (isViewerLink()) return undefined;
    let alive = true;
    let filesTimer: ReturnType<typeof setTimeout> | null = null;
    let domainsTimer: ReturnType<typeof setTimeout> | null = null;
    let semanticTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFiles = () => {
      if (filesTimer) clearTimeout(filesTimer);
      filesTimer = setTimeout(() => {
        filesTimer = null;
        void api.listNotebooks().then((files) => {
          if (alive) {
            queryClient.setQueryData(['notebooks'], files);
            dispatch({ type: 'SET_FILES', files });
          }
        }).catch(() => undefined);
      }, 150);
    };
    const scheduleDomains = () => {
      if (domainsTimer) clearTimeout(domainsTimer);
      domainsTimer = setTimeout(() => {
        domainsTimer = null;
        void api.getDomains().then(({ domains }) => {
          if (alive) {
            queryClient.setQueryData(['authored-domains'], { domains });
            dispatch({ type: 'SET_AUTHORED_DOMAINS', domains });
          }
        }).catch(() => undefined);
      }, 150);
    };
    const scheduleSemantic = () => {
      if (semanticTimer) clearTimeout(semanticTimer);
      semanticTimer = setTimeout(() => {
        semanticTimer = null;
        dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
        void api.getSemanticLayer().then((layer) => {
          if (alive) {
            queryClient.setQueryData(['semantic-layer'], layer);
            dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
          }
        }).catch(() => undefined);
      }, 100);
    };

    // Opened again when it fails; in the app for Snowflake, not once ZLens stopped (follow-server-events.ts).
    const stopFollowing = followServerEvents('/api/watch', (frame) => {
      if (frame.event !== 'change') return;
      try {
        const event: WatchEvent = JSON.parse(frame.data) as WatchEvent;

        if (event.type === 'file-added' || event.type === 'file-deleted' || event.type === 'file-changed') {
          const changedPath = event.path ?? '';
          if (/^(?:notebooks|workbooks|blocks|skills|apps|dashboards)\//.test(changedPath)) scheduleFiles();
          if (changedPath.startsWith('domains/')) {
            scheduleFiles();
            scheduleDomains();
          }
        }

        if (event.type === 'semantic-reload') {
          scheduleSemantic();
        }
      } catch {
        // ignore parse errors
      }
    });

    return () => {
      alive = false;
      stopFollowing();
      if (filesTimer) clearTimeout(filesTimer);
      if (domainsTimer) clearTimeout(domainsTimer);
      if (semanticTimer) clearTimeout(semanticTimer);
    };
  }, [dispatch, queryClient]); // only mount/unmount once
}
