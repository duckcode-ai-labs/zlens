/**
 * A dbt project's model, drafted from its warehouse (RFC 0012, decision M5).
 *
 * dbt alone says what each model is built from and which joins its
 * `relationships` tests hold, and nothing else: on the NBA project it drafted
 * no join at all. So a dbt-first project reads the warehouse too. The tables
 * and views dbt built (and the sources and snapshots it reads) are read with
 * the metadata statements `zlens sync warehouse` runs, without writing a
 * catalog file, and each is keyed by the dbt node that builds it. The same
 * drafting then runs as for a warehouse-first project, and its entities bind
 * with `dbt_model:`.
 */

import { readFileSync } from 'node:fs';
import { collectDbtRelationshipTests, normalizeWarehouseCatalog, type WarehouseCatalogRelationV1, type WarehouseCatalogSnapshotV1 } from '@zlens/core';

interface DbtNode {
  uniqueId: string;
  /** `database.schema.name`, unquoted, as the warehouse spells it. */
  relation: string;
  database?: string;
  schema: string;
  /** The model's compiled SQL, when the manifest holds it: what it is built from. */
  sql?: string;
}

type Manifest = Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The warehouse relations a dbt project builds or reads: models, snapshots, seeds and sources (ephemeral models are not in the warehouse). */
export function dbtWarehouseNodes(dbtManifest: Manifest): DbtNode[] {
  const nodes: DbtNode[] = [];
  const add = (uniqueId: string, node: Record<string, unknown>) => {
    const schema = text(node.schema);
    const name = text(node.alias) ?? text(node.identifier) ?? text(node.name);
    if (!schema || !name) return;
    const database = text(node.database);
    const fromRelationName = text(node.relation_name)?.replace(/["`\[\]]/g, '');
    nodes.push({
      uniqueId,
      relation: fromRelationName ?? [database, schema, name].filter(Boolean).join('.'),
      ...(database ? { database } : {}),
      schema,
      ...(text(node.compiled_code) ?? text(node.compiled_sql) ? { sql: text(node.compiled_code) ?? text(node.compiled_sql) } : {}),
    });
  };
  for (const [uniqueId, value] of Object.entries(record(dbtManifest.nodes))) {
    const node = record(value);
    if (!['model', 'snapshot', 'seed'].includes(String(node.resource_type))) continue;
    if (record(node.config).materialized === 'ephemeral') continue;
    add(uniqueId, node);
  }
  for (const [uniqueId, value] of Object.entries(record(dbtManifest.sources))) add(uniqueId, record(value));
  return nodes.sort((a, b) => a.uniqueId.localeCompare(b.uniqueId));
}

/** The databases and schemas to read: those the dbt nodes live in. */
export function dbtWarehouseScopes(nodes: readonly DbtNode[], defaultDatabase?: string): Array<{ catalogOrDatabase: string; schemas: string[] }> {
  const byDatabase = new Map<string, Set<string>>();
  for (const node of nodes) {
    const database = node.database ?? defaultDatabase ?? '';
    byDatabase.set(database, (byDatabase.get(database) ?? new Set()).add(node.schema));
  }
  return [...byDatabase].map(([catalogOrDatabase, schemas]) => ({ catalogOrDatabase, schemas: [...schemas].sort() }));
}

/**
 * The warehouse catalog as dbt sees it: each relation a dbt node builds,
 * keyed by that node's unique id, with the model's compiled SQL as its
 * lineage, and dbt `relationships` tests as declared foreign keys. Relations
 * no dbt node owns are left out: a dbt-first entity binds a dbt node.
 */
export function dbtModelSnapshot(input: {
  dbtManifest: Manifest;
  relations: readonly WarehouseCatalogRelationV1[];
  driver: string;
  connectionId: string;
  scopes: Array<{ catalogOrDatabase: string; schemas: string[] }>;
}): WarehouseCatalogSnapshotV1 {
  const nodes = dbtWarehouseNodes(input.dbtManifest);
  const byRelation = new Map<string, DbtNode>();
  for (const node of nodes) {
    byRelation.set(node.relation.toLowerCase(), node);
    byRelation.set(`${node.schema}.${node.relation.split('.').pop()}`.toLowerCase(), node);
  }
  const relations: WarehouseCatalogRelationV1[] = [];
  const relationOfNode = new Map<string, WarehouseCatalogRelationV1>();
  for (const relation of input.relations) {
    const node = byRelation.get(relation.relation.toLowerCase()) ?? byRelation.get(`${relation.schema ?? ''}.${relation.name}`.toLowerCase());
    if (!node || relationOfNode.has(node.uniqueId)) continue;
    const keyed: WarehouseCatalogRelationV1 = { ...relation, id: node.uniqueId, ...(!relation.viewSql && node.sql ? { viewSql: node.sql } : {}) };
    relations.push(keyed);
    relationOfNode.set(node.uniqueId, keyed);
  }
  // dbt's relationships tests are declared keys: the team enforces them.
  for (const edge of collectDbtRelationshipTests(input.dbtManifest)) {
    const from = relationOfNode.get(edge.fromDbtUniqueId);
    const to = relationOfNode.get(edge.toDbtUniqueId);
    if (!from || !to || edge.fromColumn === 'unknown' || edge.toColumn === 'unknown') continue;
    from.foreignKeys = [...(from.foreignKeys ?? []), { name: 'a dbt relationships test', columns: [edge.fromColumn], references: { relation: to.relation, columns: [edge.toColumn] } }];
  }
  return normalizeWarehouseCatalog({
    version: 1,
    driver: input.driver,
    connectionId: input.connectionId,
    scopes: input.scopes,
    capturedAt: new Date().toISOString(),
    relations,
  });
}

export function readDbtManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}
