import { useState } from 'react';
import { Blocks, Play, ShieldCheck } from 'lucide-react';
import { api, type AppBlockRecommendation } from '../../../api/client';
import type { DatasetDescriptor, DatasetMeasureField } from '@zlens/core/datasets/descriptor';
import { datasetTileVisualizationCompatibility, tileQueryValidationRuns, validateTileQuery, type TileQuery } from '@zlens/core/apps/tile-query';
import { TileQueryEditor } from '../builder/TileQueryEditor';
import { TileLivePreview } from '../builder/TileLivePreview';
import { humanize } from './studio-ui';

/**
 * The primary M1 authoring surface. It turns an approved Dataset projection
 * into a deterministic TileQuery; it never exposes source SQL or asks the
 * browser to infer a measure/field contract.
 */
export function DatasetTileBuilder({
  source,
  disabled,
  onAdd,
}: {
  source: AppBlockRecommendation;
  disabled: boolean;
  onAdd: (source: AppBlockRecommendation, view: 'kpi' | 'chart' | 'table', query: TileQuery, title?: string) => void;
}): JSX.Element {
  const descriptor = source.capabilities?.dataset as DatasetDescriptor;
  const firstMeasure = descriptor.fields.find((field): field is DatasetMeasureField => field.kind === 'measure' && field.status === 'approved');
  const [query, setQuery] = useState<TileQuery>(() => ({
    dimensions: [],
    measures: firstMeasure ? [{ measure: firstMeasure.name }] : [],
    respectsGlobalFilters: true,
  }));
  const [view, setView] = useState<'kpi' | 'chart' | 'table'>('chart');
  const [title, setTitle] = useState('');
  const [sourceValidation, setSourceValidation] = useState<{ state: 'idle' | 'running' | 'passed' | 'failed'; message?: string }>({ state: 'idle' });
  const detail = query.detail === true;
  const detailSourceEligible = descriptor.kind === 'block'
    && (descriptor.binding.state === 'valid' || sourceValidation.state === 'passed');
  const effectiveView = detail ? 'table' : view;
  const validation = validateTileQuery(descriptor, query);
  const visualization = datasetTileVisualizationCompatibility(query, effectiveView === 'kpi' ? 'kpi' : effectiveView === 'table' ? 'table' : 'bar');
  const blockingMessage = !tileQueryValidationRuns(validation)
    ? validation.diagnostics[0]?.message ?? 'Choose at least one measure, or switch to row details.'
    : detail && !detailSourceEligible
      ? 'Validate the complete source key before adding a detail tile. ZLens will recheck it on every run.'
      : !visualization.compatible ? visualization.message : undefined;
  const changeQuery = (next: TileQuery) => {
    setQuery(next);
    // A comparison or grouped selection cannot show as a single KPI value.
    // Move to the lossless view instead of silently dropping outputs.
    const compatibility = datasetTileVisualizationCompatibility(next, view === 'kpi' ? 'kpi' : view === 'table' ? 'table' : 'bar');
    if (!compatibility.compatible && compatibility.recoveryVisualization) setView(compatibility.recoveryVisualization);
  };
  const validateSourceGrain = async () => {
    const sourceId = source.sourceId?.trim();
    if (!sourceId) {
      setSourceValidation({ state: 'failed', message: 'Refresh this source before validation so ZLens can use its exact Dataset identity.' });
      return;
    }
    setSourceValidation({ state: 'running' });
    const result = await api.validateDatasetGrain({ sourceId, sourceRevision: source.sourceRevision });
    if (result.ok && result.eligible) {
      const uniqueness = result.evidence?.uniqueness;
      setSourceValidation({
        state: 'passed',
        message: uniqueness
          ? `Validated ${uniqueness.rowCount} source rows with ${uniqueness.distinctKeyCount} distinct declared keys. Each preview will check again.`
          : 'Declared source keys were validated for the active target. Each preview will check again.',
      });
      return;
    }
    setSourceValidation({ state: 'failed', message: result.error || 'The declared Dataset keys were not unique on the active target. Fix the source or contract, then validate again.' });
  };
  const needsKeyValidation = descriptor.kind === 'block' && (descriptor.binding.state !== 'valid' || detail);
  const defaultTitle = detail
    ? `${descriptor.label} rows`
    : `${humanize(query.measures[0]?.measure ?? 'Measure')}${query.dimensions[0] ? ` by ${humanize(query.dimensions[0].field)}` : ''}`;
  return <section className="dataset-tile-builder" aria-label={`Build a tile from ${descriptor.label}`}>
    <header><span><Blocks size={13} /></span><div><small>{descriptor.label.toUpperCase()}</small><strong>Pick measures and a grouping. The preview updates as you go.</strong></div></header>
    <p className="dataset-builder-description">{descriptor.trust === 'certified' ? 'Certified Dataset' : 'Dataset · Needs review'} · fields compile to governed SQL on every run.</p>
    {!detail ? <label><span>Show as</span><select value={view} disabled={disabled} onChange={(event) => {
      const next = event.target.value as typeof view;
      setView(next);
      if (next === 'kpi' && query.dimensions.length) {
        const { orderBy: _orderBy, limit: _limit, ...rest } = query;
        setQuery({ ...rest, dimensions: [] });
      }
    }}><option value="chart">Chart</option><option value="table">Table</option><option value="kpi">KPI</option></select></label> : null}
    <TileQueryEditor descriptor={descriptor} query={query} disabled={disabled} onChange={changeQuery} idPrefix={`dataset-builder-${source.sourceId ?? source.id}`} />
    <TileLivePreview sourceId={source.sourceId} query={query} runnable={tileQueryValidationRuns(validation)} reason={validation.diagnostics[0]?.message} />
    <label><span>Tile title <small>Optional</small></span><input value={title} disabled={disabled} onChange={(event) => setTitle(event.target.value)} placeholder={defaultTitle} /></label>
    {needsKeyValidation ? <>
      <small className="dataset-binding-note">{sourceValidation.state === 'passed' ? sourceValidation.message : detail ? 'Row details need the Dataset key validated on the active warehouse.' : 'ZLens checks the Dataset key on the active warehouse when the tile runs. You can validate it now.'}</small>
      <button type="button" className="dataset-validate-source" disabled={disabled || sourceValidation.state === 'running'} onClick={() => void validateSourceGrain()}><ShieldCheck size={12} /> {sourceValidation.state === 'running' ? 'Validating full source…' : sourceValidation.state === 'passed' ? 'Validate source keys again' : 'Validate source keys'}</button>
    </> : null}
    {sourceValidation.state === 'failed' && sourceValidation.message ? <small className="dataset-builder-error" role="alert">{sourceValidation.message}</small> : null}
    {blockingMessage ? <small className="dataset-builder-error" role="alert">{blockingMessage}</small> : null}
    <button type="button" className="primary dataset-add-tile" disabled={disabled || Boolean(blockingMessage)} onClick={() => onAdd(source, effectiveView, query, title.trim() || defaultTitle)}><Play size={13} /> Add tile</button>
  </section>;
}
