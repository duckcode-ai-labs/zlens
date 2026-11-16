import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type LocalOperation,
} from '../api/client';
import { useNotebookStore } from '../store/NotebookStore';
import { isViewerLink } from '../api/server-auth';
import { followServerEvents } from '../api/follow-server-events';
import { useZLensStopped } from '../snowflake-app/zlens-stopped';
import {
  blockCertificationOperationsForReconciliation,
  isTerminalOperation,
  mergeOperation,
  mergeOperationLists,
  recoverTrackedOperationsById,
  seedListedNonterminalOperationIds,
} from './operation-state';

const OPERATIONS_QUERY_KEY = ['local-operations'] as const;

/**
 * Fired on `window` when a project refresh (manifest + lineage rebuild) finishes,
 * e.g. after a block save. Views that cache project-wide data (Lineage) reload on it
 * instead of depending on the server's file watcher.
 */
export const PROJECT_REFRESHED_EVENT = 'dql:project-refreshed';

interface OperationsContextValue {
  operations: LocalOperation[];
  activeCount: number;
  loading: boolean;
  cancel: (operationId: string) => Promise<void>;
  track: (operation: LocalOperation) => void;
}

const OperationsContext = createContext<OperationsContextValue | null>(null);

export function OperationsProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const handledTerminalOperations = useRef(new Set<string>());
  const trackedOperationIds = useRef(new Set<string>());
  const dispatch = useNotebookStore((state) => state.dispatch);
  const readOnlyLink = isViewerLink();
  // The app for Snowflake stopped: no more polls (any request would start it again).
  const stopped = useZLensStopped() !== null;
  const query = useQuery({
    queryKey: OPERATIONS_QUERY_KEY,
    queryFn: async () => {
      const listed = (await api.listOperations(50)).operations;
      const current = queryClient.getQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY) ?? [];
      return mergeOperationLists(current, listed);
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    // Polling is a recovery path if the authenticated event stream is dropped.
    // A read-only link has no operations to follow.
    enabled: !readOnlyLink && !stopped,
    refetchInterval: operationsPollMs(readOnlyLink, stopped),
  });
  const operations = query.data ?? [];

  useEffect(() => {
    if (readOnlyLink) return undefined;
    return followServerEvents('/api/operations/events', (frame) => {
      if (frame.event !== 'operation') return;
      try {
        const operation = JSON.parse(frame.data) as LocalOperation;
        queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
          mergeOperation(current, operation)
        ));
      } catch {
        // A malformed progress frame must not interrupt later updates.
      }
    });
  }, [queryClient]);

  useEffect(() => {
    // A provider remount loses its component-local ref even though durable
    // queued/running operations survive. Seed exact-id recovery from every
    // nonterminal operation returned by the list endpoint.
    seedListedNonterminalOperationIds(trackedOperationIds.current, operations);
  }, [operations]);

  useEffect(() => {
    if (stopped) return undefined;
    let alive = true;
    let recovering = false;
    const recoverTrackedOperations = async () => {
      if (recovering || trackedOperationIds.current.size === 0) return;
      recovering = true;
      try {
        await recoverTrackedOperationsById(
          trackedOperationIds.current,
          (operationId) => api.getOperation(operationId),
          (operation) => {
            if (!alive) return false;
            queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
              mergeOperation(current, operation)
            ));
          },
        );
      } finally {
        recovering = false;
      }
    };
    void recoverTrackedOperations();
    const timer = window.setInterval(() => void recoverTrackedOperations(), 1_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [queryClient, stopped]);

  useEffect(() => {
    for (const operation of blockCertificationOperationsForReconciliation(
      operations,
      handledTerminalOperations.current,
    )) {
      const result = operation.result;
      handledTerminalOperations.current.add(operation.id);
      dispatch({
        type: 'RECONCILE_BLOCK_CERTIFICATION',
        outcome: result.outcome,
        oldPath: result.oldPath,
        draftPath: result.draftPath,
        newPath: result.newPath,
        payload: result.block,
      });
      window.dispatchEvent(new CustomEvent('dql:block-library-invalidated', {
        detail: { operationId: operation.id, outcome: result.outcome },
      }));
    }
  }, [dispatch, operations]);

  // Announce project refreshes that complete while this tab is open. The ids
  // already finished when the list first loads are history, not news.
  const seenProjectRefreshes = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!query.data) return;
    const completed = operations.filter((operation) => operation.type === 'project_refresh' && operation.status === 'succeeded');
    if (!seenProjectRefreshes.current) {
      seenProjectRefreshes.current = new Set(completed.map((operation) => operation.id));
      return;
    }
    const seen = seenProjectRefreshes.current;
    const fresh = completed.filter((operation) => !seen.has(operation.id));
    if (fresh.length === 0) return;
    for (const operation of fresh) seen.add(operation.id);
    window.dispatchEvent(new CustomEvent(PROJECT_REFRESHED_EVENT, {
      detail: { operationIds: fresh.map((operation) => operation.id) },
    }));
  }, [operations, query.data]);

  const value = useMemo<OperationsContextValue>(() => ({
    operations,
    activeCount: operations.filter((operation) => operation.status === 'queued' || operation.status === 'running').length,
    loading: query.isLoading,
    cancel: async (operationId: string) => {
      const operation = await api.cancelOperation(operationId);
      trackedOperationIds.current.delete(operationId);
      queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
        mergeOperation(current, operation)
      ));
    },
    track: (operation: LocalOperation) => {
      if (isTerminalOperation(operation)) trackedOperationIds.current.delete(operation.id);
      else trackedOperationIds.current.add(operation.id);
      queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
        mergeOperation(current, operation)
      ));
    },
  }), [operations, query.isLoading, queryClient]);

  return <OperationsContext.Provider value={value}>{children}</OperationsContext.Provider>;
}

/** How often the operations list is polled: never for a read-only link, or once the app for Snowflake stopped. */
export function operationsPollMs(readOnlyLink: boolean, stopped: boolean): number | false {
  return readOnlyLink || stopped ? false : 1_500;
}

export function useOperations(): OperationsContextValue {
  const value = useContext(OperationsContext);
  if (!value) throw new Error('useOperations must be used inside OperationsProvider.');
  return value;
}
