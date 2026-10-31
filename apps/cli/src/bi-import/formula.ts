/**
 * A Tableau calculated field or a DAX expression read into a tree, for
 * turning calculations into metrics. It reads what the converter translates
 * (aggregates, IF/IIF, CALCULATE, arithmetic, comparisons, IN lists, plain
 * values) and marks the rest by name (`CASE`, a function call), so a formula
 * is translated exactly or left out with the construct that stopped it.
 */

import type { BiCalculation } from './calculations.js';

export type FormulaNode =
  | { k: 'number'; value: number; text: string }
  | { k: 'string'; value: string }
  | { k: 'date'; value: string }
  | { k: 'boolean'; value: boolean }
  | { k: 'null' }
  /** Tableau `[Sales]` / `[Source].[Sales]`; DAX `Orders[Sales]`, `'Order Lines'[Qty]` or `[Measure]`. */
  | { k: 'field'; name: string; table?: string }
  /** DAX: a table by itself (`COUNTROWS(Orders)`). */
  | { k: 'table'; name: string }
  | { k: 'call'; name: string; args: FormulaNode[] }
  | { k: 'binary'; op: string; left: FormulaNode; right: FormulaNode }
  | { k: 'not'; operand: FormulaNode }
  | { k: 'negate'; operand: FormulaNode }
  | { k: 'if'; branches: Array<{ condition: FormulaNode; then: FormulaNode }>; otherwise?: FormulaNode }
  | { k: 'in'; operand: FormulaNode; values: FormulaNode[] }
  /** Read, but never translated: named in the reason. */
  | { k: 'unsupported'; what: string };

type Token =
  | { t: 'field'; name: string; table?: string }
  | { t: 'word'; text: string }
  | { t: 'number'; text: string }
  | { t: 'string'; value: string }
  | { t: 'date'; value: string }
  | { t: 'op'; text: string };

export class FormulaError extends Error {}

export function parseFormula(formula: string, language: BiCalculation['language']): FormulaNode {
  const parser = new Parser(tokenize(formula, language), language);
  const node = parser.expression();
  if (!parser.done()) throw new FormulaError(`ZLens could not read the formula after ${parser.where()}.`);
  return node;
}

function tokenize(source: string, language: BiCalculation['language']): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const quoted = (quote: string): string => {
    let at = index + 1;
    let value = '';
    while (at < source.length) {
      if (source[at] === quote) {
        if (source[at + 1] === quote) {
          value += quote;
          at += 2;
          continue;
        }
        index = at + 1;
        return value;
      }
      value += source[at];
      at += 1;
    }
    throw new FormulaError('A quote or bracket in the formula is not closed.');
  };
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if ((char === '/' && next === '/') || (language === 'dax' && char === '-' && next === '-')) {
      const end = source.slice(index).search(/[\r\n]/);
      index = end < 0 ? source.length : index + end;
    } else if (char === '[') {
      const name = quoted(']');
      // Tableau `[Source].[Field]`; DAX has no dotted names.
      if (language === 'tableau' && source[index] === '.' && source[index + 1] === '[') {
        index += 1;
        tokens.push({ t: 'field', table: name, name: quoted(']') });
      } else {
        tokens.push({ t: 'field', name });
      }
    } else if (char === "'" && language === 'dax') {
      const table = quoted("'");
      if (source[index] === '[') tokens.push({ t: 'field', table, name: quoted(']') });
      else tokens.push({ t: 'word', text: table });
    } else if (char === '"' || (char === "'" && language === 'tableau')) {
      tokens.push({ t: 'string', value: quoted(char) });
    } else if (char === '#' && language === 'tableau') {
      const end = source.indexOf('#', index + 1);
      if (end < 0) throw new FormulaError('A date in the formula is not closed with #.');
      tokens.push({ t: 'date', value: source.slice(index + 1, end).trim() });
      index = end + 1;
    } else if (/[0-9.]/.test(char) && /^\.?\d/.test(source.slice(index, index + 2))) {
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(index))![0];
      tokens.push({ t: 'number', text: number });
      index += number.length;
    } else if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][\w.]*/.exec(source.slice(index))![0];
      index += word.length;
      // DAX `Orders[Sales]`.
      if (language === 'dax' && source[index] === '[') tokens.push({ t: 'field', table: word, name: quoted(']') });
      else tokens.push({ t: 'word', text: word });
    } else {
      const op = /^(?:==|!=|<>|<=|>=|&&|\|\|)/.exec(source.slice(index))?.[0] ?? char;
      if (!/^(?:==|!=|<>|<=|>=|&&|\|\||[-+*/%^=<>(),{}&])$/.test(op)) throw new FormulaError(`ZLens could not read "${op}" in the formula.`);
      tokens.push({ t: 'op', text: op });
      index += op.length;
    }
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[], private readonly language: BiCalculation['language']) {}

  done(): boolean {
    return this.index >= this.tokens.length;
  }

  where(): string {
    const token = this.tokens[this.index - 1];
    if (!token) return 'its start';
    return `"${token.t === 'field' ? `[${token.name}]` : token.t === 'string' ? `"${token.value}"` : token.t === 'date' ? `#${token.value}#` : token.text}"`;
  }

  expression(): FormulaNode {
    return this.or();
  }

  private peekWord(...words: string[]): boolean {
    const token = this.tokens[this.index];
    return token?.t === 'word' && words.includes(token.text.toUpperCase());
  }

  private peekOp(...ops: string[]): boolean {
    const token = this.tokens[this.index];
    return token?.t === 'op' && ops.includes(token.text);
  }

  private expectOp(op: string): void {
    if (!this.peekOp(op)) throw new FormulaError(`ZLens could not read the formula: expected "${op}" after ${this.where()}.`);
    this.index += 1;
  }

  private expectWord(word: string): void {
    if (!this.peekWord(word)) throw new FormulaError(`ZLens could not read the formula: expected ${word} after ${this.where()}.`);
    this.index += 1;
  }

  private or(): FormulaNode {
    let left = this.and();
    while (this.peekWord('OR') || this.peekOp('||')) {
      this.index += 1;
      left = { k: 'binary', op: 'or', left, right: this.and() };
    }
    return left;
  }

  private and(): FormulaNode {
    let left = this.not();
    while (this.peekWord('AND') || this.peekOp('&&')) {
      this.index += 1;
      left = { k: 'binary', op: 'and', left, right: this.not() };
    }
    return left;
  }

  private not(): FormulaNode {
    // DAX `NOT(x)` is a function; Tableau `NOT x` is an operator. Both mean the same.
    if (this.peekWord('NOT')) {
      this.index += 1;
      return { k: 'not', operand: this.not() };
    }
    return this.comparison();
  }

  private comparison(): FormulaNode {
    let left = this.concatenation();
    for (;;) {
      if (this.peekOp('=', '==', '!=', '<>', '<', '>', '<=', '>=')) {
        const op = (this.tokens[this.index++] as { text: string }).text;
        // DAX `==` is strict (a blank is not 0); in Tableau it is `=`.
        left = { k: 'binary', op: op === '==' && this.language === 'tableau' ? '=' : op === '!=' ? '<>' : op, left, right: this.concatenation() };
      } else if (this.peekWord('IN')) {
        this.index += 1;
        const open = this.language === 'dax' ? '{' : '(';
        const close = this.language === 'dax' ? '}' : ')';
        this.expectOp(open);
        const values: FormulaNode[] = [];
        if (!this.peekOp(close)) {
          values.push(this.expression());
          while (this.peekOp(',')) {
            this.index += 1;
            values.push(this.expression());
          }
        }
        this.expectOp(close);
        left = { k: 'in', operand: left, values };
      } else {
        return left;
      }
    }
  }

  private concatenation(): FormulaNode {
    let left = this.additive();
    while (this.peekOp('&')) {
      this.index += 1;
      left = { k: 'binary', op: '&', left, right: this.additive() };
    }
    return left;
  }

  private additive(): FormulaNode {
    let left = this.multiplicative();
    while (this.peekOp('+', '-')) {
      const op = (this.tokens[this.index++] as { text: string }).text;
      left = { k: 'binary', op, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): FormulaNode {
    let left = this.power();
    while (this.peekOp('*', '/', '%')) {
      const op = (this.tokens[this.index++] as { text: string }).text;
      left = { k: 'binary', op, left, right: this.power() };
    }
    return left;
  }

  private power(): FormulaNode {
    const left = this.unary();
    if (this.peekOp('^')) {
      this.index += 1;
      return { k: 'binary', op: '^', left, right: this.unary() };
    }
    return left;
  }

  private unary(): FormulaNode {
    if (this.peekOp('-')) {
      this.index += 1;
      return { k: 'negate', operand: this.unary() };
    }
    if (this.peekOp('+')) {
      this.index += 1;
      return this.unary();
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    const token = this.tokens[this.index];
    if (!token) throw new FormulaError(`ZLens could not read the formula: it ends after ${this.where()}.`);
    this.index += 1;
    if (token.t === 'number') return { k: 'number', value: Number(token.text), text: token.text };
    if (token.t === 'string') return { k: 'string', value: token.value };
    if (token.t === 'date') return { k: 'date', value: token.value.replace(/ 00:00:00$/, '') };
    if (token.t === 'field') return { k: 'field', name: token.name.trim(), ...(token.table ? { table: token.table.trim() } : {}) };
    if (token.t === 'op') {
      if (token.text === '(') {
        const inner = this.expression();
        this.expectOp(')');
        return inner;
      }
      if (token.text === '{') return { k: 'unsupported', what: 'A table constructor ({…})' };
      throw new FormulaError(`ZLens could not read "${token.text}" in the formula.`);
    }
    const word = token.text.toUpperCase();
    if (this.language === 'tableau') {
      if (word === 'TRUE' || word === 'FALSE') return { k: 'boolean', value: word === 'TRUE' };
      if (word === 'NULL') return { k: 'null' };
      if (word === 'IF') return this.tableauIf();
      if (word === 'CASE') {
        this.skipToEnd();
        return { k: 'unsupported', what: 'CASE' };
      }
    }
    if (this.peekOp('(')) {
      this.index += 1;
      const args: FormulaNode[] = [];
      if (!this.peekOp(')')) {
        args.push(this.expression());
        while (this.peekOp(',')) {
          this.index += 1;
          args.push(this.expression());
        }
      }
      this.expectOp(')');
      if (this.language === 'dax' && (word === 'TRUE' || word === 'FALSE') && !args.length) return { k: 'boolean', value: word === 'TRUE' };
      if (this.language === 'dax' && word === 'BLANK' && !args.length) return { k: 'null' };
      return { k: 'call', name: word, args };
    }
    if (this.language === 'dax') return { k: 'table', name: token.text };
    throw new FormulaError(`ZLens could not read "${token.text}" in the formula.`);
  }

  private tableauIf(): FormulaNode {
    const branches: Array<{ condition: FormulaNode; then: FormulaNode }> = [];
    const condition = this.expression();
    this.expectWord('THEN');
    branches.push({ condition, then: this.expression() });
    let otherwise: FormulaNode | undefined;
    for (;;) {
      if (this.peekWord('ELSEIF')) {
        this.index += 1;
        const next = this.expression();
        this.expectWord('THEN');
        branches.push({ condition: next, then: this.expression() });
      } else if (this.peekWord('ELSE')) {
        this.index += 1;
        otherwise = this.expression();
      } else {
        this.expectWord('END');
        return { k: 'if', branches, ...(otherwise ? { otherwise } : {}) };
      }
    }
  }

  /** Past a CASE … END, nested ones included. */
  private skipToEnd(): void {
    let depth = 1;
    while (this.index < this.tokens.length && depth > 0) {
      const token = this.tokens[this.index++]!;
      if (token.t !== 'word') continue;
      const word = token.text.toUpperCase();
      if (word === 'CASE' || word === 'IF') depth += 1;
      else if (word === 'END') depth -= 1;
    }
  }
}
