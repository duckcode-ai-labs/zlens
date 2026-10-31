import { describe, expect, it } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { Parser } from '@zlens/core';
import { errorDecoField, errorMarkRange, parseErrorLocation, setErrorEffect } from './error-marks';

/** What the server's check says about a source (validateBlockStudioSource), from the real parser. */
function firstProblem(source: string): string | null {
  try {
    new Parser(source, '<block-studio>').parse();
    return null;
  } catch (error) {
    const problem = (error as { diagnostics?: Array<{ message?: string; span?: { start?: { line?: number; column?: number } } }> }).diagnostics?.[0];
    if (!problem) return error instanceof Error ? error.message : String(error);
    const { line, column } = problem.span?.start ?? {};
    return `${line ? `Line ${line}${column ? `, column ${column}` : ''}: ` : ''}${problem.message ?? 'Syntax error'}`;
  }
}

function marks(state: EditorState): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = [];
  state.field(errorDecoField).between(0, state.doc.length, (from, to) => { found.push({ from, to }); });
  return found;
}

/** One key press, then the check that follows it, as Block Studio does. */
function typeAndCheck(state: EditorState, text: string): EditorState {
  const typed = state.update({ changes: { from: state.doc.length, insert: text } }).state;
  return typed.update({ effects: setErrorEffect.of(firstProblem(typed.doc.toString())) }).state;
}

const emptyEditor = () => EditorState.create({ doc: '', extensions: [errorDecoField] });

describe('the error mark in the source editor', () => {
  it('survives typing a draft block one character at a time', () => {
    const source = [
      '// Draft for a request.',
      'block "Paid claims" {',
      '  type = "custom"',
      '  query = """',
      '-- The AI did not write SQL for this question; write it here.',
      'SELECT 1',
      '"""',
      '}',
      '',
    ].join('\n');
    let state = emptyEditor();
    let marked = 0;
    for (const character of source) {
      state = typeAndCheck(state, character);
      for (const { from, to } of marks(state)) {
        expect(from).toBeLessThan(to);
        expect(to).toBeLessThanOrEqual(state.doc.length);
        marked += 1;
      }
    }
    expect(state.doc.toString()).toBe(source);
    expect(marked).toBeGreaterThan(0);
  });

  it('survives a comment line and SELECT 1 typed with no block around them', () => {
    let state = emptyEditor();
    for (const character of '-- check this first\nSELECT 1\n') state = typeAndCheck(state, character);
    expect(state.doc.toString()).toBe('-- check this first\nSELECT 1\n');
  });

  it('never makes an empty mark for an error past the end of the text', () => {
    const atEnd = EditorState.create({ doc: 'block "x" {\n', extensions: [errorDecoField] });
    const next = atEnd.update({ effects: setErrorEffect.of("Line 2, column 1: Expected RightBrace but found '' (EOF).") }).state;
    expect(marks(next)).toEqual([{ from: 10, to: 11 }]);
  });

  it('marks nothing in an empty editor', () => {
    expect(errorMarkRange(Text.empty, 'Line 1, column 1: Expected block')).toBeNull();
    expect(errorMarkRange(Text.empty, 'Something else went wrong')).toBeNull();
    const state = EditorState.create({ doc: '', extensions: [errorDecoField] });
    expect(marks(state.update({ effects: setErrorEffect.of('Line 3, column 9: nope') }).state)).toEqual([]);
  });

  it('never makes an empty mark on a line of nothing but white space', () => {
    for (const doc of ['\n', '  \n\n', '\n\n\n']) {
      const state = EditorState.create({ doc, extensions: [errorDecoField] });
      for (const message of ['Line 1, column 1: x', 'Line 2, column 1: x', 'Line 3, column 1: x', 'Line 4, column 9: x', 'no place named']) {
        for (const { from, to } of marks(state.update({ effects: setErrorEffect.of(message) }).state)) expect(from).toBeLessThan(to);
      }
    }
  });

  it('underlines from the error to the end of its line, and the first line when the message names none', () => {
    const doc = Text.of(['SELECT 1', 'FROM nowhere']);
    expect(errorMarkRange(doc, 'LINE 2: FROM nowhere\n     ^')).toEqual({ from: 14, to: 21 });
    expect(errorMarkRange(doc, 'Line 2, column 6: Unknown table')).toEqual({ from: 9, to: 21 });
    expect(errorMarkRange(doc, 'Table not found')).toEqual({ from: 0, to: 8 });
    expect(parseErrorLocation('Line 4, column 2: Expected RightBrace')).toEqual({ line: 4, col: 1 });
  });

  it('stays on its text as the person types, and goes when that text is deleted', () => {
    const start = EditorState.create({ doc: 'SELECT 1\nFROM nowhere', extensions: [errorDecoField] });
    const marked = start.update({ effects: setErrorEffect.of('LINE 2: FROM nowhere\n     ^') }).state;
    expect(marks(marked)).toEqual([{ from: 14, to: 21 }]);
    const moved = marked.update({ changes: { from: 0, insert: '-- first\n' } }).state;
    expect(marks(moved)).toEqual([{ from: 23, to: 30 }]);
    const emptied = moved.update({ changes: { from: 0, to: moved.doc.length } }).state;
    expect(marks(emptied)).toEqual([]);
  });

  it('clears the mark when the error goes', () => {
    const start = EditorState.create({ doc: 'SELECT 1', extensions: [errorDecoField] });
    const marked = start.update({ effects: setErrorEffect.of('Table not found') }).state;
    expect(marks(marked.update({ effects: setErrorEffect.of(null) }).state)).toEqual([]);
  });
});
