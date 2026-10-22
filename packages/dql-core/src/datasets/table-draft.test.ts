import { describe, expect, it } from 'vitest';
import { Parser } from '../parser/parser.js';
import { applyTableDuplicateChoices, applyTableProfile, minorUnitOf, nativeTimeGrain, proposeTableDataset, renderTableDatasetBlock, tableColumnKind, tableDatasetCheckSentences, tableDatasetDeclaration } from './table-draft.js';

const columns = [
  { name: 'order_line_id', type: 'VARCHAR' },
  { name: 'customer_id', type: 'VARCHAR' },
  { name: 'region', type: 'VARCHAR' },
  { name: 'order_date', type: 'TIMESTAMP' },
  { name: 'net_amount', type: 'DECIMAL(12,2)' },
  { name: 'discount_rate', type: 'DOUBLE' },
  { name: 'quantity', type: 'INTEGER' },
  { name: 'fiscal_year', type: 'INTEGER' },
  { name: 'Weird Name', type: 'VARCHAR' },
];

describe('start from a table', () => {
  it('reads types into kinds', () => {
    expect(['BIGINT', 'DECIMAL(10,2)', 'TIMESTAMP WITH TIME ZONE', 'DATE', 'BOOLEAN', 'VARCHAR'].map(tableColumnKind)).toEqual(['number', 'number', 'timestamp', 'date', 'boolean', 'string']);
  });

  it('proposes dates as time, text and ids as categories, numbers as totals, ids as distinct counts', () => {
    const proposal = proposeTableDataset({ table: 'order_lines', relation: 'main.order_lines', columns });
    expect(proposal.fields.map((field) => `${field.name}:${field.role}`)).toEqual([
      'order_line_id:dimension', 'customer_id:dimension', 'region:dimension', 'order_date:time', 'net_amount:attribute', 'discount_rate:attribute', 'quantity:attribute', 'fiscal_year:dimension',
    ]);
    expect(proposal.skipped).toEqual(['Weird Name']);
    expect(proposal.keyCandidates).toEqual(['order_line_id', 'customer_id']);
    expect(proposal.measures.map((measure) => [measure.name, measure.aggregation, measure.format, measure.include])).toEqual([
      ['net_amount', 'sum', 'currency', true],
      ['discount_rate', 'sum', 'number', false],
      ['quantity', 'sum', 'number', true],
      // The table's own id becomes the row count once the profile shows it is unique.
      ['customer_count', 'count_distinct', 'number', true],
    ]);
  });

  it('takes the first column with a value on every row and no repeats as the row identity', () => {
    const proposal = proposeTableDataset({ table: 'order_lines', relation: 'main.order_lines', columns });
    const profiled = applyTableProfile(proposal, { rows: 100, columns: { order_line_id: { distinct: 100, nonNull: 100 }, customer_id: { distinct: 12, nonNull: 100 } } }, 'order_lines');
    expect(profiled.key).toEqual({ column: 'order_line_id', entity: 'order_line' });
    expect(profiled.fields.find((field) => field.name === 'order_line_id')?.role).toBe('key');
    expect(profiled.measures[0]).toMatchObject({ name: 'order_line_count', from: 'order_line_id' });
    const noKey = applyTableProfile(proposal, { rows: 100, columns: { order_line_id: { distinct: 99, nonNull: 100 } } }, 'order_lines');
    expect(noKey.key).toBeUndefined();
  });

  it('renders a Dataset block that parses, with only the numbers kept', () => {
    const proposal = applyTableProfile(proposeTableDataset({ table: 'order_lines', relation: 'main.order_lines', columns: columns.slice(0, 8) }), { rows: 5, columns: { order_line_id: { distinct: 5, nonNull: 5 } } }, 'order_lines');
    const source = renderTableDatasetBlock({ proposal, blockName: 'Order lines', domain: 'sales', owner: 'ana@example.com', columnSql: (name) => `"${name}"` });
    const block = new Parser(source, 'order-lines.dql').parse().statements[0] as { datasetGrain?: { keys: string[]; keyEvidence?: string }; datasetMeasures?: Array<{ name: string }>; datasetFields?: Array<{ name: string }> };
    expect(block.datasetGrain).toMatchObject({ keys: ['order_line_id'], keyEvidence: 'proof.order-lines' });
    expect(block.datasetMeasures?.map((measure) => measure.name)).toEqual(['order_line_count', 'net_amount', 'quantity', 'customer_count']);
    expect(block.datasetFields).toHaveLength(8);
    expect(() => renderTableDatasetBlock({ proposal: { ...proposal, key: undefined }, blockName: 'x', domain: 'd', owner: 'o', columnSql: (name) => name })).toThrow('TABLE_DATASET_KEY_REQUIRED');
  });

  it('marks every field and number the check confirmed as approved', () => {
    const proposal = applyTableProfile(proposeTableDataset({ table: 'order_lines', relation: 'main.order_lines', columns: columns.slice(0, 8) }), { rows: 5, columns: { order_line_id: { distinct: 5, nonNull: 5 } } }, 'order_lines');
    const source = renderTableDatasetBlock({ proposal, blockName: 'Order lines', domain: 'sales', owner: 'ana@example.com', columnSql: (name) => `"${name}"` });
    const block = new Parser(source, 'order-lines.dql').parse().statements[0] as { datasetMeasures?: Array<{ status?: string }>; datasetFields?: Array<{ status?: string }> };
    expect(block.datasetFields?.every((field) => field.status === 'approved')).toBe(true);
    expect(block.datasetMeasures?.every((measure) => measure.status === 'approved')).toBe(true);
    const declaration = tableDatasetDeclaration(proposal, 'Order lines');
    expect([...declaration.fields, ...declaration.measures].every((entry) => entry.status === 'approved')).toBe(true);
  });
});

describe('money stored as cents (B11)', () => {
  const orders = [
    { name: 'order_id', type: 'VARCHAR' },
    { name: 'ordered_at', type: 'TIMESTAMP' },
    { name: 'subtotal_cents', type: 'BIGINT' },
    { name: 'tax_paid_cents', type: 'BIGINT' },
    { name: 'order_total_cents', type: 'BIGINT' },
    { name: 'order_total', type: 'DECIMAL(12,2)' },
    { name: 'tip_pennies', type: 'INTEGER' },
    { name: 'discount_percent', type: 'DOUBLE' },
  ];

  it('finds cents and pennies as whole words only', () => {
    expect(['subtotal_cents', 'cents', 'amountInCents', 'price_in_cents', 'tip_pennies', 'percent', 'centsus', 'discount_percent'].map(minorUnitOf))
      .toEqual(['cents', 'cents', 'cents', 'cents', 'pennies', undefined, undefined, undefined]);
  });

  it('reads cents columns in dollars, as Money, and says so', () => {
    const proposal = proposeTableDataset({ table: 'orders', relation: 'main.orders', columns: orders, convertMinorUnits: true });
    const subtotal = proposal.fields.find((field) => field.column === 'subtotal_cents');
    expect(subtotal).toMatchObject({ name: 'subtotal', label: 'Subtotal', role: 'attribute', divideBy: 100 });
    // "order_total" already exists, so the dollars field keeps a distinct name.
    expect(proposal.fields.find((field) => field.column === 'order_total_cents')?.name).toBe('order_total_dollars');
    const measures = Object.fromEntries(proposal.measures.map((measure) => [measure.from, measure]));
    expect(measures.subtotal).toMatchObject({ format: 'currency', currency: 'USD', unitNote: 'Shown in dollars (stored as cents)' });
    expect(measures.tax_paid).toMatchObject({ format: 'currency', unitNote: 'Shown in dollars (stored as cents)' });
    expect(measures.tip).toMatchObject({ format: 'currency', currency: 'GBP', unitNote: 'Shown in pounds (stored as pennies)' });
    expect(measures.subtotal.minorUnits).toBeUndefined();

    const profiled = applyTableProfile(proposal, { rows: 3, columns: { order_id: { distinct: 3, nonNull: 3 } } }, 'orders');
    const source = renderTableDatasetBlock({ proposal: profiled, blockName: 'Orders', domain: 'sales', owner: 'ana@example.com', columnSql: (name) => `"${name}"` });
    // The division is in the Dataset's SQL, so tiles, KPIs, tables, filters and exports all read dollars.
    expect(source).toContain('"subtotal_cents" / 100.0 AS "subtotal"');
    expect(source).toContain('"order_total_cents" / 100.0 AS "order_total_dollars"');
    expect(source).toContain('"order_total", ');
    expect(source).toContain('subtotal_cents, tax_paid_cents, order_total_cents are stored as cents and read in dollars; tip_pennies is stored as pennies and read in pounds.');
    const block = new Parser(source, 'orders.dql').parse().statements[0] as { datasetFields?: Array<{ name: string }>; datasetMeasures?: Array<{ name: string; from?: string; format?: string }> };
    expect(block.datasetFields?.map((field) => field.name)).toContain('subtotal');
    expect(block.datasetMeasures?.find((measure) => measure.name === 'subtotal')).toMatchObject({ from: 'subtotal', format: 'currency' });
    // A declaration on someone else's SQL cannot divide.
    expect(() => tableDatasetDeclaration(profiled, 'Orders')).toThrow('TABLE_DATASET_CONVERSION_UNSUPPORTED');
  });

  it('keeps cents as a plain number where the Dataset cannot convert them', () => {
    const proposal = proposeTableDataset({ table: 'orders', relation: '(SELECT 1) AS q', columns: orders });
    expect(proposal.fields.find((field) => field.name === 'subtotal_cents')).toMatchObject({ role: 'attribute' });
    expect(proposal.fields.some((field) => field.divideBy)).toBe(false);
    const subtotal = proposal.measures.find((measure) => measure.from === 'subtotal_cents')!;
    expect(subtotal).toMatchObject({ format: 'number', minorUnits: 'cents' });
    expect(subtotal.currency).toBeUndefined();
    expect(subtotal.unitNote).toMatch(/^Stored as cents, so it is shown as a plain number/);
  });
});

describe('a period column as the row key (B12)', () => {
  const monthly = [
    { name: 'month', type: 'TIMESTAMP' },
    { name: 'gross_revenue', type: 'DOUBLE' },
    { name: 'order_count', type: 'BIGINT' },
  ];

  it('knows the period a date column stands for, and leaves instants alone', () => {
    expect(nativeTimeGrain({ name: 'month', type: 'timestamp', role: 'time' })).toBe('month');
    expect(nativeTimeGrain({ name: 'order_week', type: 'date', role: 'time' })).toBe('week');
    expect(nativeTimeGrain({ name: 'fiscal_quarter', type: 'timestamp', role: 'time' })).toBe('quarter');
    expect(nativeTimeGrain({ name: 'day', type: 'date', role: 'time' })).toBe('day');
    expect(nativeTimeGrain({ name: 'shipped_on', type: 'date', role: 'time' })).toBe('day');
    expect(nativeTimeGrain({ name: 'ordered_at', type: 'timestamp', role: 'time' })).toBeUndefined();
  });

  it('checks a month that is filled and different on every row as the key, and keeps it a time field', () => {
    const proposal = proposeTableDataset({ table: 'monthly_revenue', relation: '(SELECT 1) AS q', columns: monthly });
    expect(proposal.keyCandidates).toEqual(['month']);
    const profiled = applyTableProfile(proposal, { rows: 12, columns: { month: { distinct: 12, nonNull: 12 } } }, 'monthly_revenue');
    expect(profiled.key).toEqual({ column: 'month', entity: 'monthly_revenue', timeGrain: 'month' });
    expect(profiled.fields.find((field) => field.name === 'month')).toMatchObject({ role: 'time', grains: ['month', 'quarter', 'year'], primary: true });
    // Counting months is not a business number.
    expect(profiled.measures.map((measure) => measure.name)).toEqual(['gross_revenue', 'order_count']);
    const declaration = tableDatasetDeclaration(profiled, 'Monthly revenue');
    expect(declaration.grain).toEqual({ entities: ['monthly_revenue'], keys: ['month'], keyEvidence: 'proof.monthly-revenue', aggregate: true, timeGrain: 'month', timeBucketBy: 'month' });
    const source = renderTableDatasetBlock({ proposal: { ...profiled, relation: 'main.monthly' }, blockName: 'Monthly revenue', domain: 'sales', owner: 'ana@example.com', columnSql: (name) => `"${name}"` });
    const block = new Parser(source, 'monthly.dql').parse().statements[0] as { datasetGrain?: Record<string, unknown> };
    expect(block.datasetGrain).toMatchObject({ keys: ['month'], aggregate: true, timeGrain: 'month', timeBucketBy: 'month' });
  });

  it('does not take a repeated or partly empty month as the key', () => {
    const proposal = proposeTableDataset({ table: 'monthly_revenue', relation: '(SELECT 1) AS q', columns: monthly });
    expect(applyTableProfile(proposal, { rows: 12, columns: { month: { distinct: 11, nonNull: 12 } } }, 'monthly_revenue').key).toBeUndefined();
    expect(applyTableProfile(proposal, { rows: 12, columns: { month: { distinct: 11, nonNull: 11 } } }, 'monthly_revenue').key).toBeUndefined();
  });
});

describe('the checks a certification receipt lists (D5)', () => {
  it('says what one row is and how each kept number is shown, including cents', () => {
    const columns = [
      { name: 'order_id', type: 'VARCHAR' },
      { name: 'subtotal_cents', type: 'BIGINT' },
      { name: 'tip_pennies', type: 'INTEGER' },
      { name: 'order_total', type: 'DECIMAL(12,2)' },
    ];
    const converted = applyTableProfile(proposeTableDataset({ table: 'orders', relation: 'main.orders', columns, convertMinorUnits: true }), { rows: 1250, columns: { order_id: { distinct: 1250, nonNull: 1250 } } }, 'orders');
    const sentences = tableDatasetCheckSentences(converted, 1250);
    expect(sentences[0]).toBe('Row key: each row is one order (order_id is filled and different on all 1,250 rows)');
    expect(sentences[1]).toMatch(/^Number formats: /);
    expect(sentences[1]).toContain('Subtotal: shown in dollars (stored as cents)');
    expect(sentences[1]).toContain('Order total: money');

    const plain = applyTableProfile(proposeTableDataset({ table: 'orders', relation: 'main.orders', columns }), { rows: 3, columns: { order_id: { distinct: 3, nonNull: 3 } } }, 'orders');
    expect(tableDatasetCheckSentences(plain, 3)[1]).toContain('Subtotal cents: a plain number (stored as cents)');
    const withoutKey = { ...plain, key: undefined, measures: plain.measures.map((measure) => ({ ...measure, include: false })) };
    expect(tableDatasetCheckSentences(withoutKey, 3)).toEqual([]);
  });

  it('asks one question when a table has the same number twice, and hides the other column (design Q1.4)', () => {
    const raw = proposeTableDataset({
      table: 'orders',
      relation: '"main"."orders"',
      columns: [{ name: 'order_id', type: 'VARCHAR' }, { name: 'order_total', type: 'DOUBLE' }, { name: 'order_total_cents', type: 'INTEGER' }, { name: 'tax_pennies', type: 'INTEGER' }],
      convertMinorUnits: true,
    });
    expect(raw.duplicates).toEqual([expect.objectContaining({ name: 'order_total', question: 'Use Order total in dollars?', plainColumn: 'order_total', minorColumn: 'order_total_cents', convertedField: 'order_total_dollars' })]);
    // A cents column with no twin is not a question.
    expect(raw.duplicates).toHaveLength(1);
    const profiled = applyTableProfile(raw, { rows: 3, columns: { order_id: { distinct: 3, nonNull: 3 } } }, 'orders');

    // Recommended (no answer given): the cents column, read in dollars, under the plain name.
    const recommended = applyTableDuplicateChoices(profiled);
    expect(recommended.duplicates).toBeUndefined();
    expect(recommended.fields.filter((field) => field.name.startsWith('order_total')).map((field) => [field.name, field.column, field.divideBy])).toEqual([['order_total', 'order_total_cents', 100]]);
    expect(recommended.measures.filter((measure) => measure.from.startsWith('order_total')).map((measure) => [measure.name, measure.label, measure.format])).toEqual([['order_total', 'Order total', 'currency']]);
    expect(recommended.hiddenColumns).toEqual([{ column: 'order_total', keptColumn: 'order_total_cents', reason: 'Order total uses order_total_cents, shown in dollars; order_total holds the same number, so it is hidden.' }]);
    // Applying again changes nothing.
    expect(applyTableDuplicateChoices(recommended)).toBe(recommended);
    const block = renderTableDatasetBlock({ proposal: recommended, blockName: 'Orders', domain: 'commerce', owner: 'a@example.test', columnSql: (name) => `"${name}"` });
    expect(block).toContain('"order_total_cents" / 100.0 AS "order_total"');
    expect(block).not.toContain('SELECT "order_id", "order_total",');
    expect(block).toContain('/* Hidden duplicate columns: order_total (order_total_cents is used) */');
    expect(block).toContain('order_total is hidden (order_total_cents holds the same number).');
    expect(new Parser(block).parse().statements).toHaveLength(1);
    expect(tableDatasetCheckSentences(recommended, 3)).toContain('Duplicate column: Order total uses order_total_cents, shown in dollars; order_total holds the same number, so it is hidden.');

    // The other answer: the plain column as it is.
    const plain = applyTableDuplicateChoices(profiled, [{ name: 'order_total', use: 'plain' }]);
    expect(plain.fields.filter((field) => field.name.startsWith('order_total')).map((field) => [field.name, field.column])).toEqual([['order_total', undefined]]);
    expect(plain.measures.some((measure) => measure.from === 'order_total_dollars')).toBe(false);
    expect(plain.hiddenColumns).toEqual([expect.objectContaining({ column: 'order_total_cents', keptColumn: 'order_total' })]);
  });
});
