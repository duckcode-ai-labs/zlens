import {
  applyTableProfile,
  getDialect,
  proposeTableDataset,
  readWarehouseCatalog,
  warehouseRelationId,
  wordsFor,
  type TableDatasetProposal,
  type TableProfile,
} from '@zlens/core';

/**
 * Start from a table (RFC 0009, "15-minute first page"): the server side.
 * Tables come from the synced warehouse catalog when there is one, else from
 * the database's own information schema. Every identifier used in SQL comes
 * from that listing, never from the request.
 */
export interface WarehouseTableSummary {
  id: string;
  name: string;
  schema?: string;
  /** The relation as SQL names it, quoted for the dialect. */
  relation: string;
  kind: string;
  columns: Array<{ name: string; type?: string }>;
  primaryKey?: string[];
  rowCountEstimate?: number;
}

/** Runs one statement; `metadata` marks a schema read (RFC 0010 row policies can tell it apart). */
type RunSql = (sql: string, purpose?: 'data' | 'metadata') => Promise<Array<Record<string, unknown>>>;

/** Dialects whose information schema lists tables and columns without extra scoping. */
const LIVE_LISTING = new Set(['duckdb', 'file', 'postgresql', 'redshift', 'snowflake', 'mysql']);
const SYSTEM_SCHEMAS = ['information_schema', 'pg_catalog', 'pg_toast', 'sys', 'performance_schema', 'mysql'];
const MAX_COLUMNS = 5_000;

export class TableDatasetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TableDatasetError';
  }
}

/** The tables an author can start from. */
export async function listWarehouseTables(input: { projectRoot: string; driver: string; run: RunSql }): Promise<{ tables: WarehouseTableSummary[]; source: 'catalog' | 'live' }> {
  const { snapshot } = readWarehouseCatalog(input.projectRoot);
  if (snapshot?.relations.length) {
    return {
      source: 'catalog',
      tables: snapshot.relations.map((relation) => ({
        id: relation.id,
        name: relation.name,
        ...(relation.schema ? { schema: relation.schema } : {}),
        relation: relation.relation,
        kind: relation.kind,
        columns: relation.columns.map((column) => ({ name: column.name, ...(column.type ? { type: column.type } : {}) })),
        ...(relation.primaryKey?.length ? { primaryKey: relation.primaryKey } : {}),
        ...(relation.rowCountEstimate !== undefined ? { rowCountEstimate: relation.rowCountEstimate } : {}),
      })),
    };
  }
  const driver = input.driver.trim().toLowerCase();
  if (!LIVE_LISTING.has(driver)) {
    throw new TableDatasetError('TABLES_NEED_SYNC', 'Read your database\'s tables first: open Settings → Connection and choose Find available databases & schemas.');
  }
  const dialect = getDialect(driver);
  const rows = await input.run([
    'SELECT table_schema, table_name, column_name, data_type',
    'FROM information_schema.columns',
    `WHERE LOWER(table_schema) NOT IN (${SYSTEM_SCHEMAS.map((schema) => `'${schema}'`).join(', ')})`,
    'ORDER BY table_schema, table_name, ordinal_position',
    `LIMIT ${MAX_COLUMNS}`,
  ].join('\n'), 'metadata');
  const byTable = new Map<string, WarehouseTableSummary>();
  for (const row of rows) {
    const pick = (key: string) => String(row[key] ?? row[key.toUpperCase()] ?? '');
    const schema = pick('table_schema');
    const name = pick('table_name');
    const column = pick('column_name');
    if (!name || !column) continue;
    const id = warehouseRelationId({ schema, name });
    const table = byTable.get(id) ?? {
      id,
      name,
      ...(schema ? { schema } : {}),
      relation: [schema, name].filter(Boolean).map((part) => dialect.quoteIdentifier(part)).join('.'),
      kind: 'table',
      columns: [],
    };
    table.columns.push({ name: column, ...(pick('data_type') ? { type: pick('data_type') } : {}) });
    byTable.set(id, table);
  }
  return { source: 'live', tables: [...byTable.values()] };
}

/**
 * What DQL proposes for one table, checked against its rows: which column is
 * different on every row (so rows can be counted), and the row count.
 */
export async function draftTableDataset(input: { table: WarehouseTableSummary; driver: string; run: RunSql }): Promise<{ proposal: TableDatasetProposal; rows: number }> {
  const proposal = proposeTableDataset({ table: input.table.name, relation: input.table.relation, columns: input.table.columns, ...(input.table.primaryKey ? { primaryKey: input.table.primaryKey } : {}) });
  if (!proposal.fields.length) {
    throw new TableDatasetError('TABLE_HAS_NO_COLUMNS', `${input.table.name} has no columns ZLens can read by name.`);
  }
  const profile = await profileTable({ relation: input.table.relation, columns: proposal.keyCandidates, driver: input.driver, run: input.run });
  return { proposal: applyTableProfile(proposal, profile, input.table.name), rows: profile.rows };
}

/**
 * "Add fields" to a saved query (design D1): the same proposal as a table,
 * read from the saved query's output columns, with its SQL as the relation
 * (a subquery), checked against its rows. A saved query's result is often
 * already grouped, so a text column that is different on every row (a
 * customer name in a top-10 list) can be its row identity too; those are
 * checked after id-like columns and never become counts of their own.
 */
export async function draftSavedQueryDataset(input: {
  /** The block's name: names the proposal and, without a grain, what one row is. */
  blockName: string;
  /** The block's legacy `grain = "customer"`, when it declares one: what one row is. */
  grain?: string;
  /** The saved query as a relation: `(<its SQL>) AS "dql_saved_query"` (see `savedQueryRelation`). */
  relation: string;
  /** Its output columns and their warehouse types, read from a zero-row run. */
  columns: Array<{ name: string; type?: string }>;
  driver: string;
  run: RunSql;
}): Promise<{ proposal: TableDatasetProposal; rows: number }> {
  const rowName = input.grain?.trim() || input.blockName;
  const proposal = proposeTableDataset({ table: rowName, relation: input.relation, columns: input.columns });
  if (!proposal.fields.length) {
    throw new TableDatasetError('SAVED_QUERY_HAS_NO_COLUMNS', `${wordsFor(input.blockName)} has no columns ZLens can read by name.`);
  }
  const textColumns = proposal.fields
    .filter((field) => field.role === 'dimension' && field.type === 'string')
    .map((field) => field.name);
  const keyCandidates = [...proposal.keyCandidates, ...textColumns]
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, 8);
  const profile = await profileTable({ relation: input.relation, columns: keyCandidates, driver: input.driver, run: input.run });
  const settled = applyTableProfile({ ...proposal, keyCandidates }, profile, rowName);
  return { proposal: { ...settled, name: wordsFor(input.blockName) }, rows: profile.rows };
}

/** A saved query's SQL as a relation the proposal and its checks read from. */
export function savedQueryRelation(sql: string, driver: string): string {
  const body = sql.trim().replace(/;\s*$/, '');
  if (!body) throw new TableDatasetError('SAVED_QUERY_HAS_NO_SQL', 'This saved query has no SQL to read columns from.');
  return `(${body}) AS ${getDialect(driver).quoteIdentifier('dql_saved_query')}`;
}

/** Counts rows, and distinct and non-empty values of the key candidates, in one scan. */
export async function profileTable(input: { relation: string; columns: string[]; driver: string; run: RunSql }): Promise<TableProfile> {
  const dialect = getDialect(input.driver);
  const quote = (name: string) => dialect.quoteIdentifier(name);
  const selects = [
    `COUNT(*) AS ${quote('dql_rows')}`,
    ...input.columns.flatMap((column, index) => [
      `COUNT(DISTINCT ${quote(column)}) AS ${quote(`dql_distinct_${index}`)}`,
      `COUNT(${quote(column)}) AS ${quote(`dql_filled_${index}`)}`,
    ]),
  ];
  const [row] = await input.run(`SELECT ${selects.join(', ')} FROM ${input.relation}`);
  const read = (key: string) => Number(row?.[key] ?? row?.[key.toUpperCase()] ?? 0);
  return {
    rows: read('dql_rows'),
    columns: Object.fromEntries(input.columns.map((column, index) => [column, { distinct: read(`dql_distinct_${index}`), nonNull: read(`dql_filled_${index}`) }])),
  };
}

/**
 * Apply the author's choices to a proposal the server re-derived: which
 * numbers to keep and how to show them. Nothing else in the request is used.
 */
export function applyTableDatasetChoices(proposal: TableDatasetProposal, raw: unknown): TableDatasetProposal {
  const choices = Array.isArray(raw) ? raw : [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const choice of choices) {
    if (choice && typeof choice === 'object' && typeof (choice as { name?: unknown }).name === 'string') byName.set((choice as { name: string }).name, choice as Record<string, unknown>);
  }
  return {
    ...proposal,
    measures: proposal.measures.map((measure) => {
      const choice = byName.get(measure.name);
      if (!choice) return measure;
      const format = choice.format === 'currency' || choice.format === 'percent' || choice.format === 'number' ? choice.format : measure.format;
      const currency = typeof choice.currency === 'string' && /^[A-Z]{3}$/.test(choice.currency) ? choice.currency : measure.currency;
      return {
        ...measure,
        include: typeof choice.include === 'boolean' ? choice.include : measure.include,
        format,
        ...(format === 'currency' ? { currency: currency ?? 'USD' } : {}),
      };
    }),
  };
}
