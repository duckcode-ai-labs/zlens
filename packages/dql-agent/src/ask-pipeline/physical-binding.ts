/**
 * The executable identity of a physical relation.
 *
 * dbt normally gives Ask a logical `schema.table` name, while warehouse
 * metadata and execution may need an exact database-qualified name.  Keeping
 * those identities in separate maps made it possible for discovery, drafting
 * and validation to each choose a different object.  This additive contract
 * is deliberately small enough to travel with a vocabulary entry and keeps
 * legacy `schema.table` refs working as aliases.
 */
export type PhysicalColumnCompleteness = 'complete' | 'partial' | 'unknown';

export interface PhysicalIdentifierPartV1 {
  /** The spelling supplied by dbt or runtime metadata, without quote marks. */
  value: string;
  /** A quoted dbt identifier is case-sensitive on Snowflake and must survive. */
  quoted?: boolean;
}

export interface PhysicalRelationColumnV1 {
  name: string;
  type?: string;
  description?: string;
}

export interface PhysicalRelationBindingV1 {
  version: 1;
  /** Stable DQL identity; it never changes merely because a target changes. */
  logicalId: string;
  /** Compatibility identity used by existing stored references. */
  logicalRelation: string;
  database?: PhysicalIdentifierPartV1;
  schema?: PhysicalIdentifierPartV1;
  table: PhysicalIdentifierPartV1;
  driver?: string;
  snapshotId?: string;
  /** Redacted hash of user/role/warehouse/database/schema/runtime generation. */
  executionTargetFingerprint?: string;
  source: 'dbt_manifest' | 'dbt_catalog' | 'runtime_catalog' | 'warehouse_probe' | 'merged';
  columns: PhysicalRelationColumnV1[];
  columnCompleteness: PhysicalColumnCompleteness;
  observedAt?: string;
  /** A bounded page is not proof that a column is absent. */
  truncated?: boolean;
  /** Existing short names resolve only when this set is unique in a snapshot. */
  aliases?: string[];
}

export interface PhysicalRelationBindingInput {
  logicalRelation: string;
  physicalRelation?: string;
  driver?: string;
  snapshotId?: string;
  executionTargetFingerprint?: string;
  source?: PhysicalRelationBindingV1['source'];
  columns?: PhysicalRelationColumnV1[];
  columnCompleteness?: PhysicalColumnCompleteness;
  observedAt?: string;
  truncated?: boolean;
}

/** Split a dotted identifier without treating dots inside quoted identifiers as separators. */
export function parsePhysicalIdentifier(value: string): PhysicalIdentifierPartV1[] {
  const parts: PhysicalIdentifierPartV1[] = [];
  let current = '';
  let quote: '"' | '`' | undefined;
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
    if (char === '.') { flush(); continue; }
    current += char;
  }
  flush();
  return parts;
}

export function physicalRelationText(binding: Pick<PhysicalRelationBindingV1, 'database' | 'schema' | 'table'>, quote = false): string {
  const render = (part: PhysicalIdentifierPartV1) => quote || part.quoted
    ? `"${part.value.replace(/"/g, '""')}"`
    : part.value;
  return [binding.database, binding.schema, binding.table].filter((part): part is PhysicalIdentifierPartV1 => Boolean(part)).map(render).join('.');
}

export function physicalRelationAlias(binding: Pick<PhysicalRelationBindingV1, 'schema' | 'table'>): string {
  return [binding.schema?.value, binding.table.value].filter(Boolean).join('.');
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

/** The comparison identity Snowflake gives an identifier component. */
export function physicalIdentifierIdentity(part: PhysicalIdentifierPartV1): string {
  return `${part.quoted ? 'q' : 'u'}:${part.quoted ? part.value : part.value.toUpperCase()}`;
}

/** A two-part tail is for diagnostics only; it must never select a database. */
export function physicalRelationTailIdentity(value: string): string {
  return parsePhysicalIdentifier(value).slice(-2).map(physicalIdentifierIdentity).join('.');
}

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
 * - `tail`: the same schema and table in any database, ignoring quotes and
 *   case. The model's meaning for a table reaches each database that lists it
 *   (decision Z-D1); a dbt dev target read in production is the same table.
 *
 * No other module keeps its own name helper (decision Z-D2):
 * `scripts/check-table-names.mjs` fails CI on a new one. Before this, about
 * 30 helpers each answered it their own way, and a table listed in two
 * databases lost the model's meaning (zlens#262).
 */
export type TableMatch = 'exact' | 'object' | 'tail';

/** The key two names share when they name the same table at `level`. */
export function tableKey(name: string, level: TableMatch = 'exact'): string {
  if (level === 'exact') return physicalRelationIdentity(name);
  const parts = parsePhysicalIdentifier(name);
  return (level === 'tail' ? parts.slice(-2) : parts).map((part) => part.value.toLowerCase()).join('.');
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
 * Whether two names name the same table at `level`. At `tail`, a bare table
 * name (no schema) matches on the table alone.
 */
export function sameTable(left: string | undefined, right: string | undefined, level: TableMatch = 'exact'): boolean {
  if (!left || !right) return false;
  if (level !== 'tail') {
    const key = tableKey(left, level);
    return key !== '' && key === tableKey(right, level);
  }
  const a = parsePhysicalIdentifier(left);
  const b = parsePhysicalIdentifier(right);
  const depth = Math.min(2, a.length, b.length);
  if (depth === 0) return false;
  const tail = (parts: PhysicalIdentifierPartV1[]) => parts.slice(-depth).map((part) => part.value.toLowerCase()).join('.');
  return tail(a) === tail(b);
}

export function samePhysicalIdentifier(left: PhysicalIdentifierPartV1 | undefined, right: PhysicalIdentifierPartV1 | undefined): boolean {
  return (!left && !right)
    || Boolean(left && right && physicalIdentifierIdentity(left) === physicalIdentifierIdentity(right));
}

export function physicalRelationBinding(input: PhysicalRelationBindingInput): PhysicalRelationBindingV1 {
  const logicalParts = parsePhysicalIdentifier(input.logicalRelation);
  const parts = parsePhysicalIdentifier(input.physicalRelation ?? input.logicalRelation);
  const table = parts.at(-1) ?? logicalParts.at(-1) ?? { value: input.logicalRelation };
  const schema = parts.length >= 2 ? parts.at(-2) : logicalParts.length >= 2 ? logicalParts.at(-2) : undefined;
  const database = parts.length >= 3 ? parts.at(-3) : undefined;
  const logicalRelation = [logicalParts.length >= 2 ? logicalParts.at(-2)?.value : undefined, logicalParts.at(-1)?.value]
    .filter(Boolean).join('.') || input.logicalRelation;
  const aliases = [...new Set([logicalRelation, physicalRelationAlias({ schema, table })].filter(Boolean))];
  return {
    version: 1,
    logicalId: `relation:${logicalRelation}`,
    logicalRelation,
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
    table,
    ...(input.driver ? { driver: input.driver } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    ...(input.executionTargetFingerprint ? { executionTargetFingerprint: input.executionTargetFingerprint } : {}),
    source: input.source ?? 'dbt_manifest',
    columns: input.columns ?? [],
    columnCompleteness: input.columnCompleteness ?? 'unknown',
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    ...(input.truncated ? { truncated: true } : {}),
    aliases,
  };
}

/**
 * Merge target observations only when they name the same exact physical
 * object. A conflicting database is deliberately surfaced to the caller;
 * silently picking either side is how a Snowflake query reaches the wrong DB.
 */
export function mergePhysicalRelationBinding(
  existing: PhysicalRelationBindingV1,
  incoming: PhysicalRelationBindingV1,
): { binding?: PhysicalRelationBindingV1; conflict?: string } {
  if (!samePhysicalIdentifier(existing.database, incoming.database) || !samePhysicalIdentifier(existing.schema, incoming.schema) || !samePhysicalIdentifier(existing.table, incoming.table)) {
    return { conflict: `physical relation conflict: ${physicalRelationText(existing)} vs ${physicalRelationText(incoming)}` };
  }
  const byName = new Map(existing.columns.map((column) => [column.name.toLowerCase(), column] as const));
  for (const column of incoming.columns) {
    const known = byName.get(column.name.toLowerCase());
    if (!known) byName.set(column.name.toLowerCase(), column);
    else byName.set(column.name.toLowerCase(), { ...known, type: column.type ?? known.type, description: column.description ?? known.description });
  }
  const complete = existing.columnCompleteness === 'complete' || incoming.columnCompleteness === 'complete';
  return {
    binding: {
      ...existing,
      columns: [...byName.values()],
      columnCompleteness: complete ? 'complete' : existing.columnCompleteness === 'partial' || incoming.columnCompleteness === 'partial' ? 'partial' : 'unknown',
      source: existing.source === incoming.source ? existing.source : 'merged',
      aliases: [...new Set([...(existing.aliases ?? []), ...(incoming.aliases ?? [])])],
      ...(incoming.observedAt ? { observedAt: incoming.observedAt } : {}),
      ...(existing.truncated || incoming.truncated ? { truncated: true } : {}),
    },
  };
}

/**
 * Whether two spellings name one physical relation. Exact identities agree
 * (quote state and case rule included); a two-part logical spelling
 * (`dev.customers`) names the same object as its database-qualified binding
 * (`nba_analysis.dev.customers`) when their tails agree — the vocabulary keeps
 * a two-part alias only while one binding owns it. Column refs are written
 * with the logical spelling while a bound semantic entry carries the exact
 * one, so every comparison between the two goes through here.
 */
export function samePhysicalRelation(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftParts = parsePhysicalIdentifier(left);
  const rightParts = parsePhysicalIdentifier(right);
  if (leftParts.length === 0 || rightParts.length === 0) return false;
  if (leftParts.length === rightParts.length) return physicalRelationIdentity(left) === physicalRelationIdentity(right);
  if (Math.min(leftParts.length, rightParts.length) !== 2 || Math.max(leftParts.length, rightParts.length) !== 3) return false;
  return physicalRelationTailIdentity(left) === physicalRelationTailIdentity(right);
}
