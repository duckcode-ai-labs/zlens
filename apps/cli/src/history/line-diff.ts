/**
 * A line diff for Compare: which lines of the older version were removed and which lines of the newer one were
 * added (Myers' algorithm on lines). Very different files stop early and show as all removed and all added.
 */
export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
  /** Line number in the older version (same, removed). */
  oldNumber?: number;
  /** Line number in the newer version (same, added). */
  newNumber?: number;
}

const MAX_EDITS = 1000;

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // Common start and end first: most edits are small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB));
  const out: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  const push = (kind: DiffLine['kind'], text: string) => {
    if (kind === 'same') out.push({ kind, text, oldNumber: oldLine++, newNumber: newLine++ });
    else if (kind === 'removed') out.push({ kind, text, oldNumber: oldLine++ });
    else out.push({ kind, text, newNumber: newLine++ });
  };
  for (let i = 0; i < start; i += 1) push('same', a[i]!);
  for (const [kind, text] of middle) push(kind, text);
  for (let i = endA; i < a.length; i += 1) push('same', a[i]!);
  return out;
}

function myers(a: string[], b: string[]): Array<['same' | 'removed' | 'added', string]> {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ['added', line]);
  if (m === 0) return a.map((line) => ['removed', line]);
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max;
  const v = new Int32Array(2 * max + 2).fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return [...a.map((line): ['removed', string] => ['removed', line]), ...b.map((line): ['added', string] => ['added', line])];
  // Walk back through the trace.
  const ops: Array<['same' | 'removed' | 'added', string]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(['same', a[x - 1]!]);
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) ops.push(['added', b[y - 1]!]);
      else ops.push(['removed', a[x - 1]!]);
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** How many lines changed: removed and added lines, a changed line counting once. */
export function changedLineCount(lines: DiffLine[]): number {
  const removed = lines.filter((line) => line.kind === 'removed').length;
  const added = lines.filter((line) => line.kind === 'added').length;
  return Math.max(removed, added);
}
