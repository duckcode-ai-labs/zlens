import type { Cell, QueryResult } from '../store/types';
import { ZLENS_MARK_SVG } from '../components/shell/ZLensMark';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(v: unknown): string {
  if (typeof v === 'number') {
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return '';
}

// ─── Markdown → HTML ─────────────────────────────────────────────────────────

function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;

  for (const raw of lines) {
    const line = raw;

    if (line.startsWith('```')) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }

    if (line.startsWith('### ')) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h3>${esc(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('## '))  { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h2>${esc(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('# '))   { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h1>${esc(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('> '))   { if (inList) { out.push('</ul>'); inList = false; } out.push(`<blockquote><p>${esc(line.slice(2))}</p></blockquote>`); continue; }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineFormat(line.slice(2))}</li>`);
      continue;
    }

    if (inList) { out.push('</ul>'); inList = false; }

    if (line.trim() === '') { out.push('<br>'); continue; }

    out.push(`<p>${inlineFormat(line)}</p>`);
  }

  if (inList) out.push('</ul>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function inlineFormat(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

// ─── Table HTML ───────────────────────────────────────────────────────────────

function tableHtml(result: QueryResult): string {
  const { columns, rows } = result;
  const visible = rows.slice(0, 200);
  const truncated = rows.length > 200;

  const header = columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = visible
    .map((row) => {
      const cells = columns.map((c) => {
        const v = row[c];
        const isNum = typeof v === 'number';
        const display = v === null || v === undefined ? '—' : String(v);
        return `<td${isNum ? ' class="num"' : ''}>${esc(display)}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${truncated ? `<p class="truncated">Showing first 200 of ${rows.length.toLocaleString()} rows</p>` : ''}
    </div>`;
}

// ─── SVG Bar Chart ────────────────────────────────────────────────────────────

function detectChartCols(result: QueryResult): { labelCol: string; valueCol: string } | null {
  const { columns, rows } = result;
  if (columns.length < 2 || rows.length === 0) return null;

  const numericCol = columns.find((c) => typeof rows[0][c] === 'number');
  const labelCol = columns.find((c) => c !== numericCol);
  if (!numericCol || !labelCol) return null;

  return { labelCol, valueCol: numericCol };
}

function barChartSvg(result: QueryResult): string | null {
  const cols = detectChartCols(result);
  if (!cols) return null;

  const data = result.rows.slice(0, 20).map((r) => ({
    label: String(r[cols.labelCol] ?? ''),
    value: Number(r[cols.valueCol] ?? 0),
  }));

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const barH = 28;
  const gap = 6;
  const labelW = 140;
  const chartW = 440;
  const totalH = data.length * (barH + gap) + 40;

  const bars = data.map((d, i) => {
    const y = i * (barH + gap) + 20;
    const w = Math.max((d.value / maxVal) * chartW, 2);
    return `
      <text x="${labelW - 6}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11" fill="#8b949e">${esc(d.label.slice(0, 20))}</text>
      <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="3" fill="#388bfd" />
      <text x="${labelW + w + 5}" y="${y + barH / 2 + 4}" font-size="11" fill="#e6edf3">${fmtNum(d.value)}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW + chartW + 80}" height="${totalH}" style="max-width:100%">${bars}</svg>`;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function exportDashboardHtml(title: string, cells: Cell[]): string {
  const cellBlocks = cells.map((cell) => {
    if (cell.type === 'markdown') {
      return `<section class="cell md-cell">${mdToHtml(cell.content)}</section>`;
    }

    const header = cell.name
      ? `<div class="cell-header"><span class="cell-type">${cell.type.toUpperCase()}</span><span class="cell-name">${esc(cell.name)}</span></div>`
      : `<div class="cell-header"><span class="cell-type">${cell.type.toUpperCase()}</span></div>`;

    const codeBlock = `<pre class="cell-code"><code>${esc(cell.content)}</code></pre>`;

    let output = '';
    if (cell.result && cell.result.rows.length > 0) {
      const chart = barChartSvg(cell.result);
      const table = tableHtml(cell.result);
      const meta = `<div class="output-meta">${cell.result.rows.length.toLocaleString()} rows${cell.result.executionTime ? ` · ${cell.result.executionTime}ms` : ''}</div>`;
      output = `<div class="cell-output">${meta}${chart ?? ''}${chart ? '' : table}</div>`;
    } else if (cell.error) {
      output = `<div class="cell-error">⚠ ${esc(cell.error)}</div>`;
    }

    return `<section class="cell sql-cell">${header}${codeBlock}${output}</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117; color: #e6edf3;
      line-height: 1.6; padding: 0;
    }
    .page-header {
      background: #161b22; border-bottom: 1px solid #21262d;
      padding: 16px 32px; display: flex; align-items: center; gap: 12px;
    }
    .logo { width: 28px; height: 28px; display: flex; flex-shrink: 0; }
    .page-title { font-size: 18px; font-weight: 600; color: #e6edf3; }
    .page-meta { font-size: 12px; color: #8b949e; margin-left: auto; }
    .content { max-width: 900px; margin: 0 auto; padding: 32px 24px; display: flex; flex-direction: column; gap: 24px; }
    .cell { border-radius: 8px; overflow: hidden; }
    .md-cell { padding: 4px 0; }
    .md-cell h1 { font-size: 26px; font-weight: 700; color: #e6edf3; margin: 0 0 12px; }
    .md-cell h2 { font-size: 20px; font-weight: 600; color: #e6edf3; margin: 20px 0 10px; }
    .md-cell h3 { font-size: 16px; font-weight: 600; color: #e6edf3; margin: 16px 0 8px; }
    .md-cell p { color: #c9d1d9; margin-bottom: 8px; }
    .md-cell ul { padding-left: 20px; color: #c9d1d9; margin-bottom: 8px; }
    .md-cell code { background: #21262d; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 13px; }
    .md-cell pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 14px; overflow-x: auto; margin-bottom: 8px; }
    .md-cell pre code { background: none; padding: 0; }
    .md-cell blockquote { border-left: 3px solid #388bfd; padding-left: 14px; color: #8b949e; }
    .sql-cell { background: #161b22; border: 1px solid #30363d; }
    .cell-header { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid #21262d; background: #1c2128; }
    .cell-type { font-size: 10px; font-weight: 600; letter-spacing: 0.05em; color: #8b949e; background: #21262d; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .cell-name { font-size: 12px; color: #388bfd; font-family: monospace; }
    .cell-code { background: #0d1117; padding: 14px; font-size: 12px; font-family: 'JetBrains Mono', monospace; color: #c9d1d9; overflow-x: auto; border-bottom: 1px solid #21262d; line-height: 1.55; white-space: pre; }
    .cell-output { padding: 14px; }
    .output-meta { font-size: 11px; color: #8b949e; margin-bottom: 10px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #1c2128; color: #8b949e; font-weight: 600; text-align: left; padding: 7px 12px; border-bottom: 1px solid #30363d; white-space: nowrap; }
    td { padding: 6px 12px; border-bottom: 1px solid #21262d; color: #e6edf3; }
    td.num { text-align: right; font-family: monospace; }
    tr:last-child td { border-bottom: none; }
    .truncated { font-size: 11px; color: #8b949e; margin-top: 8px; }
    .cell-error { padding: 12px 14px; background: #3d1a1a; border-top: 1px solid #f85149; color: #f85149; font-size: 13px; }
    .exported-by { text-align: center; color: #484f58; font-size: 11px; padding: 40px 0 24px; }
  </style>
</head>
<body>
  <div class="page-header">
    <div class="logo">${ZLENS_MARK_SVG}</div>
    <span class="page-title">${esc(title)}</span>
    <span class="page-meta">Exported ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
  </div>
  <div class="content">
    ${cellBlocks}
  </div>
  <p class="exported-by">Built with ZLens</p>
</body>
</html>`;
}

/** Trigger a browser download of the generated HTML */
export function downloadDashboard(title: string, cells: Cell[]): void {
  const html = exportDashboardHtml(title, cells);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-dashboard.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
