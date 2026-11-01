import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { StateEffect, StateField, type Text } from '@codemirror/state';

/**
 * Parse a DuckDB/SQL error message to extract line and column info.
 * Common patterns:
 * - "LINE 2: ..." (DuckDB)
 * - "at line 3, column 5"
 * - "Error at position 42"
 * Returns { line, col } (1-based) or null if not parseable.
 */
export function parseErrorLocation(msg: string): { line: number; col: number } | null {
  // DuckDB: "LINE 2: SELECT * FROM ..."
  const lineMatch = msg.match(/LINE\s+(\d+)/i);
  if (lineMatch) {
    const line = parseInt(lineMatch[1], 10);
    // Try to find column from caret indicator (^) often on the next line
    const caretMatch = msg.match(/\n(\s*)\^/);
    const col = caretMatch ? caretMatch[1].length + 1 : 1;
    return { line, col };
  }
  // Generic: "at line X, column Y"
  const lcMatch = msg.match(/at line\s+(\d+),?\s*column\s+(\d+)/i);
  if (lcMatch) {
    return { line: parseInt(lcMatch[1], 10), col: parseInt(lcMatch[2], 10) };
  }
  // Fallback: "line X"
  const simpleLine = msg.match(/line\s+(\d+)/i);
  if (simpleLine) {
    return { line: parseInt(simpleLine[1], 10), col: 1 };
  }
  return null;
}

/**
 * What to underline for an error: from where it is to the end of its line, the
 * first line when the message names none. Never empty: a mark with no width
 * makes CodeMirror throw. An error can sit past the last character (an unfinished
 * block is reported on the empty line after the cursor), so it takes the last
 * thing written instead. Null when the text has nothing to underline.
 */
export function errorMarkRange(doc: Text, message: string): { from: number; to: number } | null {
  const loc = parseErrorLocation(message);
  const line = doc.line(loc && loc.line >= 1 && loc.line <= doc.lines ? loc.line : 1);
  const from = line.from + Math.max(0, (loc?.col ?? 1) - 1);
  const to = Math.max(from + 1, line.to);
  if (to <= doc.length) return { from, to };
  const written = doc.toString().trimEnd().length;
  return written > 0 ? { from: written - 1, to: written } : null;
}

/** The error to underline, as its message; null clears it. */
export const setErrorEffect = StateEffect.define<string | null>();

export const errorDecoField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorEffect)) {
        const range = e.value === null ? null : errorMarkRange(tr.newDoc, e.value);
        if (!range) return Decoration.none;
        return Decoration.set([
          Decoration.mark({
            class: 'cm-sql-error',
            attributes: { title: e.value! },
          }).range(range.from, range.to),
        ]);
      }
    }
    return decos.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
