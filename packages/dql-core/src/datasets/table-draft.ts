/**
 * Start from a table (RFC 0009, "15-minute first page").
 *
 * A new author with a warehouse and no dbt picks a table; DQL proposes what
 * it can count and group, in plain words, and writes the answer as an
 * ordinary Dataset block the author owns. This module is the pure part:
 * reading column names and types into fields and measures, choosing which
 * columns to check as the row identity, and rendering the block source.
 * Nothing here runs SQL or decides trust; the server profiles the table, and
 * the block goes through the same save-and-certify path as any saved block.
 */
export type TableColumnKind = 'number' | 'date' | 'timestamp' | 'boolean' | 'string';

export interface TableColumnInput { name: string; type?: string }

export interface TableDatasetMeasure {
  /** Identifier in the block. */
  name: string;
  /** What readers will see: the name in words ("Net amount", "Customer count"). */
  label: string;
  aggregation: 'sum' | 'count_distinct' | 'count';
  from: string;
  format: 'number' | 'currency' | 'percent';
  currency?: string;
  /** Proposed on; the author can switch it off. */
  include: boolean;
  /** Why it was proposed, in words. */
  reason: string;
}

export interface TableDatasetField {
  name: string;
  label: string;
  role: 'key' | 'dimension' | 'time' | 'attribute';
  type: TableColumnKind;
  grains?: string[];
  primary?: boolean;
}

export interface TableDatasetProposal {
  /** The block's name: "Order lines". */
  name: string;
  /** The relation as the warehouse spells it. */
  relation: string;
  fields: TableDatasetField[];
  measures: TableDatasetMeasure[];
  /** The column to check as one row each, and what one row is. */
  key?: { column: string; entity: string };
  /** Columns worth profiling as the row identity, most likely first. */
  keyCandidates: string[];
  /** Columns left out because their names are not plain identifiers. */
  skipped?: string[];
}

export interface TableProfile {
  rows: number;
  /** Per profiled column: distinct values and non-empty values. */
  columns: Record<string, { distinct: number; nonNull: number }>;
}

const TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const ID_NAME = /(^id$|_id$|_key$|_code$|_uuid$|^uuid$|_number$|_no$|^sku$)/i;
const NOT_A_MEASURE = /(^id$|_id$|_key$|_code$|year|month|day|week|quarter|zip|postal|phone|lat|lon|lng|latitude|longitude|_no$|_number$|rank|version|age$)/i;
const MONEY = /(amount|revenue|sales|price|cost|spend|fee|total|value|income|profit|margin|budget|premium|payment|paid|balance|salary|charge)/i;
const RATE = /(rate|ratio|pct|percent|share)$/i;

/** A column's kind from its warehouse type. */
export function tableColumnKind(type: string | undefined): TableColumnKind {
  const value = (type ?? '').toLowerCase();
  if (/bool/.test(value)) return 'boolean';
  if (/timestamp|datetime/.test(value)) return 'timestamp';
  if (/^date|\bdate\b/.test(value)) return 'date';
  if (/int|numeric|decimal|double|float|real|number|money|bigint|smallint|tinyint|hugeint/.test(value)) return 'number';
  return 'string';
}

/** "order_lines" reads "Order lines"; "net_amount" reads "Net amount". */
export function wordsFor(name: string): string {
  const words = name.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function singular(name: string): string {
  const words = wordsFor(name).toLowerCase();
  if (words.endsWith('ies')) return `${words.slice(0, -3)}y`;
  if (words.endsWith('ses') || words.endsWith('xes')) return words.slice(0, -2);
  if (words.endsWith('s') && !words.endsWith('ss')) return words.slice(0, -1);
  return words;
}

/**
 * What DQL proposes for a table before it is profiled: dates become time
 * fields, text and id-like columns become categories, numbers that are not
 * ids become totals, and id-like columns become distinct counts.
 */
export function proposeTableDataset(input: { table: string; relation: string; columns: TableColumnInput[]; primaryKey?: string[] }): TableDatasetProposal {
  // Dataset fields are plain identifiers; a column that is not one is left out and named in `skipped`.
  const columns = input.columns
    .filter((column) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column.name))
    .map((column) => ({ name: column.name, kind: tableColumnKind(column.type) }));
  const skipped = input.columns.filter((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.name)).map((column) => column.name);
  const primary = input.primaryKey?.length === 1 ? input.primaryKey[0] : undefined;
  const tableStem = singular(input.table).replace(/\s+/g, '_');
  const keyCandidates = [
    ...(primary ? [primary] : []),
    ...columns.filter((column) => column.name.toLowerCase() === 'id').map((column) => column.name),
    ...columns.filter((column) => column.name.toLowerCase() === `${tableStem}_id`).map((column) => column.name),
    ...columns.filter((column) => ID_NAME.test(column.name) && column.kind !== 'boolean').map((column) => column.name),
  ].filter((name, index, all) => all.indexOf(name) === index).slice(0, 8);
  let firstTime = true;
  const fields: TableDatasetField[] = columns.map((column) => {
    if (column.kind === 'date' || column.kind === 'timestamp') {
      const field: TableDatasetField = { name: column.name, label: wordsFor(column.name), role: 'time', type: column.kind, grains: TIME_GRAINS, ...(firstTime ? { primary: true } : {}) };
      firstTime = false;
      return field;
    }
    if (column.kind === 'number' && !NOT_A_MEASURE.test(column.name)) {
      return { name: column.name, label: wordsFor(column.name), role: 'attribute', type: 'number' };
    }
    return { name: column.name, label: wordsFor(column.name), role: 'dimension', type: column.kind === 'number' ? 'number' : column.kind };
  });
  const measures: TableDatasetMeasure[] = [];
  const taken = new Set<string>();
  const add = (measure: TableDatasetMeasure) => {
    let name = measure.name;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${measure.name}_${suffix}`;
    taken.add(name);
    measures.push({ ...measure, name, label: wordsFor(name) });
  };
  for (const field of fields) {
    if (field.role !== 'attribute') continue;
    const rate = RATE.test(field.name);
    add({
      name: field.name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      label: field.label,
      aggregation: 'sum',
      from: field.name,
      format: MONEY.test(field.name) ? 'currency' : 'number',
      ...(MONEY.test(field.name) ? { currency: 'USD' } : {}),
      // A rate summed across rows is meaningless; it is proposed off.
      include: !rate,
      reason: rate ? `${field.label} looks like a rate; adding it up across rows would be wrong, so it starts off.` : `Adds up ${field.label.toLowerCase()} across rows.`,
    });
  }
  for (const name of keyCandidates) {
    const other = name.replace(/_(id|key|code|uuid|number|no)$/i, '');
    if (other.toLowerCase() === 'id' || other.toLowerCase() === tableStem) continue;
    add({
      name: `${other.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_count`,
      label: `${wordsFor(other)} count`,
      aggregation: 'count_distinct',
      from: name,
      format: 'number',
      include: true,
      reason: `Counts different ${wordsFor(other).toLowerCase()} values; it does not add up across groups.`,
    });
  }
  return {
    name: wordsFor(input.table),
    relation: input.relation,
    fields,
    measures,
    keyCandidates,
    ...(skipped.length ? { skipped } : {}),
  };
}

/**
 * Settle the row identity from a profile: the first candidate with a value on
 * every row and no repeats. The row count becomes a measure when one is found.
 */
export function applyTableProfile(proposal: TableDatasetProposal, profile: TableProfile, table: string): TableDatasetProposal {
  const key = proposal.keyCandidates.find((column) => {
    const stats = profile.columns[column];
    return stats && profile.rows > 0 && stats.distinct === profile.rows && stats.nonNull === profile.rows;
  });
  if (!key) {
    const { key: _key, ...rest } = proposal;
    return rest;
  }
  const entity = singular(table);
  const fields = proposal.fields.map((field) => (field.name === key ? { ...field, role: 'key' as const } : field));
  const withoutKeyCount = proposal.measures.filter((measure) => measure.from !== key);
  const rowCount: TableDatasetMeasure = {
    name: `${entity.replace(/[^a-z0-9]+/g, '_')}_count`.replace(/^_+/, '') || 'row_count',
    label: `${wordsFor(entity)} count`,
    aggregation: 'count_distinct',
    from: key,
    format: 'number',
    include: true,
    reason: `Counts ${entity} rows by ${key}, which is different on every row.`,
  };
  return { ...proposal, fields, measures: [rowCount, ...withoutKeyCount], key: { column: key, entity: entity.replace(/\s+/g, '_') } };
}

/** The table's profile query parts: which columns to count distinct values of. */
export function tableProfileColumns(proposal: TableDatasetProposal): string[] {
  return proposal.keyCandidates.slice(0, 8);
}

/**
 * A checked proposal as Dataset declarations (grain, fields, measures), the
 * same ones `renderTableDatasetBlock` writes. "Add fields" writes these onto
 * an existing saved query block instead of a new file.
 */
export function tableDatasetDeclaration(proposal: TableDatasetProposal, blockName: string): {
  grain: { entities: string[]; keys: string[]; keyEvidence: string };
  fields: Array<{ name: string; role: TableDatasetField['role']; type: TableColumnKind; grains?: string[]; primary?: boolean }>;
  measures: Array<{ name: string; aggregation: TableDatasetMeasure['aggregation']; from: string; additive: 'additive' | 'non_additive'; allowedAggs: Array<TableDatasetMeasure['aggregation']>; format: TableDatasetMeasure['format']; currency?: string }>;
} {
  if (!proposal.key) throw new Error('TABLE_DATASET_KEY_REQUIRED: no column is different on every row, so rows cannot be counted safely.');
  const included = proposal.measures.filter((measure) => measure.include);
  if (!included.length) throw new Error('TABLE_DATASET_MEASURE_REQUIRED: keep at least one number to count or add up.');
  const slug = blockName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table';
  return {
    grain: { entities: [proposal.key.entity], keys: [proposal.key.column], keyEvidence: `proof.${slug}` },
    fields: proposal.fields.map((field) => ({
      name: field.name,
      role: field.role,
      type: field.type,
      ...(field.grains?.length ? { grains: [...field.grains] } : {}),
      ...(field.primary ? { primary: true } : {}),
    })),
    measures: included.map((measure) => ({
      name: measure.name,
      aggregation: measure.aggregation,
      from: measure.from,
      additive: measure.aggregation === 'sum' ? 'additive' as const : 'non_additive' as const,
      allowedAggs: [measure.aggregation],
      format: measure.format,
      ...(measure.format === 'currency' && measure.currency ? { currency: measure.currency } : {}),
    })),
  };
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The Dataset block for a checked proposal. Only included measures are
 * written; the row identity names a stable proof id the runtime checks
 * against the complete table on every run.
 */
export function renderTableDatasetBlock(input: {
  proposal: TableDatasetProposal;
  blockName: string;
  domain: string;
  owner: string;
  description?: string;
  /** The SQL spelling of each column (quoted where the dialect needs it). */
  columnSql: (name: string) => string;
}): string {
  const { proposal } = input;
  if (!proposal.key) throw new Error('TABLE_DATASET_KEY_REQUIRED: no column is different on every row, so rows cannot be counted safely.');
  const included = proposal.measures.filter((measure) => measure.include);
  if (!included.length) throw new Error('TABLE_DATASET_MEASURE_REQUIRED: keep at least one number to count or add up.');
  const slug = input.blockName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table';
  const fieldLines = proposal.fields.map((field) => {
    const properties = [
      `role = ${quote(field.role)}`,
      `type = ${quote(field.type === 'boolean' ? 'boolean' : field.type)}`,
      ...(field.grains?.length ? [`grains = [${field.grains.map(quote).join(', ')}]`] : []),
      ...(field.primary ? ['primary = true'] : []),
    ];
    return `    ${field.name} { ${properties.join(', ')} }`;
  });
  const measureLines = included.map((measure) => {
    const properties = [
      `agg = ${quote(measure.aggregation)}`,
      `from = ${quote(measure.from)}`,
      `additive = ${quote(measure.aggregation === 'sum' ? 'additive' : 'non_additive')}`,
      `allowedAggs = [${quote(measure.aggregation)}]`,
      `format = ${quote(measure.format)}`,
      ...(measure.format === 'currency' && measure.currency ? [`currency = ${quote(measure.currency)}`] : []),
    ];
    return `    ${measure.name} { ${properties.join(', ')} }`;
  });
  return [
    `block ${quote(input.blockName)} {`,
    `  domain = ${quote(input.domain)}`,
    '  type = "custom"',
    '  status = "draft"',
    `  owner = ${quote(input.owner)}`,
    `  description = ${quote(input.description ?? `${proposal.name} from ${proposal.relation}, one row per ${proposal.key.entity.replace(/_/g, ' ')}.`)}`,
    '  tags = ["app-datasets", "from-table"]',
    '',
    '  grain = {',
    `    entities = [${quote(proposal.key.entity)}]`,
    `    keys = [${quote(proposal.key.column)}]`,
    `    keyEvidence = ${quote(`proof.${slug}`)}`,
    '  }',
    '',
    '  fields {',
    ...fieldLines,
    '  }',
    '',
    '  measures {',
    ...measureLines,
    '  }',
    '',
    '  query = """',
    `SELECT ${proposal.fields.map((field) => input.columnSql(field.name)).join(', ')}`,
    `FROM ${proposal.relation}`,
    '"""',
    '}',
    '',
  ].join('\n');
}
