import {
  applyTableDuplicateChoices,
  applyTableProfile,
  getDialect,
  proposeTableDataset,
  readWarehouseCatalog,
  warehouseRelationId,
  withDuplicateUnitRelations,
  wordsFor,
  type DuplicateUnitRelation,
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
export async function draftTableDataset(input: {
  table: WarehouseTableSummary;
  driver: string;
  run: RunSql;
  /** The row key setup or Modeling already checked for this table (design D7): checked alone first. */
  modeledKey?: string;
}): Promise<{ proposal: TableDatasetProposal; rows: number }> {
  const primaryKey = input.table.primaryKey ?? (input.modeledKey ? [input.modeledKey] : undefined);
  // ZLens writes this Dataset's SQL, so cents columns are read as dollars.
  const proposed = proposeTableDataset({ table: input.table.name, relation: input.table.relation, columns: input.table.columns, ...(primaryKey ? { primaryKey } : {}), convertMinorUnits: true });
  if (!proposed.fields.length) {
    throw new TableDatasetError('TABLE_HAS_NO_COLUMNS', `${input.table.name} has no columns ZLens can read by name.`);
  }
  // `subtotal` beside `subtotal_cents`: the data says whether they are the same
  // amount in two units or the same number twice, and the question says so.
  const proposal = proposed.duplicates?.length
    ? withDuplicateUnitRelations(proposed, await checkDuplicateUnits({ relation: input.table.relation, pairs: proposed.duplicates, driver: input.driver, run: input.run }))
    : proposed;
  // A key the model already checked is counted on its own (one distinct count,
  // not up to eight); only when it no longer holds are the other candidates tried.
  if (input.modeledKey && proposal.keyCandidates.includes(input.modeledKey)) {
    const quick = await profileTable({ relation: input.table.relation, columns: [input.modeledKey], driver: input.driver, run: input.run });
    const settled = applyTableProfile(proposal, quick, input.table.name);
    if (settled.key) return { proposal: settled, rows: quick.rows };
  }
  const profile = await profileTable({ relation: input.table.relation, columns: proposal.keyCandidates, driver: input.driver, run: input.run });
  return { proposal: applyTableProfile(proposal, profile, input.table.name), rows: profile.rows };
}

/**
 * How each duplicate pair relates on the data (new-user round 2, problem 7):
 * `hundredths` when the cents column is the plain one × 100 on (nearly) every
 * row where both are filled, `same` when they hold the same number. One
 * aggregate statement; nothing when it cannot be read or the rows say neither.
 */
export async function checkDuplicateUnits(input: {
  relation: string;
  pairs: Array<{ name: string; plainColumn: string; minorColumn: string }>;
  driver: string;
  run: RunSql;
}): Promise<Record<string, DuplicateUnitRelation | undefined>> {
  if (!input.pairs.length) return {};
  const quote = (name: string) => getDialect(input.driver).quoteIdentifier(name);
  const selects = input.pairs.flatMap((pair, index) => {
    const plain = `CAST(${quote(pair.plainColumn)} AS DOUBLE PRECISION)`;
    const minor = `CAST(${quote(pair.minorColumn)} AS DOUBLE PRECISION)`;
    return [
      `COUNT(CASE WHEN ${plain} IS NOT NULL AND ${minor} IS NOT NULL AND ${minor} <> 0 THEN 1 END) AS ${quote(`dql_both_${index}`)}`,
      `COUNT(CASE WHEN ${minor} <> 0 AND ABS(${plain} * 100 - ${minor}) < 0.5 THEN 1 END) AS ${quote(`dql_hundredths_${index}`)}`,
      `COUNT(CASE WHEN ${minor} <> 0 AND ABS(${plain} - ${minor}) < 0.005 THEN 1 END) AS ${quote(`dql_same_${index}`)}`,
    ];
  });
  try {
    const [row] = await input.run(`SELECT ${selects.join(', ')} FROM ${input.relation}`);
    const read = (key: string) => Number(row?.[key] ?? row?.[key.toUpperCase()] ?? 0);
    return Object.fromEntries(input.pairs.map((pair, index) => {
      const both = read(`dql_both_${index}`);
      if (!(both > 0)) return [pair.name, undefined];
      const hundredths = read(`dql_hundredths_${index}`) / both;
      const same = read(`dql_same_${index}`) / both;
      return [pair.name, hundredths >= 0.99 ? 'hundredths' : same >= 0.99 ? 'same' : undefined];
    }));
  } catch {
    // The question still asks, worded from the column names alone.
    return {};
  }
}

/**
 * Whether a database table is already modeled (design D7): an entity in the
 * project's model binds it ("Modeled"), or "Draft my models" drafted one that
 * waits for review in Modeling ("Drafted"). Both carry the row key that was
 * checked, so "Check and add" reuses it.
 */
export interface TableModelState {
  state: 'modeled' | 'drafted';
  entity: string;
  domain: string;
  /** The checked row key, when it is one column. */
  key?: string;
  /** The drafted proposal Modeling opens for review. */
  proposalId?: string;
}

interface ModelEntityLike {
  dbtUniqueId?: string;
  relation?: string;
  localId?: string;
  id?: string;
  domain: string;
  businessName?: string;
  grain?: string;
  keys?: string[];
}

interface ProposalLike {
  id: string;
  status?: string;
  origin?: string;
  operations?: ReadonlyArray<{ kind?: string; change?: unknown }>;
}

const bareRelation = (relation: string | undefined): string => (relation ?? '').replace(/["`\[\]]/g, '').toLowerCase();

function singleKey(grain: string | undefined, keys: string[] | undefined): string | undefined {
  const fromGrain = grain?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
  if (fromGrain.length === 1) return fromGrain[0];
  return !fromGrain.length && keys?.length === 1 ? keys[0] : undefined;
}

export function tableModelStates(input: {
  tables: Array<Pick<WarehouseTableSummary, 'id' | 'relation'>>;
  entities: ModelEntityLike[];
  /** Newest first, as the proposal store lists them. */
  proposals: ProposalLike[];
}): Map<string, TableModelState> {
  const states = new Map<string, TableModelState>();
  const byId = new Map(input.tables.map((table) => [table.id, table.id]));
  const byRelation = new Map(input.tables.map((table) => [bareRelation(table.relation), table.id]));
  const tableFor = (id: unknown, relation?: unknown): string | undefined =>
    (typeof id === 'string' ? byId.get(id) : undefined) ?? (typeof relation === 'string' ? byRelation.get(bareRelation(relation)) : undefined);
  for (const entity of input.entities) {
    const table = tableFor(entity.dbtUniqueId, entity.relation);
    if (!table || states.has(table)) continue;
    const key = singleKey(entity.grain, entity.keys);
    states.set(table, { state: 'modeled', entity: entity.businessName || entity.localId || entity.id || table, domain: entity.domain, ...(key ? { key } : {}) });
  }
  for (const proposal of input.proposals) {
    if (proposal.status !== 'proposed' || proposal.origin !== 'warehouse_discovery') continue;
    for (const operation of proposal.operations ?? []) {
      const change = operation.change as { operation?: string; value?: Record<string, unknown> } | undefined;
      const value = change?.operation === 'upsert_entity' ? change.value : undefined;
      if (!value) continue;
      const table = tableFor(value.dbtModel, value.relation);
      if (!table || states.has(table)) continue;
      const key = singleKey(typeof value.grain === 'string' ? value.grain : undefined, Array.isArray(value.keys) ? value.keys.filter((item): item is string => typeof item === 'string') : undefined);
      states.set(table, {
        state: 'drafted',
        entity: String(value.businessName ?? value.id ?? table),
        domain: String(value.domain ?? ''),
        proposalId: proposal.id,
        ...(key ? { key } : {}),
      });
    }
  }
  return states;
}

/**
 * "Add fields" to a saved query (design D1): the same proposal as a table,
 * read from the saved query's output columns, with its SQL as the relation
 * (a subquery), checked against its rows. A saved query's result is often
 * already grouped, so a text column that is different on every row (a
 * customer name in a top-10 list) can be its row identity too; those are
 * checked after id-like columns and never become counts of their own. So can
 * a period column (one row per month), checked last.
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
  // A period column (a month) can be the row key too, when it is filled and
  // different on every row (B12): checked last, after ids and text, with the
  // same proof.
  const timeKeys = new Set(proposal.fields.filter((field) => field.role === 'time').map((field) => field.name));
  const keyCandidates = [
    ...proposal.keyCandidates.filter((name) => !timeKeys.has(name)),
    ...textColumns,
    ...proposal.keyCandidates.filter((name) => timeKeys.has(name)),
  ]
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
 * Apply the author's choices to a proposal the server re-derived: which of
 * two duplicate columns to use (design Q1.4; unanswered means the
 * recommended one), then which numbers to keep and how to show them. Nothing
 * else in the request is used.
 */
export function applyTableDatasetChoices(drafted: TableDatasetProposal, raw: unknown, duplicates?: unknown): TableDatasetProposal {
  const proposal = applyTableDuplicateChoices(drafted, duplicates);
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
      const asked = choice.format === 'currency' || choice.format === 'percent' || choice.format === 'number' ? choice.format : measure.format;
      // A number stored in cents that the Dataset does not convert is never Money: it would read 100 times too large.
      const format = measure.minorUnits && asked === 'currency' ? measure.format : asked;
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
