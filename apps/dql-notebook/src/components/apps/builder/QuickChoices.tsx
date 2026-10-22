import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BarChart3, Database, Gauge, LineChart, Plus, Sparkles, X } from 'lucide-react';
import {
  QUICK_CHOICE_KIND_LABELS,
  QUICK_CHOICE_LIMIT,
  QUICK_TOP_N_CHOICES,
  CONNECT_AI_TO_DESCRIBE_IN_WORDS,
  defaultQuickChoices,
  newQuickChoice,
  quickChoiceTitle,
  quickDataOf,
  quickDimensionOptions,
  quickKindAvailable,
  quickMeasureOptions,
  updateQuickChoice,
  type QuickChoice,
  type QuickChoiceKind,
  type QuickData,
  type QuickField,
} from './quick-choices';

const KIND_ICONS: Record<QuickChoiceKind, JSX.Element> = {
  kpi: <Gauge size={13} />,
  trend: <LineChart size={13} />,
  top: <BarChart3 size={13} />,
};

/** Fields grouped as the Data pane groups them: by data, related fields under "Orders → Customer". */
function FieldOptions({ fields, data }: { fields: readonly QuickField[]; data: readonly QuickData[] }): JSX.Element {
  const groups: Array<{ label: string; fields: QuickField[] }> = [];
  for (const field of fields) {
    const owner = quickDataOf(data, field.key);
    const label = `${field.group}${owner && !owner.certified ? ' · Needs review' : field.review ? ' · Needs review' : ''}`;
    let group = groups.find((candidate) => candidate.label === label);
    if (!group) {
      group = { label, fields: [] };
      groups.push(group);
    }
    group.fields.push(field);
  }
  return <>{groups.map((group) => <optgroup key={group.label} label={group.label}>
    {group.fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
  </optgroup>)}</>;
}

/**
 * The three quick choices (round-2 design Q2): KPI, Trend and Top rows built
 * from pickers over the App's data, "+ another tile" up to six, and one
 * button that builds exactly what is shown. Used by the Quick start step of a
 * new App and by the canvas's Quick tiles panel.
 */
export function QuickChoices({
  data,
  busy = false,
  submitLabel,
  error,
  onSubmit,
}: {
  data: readonly QuickData[];
  busy?: boolean;
  /** The button's words for this many tiles: "Build App", "Add 3 tiles to page". */
  submitLabel: (count: number) => string;
  error?: string | null;
  onSubmit: (choices: QuickChoice[]) => void;
}): JSX.Element {
  const dataKey = data.map((entry) => entry.sourceId).join('\n');
  const [choices, setChoices] = useState<QuickChoice[]>(() => defaultQuickChoices(data));
  // New data in the App: start again from its fields.
  useEffect(() => { setChoices(defaultQuickChoices(data)); }, [dataKey]);
  const dimensions = useMemo(() => quickDimensionOptions(data), [data]);
  const replace = (id: string, patch: Partial<Omit<QuickChoice, 'id' | 'kind'>>) => setChoices((current) => current.map((choice) => choice.id === id ? updateQuickChoice(data, choice, patch) : choice));
  const add = (kind: QuickChoiceKind) => setChoices((current) => {
    const like = current.find((choice) => choice.kind === 'kpi')?.measure ?? current[0]?.measure;
    const choice = newQuickChoice(data, kind, { measure: like });
    return choice && current.length < QUICK_CHOICE_LIMIT ? [...current, choice] : current;
  });
  const full = choices.length >= QUICK_CHOICE_LIMIT;
  return <div className="quick-choices">
    <ol className="quick-choice-list" aria-label="Tiles to build">
      {choices.map((choice, index) => {
        const n = index + 1;
        const title = quickChoiceTitle(data, choice);
        const measures = quickMeasureOptions(data, choice.kind, choice.dimension);
        const time = choice.kind === 'trend' ? quickDataOf(data, choice.measure)?.time : undefined;
        const measureSelect = <select aria-label={`Tile ${n}: measure`} value={choice.measure} disabled={busy} onChange={(event) => replace(choice.id, { measure: event.target.value })}><FieldOptions fields={measures} data={data} /></select>;
        return <li key={choice.id} className={`quick-choice quick-choice-${choice.kind}`} aria-label={`Tile ${n}: ${QUICK_CHOICE_KIND_LABELS[choice.kind]}`}>
          <span className="quick-choice-kind">{KIND_ICONS[choice.kind]} {QUICK_CHOICE_KIND_LABELS[choice.kind]}</span>
          <span className="quick-choice-sentence">
            {choice.kind === 'kpi' ? <><span>Total of</span>{measureSelect}</> : null}
            {choice.kind === 'trend' ? <>{measureSelect}<span>by</span><select aria-label={`Tile ${n}: time grain`} value={choice.grain ?? time?.defaultGrain ?? ''} disabled={busy} onChange={(event) => replace(choice.id, { grain: event.target.value })}>
              {(time?.grains ?? []).map((grain) => <option key={grain} value={grain}>{grain}</option>)}
            </select>{time ? <small className="quick-choice-time" title={`Grouped by ${time.label}, the main date of this data`}>of {time.label}</small> : null}</> : null}
            {choice.kind === 'top' ? <><span>Top</span><select aria-label={`Tile ${n}: how many`} value={String(choice.n ?? 10)} disabled={busy} onChange={(event) => replace(choice.id, { n: Number(event.target.value) })}>
              {QUICK_TOP_N_CHOICES.map((count) => <option key={count} value={count}>{count}</option>)}
            </select><select aria-label={`Tile ${n}: rank`} value={choice.dimension ?? ''} disabled={busy} onChange={(event) => replace(choice.id, { dimension: event.target.value })}><FieldOptions fields={dimensions} data={data} /></select><span>by</span>{measureSelect}</> : null}
          </span>
          <small className="quick-choice-title">{title ? <>Title: <strong>{title}</strong></> : 'Pick the fields'}</small>
          <button type="button" className="quick-choice-remove" disabled={busy || choices.length <= 1} onClick={() => setChoices((current) => current.filter((item) => item.id !== choice.id))} aria-label={`Remove tile ${n}`} title="Remove this tile"><X size={13} /></button>
        </li>;
      })}
    </ol>
    <div className="quick-choice-add" role="group" aria-label="Add another tile">
      <span>{full ? `Up to ${QUICK_CHOICE_LIMIT} tiles at once` : 'Add another tile'}</span>
      {(['kpi', 'trend', 'top'] as const).map((kind) => <button key={kind} type="button" disabled={busy || full || !quickKindAvailable(data, kind)} onClick={() => add(kind)} aria-label={`Add a ${QUICK_CHOICE_KIND_LABELS[kind]} tile`}><Plus size={12} /> {QUICK_CHOICE_KIND_LABELS[kind]}</button>)}
    </div>
    {error ? <div className="studio-error" role="alert">{error}</div> : null}
    <button type="button" className="primary quick-choice-submit" disabled={busy || choices.length === 0} onClick={() => onSubmit(choices)}>{busy ? 'Building…' : submitLabel(choices.length)}</button>
  </div>;
}

/** No AI is used, and this says so where the choices are made. */
function QuickStartNote({ onConnectAi }: { onConnectAi?: () => void }): JSX.Element {
  return <small className="quick-start-note">No AI is used: you get exactly the tiles you pick.{onConnectAi ? <> <button type="button" className="link" onClick={onConnectAi}>{CONNECT_AI_TO_DESCRIBE_IN_WORDS}</button></> : null}</small>;
}

/**
 * Quick start for a new App with no AI provider: after its data is picked,
 * "What should this App show?" with the three quick choices, then Build App.
 */
export function QuickStartStep({
  appName,
  data,
  busy,
  error,
  onBack,
  onBackToData,
  onBuild,
  onConnectAi,
}: {
  appName: string;
  data: readonly QuickData[];
  busy: boolean;
  error?: string | null;
  onBack: () => void;
  onBackToData: () => void;
  onBuild: (choices: QuickChoice[]) => void;
  onConnectAi?: () => void;
}): JSX.Element {
  const usable = quickKindAvailable(data, 'kpi');
  return <section className="studio-data-step quick-start-step" aria-labelledby="quick-start-title">
    <header className="data-step-header">
      <button type="button" className="ghost-icon" onClick={onBack} aria-label="Back to Apps" title="Back to Apps"><ArrowLeft size={16} /></button>
      <div>
        <small>{appName}</small>
        <h1 id="quick-start-title">What should this App show?</h1>
        <p>Pick a total, a trend and a top list from this App's data. Add up to {QUICK_CHOICE_LIMIT} tiles; you can change everything later on the page.</p>
        <QuickStartNote {...(onConnectAi ? { onConnectAi } : {})} />
      </div>
    </header>
    {usable
      ? <QuickChoices data={data} busy={busy} error={error ?? null} submitLabel={() => 'Build App'} onSubmit={onBuild} />
      : <div className="data-step-empty quick-start-empty"><Database size={18} aria-hidden="true" /><p><strong>No numbers to add up yet</strong><small>None of this App's data has a measure. Go back and add a table, Metrics or a saved query with numbers.</small></p></div>}
    <footer className="data-step-footer">
      <button type="button" onClick={onBackToData} disabled={busy}>Back to data</button>
    </footer>
  </section>;
}

/**
 * The canvas's Quick tiles panel with no AI provider: the same quick choices,
 * added to the page that is open.
 */
export function QuickTilesPanel({
  pageTitle,
  data,
  busy,
  error,
  onAdd,
  onAddData,
  onClose,
  onConnectAi,
}: {
  pageTitle: string;
  data: readonly QuickData[];
  busy: boolean;
  error?: string | null;
  onAdd: (choices: QuickChoice[]) => void;
  onAddData: () => void;
  onClose: () => void;
  onConnectAi?: () => void;
}): JSX.Element {
  const usable = quickKindAvailable(data, 'kpi');
  return <aside className="studio-right studio-quick-panel" aria-label="Quick tiles">
    <header>
      <div><small>QUICK TILES</small><strong>Add tiles to {pageTitle}</strong></div>
      <button type="button" className="ghost-icon" onClick={onClose} aria-label="Close quick tiles"><X size={15} /></button>
    </header>
    <div className="inspector-body">
      <QuickStartNote {...(onConnectAi ? { onConnectAi } : {})} />
      {usable
        ? <QuickChoices data={data} busy={busy} error={error ?? null} submitLabel={(count) => `Add ${count} ${count === 1 ? 'tile' : 'tiles'} to page`} onSubmit={onAdd} />
        : <div className="data-step-empty"><Sparkles size={16} aria-hidden="true" /><p><strong>Add data with numbers first</strong><small>Quick tiles use this App's data. Add a table, Metrics or a saved query with a measure.</small></p><button type="button" onClick={onAddData}><Plus size={13} /> Add data</button></div>}
    </div>
  </aside>;
}
