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
  /** How a stored unit is shown, in words: "Shown in dollars (stored as cents)". */
  unitNote?: string;
  /**
   * Stored in hundredths (cents, pennies) and not converted by the Dataset:
   * shown as a plain number, because Money would read 100 times too large.
   */
  minorUnits?: 'cents' | 'pennies';
}

export interface TableDatasetField {
  name: string;
  label: string;
  role: 'key' | 'dimension' | 'time' | 'attribute';
  type: TableColumnKind;
  grains?: string[];
  primary?: boolean;
  /** The column the field reads when it differs from the field's name (a cents column read as dollars). */
  column?: string;
  /** The column is stored in hundredths: the Dataset reads it divided by 100. */
  divideBy?: 100;
}

export interface TableDatasetProposal {
  /** The block's name: "Order lines". */
  name: string;
  /** The relation as the warehouse spells it. */
  relation: string;
  fields: TableDatasetField[];
  measures: TableDatasetMeasure[];
  /**
   * The column to check as one row each, and what one row is. A date or
   * period column ("month") that is the row key makes a summary: one row per
   * `timeGrain`, rolled up to longer periods only.
   */
  key?: { column: string; entity: string; timeGrain?: string };
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

/**
 * The period one value of a date column stands for, when that is plain:
 * a column named for a period ("month", "order_week", "fiscal_quarter"), or
 * any DATE column (a day). A timestamp named otherwise ("ordered_at") is an
 * instant, not a period, so it never becomes a summary's row key.
 */
export function nativeTimeGrain(field: Pick<TableDatasetField, 'name' | 'type' | 'role'>): string | undefined {
  if (field.role !== 'time' && field.type !== 'date' && field.type !== 'timestamp') return undefined;
  const words = wordsFor(field.name).toLowerCase().split(/\s+/);
  for (const grain of ['month', 'week', 'quarter', 'year']) {
    if (words.includes(grain)) return grain;
  }
  return field.type === 'date' ? 'day' : undefined;
}
const ID_NAME = /(^id$|_id$|_key$|_code$|_uuid$|^uuid$|_number$|_no$|^sku$)/i;
const NOT_A_MEASURE = /(^id$|_id$|_key$|_code$|year|month|day|week|quarter|zip|postal|phone|lat|lon|lng|latitude|longitude|_no$|_number$|rank|version|age$)/i;
const MONEY = /(amount|revenue|sales|price|cost|spend|fee|total|value|income|profit|margin|budget|premium|payment|paid|balance|salary|charge)/i;
const RATE = /(rate|ratio|pct|percent|share)$/i;

/**
 * A money column stored in hundredths: `subtotal_cents`, `order_total_cents`,
 * `cents`, `price_pennies`, `amountInCents`. Whole words only, so `percent`
 * or `centsus` never match.
 */
export function minorUnitOf(name: string): 'cents' | 'pennies' | undefined {
  const words = wordsFor(name).toLowerCase().split(/\s+/);
  if (words.includes('cents')) return 'cents';
  if (words.includes('pennies')) return 'pennies';
  return undefined;
}

const MINOR_UNIT_MONEY = {
  cents: { currency: 'USD', major: 'dollars' },
  pennies: { currency: 'GBP', major: 'pounds' },
} as const;

/** "subtotal_cents" reads as "subtotal"; a bare "cents" column as "amount". */
function majorUnitName(name: string): string {
  const stripped = name
    .replace(/(^|_)(in_)?(cents|pennies)(?=_|$)/gi, '$1')
    .replace(/(In)?(Cents|Pennies)(?=[A-Z_]|$)/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return stripped || 'amount';
}

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
export function proposeTableDataset(input: {
  table: string;
  relation: string;
  columns: TableColumnInput[];
  primaryKey?: string[];
  /**
   * The Dataset's own SQL is written from this proposal (Start from a table),
   * so a cents column can be read divided by 100 and shown as Money. When
   * false (Add fields on a saved query, whose SQL is the author's), a cents
   * column stays a plain number.
   */
  convertMinorUnits?: boolean;
}): TableDatasetProposal {
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
    // A period column (a month, a day) that is different on every row is a summary's row key.
    ...columns.filter((column) => (column.kind === 'date' || column.kind === 'timestamp') && nativeTimeGrain({ name: column.name, type: column.kind, role: 'time' })).map((column) => column.name),
  ].filter((name, index, all) => all.indexOf(name) === index).slice(0, 8);
  let firstTime = true;
  const takenNames = new Set(columns.map((column) => column.name.toLowerCase()));
  const fields: TableDatasetField[] = columns.map((column) => {
    if (column.kind === 'date' || column.kind === 'timestamp') {
      const field: TableDatasetField = { name: column.name, label: wordsFor(column.name), role: 'time', type: column.kind, grains: TIME_GRAINS, ...(firstTime ? { primary: true } : {}) };
      firstTime = false;
      return field;
    }
    const minor = column.kind === 'number' ? minorUnitOf(column.name) : undefined;
    if (minor && input.convertMinorUnits) {
      // Read as dollars: the field gets the dollars name, the SQL divides by 100.
      let name = majorUnitName(column.name);
      if (takenNames.has(name.toLowerCase())) name = `${name}_${MINOR_UNIT_MONEY[minor].major}`;
      for (let suffix = 2; takenNames.has(name.toLowerCase()); suffix += 1) name = `${majorUnitName(column.name)}_${MINOR_UNIT_MONEY[minor].major}_${suffix}`;
      takenNames.add(name.toLowerCase());
      return { name, label: wordsFor(name), role: 'attribute', type: 'number', column: column.name, divideBy: 100 };
    }
    if (column.kind === 'number' && (minor || !NOT_A_MEASURE.test(column.name))) {
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
    const minor = minorUnitOf(field.column ?? field.name);
    if (minor) {
      const money = MINOR_UNIT_MONEY[minor];
      const converted = field.divideBy === 100;
      add({
        name: field.name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        label: field.label,
        aggregation: 'sum',
        from: field.name,
        format: converted ? 'currency' : 'number',
        ...(converted ? { currency: money.currency } : { minorUnits: minor }),
        include: true,
        reason: `Adds up ${field.label.toLowerCase()} across rows.`,
        unitNote: converted
          ? `Shown in ${money.major} (stored as ${minor})`
          : `Stored as ${minor}, so it is shown as a plain number: as Money it would read 100 times too large`,
      });
      continue;
    }
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
  const keyField = proposal.fields.find((field) => field.name === key);
  const timeGrain = keyField?.role === 'time' ? nativeTimeGrain(keyField) : undefined;
  if (keyField && timeGrain) {
    // One row per period (a monthly summary): the period stays a time field,
    // offered at its own grain and longer ones, and is the summary's key.
    const grains = TIME_GRAINS.slice(TIME_GRAINS.indexOf(timeGrain));
    const fields = proposal.fields.map((field) => (field.name === key
      ? { ...field, grains, primary: true }
      : field.role === 'time' ? (({ primary: _primary, ...rest }) => rest)(field) : field));
    return {
      ...proposal,
      fields,
      // Counting periods is not a business number; the summary's own numbers are.
      measures: proposal.measures.filter((measure) => measure.from !== key),
      key: { column: key, entity: entity.replace(/\s+/g, '_'), timeGrain },
    };
  }
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
  grain: { entities: string[]; keys: string[]; keyEvidence: string; aggregate?: boolean; timeGrain?: string; timeBucketBy?: string };
  fields: Array<{ name: string; role: TableDatasetField['role']; type: TableColumnKind; grains?: string[]; primary?: boolean; status: 'approved' }>;
  measures: Array<{ name: string; aggregation: TableDatasetMeasure['aggregation']; from: string; additive: 'additive' | 'non_additive'; allowedAggs: Array<TableDatasetMeasure['aggregation']>; format: TableDatasetMeasure['format']; currency?: string; status: 'approved' }>;
} {
  if (!proposal.key) throw new Error('TABLE_DATASET_KEY_REQUIRED: no column is different on every row, so rows cannot be counted safely.');
  // Declarations name existing output columns; they cannot divide one by 100.
  if (proposal.fields.some((field) => field.column || field.divideBy)) throw new Error('TABLE_DATASET_CONVERSION_UNSUPPORTED: fields read from another column can only be written as a new Dataset from a table.');
  const included = proposal.measures.filter((measure) => measure.include);
  if (!included.length) throw new Error('TABLE_DATASET_MEASURE_REQUIRED: keep at least one number to count or add up.');
  const slug = blockName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table';
  return {
    grain: {
      entities: [proposal.key.entity],
      keys: [proposal.key.column],
      keyEvidence: `proof.${slug}`,
      ...(proposal.key.timeGrain ? { aggregate: true, timeGrain: proposal.key.timeGrain, timeBucketBy: proposal.key.column } : {}),
    },
    fields: proposal.fields.map((field) => ({
      name: field.name,
      role: field.role,
      type: field.type,
      ...(field.grains?.length ? { grains: [...field.grains] } : {}),
      ...(field.primary ? { primary: true } : {}),
      // Every field the check confirmed is approved for tiles and the App planner.
      status: 'approved' as const,
    })),
    measures: included.map((measure) => ({
      name: measure.name,
      aggregation: measure.aggregation,
      from: measure.from,
      additive: measure.aggregation === 'sum' ? 'additive' as const : 'non_additive' as const,
      allowedAggs: [measure.aggregation],
      format: measure.format,
      ...(measure.format === 'currency' && measure.currency ? { currency: measure.currency } : {}),
      status: 'approved' as const,
    })),
  };
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** " Subtotal cents is stored as cents and read in dollars." for the block's description. */
function convertedNote(proposal: TableDatasetProposal): string {
  const parts = (['cents', 'pennies'] as const).flatMap((minor) => {
    const columns = proposal.fields
      .filter((field) => field.divideBy && field.column && minorUnitOf(field.column) === minor)
      .map((field) => field.column!);
    return columns.length ? [`${columns.join(', ')} ${columns.length === 1 ? 'is' : 'are'} stored as ${minor} and read in ${MINOR_UNIT_MONEY[minor].major}`] : [];
  });
  return parts.length ? ` ${parts.join('; ')}.` : '';
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
      // Every field the check confirmed is approved for tiles and the App planner.
      'status = "approved"',
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
      'status = "approved"',
    ];
    return `    ${measure.name} { ${properties.join(', ')} }`;
  });
  return [
    `block ${quote(input.blockName)} {`,
    `  domain = ${quote(input.domain)}`,
    '  type = "custom"',
    '  status = "draft"',
    `  owner = ${quote(input.owner)}`,
    `  description = ${quote(input.description ?? `${proposal.name} from ${proposal.relation}, one row per ${proposal.key.entity.replace(/_/g, ' ')}.${convertedNote(proposal)}`)}`,
    '  tags = ["app-datasets", "from-table"]',
    '',
    '  grain = {',
    `    entities = [${quote(proposal.key.entity)}]`,
    `    keys = [${quote(proposal.key.column)}]`,
    `    keyEvidence = ${quote(`proof.${slug}`)}`,
    ...(proposal.key.timeGrain ? [`    timeGrain = ${quote(proposal.key.timeGrain)}`, `    timeBucketBy = ${quote(proposal.key.column)}`, '    aggregate = true'] : []),
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
    // A cents column is read in dollars here, so every tile, KPI, table,
    // filter and export of this Dataset shows the same dollars.
    `SELECT ${proposal.fields.map((field) => (field.divideBy
      ? `${input.columnSql(field.column ?? field.name)} / ${field.divideBy}.0 AS ${input.columnSql(field.name)}`
      : field.column
        ? `${input.columnSql(field.column)} AS ${input.columnSql(field.name)}`
        : input.columnSql(field.name))).join(', ')}`,
    `FROM ${proposal.relation}`,
    '"""',
    '}',
    '',
  ].join('\n');
}
