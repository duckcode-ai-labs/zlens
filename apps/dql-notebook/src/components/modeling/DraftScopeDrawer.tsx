import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { api, type DraftScopeRequest, type DraftScopeResponse } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';

/**
 * Choose what to draft in a large dbt project (model-at-scale design S3):
 * a whole Domain or subject area, some tables and their neighbours, or a dbt
 * selector. The footer says how many tables the pick drafts before anything
 * runs; over the budget, the most important are drafted and the rest listed.
 */

type Mode = 'areas' | 'tables' | 'selector';

const words = (id: string) => {
  const text = id.replace(/[._]+/g, ' ').trim();
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : id;
};
const plural = (count: number, noun: string, many = `${noun}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? noun : many}`;

export function DraftScopeDrawer({ theme, drafting, hybrid = false, onClose, onDraft }: {
  theme: Theme;
  drafting: boolean;
  /** A dbt project with warehouse tables beside it: draft its dbt models or its warehouse tables. */
  hybrid?: boolean;
  onClose: () => void;
  onDraft: (scope: DraftScopeRequest, source: 'dbt' | 'warehouse') => void;
}): JSX.Element {
  const [side, setSide] = useState<'dbt' | 'warehouse'>('dbt');
  const [mode, setMode] = useState<Mode>('areas');
  const [areas, setAreas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [neighbours, setNeighbours] = useState(false);
  const [selector, setSelector] = useState('');
  const [q, setQ] = useState('');
  const [businessOnly, setBusinessOnly] = useState(true);
  const [response, setResponse] = useState<DraftScopeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const select = useMemo(() => {
    if (mode === 'areas') return areas;
    if (mode === 'tables') return tables;
    return selector.split(/\s+/).map((term) => term.trim()).filter(Boolean);
  }, [mode, areas, tables, selector]);
  const hops = mode === 'tables' && neighbours ? 1 : undefined;

  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api.draftScope({ select, ...(hops ? { hops } : {}), ...(mode === 'tables' ? { q, businessOnly } : {}) })
        .then((next) => { if (live) { setResponse(next); setError(null); } })
        .catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [select, hops, mode, q, businessOnly]);

  const choices = response?.choices;
  const preview = response?.preview;
  const picked = select.length > 0;
  const toggle = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((item) => item !== value));
  const hidden = choices ? choices.layers.intermediate + choices.layers.aside + choices.layers.snapshot + choices.layers.staging + choices.layers.raw : 0;

  return (
    <div onClick={() => !drafting && onClose()} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(8,10,16,.46)', display: 'flex', justifyContent: 'flex-end' }}>
      <aside role="dialog" aria-modal="true" aria-label="Choose what to draft" onClick={(event) => event.stopPropagation()} style={{ width: 'min(620px, 96vw)', height: '100%', background: theme.appBg, borderLeft: '1px solid var(--border-default)', boxShadow: '-16px 0 45px rgba(0,0,0,.22)', display: 'flex', flexDirection: 'column' }}>
        <header style={{ minHeight: 58, padding: '10px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ flex: 1 }}>
            <b style={{ display: 'block', fontSize: 14 }}>Choose what to draft</b>
            <small style={{ color: theme.textMuted }}>
              {choices ? `${hybrid && response?.warehouse ? `${plural(choices.tables, 'dbt table')} and ${plural(response.warehouse.tables, 'warehouse table')}` : plural(choices.tables, 'table')} in this project. A draft reads and checks up to ${choices.budget} at a time.` : 'Reading the project…'}
            </small>
          </div>
          <button type="button" aria-label="Close" disabled={drafting} onClick={onClose} style={{ ...secondary(theme), width: 30, padding: 0 }}><X size={14} /></button>
        </header>

        <div style={{ padding: '12px 18px 0', display: 'grid', gap: 10 }}>
          {hybrid ? (
            <div role="group" aria-label="Draft from" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: theme.textMuted }}>Draft from</span>
              {([['dbt', 'dbt models'], ['warehouse', 'Warehouse tables']] as Array<['dbt' | 'warehouse', string]>).map(([value, text]) => (
                <button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)} style={{ ...secondary(theme), ...(side === value ? { borderColor: theme.accent, color: theme.accent, fontWeight: 650 } : {}) }}>{text}</button>
              ))}
            </div>
          ) : null}
          {side === 'warehouse' ? (
            <p style={{ margin: 0, fontSize: 11.5, color: theme.textSecondary, lineHeight: 1.5 }}>{warehouseNote(response?.warehouse)}</p>
          ) : null}
          {side === 'dbt' && choices ? (
            <p style={{ margin: 0, fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>{layerNote(choices)}</p>
          ) : null}
          {side === 'dbt' ? <div role="group" aria-label="How to choose" style={{ display: 'inline-flex', gap: 6 }}>
            {([['areas', 'By area'], ['tables', 'Tables'], ['selector', 'dbt selector']] as Array<[Mode, string]>).map(([value, text]) => (
              <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} style={{ ...secondary(theme), ...(mode === value ? { borderColor: theme.accent, color: theme.accent, fontWeight: 650 } : {}) }}>{text}</button>
            ))}
          </div> : null}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 18px' }}>
          {error ? <p role="alert" style={{ color: 'var(--status-error, #c53030)', fontSize: 11.5 }}>{error}</p> : null}

          {side === 'dbt' && mode === 'areas' && choices ? (
            choices.areas.length === 0
              ? <p style={{ fontSize: 11.5, color: theme.textSecondary }}>No Domains or subject areas found in this project. Pick tables, or use a dbt selector.</p>
              : (
                <div role="list" aria-label="Domains and subject areas" style={{ display: 'grid', gap: 6 }}>
                  {choices.areas.map((item) => (
                    <label key={item.select} role="listitem" style={{ ...row(theme), marginLeft: item.area ? 22 : 0 }}>
                      <input type="checkbox" checked={areas.includes(item.select)} disabled={drafting} onChange={(event) => setAreas((current) => toggle(current, item.select, event.target.checked))} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <b style={{ fontSize: item.area ? 11.5 : 12 }}>{areaRow(item).title}</b>
                        <span style={{ display: 'block', fontSize: 10.5, color: theme.textMuted, marginTop: 2 }}>{areaRow(item).detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )
          ) : null}

          {side === 'dbt' && mode === 'tables' ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: theme.textMuted }} />
                <input autoFocus aria-label="Search tables" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search table name or relation" style={{ ...input(theme), width: '100%', paddingLeft: 32 }} />
              </div>
              <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11, color: theme.textSecondary }}>
                <input type="checkbox" checked={businessOnly} onChange={(event) => setBusinessOnly(event.target.checked)} />
                Business tables only{choices && hidden ? ` (${hidden.toLocaleString('en-US')} others hidden)` : ''}
              </label>
              <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11, color: theme.textSecondary }}>
                <input type="checkbox" checked={neighbours} onChange={(event) => setNeighbours(event.target.checked)} />
                Also draft their neighbours: what they read and what reads them, one step each way
              </label>
              {tables.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {tables.map((name) => (
                    <button key={name} type="button" aria-label={`Remove ${name}`} onClick={() => setTables((current) => current.filter((item) => item !== name))} style={{ ...secondary(theme), minHeight: 24, fontSize: 10.5 }}>{name} <X size={11} /></button>
                  ))}
                </div>
              ) : null}
              <div role="list" aria-label="Tables" style={{ display: 'grid', gap: 5 }}>
                {(response?.tables?.items ?? []).map((item) => (
                  <label key={item.id} role="listitem" style={row(theme)}>
                    <input type="checkbox" checked={tables.includes(item.name)} disabled={drafting} onChange={(event) => setTables((current) => toggle(current, item.name, event.target.checked))} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>{item.name}</b>
                      <span style={{ display: 'block', fontSize: 10, color: theme.textMuted, marginTop: 2, overflowWrap: 'anywhere' }}>
                        {item.relation}{item.area ? ` · ${words(item.area)}` : item.domain ? ` · ${words(item.domain)}` : ''}{item.business ? '' : ` · ${item.layer}`}{item.readers ? ` · read by ${plural(item.readers, 'model')}` : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {response?.tables ? <small style={{ color: theme.textMuted }}>Showing {Math.min(response.tables.items.length, response.tables.total).toLocaleString('en-US')} of {plural(response.tables.total, 'match', 'matches')}{response.tables.total > response.tables.items.length ? '. Type more of the name to narrow it.' : '.'}</small> : null}
            </div>
          ) : null}

          {side === 'dbt' && mode === 'selector' ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <input autoFocus aria-label="dbt selector" value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="+fct_orders path:models/marts tag:finance area:sales" style={{ ...input(theme), width: '100%', fontFamily: 'var(--font-mono, monospace)' }} />
              <small style={{ color: theme.textMuted, lineHeight: 1.5 }}>
                As dbt picks, any term may match: a name or <code>fct_*</code>; <code>+name</code> adds what it reads and <code>name+</code> what reads it; <code>path:</code>, <code>tag:</code>, <code>schema:</code>, <code>package:</code>, <code>source:</code>; and <code>domain:</code> or <code>area:</code> for a proposed Domain or subject area. The same terms work in <code>zlens model draft --select</code>.
              </small>
            </div>
          ) : null}
        </div>

        <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--border-subtle)', display: 'grid', gap: 8 }}>
          <div aria-live="polite" style={{ fontSize: 11.5, color: theme.textSecondary, lineHeight: 1.5 }}>{side === 'warehouse' ? (response?.warehouse?.tables ? `Drafts the ${plural(response.warehouse.tables, 'warehouse table')} dbt does not build, checked on the warehouse.` : '') : pickSummary(picked, loading, preview)}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={onClose} disabled={drafting} style={secondary(theme)}>Cancel</button>
            {side === 'warehouse' ? (
              <button type="button" disabled={drafting || !response?.warehouse?.tables} onClick={() => onDraft({}, 'warehouse')} style={{ ...primary(theme), opacity: drafting || !response?.warehouse?.tables ? .55 : 1 }}>
                {drafting ? <Loader2 size={13} /> : null}{drafting ? 'Drafting…' : response?.warehouse?.tables ? `Draft ${plural(response.warehouse.tables, 'warehouse table')}` : 'Draft'}
              </button>
            ) : (
              <button type="button" disabled={drafting || loading || !picked || !preview?.drafted} onClick={() => onDraft({ select, ...(hops ? { hops } : {}) }, 'dbt')} style={{ ...primary(theme), opacity: drafting || loading || !picked || !preview?.drafted ? .55 : 1 }}>
                {drafting ? <Loader2 size={13} /> : null}{drafting ? 'Drafting…' : picked && preview?.drafted ? `Draft ${plural(preview.drafted, 'table')}` : 'Draft'}
              </button>
            )}
          </div>
        </footer>
      </aside>
    </div>
  );
}

const input = (theme: Theme): React.CSSProperties => ({ boxSizing: 'border-box', border: '1px solid var(--border-default)', background: theme.inputBg, color: theme.textPrimary, borderRadius: 7, padding: '8px 9px', outline: 'none' });
const row = (theme: Theme): React.CSSProperties => ({ display: 'flex', gap: 9, alignItems: 'flex-start', border: '1px solid var(--border-subtle)', borderRadius: 8, background: theme.cellBg, padding: '9px 10px', cursor: 'pointer' });
const secondary = (theme: Theme): React.CSSProperties => ({ minHeight: 31, border: '1px solid var(--border-default)', borderRadius: 7, background: theme.cellBg, color: theme.textPrimary, padding: '0 11px', cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'center' });
const primary = (theme: Theme): React.CSSProperties => ({ ...secondary(theme), background: theme.accent, borderColor: theme.accent, color: 'var(--accent-fg)', fontWeight: 650 });

/** The line under the tabs: how many tables can be answered from, and what the other layers hold. */
export function layerNote(choices: DraftScopeResponse['choices']): string {
  const { business, intermediate, aside, snapshot, staging, raw } = choices.layers;
  const others = [
    intermediate ? `${intermediate.toLocaleString('en-US')} intermediate` : '',
    aside ? `${aside.toLocaleString('en-US')} team workspace and legacy` : '',
    snapshot ? `${snapshot.toLocaleString('en-US')} snapshot${snapshot === 1 ? '' : 's'}` : '',
    staging ? `${staging.toLocaleString('en-US')} staging` : '',
    raw ? `${raw.toLocaleString('en-US')} raw` : '',
  ].filter(Boolean);
  const hidden = intermediate + aside + snapshot + staging + raw;
  return `${plural(business, 'business table')} to answer from.${hidden ? ` ${hidden.toLocaleString('en-US')} more are not offered by area: ${others.join(', ')}.` : ''}`;
}

/** One Domain or area in the list. */
export function areaRow(item: DraftScopeResponse['choices']['areas'][number]): { title: string; detail: string } {
  return {
    title: item.shared ? 'Shared' : words(item.area ?? item.domain),
    detail: `${plural(item.tables, 'table')}${item.reads ? `, and ${item.reads.toLocaleString('en-US')} they read` : ''}${item.shared ? ' · read by several areas; drafted once, with the first area that reads them' : item.area ? '' : ' · the whole Domain'}`,
  };
}

/** The footer: what the pick drafts, before anything runs. */
export function pickSummary(picked: boolean, loading: boolean, preview: DraftScopeResponse['preview'] | undefined): string {
  if (!picked) return 'Pick an area, some tables or a selector.';
  if (!preview) return loading ? 'Counting…' : '';
  if (preview.asked === 0) return 'Nothing in the project matches this pick.';
  const first = `${plural(preview.asked, 'table')} picked.`;
  if (preview.leftOut > 0) {
    return `${first} ZLens drafts the ${preview.drafted} most important now and lists the other ${preview.leftOut.toLocaleString('en-US')}: business tables first, then the ones dbt exposures use, then the ones many models read.`;
  }
  return `${first} ${preview.asked === 1 ? 'Only this table is' : 'Only these are'} read from the warehouse and checked.`;
}

/** The warehouse side of a hybrid project: the synced tables dbt does not build. */
export function warehouseNote(warehouse: DraftScopeResponse['warehouse']): string {
  if (!warehouse) return 'Reading the warehouse catalog…';
  if (warehouse.tables === 0) {
    return `No warehouse tables outside dbt yet${warehouse.dbtBuilt ? ` (the ${plural(warehouse.dbtBuilt, 'synced table')} dbt builds are drafted as dbt models)` : ''}. Choose their schemas in Settings → Connections → Sync schema.`;
  }
  const schemas = warehouse.schemas.length > 5 ? `${warehouse.schemas.slice(0, 5).join(', ')} and ${warehouse.schemas.length - 5} more schemas` : warehouse.schemas.join(', ');
  const modeled = warehouse.modeled ? ` ${warehouse.modeled === warehouse.tables ? 'All of them are' : `${warehouse.modeled.toLocaleString('en-US')} are`} in the model already; a draft adds only what is new.` : '';
  return `${plural(warehouse.tables, 'warehouse table')} dbt does not build, in ${schemas}.${modeled}${warehouse.dbtBuilt ? ` The ${plural(warehouse.dbtBuilt, 'synced table')} dbt builds are drafted as dbt models, never twice; joins to the ones already in the model are drafted too.` : ''}`;
}
