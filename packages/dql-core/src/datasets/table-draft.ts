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
  key?: {
    column: string;
    entity: string;
    timeGrain?: string;
    /**
     * Several columns that are one row's identity together (GAME_ID and
     * TEAM_ID): the row key Modeling saved, checked on the rows. `column` is
     * the first of them. Absent for a one-column key.
     */
    columns?: string[];
  };
  /** Columns worth profiling as the row identity, most likely first. */
  keyCandidates: string[];
  /** Columns left out because their names are not plain identifiers. */
  skipped?: string[];
  /**
   * Two columns that hold the same number in different units (`order_total`
   * and `order_total_cents`). The check asks one question per pair and keeps
   * one column ({@link applyTableDuplicateChoices}); until it is answered both
   * are proposed.
   */
  duplicates?: TableDatasetDuplicate[];
  /** Columns the author's duplicate answers left out, and why (recorded with the Dataset). */
  hiddenColumns?: TableDatasetHiddenColumn[];
}

/** One "same number, two units" pair the check asks about. */
export interface TableDatasetDuplicate {
  /** The field the kept column becomes: "order_total". */
  name: string;
  /** "Order total". */
  label: string;
  /** The column without a unit in its name: `order_total`. */
  plainColumn: string;
  /** The column stored in hundredths: `order_total_cents`. */
  minorColumn: string;
  minorUnits: 'cents' | 'pennies';
  /** The unit the hundredths column is read in: "dollars". */
  major: 'dollars' | 'pounds';
  /** The field the proposal reads the hundredths column as before the answer ("order_total_dollars"). */
  convertedField: string;
  /** "Order total is stored twice: Order total (dollars) and Order total cents. Use Order total in dollars?" */
  question: string;
  /**
   * What the data shows about the two columns (checked on the table):
   * `hundredths`, the hundredths column is the plain one × 100 (19.00 and
   * 1900, the same amount in two units); `same`, they hold the same number
   * (both in cents). Absent when it could not be checked.
   */
  relation?: DuplicateUnitRelation;
}

/** How two columns of one amount relate on the data: ×100 (two units) or the same number (both in hundredths). */
export type DuplicateUnitRelation = 'hundredths' | 'same';

/**
 * An answer: use the hundredths column read in dollars (`minor`), the plain
 * column as it is (`plain`), or keep both columns (`both`: the plain one as
 * it is, the hundredths one as a plain number in cents).
 */
export interface TableDuplicateChoice { name: string; use: 'minor' | 'plain' | 'both' }

/**
 * What "OK" means for one pair (new-user round 3, problem 8): when the data
 * shows the plain column is the same amount in dollars, the dollar column is
 * used as it is; otherwise (both in cents, or not checked) the cents column
 * is read in dollars. Either way the copy is hidden.
 */
export function defaultDuplicateUse(pair: Pick<TableDatasetDuplicate, 'relation'>): 'minor' | 'plain' {
  return pair.relation === 'hundredths' ? 'plain' : 'minor';
}

/** The one question a table's duplicate columns get, and what each answer does. */
export interface DuplicateColumnsQuestion {
  question: string;
  /** What OK does. */
  ok: string;
  /** What Show both does. */
  both: string;
  okChoices: TableDuplicateChoice[];
  bothChoices: TableDuplicateChoice[];
}

/**
 * One question per table for every column stored twice (new-user round 3,
 * problem 8), instead of a Yes/No per column whose two answers both gave
 * dollars: "These columns are stored twice, in dollars and in cents:
 * Subtotal, Tax paid, Order total. ZLens will use the dollar columns and hide
 * the cents copies." [OK] [Show both].
 */
export function duplicateColumnsQuestion(pairs: ReadonlyArray<TableDatasetDuplicate>): DuplicateColumnsQuestion | undefined {
  if (!pairs.length) return undefined;
  const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
  const labels = list(pairs.map((pair) => pair.label));
  const minor = pairs[0]!.minorUnits;
  const major = pairs[0]!.major;
  const sameUnits = pairs.every((pair) => pair.minorUnits === minor);
  const units = sameUnits ? minor : 'cents or pennies';
  const majorWord = sameUnits ? major : 'dollars or pounds';
  const twoUnits = pairs.every((pair) => pair.relation === 'hundredths');
  const bothInCents = pairs.every((pair) => pair.relation === 'same');
  const question = twoUnits
    ? `These columns are stored twice, in ${majorWord} and in ${units}: ${labels}.`
    : bothInCents
      ? `These columns are stored twice, both in ${units}: ${labels}.`
      : `These columns are stored twice: ${labels}, each with a copy in ${units}.`;
  const ok = twoUnits
    ? `ZLens will use the ${majorWord.replace(/s$/, '')} columns and hide the ${units} copies.`
    : `ZLens will read the ${units} columns in ${majorWord} and hide the other copies.`;
  return {
    question,
    ok,
    both: `Both copies stay: the ${units} columns as plain numbers (as Money they would read 100 times too large).`,
    okChoices: pairs.map((pair) => ({ name: pair.name, use: defaultDuplicateUse(pair) })),
    bothChoices: pairs.map((pair) => ({ name: pair.name, use: 'both' as const })),
  };
}

/** A column a duplicate answer left out. */
export interface TableDatasetHiddenColumn { column: string; keptColumn: string; reason: string; relation?: DuplicateUnitRelation }

/** The words of one duplicate-column question, for what the data showed (new-user round 2, problem 7). */
export interface DuplicateColumnWords {
  question: string;
  detail: string;
  recommended: { title: string; detail: string };
  alternative: { title: string; detail: string };
}

/**
 * "Subtotal is stored twice: Subtotal (dollars) and Subtotal cents. Use
 * Subtotal in dollars?" The columns are named as people read them, and the
 * sentence says what the data showed: the same amount in two units (×100),
 * the same number twice (both in cents), or, unchecked, what the names say.
 */
export function duplicateColumnWords(pair: Pick<TableDatasetDuplicate, 'plainColumn' | 'minorColumn' | 'minorUnits' | 'major' | 'relation'>): DuplicateColumnWords {
  const plain = wordsFor(pair.plainColumn);
  const minor = wordsFor(pair.minorColumn);
  const recommended = { title: `Yes, use ${plain} in ${pair.major}`, detail: `Read from ${minor} ÷ 100, shown as Money. The ${plain} column is hidden.` };
  if (pair.relation === 'hundredths') {
    return {
      question: `${plain} is stored twice: ${plain} (${pair.major}) and ${minor}. Use ${plain} in ${pair.major}?`,
      detail: `${minor} is ${plain} × 100: the same amount in ${pair.minorUnits}. ZLens keeps one and hides the other.`,
      recommended,
      alternative: { title: `No, use the ${plain} column as it is`, detail: `It is already in ${pair.major}. ${minor} is hidden.` },
    };
  }
  if (pair.relation === 'same') {
    return {
      question: `${plain} is stored twice, both in ${pair.minorUnits}: ${plain} and ${minor}. Use ${plain} in ${pair.major}?`,
      detail: `${plain} and ${minor} hold the same number, in ${pair.minorUnits}. ZLens keeps one and hides the other.`,
      recommended,
      alternative: { title: `No, use the ${plain} column as it is`, detail: `It stays in ${pair.minorUnits}, shown as a plain number. ${minor} is hidden.` },
    };
  }
  return {
    question: `${plain} is stored twice: ${plain} and ${minor}. Use ${plain} in ${pair.major}?`,
    detail: `${minor} is stored in ${pair.minorUnits}, as its name says. ZLens keeps one and hides the other.`,
    recommended,
    alternative: { title: `No, use the ${plain} column as it is`, detail: `${minor} is hidden.` },
  };
}

/** The proposal with what the data showed about each duplicate pair, and the question worded for it. */
export function withDuplicateUnitRelations(proposal: TableDatasetProposal, relations: Record<string, DuplicateUnitRelation | undefined>): TableDatasetProposal {
  if (!proposal.duplicates?.length) return proposal;
  return {
    ...proposal,
    duplicates: proposal.duplicates.map((pair) => {
      const relation = relations[pair.name];
      const next = relation ? { ...pair, relation } : pair;
      return { ...next, question: duplicateColumnWords(next).question };
    }),
  };
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
/** A column named for a year or season ends in one of these words: `SEASON`, `fiscal_year`, `fy`. */
const YEAR_WORDS = new Set(['season', 'year', 'yr', 'fy']);
/** A column with one of these words is an identifier, however it is spelled: `TEAM_ID_HOME`, `playerId`. */
const ID_WORDS = new Set(['id', 'uuid', 'guid']);
/**
 * True for a number column that is a label, never an amount: a year or a
 * season (`SEASON`, not `SEASON_WINS`), or an id. Adding these up across rows
 * means nothing, so they are offered to group by, never summed.
 */
export function isLabelNumberColumnName(name: string): boolean {
  const words = wordsFor(name).toLowerCase().split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  return (last !== undefined && YEAR_WORDS.has(last)) || words.some((word) => ID_WORDS.has(word));
}
/** A percentage, rate, ratio, share or average: a sum of it across rows is wrong, so none is proposed. */
const NON_SUMMABLE_WORDS = new Set(['pct', 'percent', 'percentage', 'rate', 'ratio', 'share', 'avg', 'average', 'mean', 'median']);
function isNonSummableName(name: string): boolean {
  return wordsFor(name).toLowerCase().split(/\s+/).some((word) => NON_SUMMABLE_WORDS.has(word));
}

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

/** "order_lines" → "order line": a table name as one row of it, in lower-case words. */
export function singularWords(name: string): string {
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
  const tableStem = singularWords(input.table).replace(/\s+/g, '_');
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
  const numberColumns = new Set(columns.filter((column) => column.kind === 'number').map((column) => column.name.toLowerCase()));
  const duplicates: TableDatasetDuplicate[] = [];
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
      const plain = name.toLowerCase();
      const plainColumn = columns.find((other) => other.name.toLowerCase() === plain);
      if (takenNames.has(name.toLowerCase())) name = `${name}_${MINOR_UNIT_MONEY[minor].major}`;
      for (let suffix = 2; takenNames.has(name.toLowerCase()); suffix += 1) name = `${majorUnitName(column.name)}_${MINOR_UNIT_MONEY[minor].major}_${suffix}`;
      takenNames.add(name.toLowerCase());
      // `order_total` beside `order_total_cents`: the same number twice. One question decides which one tiles use.
      if (plainColumn && plainColumn.name !== column.name && numberColumns.has(plainColumn.name.toLowerCase())) {
        duplicates.push({
          name: plainColumn.name,
          label: wordsFor(plainColumn.name),
          plainColumn: plainColumn.name,
          minorColumn: column.name,
          minorUnits: minor,
          major: MINOR_UNIT_MONEY[minor].major,
          convertedField: name,
          question: duplicateColumnWords({ plainColumn: plainColumn.name, minorColumn: column.name, minorUnits: minor, major: MINOR_UNIT_MONEY[minor].major }).question,
        });
      }
      return { name, label: wordsFor(name), role: 'attribute', type: 'number', column: column.name, divideBy: 100 };
    }
    if (column.kind === 'number' && (minor || (!NOT_A_MEASURE.test(column.name) && !isLabelNumberColumnName(column.name)))) {
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
    // A percentage, rate or average summed across rows is wrong: it stays a
    // number on each row (for filters and row detail), never a sum.
    if (isNonSummableName(field.name)) continue;
    add({
      name: field.name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      label: field.label,
      aggregation: 'sum',
      from: field.name,
      format: MONEY.test(field.name) ? 'currency' : 'number',
      ...(MONEY.test(field.name) ? { currency: 'USD' } : {}),
      include: true,
      reason: `Adds up ${field.label.toLowerCase()} across rows.`,
    });
  }
  for (const name of keyCandidates) {
    const other = name.replace(/_(id|key|code|uuid|number|no)$/i, '');
    if (other.toLowerCase() === 'id' || other.toLowerCase() === tableStem) continue;
    // Counting different dates ("Ordered at count") or running numbers
    // ("Customer order count" from customer_order_number) is rarely a
    // business number: offered, never ticked (new-user round 3, problem 8).
    const kind = columns.find((column) => column.name === name)?.kind;
    const dated = kind === 'date' || kind === 'timestamp';
    const ordinal = /_(number|no)$/i.test(name);
    add({
      name: `${other.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_count`,
      label: `${wordsFor(other)} count`,
      aggregation: 'count_distinct',
      from: name,
      format: 'number',
      include: !dated && !ordinal,
      reason: dated
        ? `Counts different ${wordsFor(name).toLowerCase()} dates; that is rarely a number anyone reports, so it starts off.`
        : ordinal
          ? `Counts different ${wordsFor(name).toLowerCase()} values, a running number; that is rarely a number anyone reports, so it starts off.`
          : `Counts different ${wordsFor(other).toLowerCase()} values; it does not add up across groups.`,
    });
  }
  return {
    name: wordsFor(input.table),
    relation: input.relation,
    fields,
    measures,
    keyCandidates,
    ...(skipped.length ? { skipped } : {}),
    ...(duplicates.length ? { duplicates } : {}),
  };
}

/**
 * Apply the answers to the duplicate-column questions (design Q1.4). For each
 * pair the recommended answer, used when none was given, is the hundredths
 * column read in dollars: its name says its unit, the plain column's does
 * not. The other column is hidden from fields and measures, and recorded in
 * `hiddenColumns` so the Dataset says what was left out and why. The kept
 * field takes the plain name ("Order total"), so number choices keyed by it
 * stay the same whichever answer is given. Applying twice changes nothing.
 */
export function applyTableDuplicateChoices(proposal: TableDatasetProposal, raw?: unknown): TableDatasetProposal {
  const pairs = proposal.duplicates ?? [];
  if (!pairs.length) return proposal;
  const answers = new Map<string, TableDuplicateChoice['use']>();
  for (const choice of Array.isArray(raw) ? raw : []) {
    if (choice && typeof choice === 'object' && typeof (choice as { name?: unknown }).name === 'string') {
      const use = (choice as { use?: unknown }).use;
      if (use === 'minor' || use === 'plain' || use === 'both') answers.set((choice as { name: string }).name, use);
    }
  }
  let fields = proposal.fields;
  let measures = proposal.measures;
  const hidden: TableDatasetHiddenColumn[] = [...(proposal.hiddenColumns ?? [])];
  const measureName = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  for (const pair of pairs) {
    const use = answers.get(pair.name) ?? defaultDuplicateUse(pair);
    if (use === 'both') {
      // Both stay: the plain column as it is, the hundredths one under its own name as a plain number.
      const money = MINOR_UNIT_MONEY[pair.minorUnits];
      fields = fields.map((field) => (field.name === pair.convertedField
        ? { name: pair.minorColumn, label: wordsFor(pair.minorColumn), role: 'attribute' as const, type: 'number' as const }
        : field));
      measures = measures.map((measure) => {
        if (measure.from === pair.convertedField) {
          const { currency: _currency, ...rest } = measure;
          return { ...rest, name: measureName(pair.minorColumn), label: wordsFor(pair.minorColumn), from: pair.minorColumn, format: 'number' as const, minorUnits: pair.minorUnits, reason: `Adds up ${wordsFor(pair.minorColumn).toLowerCase()} across rows.`, unitNote: `Stored as ${pair.minorUnits}, so it is shown as a plain number: as Money it would read 100 times too large` };
        }
        if (measure.from === pair.plainColumn && pair.relation === 'same' && measure.format === 'currency') {
          return { ...measure, format: 'number' as const, currency: undefined, minorUnits: pair.minorUnits, unitNote: `Stored as ${pair.minorUnits}, so it is shown as a plain number: as Money it would read 100 times too large` };
        }
        if (measure.from === pair.plainColumn && pair.relation === 'hundredths' && measure.format !== 'currency') {
          return { ...measure, format: 'currency' as const, currency: money.currency };
        }
        return measure;
      });
      continue;
    }
    if (use === 'minor') {
      const plainMeasure = measures.find((measure) => measure.from === pair.plainColumn && measure.aggregation === 'sum');
      fields = fields
        .filter((field) => !(field.name === pair.plainColumn && !field.column))
        .map((field) => (field.name === pair.convertedField ? { ...field, name: pair.name, label: pair.label } : field));
      measures = measures
        .filter((measure) => measure !== plainMeasure)
        .map((measure) => (measure.from === pair.convertedField
          ? { ...measure, name: plainMeasure?.name ?? measureName(pair.name), label: pair.label, from: pair.name, reason: `Adds up ${pair.label.toLowerCase()} across rows.` }
          : measure));
      const why = pair.relation === 'hundredths'
        ? `is the same amount in ${pair.major}`
        : pair.relation === 'same' ? `holds the same number, in ${pair.minorUnits}` : 'holds the same amount';
      hidden.push({ column: pair.plainColumn, keptColumn: pair.minorColumn, reason: `${pair.label} uses ${pair.minorColumn}, shown in ${pair.major}; ${pair.plainColumn} ${why}, so it is hidden.`, ...(pair.relation ? { relation: pair.relation } : {}) });
    } else {
      fields = fields.filter((field) => field.name !== pair.convertedField);
      measures = measures.filter((measure) => measure.from !== pair.convertedField);
      // The data showed the plain column is the amount in dollars: it is Money, whatever its name says.
      if (pair.relation === 'hundredths') {
        const money = MINOR_UNIT_MONEY[pair.minorUnits];
        measures = measures.map((measure) => (measure.from === pair.plainColumn && measure.format !== 'currency'
          ? { ...measure, format: 'currency' as const, currency: money.currency }
          : measure));
      }
      // Both columns in cents: the plain one is a number, never Money (it would read 100 times too large).
      if (pair.relation === 'same') {
        measures = measures.map((measure) => (measure.from === pair.plainColumn && measure.format === 'currency'
          ? { ...measure, format: 'number' as const, currency: undefined, minorUnits: pair.minorUnits, unitNote: `Stored as ${pair.minorUnits}, so it is shown as a plain number: as Money it would read 100 times too large` }
          : measure));
      }
      const why = pair.relation === 'same' ? 'holds the same number' : `is the same amount in ${pair.minorUnits}`;
      hidden.push({ column: pair.minorColumn, keptColumn: pair.plainColumn, reason: `${pair.label} uses ${pair.plainColumn} as it is; ${pair.minorColumn} ${why}, so it is hidden.`, ...(pair.relation ? { relation: pair.relation } : {}) });
    }
  }
  const { duplicates: _answered, ...rest } = proposal;
  return { ...rest, fields, measures, hiddenColumns: hidden };
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
  const entity = singularWords(table);
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

/** A check of several columns as one row key: rows, distinct combinations, rows with every column filled. */
export interface TableCompositeKeyProfile {
  rows: number;
  distinct: number;
  filled: number;
}

/** "GAME_ID and TEAM_ID", "A, B and C". */
export function tableKeyColumnsWords(columns: readonly string[]): string {
  return columns.length <= 1 ? columns.join('') : `${columns.slice(0, -1).join(', ')} and ${columns[columns.length - 1]}`;
}

/**
 * Settle a row key of several columns together (the row key Modeling saved,
 * such as GAME_ID and TEAM_ID for one team in one game), when the check shows
 * every combination is filled and different on every row. The columns become
 * key fields (still offered to group by) and a row count is added. Returns
 * the proposal without a key when the check does not hold or a column is not
 * a plain field of the table. `entity` names one row ("team game"), else the
 * table's name does.
 */
export function applyCompositeTableKey(
  proposal: TableDatasetProposal,
  columns: readonly string[],
  check: TableCompositeKeyProfile,
  table: string,
  entity?: string,
): TableDatasetProposal {
  const byName = new Map(proposal.fields.map((field) => [field.name.toLowerCase(), field]));
  const keyFields = columns.map((column) => byName.get(column.toLowerCase()));
  const holds = columns.length > 1
    && keyFields.every((field) => field && !field.column && !field.divideBy && field.role !== 'time')
    && check.rows > 0 && check.distinct === check.rows && check.filled === check.rows;
  if (!holds) {
    const { key: _key, ...rest } = proposal;
    return rest;
  }
  const names = keyFields.map((field) => field!.name);
  const keySet = new Set(names);
  const rowName = singularWords(entity?.trim() || table);
  const entityId = rowName.replace(/\s+/g, '_');
  const fields = proposal.fields.map((field) => (keySet.has(field.name) ? { ...field, role: 'key' as const } : field));
  // The parts of the key are labels: never summed. Their distinct counts stay.
  const measures = proposal.measures.filter((measure) => !(measure.aggregation === 'sum' && keySet.has(measure.from)));
  const rowCount: TableDatasetMeasure = {
    name: `${entityId.replace(/[^a-z0-9]+/g, '_')}_count`.replace(/^_+/, '') || 'row_count',
    label: `${wordsFor(rowName)} count`,
    aggregation: 'count',
    from: names[0]!,
    format: 'number',
    include: true,
    reason: `Counts ${rowName} rows: ${tableKeyColumnsWords(names)} together are different on every row.`,
  };
  const taken = new Set(measures.map((measure) => measure.name));
  return {
    ...proposal,
    fields,
    measures: [...(taken.has(rowCount.name) ? [] : [rowCount]), ...measures],
    key: { column: names[0]!, columns: names, entity: entityId },
  };
}

/** The columns of a proposal's row key: one, or several together. */
export function tableKeyColumns(key: NonNullable<TableDatasetProposal['key']>): string[] {
  return key.columns?.length ? [...key.columns] : [key.column];
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
      keys: tableKeyColumns(proposal.key),
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
      // A sum or a row count adds up across groups; a distinct count does not.
      additive: measure.aggregation === 'sum' || measure.aggregation === 'count' ? 'additive' as const : 'non_additive' as const,
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

/** " order_total is hidden (order_total_cents holds the same amount)." for the block's description. */
function hiddenNote(proposal: TableDatasetProposal): string {
  const hidden = proposal.hiddenColumns ?? [];
  if (!hidden.length) return '';
  return ` ${hidden.map((entry) => `${entry.column} is hidden (${entry.keptColumn} holds the same ${entry.relation === 'same' ? 'number' : 'amount'})`).join('; ')}.`;
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
      `additive = ${quote(measure.aggregation === 'sum' || measure.aggregation === 'count' ? 'additive' : 'non_additive')}`,
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
    `  description = ${quote(input.description ?? `${proposal.name} from ${proposal.relation}, one row per ${proposal.key.entity.replace(/_/g, ' ')}.${convertedNote(proposal)}${hiddenNote(proposal)}`)}`,
    '  tags = ["app-datasets", "from-table"]',
    '',
    '  grain = {',
    `    entities = [${quote(proposal.key.entity)}]`,
    `    keys = [${tableKeyColumns(proposal.key).map(quote).join(', ')}]`,
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
    // The duplicate-column answer stays with the Dataset's own SQL, so a later
    // check (or a person reading the file) sees what was left out and why.
    ...((proposal.hiddenColumns ?? []).length
      ? [`/* Hidden duplicate columns: ${(proposal.hiddenColumns ?? []).map((entry) => `${entry.column} (${entry.keptColumn} is used)`).join(', ').replace(/\*\//g, '')} */`]
      : []),
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

/**
 * The checks a table (or a saved query made row-level) passed before it was
 * certified, in plain words, for its certification receipt (D5): what one
 * row is and how it was checked, and how each kept number is shown,
 * including money stored in cents.
 */
export function tableDatasetCheckSentences(proposal: TableDatasetProposal, rows: number): string[] {
  const out: string[] = [];
  if (proposal.key) {
    const entity = proposal.key.timeGrain ?? proposal.key.entity.replace(/_/g, ' ');
    const columns = tableKeyColumns(proposal.key);
    out.push(columns.length > 1
      ? `Row key: each row is one ${entity} (${tableKeyColumnsWords(columns)} together are filled and different on all ${rows.toLocaleString('en-US')} rows)`
      : `Row key: each row is one ${entity} (${proposal.key.column} is filled and different on all ${rows.toLocaleString('en-US')} rows)`);
  }
  const formats = proposal.measures
    .filter((measure) => measure.include && measure.aggregation === 'sum')
    .map((measure) => {
      if (measure.minorUnits) return `${measure.label}: a plain number (stored as ${measure.minorUnits})`;
      if (measure.unitNote) return `${measure.label}: ${measure.unitNote.charAt(0).toLowerCase()}${measure.unitNote.slice(1)}`;
      return `${measure.label}: ${measure.format === 'currency' ? 'money' : measure.format === 'percent' ? 'a percent' : 'a number'}`;
    });
  if (formats.length) out.push(`Number formats: ${formats.join('; ')}`);
  for (const entry of proposal.hiddenColumns ?? []) out.push(`Duplicate column: ${entry.reason}`);
  return out;
}
