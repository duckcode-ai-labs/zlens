/**
 * Snowflake Semantic Views Provider.
 *
 * Introspects Snowflake's semantic views (CREATE SEMANTIC VIEW) to discover
 * metrics, dimensions, and relationships. Unlike file-based providers (dbt,
 * cubejs), this provider requires a live Snowflake connection.
 *
 * Because dql-core must not depend on dql-connectors, this provider accepts
 * a generic query executor function. The CLI / local-runtime injects the
 * actual Snowflake connector at runtime.
 *
 * Usage:
 *   const provider = new SnowflakeSemanticProvider(async (sql) => {
 *     return connector.execute(sql);
 *   });
 *   const layer = await provider.loadAsync(config, projectRoot);
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SemanticLayer } from '../semantic-layer.js';
import type { MetricDefinition, DimensionDefinition, JoinDefinition } from '../semantic-layer.js';
import type { SemanticLayerProviderConfig } from './provider.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface SnowflakeCacheEntry {
  timestamp: number;
  views: SemanticViewInfo[];
  viewDescriptions: Record<string, SnowflakeQueryRow[]>;
  relationships: Record<string, SnowflakeQueryRow[]>;
}

function getCachePath(projectRoot: string): string {
  return join(projectRoot, 'semantic-layer', 'cache', 'snowflake-introspection.json');
}

function readCache(projectRoot: string): SnowflakeCacheEntry | null {
  const path = getCachePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as SnowflakeCacheEntry;
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(projectRoot: string, entry: SnowflakeCacheEntry): void {
  const path = getCachePath(projectRoot);
  const dir = join(projectRoot, 'semantic-layer', 'cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(entry, null, 2), 'utf-8');
}

type MetricType = MetricDefinition['type'];
type DimensionType = DimensionDefinition['type'];

export interface SnowflakeQueryRow {
  [column: string]: unknown;
}

export interface SnowflakeQueryResult {
  rows: SnowflakeQueryRow[];
}

/** A function that executes a SQL query against Snowflake and returns rows. */
export type SnowflakeQueryExecutor = (sql: string) => Promise<SnowflakeQueryResult>;

export class SnowflakeSemanticProvider {
  /** What could not be imported, and why (a metric over two tables, an expression the native engine does not run). */
  readonly notes: string[] = [];

  readonly name = 'snowflake';

  constructor(private readonly executeQuery: SnowflakeQueryExecutor) {}

  /**
   * Load semantic layer definitions from Snowflake semantic views.
   * This is async because it needs to query Snowflake metadata.
   * Uses a file cache (1-hour TTL) to avoid repeated introspection.
   */
  async loadAsync(
    config: SemanticLayerProviderConfig,
    _projectRoot: string,
  ): Promise<SemanticLayer> {
    const layer = new SemanticLayer();
    const database = config.projectPath; // Reuse projectPath as database filter

    // Try reading from cache first
    const cached = readCache(_projectRoot);
    if (cached) {
      this.populateLayerFromCache(layer, cached);
      return layer;
    }

    // 1. Discover semantic views
    const views = await this.discoverSemanticViews(database);

    // 2. For each semantic view, load its metrics and dimensions
    const cacheEntry: SnowflakeCacheEntry = {
      timestamp: Date.now(),
      views,
      viewDescriptions: {},
      relationships: {},
    };

    for (const view of views) {
      const fqn = `"${view.databaseName}"."${view.schemaName}"."${view.name}"`;
      try {
        const desc = await this.executeQuery(`DESC SEMANTIC VIEW ${fqn}`);
        cacheEntry.viewDescriptions[fqn] = desc.rows;
      } catch { /* skip */ }
    }

    // Populate layer from the fresh data
    this.populateLayerFromCache(layer, cacheEntry);

    // Write cache for next time
    writeCache(_projectRoot, cacheEntry);

    return layer;
  }

  /**
   * Clear the cached introspection so the next load queries Snowflake fresh.
   */
  static clearCache(projectRoot: string): boolean {
    const path = getCachePath(projectRoot);
    if (existsSync(path)) {
      const { unlinkSync } = require('node:fs');
      unlinkSync(path);
      return true;
    }
    return false;
  }

  /**
   * Check if cache is present and fresh.
   */
  static isCached(projectRoot: string): { cached: boolean; age?: number } {
    const path = getCachePath(projectRoot);
    if (!existsSync(path)) return { cached: false };
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as SnowflakeCacheEntry;
      const age = Date.now() - data.timestamp;
      return { cached: age <= CACHE_TTL_MS, age };
    } catch {
      return { cached: false };
    }
  }

  private populateLayerFromCache(layer: SemanticLayer, cache: SnowflakeCacheEntry): void {
    for (const view of cache.views) {
      const fqn = `"${view.databaseName}"."${view.schemaName}"."${view.name}"`;
      const notes = addSnowflakeSemanticView(layer, view, cache.viewDescriptions[fqn] ?? []);
      for (const note of notes) this.notes.push(`${view.name}: ${note}`);
    }
  }

  /**
   * Discover available semantic views in the Snowflake account.
   */
  private async discoverSemanticViews(database?: string): Promise<SemanticViewInfo[]> {
    // Snowflake exposes semantic views via SHOW SEMANTIC VIEWS or
    // INFORMATION_SCHEMA. We try SHOW first as it's more universally available.
    let sql = 'SHOW SEMANTIC VIEWS';
    if (database) {
      sql += ` IN DATABASE "${database}"`;
    }

    try {
      const result = await this.executeQuery(sql);
      return result.rows.map((row) => ({
        name: String(row['name'] ?? row['NAME'] ?? ''),
        databaseName: String(row['database_name'] ?? row['DATABASE_NAME'] ?? ''),
        schemaName: String(row['schema_name'] ?? row['SCHEMA_NAME'] ?? ''),
      }));
    } catch {
      // SHOW SEMANTIC VIEWS may not be available in older Snowflake versions.
      // Fall back to INFORMATION_SCHEMA query.
      return this.discoverViaInformationSchema(database);
    }
  }

  private async discoverViaInformationSchema(database?: string): Promise<SemanticViewInfo[]> {
    const db = database ? `"${database}".` : '';
    const sql = `
      SELECT TABLE_NAME, TABLE_CATALOG, TABLE_SCHEMA
      FROM ${db}INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'SEMANTIC VIEW'
      ORDER BY TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME
    `;

    try {
      const result = await this.executeQuery(sql);
      return result.rows.map((row) => ({
        name: String(row['TABLE_NAME'] ?? ''),
        databaseName: String(row['TABLE_CATALOG'] ?? ''),
        schemaName: String(row['TABLE_SCHEMA'] ?? ''),
      }));
    } catch (error) {
      throw new Error(`Could not discover Snowflake semantic views: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

}

interface SemanticViewInfo {
  name: string;
  databaseName: string;
  schemaName: string;
}



/**
 * Infer the dimension type from the column SQL type.
 */
function inferDimensionType(colType: string): DimensionType {
  const typeLower = colType.toLowerCase();
  if (typeLower.includes('date') || typeLower.includes('time') || typeLower.includes('timestamp')) {
    return 'date';
  }
  if (typeLower.includes('number') || typeLower.includes('float') || typeLower.includes('decimal') || typeLower.includes('int')) {
    return 'number';
  }
  if (typeLower.includes('bool')) {
    return 'boolean';
  }
  return 'string';
}

type DescRow = Record<string, unknown>;
interface SemanticViewObject {
  kind: string;
  name: string;
  parent?: string;
  props: Record<string, string>;
}

const field = (row: DescRow, name: string): string | undefined => {
  const value = row[name] ?? row[name.toUpperCase()];
  return value === null || value === undefined || value === '' ? undefined : String(value);
};

/**
 * `DESC SEMANTIC VIEW` as Snowflake returns it: one row per property of each
 * object (`object_kind`, `object_name`, `parent_entity`, `property`,
 * `property_value`), grouped back into objects: logical tables, relationships,
 * facts, dimensions and metrics. Read live, 2026-11-07.
 */
export function semanticViewObjects(rows: DescRow[]): { comment?: string; objects: SemanticViewObject[] } {
  const objects = new Map<string, SemanticViewObject>();
  let comment: string | undefined;
  for (const row of rows) {
    const kind = field(row, 'object_kind')?.toUpperCase();
    const name = field(row, 'object_name');
    const property = field(row, 'property')?.toUpperCase();
    const value = field(row, 'property_value');
    if (!property || value === undefined) continue;
    if (!kind || !name) {
      if (property === 'COMMENT') comment = value;
      continue;
    }
    const parent = field(row, 'parent_entity');
    const key = `${kind}|${parent ?? ''}|${name}`;
    const object = objects.get(key) ?? { kind, name, ...(parent ? { parent } : {}), props: {} };
    object.props[property] = value;
    objects.set(key, object);
  }
  return { ...(comment ? { comment } : {}), objects: [...objects.values()] };
}

const AGGREGATES: Record<string, MetricType> = { SUM: 'sum', AVG: 'avg', MIN: 'min', MAX: 'max', COUNT: 'count' };
const lower = (value: string) => value.toLowerCase();

/** The text inside the outer parentheses of `FN( … )`, when they close at the very end. */
function outerCall(expression: string): { fn: string; inner: string } | undefined {
  const match = /^\s*([A-Za-z_]+)\s*\(([\s\S]*)\)\s*$/.exec(expression);
  if (!match) return undefined;
  let depth = 0;
  for (const char of match[2]!) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return undefined;
  }
  return depth === 0 ? { fn: match[1]!.toUpperCase(), inner: match[2]!.trim() } : undefined;
}

/**
 * Add one Snowflake semantic view to the layer: a cube and semantic model per
 * logical table (over its base table, keyed on its primary key), a join per
 * relationship, each dimension, and each metric the native engine can run: an
 * aggregate of one table's columns and facts (`SUM(WINS)`,
 * `SUM(seasons.points_scored)` with the fact expanded), or arithmetic over
 * other metrics (`seasons.total_wins / NULLIF(seasons.games_played, 0)` is a
 * ratio). Returns what it left out, and why. Compiled SQL reads the base tables.
 */
export function addSnowflakeSemanticView(layer: SemanticLayer, view: { name: string; databaseName: string; schemaName: string }, rows: DescRow[]): string[] {
  const notes: string[] = [];
  const { comment, objects } = semanticViewObjects(rows);
  const viewKey = lower(view.name);
  const fqn = `"${view.databaseName}"."${view.schemaName}"."${view.name}"`;
  const tables = new Map(objects.filter((object) => object.kind === 'TABLE').map((object) => [lower(object.name), object]));
  const cubeOf = (table: string) => `${viewKey}_${lower(table)}`;
  const baseOf = (table: SemanticViewObject) => [table.props.BASE_TABLE_DATABASE_NAME, table.props.BASE_TABLE_SCHEMA_NAME, table.props.BASE_TABLE_NAME].filter(Boolean).join('.');
  const ofKind = (kind: string) => objects.filter((object) => object.kind === kind && object.props.ACCESS_MODIFIER?.toUpperCase() !== 'PRIVATE');
  const facts = new Map(objects.filter((object) => object.kind === 'FACT').map((object) => [`${lower(object.parent ?? '')}.${lower(object.name)}`, object]));
  const metrics = new Map(objects.filter((object) => object.kind === 'METRIC').map((object) => [`${lower(object.parent ?? '')}.${lower(object.name)}`, object]));
  const source = (objectType: 'semantic_view' | 'metric' | 'dimension', id: string, name: string) => ({ provider: 'snowflake' as const, objectType, objectId: id, objectName: name });

  // `table.name` references in an expression: a fact is expanded, the owning table's column loses its prefix.
  const resolve = (expression: string, owner: string, depth = 0): { sql: string; otherTable?: string; metricRefs: string[] } => {
    const metricRefs: string[] = [];
    let otherTable: string | undefined;
    const sql = expression.replace(/\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)\b/g, (whole, table: string, name: string) => {
      const key = `${lower(table)}.${lower(name)}`;
      if (!tables.has(lower(table))) return whole;
      if (metrics.has(key)) {
        metricRefs.push(key);
        return whole;
      }
      const fact = facts.get(key);
      if (fact && depth < 5) {
        const inner = resolve(fact.props.EXPRESSION ?? name, lower(table), depth + 1);
        if (inner.otherTable) otherTable = inner.otherTable;
        if (lower(table) !== owner) otherTable = lower(table);
        return `(${inner.sql})`;
      }
      if (lower(table) !== owner) otherTable = lower(table);
      return name;
    });
    return { sql, ...(otherTable ? { otherTable } : {}), metricRefs };
  };

  // Relationships first: the layer indexes a cube's joins when the cube is added.
  const joinsOf = new Map<string, JoinDefinition[]>();
  for (const relationship of objects.filter((object) => object.kind === 'RELATIONSHIP')) {
    const left = lower(relationship.props.TABLE ?? relationship.parent ?? '');
    const right = lower(relationship.props.REF_TABLE ?? '');
    let foreign: string[] = [];
    let referenced: string[] = [];
    try {
      foreign = JSON.parse(relationship.props.FOREIGN_KEY ?? '[]') as string[];
      referenced = JSON.parse(relationship.props.REF_KEY ?? '[]') as string[];
    } catch { /* unreadable keys */ }
    if (!tables.has(left) || !tables.has(right) || foreign.length === 0 || foreign.length !== referenced.length) {
      notes.push(`relationship ${relationship.name} left out: its tables or keys could not be read`);
      continue;
    }
    joinsOf.set(cubeOf(left), [...(joinsOf.get(cubeOf(left)) ?? []), {
      name: `${cubeOf(left)}_to_${cubeOf(right)}`, left: cubeOf(left), right: cubeOf(right), type: 'left',
      sql: foreign.map((column, index) => `\${left}.${column} = \${right}.${referenced[index]}`).join(' AND '),
    }]);
  }

  for (const table of tables.values()) {
    const cube = cubeOf(table.name);
    const base = baseOf(table);
    if (!base) {
      notes.push(`logical table ${table.name} has no base table`);
      continue;
    }
    const description = table.props.COMMENT ?? `Table ${table.name} of Snowflake semantic view ${fqn}`;
    if (!layer.getCube(cube)) {
      layer.addCube({
        name: cube, label: `${view.name} ${table.name}`.replace(/_/g, ' '), description, sql: `SELECT * FROM ${base}`, table: base,
        domain: view.schemaName || 'snowflake', measures: [], dimensions: [], timeDimensions: [], joins: joinsOf.get(cube) ?? [], segments: [], preAggregations: [],
        source: source('semantic_view', `${fqn}.${table.name}`, table.name),
      });
      let primaryKey: string[] = [];
      try { primaryKey = JSON.parse(table.props.PRIMARY_KEY ?? '[]') as string[]; } catch { /* no key */ }
      layer.addSemanticModel({
        name: cube, label: `${view.name} ${table.name}`.replace(/_/g, ' '), description, domain: view.schemaName || 'snowflake', table: base,
        entities: primaryKey.map((column) => `${cube}.${lower(column)}`), measures: [], dimensions: [], timeDimensions: [],
        source: source('semantic_view', `${fqn}.${table.name}`, table.name),
      });
    }
  }

  for (const dimension of ofKind('DIMENSION')) {
    const owner = lower(dimension.parent ?? '');
    const table = tables.get(owner);
    if (!table) continue;
    const resolved = resolve(dimension.props.EXPRESSION ?? dimension.name, owner);
    if (resolved.otherTable) {
      notes.push(`dimension ${dimension.name} reads another table (${resolved.otherTable}): left out`);
      continue;
    }
    const cube = cubeOf(owner);
    const plain = lower(dimension.name);
    const taken = layer.getDimension(plain);
    const definition: DimensionDefinition = {
      name: taken && taken.cube !== cube ? `${viewKey}_${plain}` : plain,
      label: dimension.name.replace(/_/g, ' ').toLowerCase(),
      description: dimension.props.COMMENT ?? `Dimension of ${view.name}`,
      sql: resolved.sql,
      type: inferDimensionType(dimension.props.DATA_TYPE ?? ''),
      table: baseOf(table),
      domain: view.schemaName,
      cube,
      source: source('dimension', `${fqn}.${dimension.name}`, dimension.name),
    };
    layer.addDimension(definition);
    const model = layer.getSemanticModel(cube);
    if (definition.type === 'date') {
      layer.getCube(cube)?.timeDimensions.push({ ...definition, isTimeDimension: true, granularities: ['day', 'week', 'month', 'quarter', 'year'] });
      model?.timeDimensions.push(definition.name);
    } else {
      layer.getCube(cube)?.dimensions.push(definition);
      model?.dimensions.push(definition.name);
    }
  }

  // Plain names, as the layer names metrics; the view's name in front only when another model has the name.
  const metricNames = new Map<string, string>();
  for (const [key] of metrics) {
    const plain = key.split('.').pop()!;
    metricNames.set(key, layer.getMetric(plain) ? `${viewKey}_${plain}` : plain);
  }
  const metricName = (key: string) => metricNames.get(key) ?? key.split('.').pop()!;
  for (const metric of ofKind('METRIC')) {
    const owner = lower(metric.parent ?? '');
    const table = tables.get(owner);
    if (!table) continue;
    const expression = metric.props.EXPRESSION ?? '';
    const name = metricName(`${owner}.${lower(metric.name)}`);
    const cube = cubeOf(owner);
    const common = {
      name, label: metric.name.replace(/_/g, ' ').toLowerCase(), description: metric.props.COMMENT ?? `Metric of ${view.name}`,
      domain: view.schemaName, cube, source: source('metric', `${fqn}.${metric.name}`, metric.name),
    };
    const call = outerCall(expression);
    const aggregate = call ? AGGREGATES[call.fn] : undefined;
    const resolved = resolve(call && aggregate ? call.inner : expression, owner);
    if (call && aggregate && resolved.metricRefs.length === 0) {
      if (resolved.otherTable) {
        notes.push(`metric ${metric.name} aggregates another table (${resolved.otherTable}): left out`);
        continue;
      }
      const distinct = /^distinct\s+/i.test(resolved.sql);
      const type: MetricType = aggregate === 'count' && distinct ? 'count_distinct' : aggregate;
      const definition: MetricDefinition = {
        ...common, sql: distinct ? resolved.sql.replace(/^distinct\s+/i, '') : resolved.sql, type, table: baseOf(table), aggregation: type, metricType: 'simple',
      };
      layer.addMetric(definition);
      layer.getCube(cube)?.measures.push(definition);
      layer.getSemanticModel(cube)?.measures.push(name);
      continue;
    }
    // Arithmetic over other metrics: a ratio when it is `a / b` or `a / NULLIF(b, 0)`, else derived.
    const refs = [...new Set(resolved.metricRefs)];
    const residue = expression.replace(/\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)\b/g, (whole, t: string, n: string) => (metrics.has(`${lower(t)}.${lower(n)}`) ? 'M' : whole));
    if (refs.length === 0 || /[A-Za-z_]\w*\s*\.\s*[A-Za-z_]/.test(residue) || !/^[\sM0-9.+\-*/(),]*$/i.test(residue.replace(/\bNULLIF\b|\bCOALESCE\b|\bROUND\b|\bABS\b/gi, ''))) {
      notes.push(`metric ${metric.name} (${expression}) is not an aggregate of one table or arithmetic over metrics: left out`);
      continue;
    }
    const ratio = /^\s*([A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*)\s*\/\s*(?:NULLIF\s*\(\s*([A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*)\s*,\s*0\s*\)|([A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*))\s*$/i.exec(expression);
    const key = (ref: string) => lower(ref.replace(/\s+/g, ''));
    const definition: MetricDefinition = ratio
      ? { ...common, sql: expression, type: 'custom', table: '', metricType: 'ratio', typeParams: { numerator: { name: metricName(key(ratio[1]!)) }, denominator: { name: metricName(key(ratio[2] ?? ratio[3]!)) } } }
      : {
        ...common, sql: expression, type: 'custom', table: '', metricType: 'derived',
        typeParams: {
          expr: expression.replace(/\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)\b/g, (whole, t: string, n: string) => (metrics.has(`${lower(t)}.${lower(n)}`) ? lower(n) : whole)),
          metrics: refs.map((ref) => ({ name: metricName(ref), alias: ref.split('.').pop()! })),
        },
      };
    layer.addMetric(definition);
    layer.getSemanticModel(cube)?.measures.push(name);
  }
  if (comment && !layer.getSemanticModel(viewKey)) {
    // The view's own description, for search: its tables carry their own.
    for (const table of tables.values()) {
      const model = layer.getSemanticModel(cubeOf(table.name));
      if (model && !model.description.includes(comment)) model.description = `${model.description} (${view.name}: ${comment})`;
    }
  }
  return notes;
}
