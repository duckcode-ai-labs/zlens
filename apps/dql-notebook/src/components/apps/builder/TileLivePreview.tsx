import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import { api, type DatasetTileQueryPreview } from '../../../api/client';

type PreviewState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ready'; preview: Extract<DatasetTileQueryPreview, { ok: true }> }
  | { state: 'failed'; message: string };

const PREVIEW_ROWS = 6;

/**
 * Live preview of the field query being built, before it becomes a tile.
 * Each edit waits briefly, then runs through the governed Dataset runtime;
 * a newer edit cancels the older request, so only the latest query's result
 * is ever shown. Nothing here is App evidence: adding the tile still runs a
 * real page preview.
 */
export function TileLivePreview({
  sourceId,
  query,
  runnable,
  reason,
  debounceMs = 450,
}: {
  sourceId?: string;
  query: TileQuery;
  /** False while the query is incomplete or refused by the contract. */
  runnable: boolean;
  /** Shown instead of a result when the query cannot run yet. */
  reason?: string;
  debounceMs?: number;
}): JSX.Element {
  const [status, setStatus] = useState<PreviewState>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify(query);
  const latest = useRef(0);

  useEffect(() => {
    if (!sourceId || !runnable) {
      setStatus({ state: 'idle' });
      return;
    }
    const ticket = ++latest.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus({ state: 'running' });
      api.previewDatasetTileQuery({ sourceId, query }, controller.signal)
        .then((preview) => {
          if (ticket !== latest.current) return;
          setStatus(preview.ok
            ? { state: 'ready', preview }
            : { state: 'failed', message: preview.error || 'This query did not return a result.' });
        })
        .catch(() => {
          // An aborted request was superseded by a newer edit.
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sourceId, key, runnable, attempt, debounceMs]);

  const rows = status.state === 'ready' ? status.preview.result?.rows ?? [] : [];
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  const total = status.state === 'ready' ? status.preview.result?.rowCount ?? rows.length : 0;
  const adaptations = status.state === 'ready' ? status.preview.validation?.adaptations ?? [] : [];

  return <section className="dataset-live-preview" aria-label="Live preview" aria-live="polite">
    <header>
      <strong>Live preview</strong>
      <small>{status.state === 'running' ? 'Running…' : status.state === 'ready' ? `${total} row${total === 1 ? '' : 's'}` : 'Updates as you edit'}</small>
      {status.state === 'failed' ? <button type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={11} /> Retry</button> : null}
    </header>
    {!runnable ? <p className="dataset-live-preview-note">{reason || 'Choose at least one measure, or switch to row details.'}</p> : null}
    {runnable && status.state === 'failed' ? <p className="dataset-builder-error" role="alert">{status.message}</p> : null}
    {adaptations.map((adaptation) => <p key={adaptation.kind} className="dataset-live-preview-note">{adaptation.message}</p>)}
    {status.state === 'ready' ? (status.preview.nameWarnings ?? []).map((warning) => <p key={warning.field} className="dataset-live-preview-note" role="note">{warning.message}</p>) : null}
    {runnable && status.state === 'ready' && rows.length === 0 ? <p className="dataset-live-preview-note">No rows match.</p> : null}
    {rows.length ? <div className="dataset-live-preview-table">
      <table>
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{rows.slice(0, PREVIEW_ROWS).map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}</tr>)}</tbody>
      </table>
      {total > PREVIEW_ROWS ? <small>Showing {PREVIEW_ROWS} of {total}.</small> : null}
    </div> : null}
  </section>;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return String(value);
}
