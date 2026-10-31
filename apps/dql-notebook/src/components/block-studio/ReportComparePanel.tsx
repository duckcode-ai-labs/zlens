import { useState, type CSSProperties, type DragEvent } from 'react';
import { api } from '../../api/client';
import type { ReportCompareRecording, ReportCompareRequest, ReportComparison, ReportVerdict } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';

/**
 * Compare with the old report, on the Import screen: drop an export, say the
 * report's filters, read every difference. The same comparison as
 * `zlens migrate compare`, so its messages name the same options; on the
 * screen those are the fields here.
 */

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SHOWN_DIFFERENCES = 50;

const VERDICT_WORDS: Record<ReportVerdict, string> = { matches: 'Matches', differs: 'Differs', 'not-proven': 'Not proven' };

const OPTION_WORDS: Array<[RegExp, string]> = [
  [/--filter\b/g, 'Filters'],
  [/--waive\b/g, 'Waived filters'],
  [/--map\b/g, 'Column names'],
  [/--key\b/g, 'Keys'],
  [/--ignore\b/g, 'Ignore'],
  [/--file-rows\b/g, "Only the file's rows"],
  [/--tolerance\b/g, 'Tolerance'],
  [/--worksheet\b/g, 'Worksheet'],
  [/--dates dmy\b/g, 'Dates day first'],
  [/--query\b/g, 'a saved query'],
];

/** A message written for the terminal, in the words of this panel. */
export function screenWords(text: string): string {
  return OPTION_WORDS.reduce((words, [flag, label]) => words.replace(flag, label), text);
}

export function verdictTone(verdict: ReportVerdict): 'ok' | 'warn' | 'info' {
  return verdict === 'matches' ? 'ok' : verdict === 'differs' ? 'warn' : 'info';
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

function columnNames(text: string): Record<string, string> {
  const named: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf('=');
    if (at <= 0) throw new Error(`Write each column name as Column=metric. "${line}" has no =.`);
    named[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return named;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export function ReportComparePanel({ query, worksheets, onRecorded, primaryButton, t }: {
  /** The saved query to compare, instead of the metrics the file's columns name. */
  query?: string;
  worksheets?: Array<{ name: string; filters: Array<{ field: string; words: string }> }>;
  onRecorded?: () => void;
  primaryButton: CSSProperties;
  t: Theme;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [worksheet, setWorksheet] = useState('');
  const [filters, setFilters] = useState('');
  const [waived, setWaived] = useState('');
  const [names, setNames] = useState('');
  const [keys, setKeys] = useState('');
  const [ignore, setIgnore] = useState('');
  const [tolerance, setTolerance] = useState('');
  const [fileRows, setFileRows] = useState(false);
  const [dayFirst, setDayFirst] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ReportComparison | null>(null);
  const [recording, setRecording] = useState<ReportCompareRecording | null>(null);
  const [recorded, setRecorded] = useState(false);

  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    setResult(null);
    setRecorded(false);
    if (chosen.size > MAX_FILE_BYTES) {
      setFile(null);
      setMessage(`${chosen.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setMessage(null);
    setFile(chosen);
  };

  const record = async (id: string) => {
    try {
      await api.recordComparison(id);
      setRecorded(true);
      onRecorded?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The result was not recorded.');
    }
  };

  const compare = async () => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setResult(null);
    setRecorded(false);
    try {
      const body: ReportCompareRequest = {
        file: { name: file.name, base64: await readAsBase64(file) },
        ...(query ? { query } : {}),
        ...(worksheet ? { worksheet } : {}),
        filters: lines(filters),
        waive: lines(waived),
        map: columnNames(names),
        keys: lines(keys),
        ignore: lines(ignore),
        fileRows,
        ...(tolerance.trim() ? { tolerance: tolerance.trim() } : {}),
        ...(dayFirst ? { dates: 'dmy' as const } : {}),
      };
      const compared = await api.compareWithReport(body);
      setResult(compared.comparison);
      setRecording(compared.recording);
      if (compared.recording === 'with-compare') await record(compared.comparison.id);
    } catch (error) {
      setMessage(screenWords(error instanceof Error ? error.message : 'The comparison did not run.'));
    } finally {
      setBusy(false);
    }
  };

  const label: CSSProperties = { display: 'grid', gap: 3, fontSize: 11, fontWeight: 700, color: t.textSecondary, fontFamily: t.font };
  const field: CSSProperties = { fontSize: 11, fontFamily: t.fontMono, color: t.textPrimary, background: 'transparent', border: `1px solid ${t.headerBorder}`, borderRadius: 6, padding: '4px 6px', minWidth: 0, width: '100%', boxSizing: 'border-box' };
  const chosenSheet = worksheets?.find((candidate) => candidate.name === worksheet);

  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 8, minWidth: 0 }}>
      <label
        onDragOver={(event: DragEvent) => event.preventDefault()}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          choose(event.dataTransfer.files[0]);
        }}
        style={{ display: 'block', border: `1px dashed ${t.headerBorder}`, borderRadius: 8, padding: 10, cursor: 'pointer', fontSize: 11, color: t.textSecondary, lineHeight: 1.4, overflowWrap: 'anywhere' }}
      >
        {file ? file.name : "Drop the report's export here, or choose it: CSV or .xlsx, from Tableau's Download → Crosstab or a Power BI visual's Export data."}
        <input type="file" accept=".csv,.tsv,.txt,.xlsx" aria-label="The old report's export" onChange={(event) => choose(event.target.files?.[0])} style={{ display: 'block', marginTop: 6, fontSize: 11, maxWidth: '100%' }} />
      </label>
      {(worksheets?.length ?? 0) > 0 && (
        <label style={label}>
          Worksheet
          <select value={worksheet} onChange={(event) => setWorksheet(event.target.value)} style={field}>
            <option value="">None</option>
            {worksheets!.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
          </select>
        </label>
      )}
      {chosenSheet && chosenSheet.filters.length > 0 && (
        <span style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.4 }}>
          Saved on this worksheet: {chosenSheet.filters.map((filter) => filter.words).join('; ')}. An export does not show them, so state or waive each one.
        </span>
      )}
      <label style={label}>
        Filters on the report, one per line
        <textarea rows={2} value={filters} onChange={(event) => setFilters(event.target.value)} placeholder="order_date >= 2024-01-01" style={field} />
      </label>
      <label style={label}>
        Waived filters, with your reason
        <textarea rows={1} value={waived} onChange={(event) => setWaived(event.target.value)} placeholder="Order Date: covers every row" style={field} />
      </label>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, color: t.textSecondary }}>More options</summary>
        <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
          <label style={label}>
            Column names, one per line
            <textarea rows={2} value={names} onChange={(event) => setNames(event.target.value)} placeholder="Sales=total_sales" style={field} />
          </label>
          <label style={label}>
            Keys, one per line
            <textarea rows={1} value={keys} onChange={(event) => setKeys(event.target.value)} style={field} />
          </label>
          <label style={label}>
            Ignore, one per line
            <textarea rows={1} value={ignore} onChange={(event) => setIgnore(event.target.value)} style={field} />
          </label>
          <label style={label}>
            Tolerance
            <input value={tolerance} onChange={(event) => setTolerance(event.target.value)} placeholder="0.5%" style={field} />
          </label>
          <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={fileRows} onChange={(event) => setFileRows(event.target.checked)} />
            Only the file's rows
          </label>
          <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={dayFirst} onChange={(event) => setDayFirst(event.target.checked)} />
            Dates day first
          </label>
        </div>
      </details>
      <button onClick={() => void compare()} disabled={!file || busy} style={primaryButton}>{busy ? 'Comparing...' : 'Compare'}</button>
      {message && <span role="alert" style={{ fontSize: 11, color: '#d29922', lineHeight: 1.4, overflowWrap: 'anywhere' }}>{message}</span>}
      {result && (
        <ComparisonResult
          result={result}
          recording={recording}
          recorded={recorded}
          onRecord={() => void record(result.id)}
          primaryButton={primaryButton}
          t={t}
        />
      )}
    </div>
  );
}

/** One comparison, read top to bottom: the verdict, why, then every difference shown. */
export function ComparisonResult({ result, recording, recorded, onRecord, primaryButton, t }: {
  result: ReportComparison;
  recording: ReportCompareRecording | null;
  recorded: boolean;
  onRecord: () => void;
  primaryButton: CSSProperties;
  t: Theme;
}) {
  const { comparison } = result;
  const { rows, values, verdict } = comparison;
  const scope = [...result.filters.stated, ...result.filters.waived.map((text) => `waived ${text}`)];
  const heading: CSSProperties = { fontSize: 11, fontWeight: 700, color: t.textSecondary };
  const text: CSSProperties = { fontSize: 11, color: t.textMuted, lineHeight: 1.4, overflowWrap: 'anywhere' };
  const color = verdict === 'matches' ? '#2ea043' : verdict === 'differs' ? '#d29922' : t.accent;
  const cell: CSSProperties = { fontSize: 11, padding: '2px 8px 2px 0', textAlign: 'left', color: t.textPrimary, overflowWrap: 'anywhere' };
  return (
    <div role="status" style={{ display: 'grid', gap: 6, borderTop: `1px solid ${t.headerBorder}`, paddingTop: 8, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 800, color }}>
        {VERDICT_WORDS[verdict]}: {rows.inBoth} of {rows.inFile} rows, {values.equal} of {values.compared} values{scope.length ? `, with ${scope.join(' and ')}` : ''}.
      </span>
      {comparison.missing.map((item) => <span key={item} style={{ ...text, color: '#d29922' }}>{screenWords(item)}</span>)}
      {rows.totalsSetAside > 0 && <span style={text}>{rows.totalsSetAside} total row{rows.totalsSetAside === 1 ? '' : 's'} set aside.</span>}
      <details>
        <summary style={{ ...heading, cursor: 'pointer' }}>Columns</summary>
        <div style={{ display: 'grid', gap: 2, marginTop: 4 }}>
          {Object.entries(result.mapping).map(([column, meaning]) => {
            const number = comparison.numbers.find((item) => item.column === column);
            return <span key={column} style={text}>{column}: {meaning}{number ? `, at ${number.precision}` : ''}</span>;
          })}
        </div>
      </details>
      {comparison.differences.length > 0 && (
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>{['Row', 'Column', 'Old report', 'ZLens'].map((title) => <th key={title} style={{ ...cell, ...heading }}>{title}</th>)}</tr>
            </thead>
            <tbody>
              {comparison.differences.slice(0, MAX_SHOWN_DIFFERENCES).map((item, index) => (
                <tr key={`${item.key.join('|')}-${item.column}-${index}`}>
                  <td style={cell}>{item.key.join(' · ') || 'The total'}</td>
                  <td style={cell}>{item.column}</td>
                  <td style={cell}>{item.old || '(empty)'}</td>
                  <td style={cell}>{item.zlens ?? '(empty)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {comparison.differences.length > MAX_SHOWN_DIFFERENCES && <span style={text}>…and {comparison.differences.length - MAX_SHOWN_DIFFERENCES} more.</span>}
      {comparison.onlyInFile.length > 0 && <span style={text}>Only in the export: {comparison.onlyInFile.slice(0, 20).map((key) => key.join(' · ') || '(empty)').join(', ')}</span>}
      {comparison.onlyInZLens.length > 0 && <span style={text}>Only in ZLens: {comparison.onlyInZLens.slice(0, 20).map((key) => key.join(' · ') || '(empty)').join(', ')}</span>}
      {comparison.reasons.length > 0 && <span style={heading}>Possible reasons</span>}
      {comparison.reasons.map((reason) => <span key={reason} style={text}>{screenWords(reason)}</span>)}
      {comparison.notes.map((note) => <span key={note} style={text}>{screenWords(note)}</span>)}
      {result.filters.seen.length > 0 && (
        <span style={text}>Filters ZLens can see, as saved (they may have been changed before exporting): {result.filters.seen.join('; ')}</span>
      )}
      {recorded && <span style={text}>Recorded beside {result.report}. Approving a draft shows this result.</span>}
      {!recorded && recording === 'separate' && <button onClick={onRecord} style={primaryButton}>Record this result</button>}
      {recording === 'refused' && <span style={text}>Another person could see different figures here, so this result is yours and is not recorded. Someone who sees every row can compare the file and record it.</span>}
    </div>
  );
}
