/**
 * ONE ANSWER TO "IS THIS THE SAME TABLE?" (simplification plan Z1). Every
 * comparison of two table names goes through `tableKey` or `sameTable`, at a
 * stated level:
 * - `exact`: the name as written. Unquoted parts fold to upper case, as
 *   Snowflake does; quoted parts keep their spelling and never merge with
 *   unquoted ones. This is `physicalRelationIdentity`. Choose what to run by it.
 * - `object`: the same object in every part, ignoring quotes and case.
 *   dbt-duckdb writes provenance quoted (`"nba"."dev"."t"`) and the warehouse
 *   describes the object unquoted: one object.
 * - `shared`: the same in every part both names have, ignoring quotes and
 *   case. `s.t` matches `prod.s.t` and `dev.s.t`, but `prod.s.t` and
 *   `dev.s.t` differ. A certified block matches on this level, so a block
 *   written against one database never answers for another.
 * - `tail`: the same schema and table in any database, ignoring quotes and
 *   case. The model's meaning for a table reaches each database that lists it
 *   (decision Z-D1); a dbt dev target read in production is the same table.
 *
 * At `shared` and `tail`, a bare table name (no schema) matches on the table.
 *
 * It lives in `@zlens/core` so core, the agent and the apps share it;
 * `@zlens/agent` re-exports it. No other module keeps its own name helper
 * (decision Z-D2): `scripts/check-table-names.mjs` fails CI on a new one.
 * Before this, about 30 helpers each answered it their own way, and a table
 * listed in two databases lost the model's meaning (zlens#262).
 */

export interface PhysicalIdentifierPartV1 {
  /** The spelling supplied by dbt or runtime metadata, without quote marks. */
  value: string;
  /** A quoted dbt identifier is case-sensitive on Snowflake and must survive. */
  quoted?: boolean;
}

/**
 * Split a dotted identifier without treating dots inside quoted identifiers as
 * separators. A part may be quoted with `"…"`, `` `…` `` or `[…]` (SQL Server);
 * a doubled closing quote is that character inside the part.
 */
export function parsePhysicalIdentifier(value: string): PhysicalIdentifierPartV1[] {
  const parts: PhysicalIdentifierPartV1[] = [];
  let current = '';
  let quote: '"' | '`' | ']' | undefined;
  let quoted = false;
  const flush = () => {
    const text = current.trim();
    if (text) parts.push({ value: text, ...(quoted ? { quoted: true } : {}) });
    current = '';
    quoted = false;
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) {
        // SQL doubles a quote inside a quoted identifier.
        if (value[index + 1] === quote) { current += quote; index += 1; }
        else quote = undefined;
      } else current += char;
      continue;
    }
    if (char === '"' || char === '`') { quote = char; quoted = true; continue; }
    if (char === '[') { quote = ']'; quoted = true; continue; }
    if (char === '.') { flush(); continue; }
    current += char;
  }
  flush();
  return parts;
}

/** The comparison identity Snowflake gives an identifier component. */
export function physicalIdentifierIdentity(part: PhysicalIdentifierPartV1): string {
  return `${part.quoted ? 'q' : 'u'}:${part.quoted ? part.value : part.value.toUpperCase()}`;
}

/**
 * Exact warehouse identity for a parsed identifier. Unquoted Snowflake
 * identifiers fold to upper case; quoted identifiers retain both spelling and
 * quote state. This deliberately does not emit a two-part tail alias.
 */
export function physicalRelationIdentity(value: string): string {
  return parsePhysicalIdentifier(value)
    .map(physicalIdentifierIdentity)
    .join('.');
}

export type TableMatch = 'exact' | 'object' | 'shared' | 'tail';

const lowered = (parts: PhysicalIdentifierPartV1[]) => parts.map((part) => part.value.toLowerCase()).join('.');

/**
 * The key two names share when they name the same table at `level`. A key is
 * for a map or a set, so `shared` (which depends on both names) keys on every
 * part, as `object` does; compare at `shared` with `sameTable`.
 */
export function tableKey(name: string, level: TableMatch = 'exact'): string {
  if (level === 'exact') return physicalRelationIdentity(name);
  const parts = parsePhysicalIdentifier(name);
  return lowered(level === 'tail' ? parts.slice(-2) : parts);
}

/**
 * The table's own name, unquoted: `"nba"."dev"."T"` → `T`. For showing a
 * table and matching it to the words of a question; compare two tables with
 * `sameTable`.
 */
export function tableName(name: string): string {
  return parsePhysicalIdentifier(name).at(-1)?.value ?? '';
}

/**
 * The schema and table as written, unquoted: `"nba"."dev"."T"` → `dev.T`.
 * For writing a reference the model reads back; compare with `sameTable`.
 */
export function tableTail(name: string): string {
  return parsePhysicalIdentifier(name).slice(-2).map((part) => part.value).join('.');
}

/** Whether two names name the same table at `level`. */
export function sameTable(left: string | undefined, right: string | undefined, level: TableMatch = 'exact'): boolean {
  if (!left || !right) return false;
  if (level === 'exact' || level === 'object') {
    const key = tableKey(left, level);
    return key !== '' && key === tableKey(right, level);
  }
  const a = parsePhysicalIdentifier(left);
  const b = parsePhysicalIdentifier(right);
  const depth = Math.min(level === 'tail' ? 2 : Number.POSITIVE_INFINITY, a.length, b.length);
  if (depth === 0) return false;
  return lowered(a.slice(-depth)) === lowered(b.slice(-depth));
}
