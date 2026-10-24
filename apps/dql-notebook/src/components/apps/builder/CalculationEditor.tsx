import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { DatasetDescriptor, DatasetMeasureField } from '@zlens/core/datasets/descriptor';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import {
  checkTileCalculations,
  formatTileCalcExpr,
  parseTileFormula,
  uniqueCalculationId,
  type TileCalcExpr,
  type TileCalcOutput,
  type TileCalculation,
} from '@zlens/core/apps/tile-calcs';
import { humanize } from './studio-ui';

type Verdict =
  | { state: 'empty' }
  | { state: 'error'; message: string; at?: number }
  | { state: 'ok'; expr: TileCalcExpr; output: TileCalcOutput };

/** What a formula means, or the rule it breaks, checked as the author types. */
export function checkFormula(descriptor: DatasetDescriptor, query: TileQuery, text: string, id: string): Verdict {
  if (!text.trim()) return { state: 'empty' };
  const parsed = parseTileFormula(text, descriptor);
  if (!parsed.ok) return { state: 'error', message: parsed.message, at: parsed.at };
  const others = (query.calculations ?? []).filter((calculation) => calculation.id !== id);
  const check = checkTileCalculations(descriptor, { ...query, calculations: [...others, { id, expr: parsed.expr }] });
  const problem = check.diagnostics.find((diagnostic) => diagnostic.field === id) ?? check.diagnostics[0];
  if (problem) return { state: 'error', message: problem.message };
  const output = check.outputs.find((entry) => entry.id === id);
  return output ? { state: 'ok', expr: parsed.expr, output } : { state: 'error', message: 'This formula did not pass its checks.' };
}

function resultWords(output: TileCalcOutput): string {
  const unit = output.facts.unit;
  const kind = unit.kind === 'currency'
    ? `money${unit.currency ? ` (${unit.currency})` : ''}`
    : unit.kind === 'ratio' ? 'a rate, shown as a percent' : unit.kind === 'count' ? 'a count' : 'a number';
  const adds = output.facts.additive.entities ? 'adds up across rows' : 'does not add up across rows';
  return `Gives ${kind}; ${adds}.`;
}

/**
 * Write or edit a calculated measure (RFC 0009 step 3): a formula over the
 * Dataset's measures, checked as it is typed. Measures can be clicked in;
 * `where` restricts a measure to some rows.
 */
export function CalculationEditor({
  descriptor,
  query,
  editing,
  onSave,
  onCancel,
}: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  editing?: TileCalculation;
  onSave: (calculation: TileCalculation) => void;
  onCancel: () => void;
}): JSX.Element {
  const baseId = useId();
  const [name, setName] = useState(editing?.label ?? '');
  const [text, setText] = useState(editing?.expr ? formatTileCalcExpr(editing.expr) : '');
  const formulaRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = editing?.id ?? uniqueCalculationId(query, name.trim() || 'calculation');
  const verdict = useMemo(() => checkFormula(descriptor, query, text, id), [descriptor, query, text, id]);
  const measures = descriptor.fields.filter((field): field is DatasetMeasureField => field.kind === 'measure' && field.status === 'approved');
  // A new formula starts at its name; an existing one at its formula.
  useEffect(() => { (editing ? formulaRef.current : nameRef.current)?.focus(); }, []);

  const insert = (token: string) => {
    const area = formulaRef.current;
    const start = area?.selectionStart ?? text.length;
    const end = area?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const spacer = before && !/[\s(]$/.test(before) ? ' ' : '';
    const next = `${before}${spacer}${token}${text.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => {
      const caret = before.length + spacer.length + token.length;
      area?.focus();
      area?.setSelectionRange(caret, caret);
    });
  };
  const save = () => {
    if (verdict.state !== 'ok') return;
    onSave({ id, ...(name.trim() ? { label: name.trim() } : {}), expr: verdict.expr });
  };

  return (
    <form className="calc-editor" aria-label={editing ? 'Edit formula' : 'New formula'} onSubmit={(event) => { event.preventDefault(); save(); }}>
      <div className="calc-editor-row">
        <label htmlFor={`${baseId}-name`}>Name</label>
        <input id={`${baseId}-name`} ref={nameRef} value={name} maxLength={80} placeholder="Average order value" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="calc-editor-row">
        <label htmlFor={`${baseId}-formula`}>Formula</label>
        <textarea
          id={`${baseId}-formula`}
          ref={formulaRef}
          rows={2}
          spellCheck={false}
          value={text}
          placeholder="revenue / orders"
          aria-describedby={`${baseId}-check`}
          aria-invalid={verdict.state === 'error'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); }
            if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
          }}
        />
      </div>
      <div className="calc-editor-measures" role="group" aria-label="Insert a measure">
        {measures.map((measure) => (
          <button key={measure.name} type="button" onClick={() => insert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(measure.name) ? measure.name : `\`${measure.name}\``)}>{humanize(measure.name)}</button>
        ))}
      </div>
      <p id={`${baseId}-check`} className={`calc-editor-check ${verdict.state}`} role="status" aria-live="polite">
        {verdict.state === 'empty'
          ? <>Use + - * / and brackets over measures. Restrict one with <code>where</code>, e.g. <code>(revenue where region = 'US') / revenue</code>.</>
          : verdict.state === 'error'
            ? verdict.message
            : <><ShieldCheck size={12} aria-hidden="true" /> {resultWords(verdict.output)} Certified when every measure it uses is certified: checked arithmetic, nothing new to certify.</>}
      </p>
      <div className="calc-editor-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={verdict.state !== 'ok'}>{editing ? 'Save' : 'Add to tile'}</button>
      </div>
    </form>
  );
}
