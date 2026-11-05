import {
  parsePhysicalIdentifier,
  physicalIdentifierIdentity,
  physicalRelationIdentity,
  type PhysicalIdentifierPartV1,
} from '@zlens/core';

// One answer to "is this the same table?" lives in @zlens/core (simplification plan Z1, part 3).
export {
  parsePhysicalIdentifier,
  physicalIdentifierIdentity,
  physicalRelationIdentity,
  sameTable,
  tableKey,
  tableName,
  type PhysicalIdentifierPartV1,
  type TableMatch,
} from '@zlens/core';

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

export function physicalRelationText(binding: Pick<PhysicalRelationBindingV1, 'database' | 'schema' | 'table'>, quote = false): string {
  const render = (part: PhysicalIdentifierPartV1) => quote || part.quoted
    ? `"${part.value.replace(/"/g, '""')}"`
    : part.value;
  return [binding.database, binding.schema, binding.table].filter((part): part is PhysicalIdentifierPartV1 => Boolean(part)).map(render).join('.');
}

export function physicalRelationAlias(binding: Pick<PhysicalRelationBindingV1, 'schema' | 'table'>): string {
  return [binding.schema?.value, binding.table.value].filter(Boolean).join('.');
}

/** A two-part tail is for diagnostics only; it must never select a database. */
export function physicalRelationTailIdentity(value: string): string {
  return parsePhysicalIdentifier(value).slice(-2).map(physicalIdentifierIdentity).join('.');
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
