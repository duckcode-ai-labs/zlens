import { describe, expect, it } from 'vitest';
import { SemanticLayer, type MetricDefinition } from '@zlens/core';
import { convertCalculationsToMetricDrafts, metricName, type MetricDraftsResult, type ResolvedTable } from './metric-drafts.js';
import { extractTableauWorkbook } from './tableau.js';
import { extractPowerBiTmdl } from './powerbi.js';

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function workbook(calculations: Array<[string, string, string?]>, options: { filters?: string; joins?: boolean; extract?: string } = {}): string {
  const fields: Array<[string, string, string]> = [
    ['Sales', 'SALES', 'real'], ['Profit', 'PROFIT', 'real'], ['Region', 'REGION', 'string'],
    ['Order ID', 'ORDER_ID', 'string'], ['Price', 'PRICE', 'real'], ['Qty', 'QTY', 'integer'],
  ];
  const relation = options.joins
    ? `<relation join='inner' type='join'><clause type='join'><expression op='='><expression op='[ORDERS].[CUSTOMER_ID]' /><expression op='[CUSTOMERS].[ID]' /></expression></clause>
         <relation connection='snowflake.1' name='ORDERS' table='[ANALYTICS].[ORDERS]' type='table' />
         <relation connection='snowflake.1' name='CUSTOMERS' table='[ANALYTICS].[CUSTOMERS]' type='table' /></relation>`
    : `<relation connection='snowflake.1' name='ORDERS' table='[ANALYTICS].[ORDERS]' type='table' />`;
  const records = fields.map(([local, remote, type]) => `<metadata-record class='column'><remote-name>${remote}</remote-name><local-name>[${local}]</local-name><parent-name>[ORDERS]</parent-name><local-type>${type}</local-type></metadata-record>`).join('\n')
    + (options.joins ? `<metadata-record class='column'><remote-name>SEGMENT</remote-name><local-name>[Segment]</local-name><parent-name>[CUSTOMERS]</parent-name><local-type>string</local-type></metadata-record>` : '');
  const columns = calculations.map(([caption, formula, id], index) => `<column caption='${attr(caption)}' datatype='real' name='[${id ?? `Calculation_${index + 1}`}]' role='measure' type='quantitative'><calculation class='tableau' formula='${attr(formula)}' /></column>`).join('\n');
  return `<?xml version='1.0' encoding='utf-8' ?>
<workbook><datasources>
  <datasource caption='Orders' inline='true' name='federated.abc' version='18.1'>
    <connection class='federated'>
      <named-connections><named-connection caption='acme' name='snowflake.1'><connection class='snowflake' dbname='ANALYTICS' server='acme.snowflakecomputing.com' /></named-connection></named-connections>
      ${relation}
      <metadata-records>${records}</metadata-records>
    </connection>
    ${columns}
    ${options.filters ?? ''}
    ${options.extract ?? ''}
  </datasource>
</datasources></workbook>`;
}

const ordersColumns = new Map([
  ['sales', 'sales'], ['profit', 'profit'], ['region', 'region'], ['order_id', '"Order ID"'], ['price', 'price'], ['qty', 'qty'],
]);
const resolveOrders = (): ResolvedTable => ({ sql: 'analytics.orders', columns: ordersColumns });

function convertTableau(calculations: Array<[string, string, string?]>, options: Parameters<typeof workbook>[1] & { existing?: MetricDefinition[] } = {}): MetricDraftsResult {
  const file = extractTableauWorkbook(workbook(calculations, options), 'Sales Overview.twb');
  return convertCalculationsToMetricDrafts(file.inventory!.calculations, file.models!, {
    domain: 'sales',
    importedAt: '2026-10-31T12:00:00Z',
    resolveTable: (source) => (source.table === 'ORDERS' ? resolveOrders() : { sql: 'analytics.customers', columns: new Map([['segment', 'segment'], ['id', 'id']]) }),
    existingMetrics: options.existing,
  });
}

const outcome = (result: MetricDraftsResult, name: string) => result.conversions.find((conversion) => conversion.calculation.name === name)!;
const draft = (result: MetricDraftsResult, name: string) => result.drafts.find((candidate) => candidate.definition.name === name)?.definition;

describe('Tableau calculations to metric drafts', () => {
  const result = convertTableau([
    ['Total Sales', 'SUM([Sales])'],
    ['Orders', 'COUNTD([Order ID])'],
    ['East Sales', 'SUM(IF [Region] = "East" THEN [Sales] END)'],
    ['Profit Ratio', 'SUM([Profit]) / SUM([Sales])'],
    ['Line Total', '[Price] * [Qty]', 'Calculation_line'],
    ['Line Revenue', 'SUM([Calculation_line])'],
    ['Profit %', '[Calculation_ratio] * 100'],
    ['Sales LY', '{FIXED [Region] : SUM([Sales])}'],
    ['Average Qty', 'AVG([Qty])'],
    ['East Profit', 'SUM(IF [Region] = "East" THEN [Profit] ELSE 0 END)'],
    ['East Orders', 'COUNT(IF [Region] = "East" THEN [Order ID] ELSE 0 END)'],
    ['Big Lines', 'SUM(IIF([Qty] >= 10 AND [Region] IN ("East", "West"), 1, NULL))'],
    ['Picked Sales', 'SUM(IF [Region] = [Parameters].[Pick] THEN [Sales] END)'],
    ['Median Sales', 'MEDIAN([Sales])'],
    ['Tiered', 'SUM(CASE [Region] WHEN "East" THEN [Sales] END)'],
  ].map(([name, formula, id], index) => [name!, formula!, id ?? (name === 'Profit Ratio' ? 'Calculation_ratio' : `Calculation_${index}`)] as [string, string, string]));

  it('turns one aggregate into a simple metric on the database table and column', () => {
    expect(outcome(result, 'Total Sales')).toMatchObject({ outcome: 'drafted', metric: 'total_sales', inWords: 'sum(sales), on analytics.orders' });
    expect(draft(result, 'total_sales')).toMatchObject({
      name: 'total_sales', label: 'Total Sales', status: 'draft', domain: 'sales', type: 'sum', sql: 'sales', table: 'analytics.orders',
      synonyms: ['Total Sales'], tags: ['imported', 'tableau', 'human-review'],
      source: { provider: 'tableau', objectType: 'calculated_field', objectName: 'Total Sales' },
    });
    expect(draft(result, 'total_sales')!.source!.extra).toMatchObject({ formula: 'SUM([Sales])', kind: 'simple', readsTable: 'ANALYTICS.ORDERS on Snowflake (server acme.snowflakecomputing.com, database ANALYTICS)' });
    expect(draft(result, 'orders')).toMatchObject({ type: 'count_distinct', sql: '"Order ID"' });
  });

  it('turns an aggregate of a condition into a filtered metric', () => {
    expect(draft(result, 'east_sales')).toMatchObject({ type: 'sum', sql: 'sales', filter: "region = 'East'" });
    expect(draft(result, 'east_profit')).toMatchObject({ type: 'sum', sql: 'profit', filter: "region = 'East'" });
    expect(draft(result, 'big_lines')).toMatchObject({ type: 'sum', sql: '1', filter: "qty >= 10 and region in ('East', 'West')" });
    expect(outcome(result, 'East Orders')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('ELSE 0 inside COUNT') });
  });

  it('turns aggregates combined into a ratio of simple parts, reusing a part that is already a draft', () => {
    expect(draft(result, 'profit_ratio')).toMatchObject({ metricType: 'ratio', type: 'custom', table: '', typeParams: { numerator: 'sum_of_profit', denominator: 'total_sales' } });
    expect(draft(result, 'sum_of_profit')).toMatchObject({ type: 'sum', sql: 'profit', source: { objectType: 'calculation_part' } });
    expect(result.drafts.filter((candidate) => candidate.definition.sql === 'sales' && !candidate.definition.filter)).toHaveLength(1);
  });

  it('flattens a ratio inside arithmetic into one derived expression that keeps decimals and never divides by 0', () => {
    expect(draft(result, 'profit_pct')).toMatchObject({
      metricType: 'derived',
      typeParams: { expr: 'sum_of_profit / NULLIF(total_sales, 0) * 100', metrics: ['sum_of_profit', 'total_sales'] },
    });
  });

  it('uses a row-level calculation inside an aggregate, and averages whole numbers with decimals', () => {
    expect(outcome(result, 'Line Total').outcome).toBe('row-level');
    expect(draft(result, 'line_revenue')).toMatchObject({ type: 'sum', sql: 'price * qty' });
    expect(draft(result, 'average_qty')).toMatchObject({ type: 'avg', sql: '1.0 * qty' });
  });

  it('leaves out what it does not translate, naming what stopped it', () => {
    expect(outcome(result, 'Sales LY')).toMatchObject({ outcome: 'advanced', reason: expect.stringContaining('level of detail') });
    expect(outcome(result, 'Picked Sales')).toMatchObject({ outcome: 'left-out', reason: 'It uses the parameter Pick.' });
    expect(outcome(result, 'Median Sales')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('MEDIAN') });
    expect(outcome(result, 'Tiered')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('CASE') });
  });

  it('gives every simple draft a check query over all rows, and reuses an identical metric the project has', () => {
    expect(result.drafts.find((candidate) => candidate.definition.name === 'east_sales')!.check).toEqual({ table: 'analytics.orders', expression: "sum(case when region = 'East' then sales end)" });
    const reused = convertTableau([['Revenue', 'SUM([Sales])']], {
      existing: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'sales', type: 'sum', sql: 'sales', table: 'analytics.orders' }],
    });
    expect(reused.conversions[0]).toMatchObject({ outcome: 'reused', metric: 'revenue' });
    expect(reused.drafts).toHaveLength(0);
    const taken = convertTableau([['Revenue', 'SUM([Profit])']], {
      existing: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'sales', type: 'sum', sql: 'sales', table: 'analytics.orders' }],
    });
    expect(taken.conversions[0]).toMatchObject({ outcome: 'drafted', metric: 'revenue_2' });
  });

  it('adds the data source and extract filters to every metric, and leaves the source out when one cannot be read', () => {
    const filtered = convertTableau([['Total Sales', 'SUM([Sales])'], ['East Sales', 'SUM(IF [Region] = "East" THEN [Sales] END)']], {
      filters: `<filter class='categorical' column='[Region]'><groupfilter function='except' user:ui-enumeration='exclusive'><groupfilter function='level-members' level='[Region]' /><groupfilter function='member' level='[Region]' member='&quot;Central&quot;' /></groupfilter></filter>`,
      extract: `<extract enabled='true'><connection class='hyper'><filter class='quantitative' column='[Qty]' included-values='in-range'><min>1</min></filter></connection></extract>`,
    });
    expect(draft(filtered, 'total_sales')!.filter).toBe("(region not in ('Central') or region is null) and qty >= 1");
    expect(draft(filtered, 'east_sales')!.filter).toBe("region = 'East' and (region not in ('Central') or region is null) and qty >= 1");
    expect(outcome(filtered, 'Total Sales').notes.join(' ')).toContain('reads an extract');
    const unreadable = convertTableau([['Total Sales', 'SUM([Sales])']], {
      filters: `<filter class='relative-date' column='[Order Date]' first-period='-1' last-period='0' period-type='month' />`,
    });
    expect(outcome(unreadable, 'Total Sales')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('cannot read') });
  });

  it('converts a joined data source at the table\'s own grain, naming the inner joins, and refuses a filter on the joined table', () => {
    const joined = convertTableau([['Total Sales', 'SUM([Sales])'], ['SMB Sales', 'SUM(IF [Segment] = "SMB" THEN [Sales] END)']], { joins: true });
    expect(outcome(joined, 'Total Sales').notes[0]).toContain('joins 2 tables, with inner joins (ORDERS with CUSTOMERS)');
    expect(outcome(joined, 'SMB Sales')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('a filter on another table') });
  });

  it('leaves out a calculation whose table is not in the connected database', () => {
    const file = extractTableauWorkbook(workbook([['Total Sales', 'SUM([Sales])']]), 'Sales Overview.twb');
    const missing = convertCalculationsToMetricDrafts(file.inventory!.calculations, file.models!, {
      domain: 'sales', importedAt: '2026-10-31T12:00:00Z',
      resolveTable: () => ({ error: 'ANALYTICS.ORDERS is not in the connected database. Connect the database the workbook reads.' }),
    });
    expect(missing.conversions[0]).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('not in the connected database') });
  });
});

describe('Power BI measures to metric drafts', () => {
  const tmdl = (mode: string, steps = '', extraColumns = '') => [{
    path: 'tables/Sales.tmdl',
    text: [
      'table Sales',
      '\tcolumn Amount', '\t\tdataType: decimal', '\t\tsourceColumn: Amount',
      '\tcolumn Region', '\t\tdataType: string', '\t\tsourceColumn: Region',
      '\tcolumn Qty', '\t\tdataType: int64', '\t\tsourceColumn: Qty',
      '\tcolumn CustomerID', '\t\tdataType: string', '\t\tsourceColumn: CustomerID',
      '\tcolumn Cost', '\t\tdataType: decimal', '\t\tsourceColumn: Cost',
      extraColumns,
      '\tmeasure \'Total Amount\' = SUM(Sales[Amount])',
      '\tmeasure \'Total Cost\' = SUM(Sales[Cost])',
      '\tmeasure \'East Amount\' = CALCULATE(SUM(Sales[Amount]), Sales[Region] = "East")',
      '\tmeasure \'Not East\' = CALCULATE([Total Amount], KEEPFILTERS(Sales[Region] <> "East"))',
      '\tmeasure \'Small Orders\' = CALCULATE([Total Amount], Sales[Qty] < 5)',
      '\tmeasure \'Large Orders\' = CALCULATE([Total Amount], Sales[Qty] > 5)',
      '\tmeasure \'East Share\' = DIVIDE([East Amount], [Total Amount])',
      '\tmeasure Margin = [Total Amount] - [Total Cost]',
      '\tmeasure \'Amount per Row\' = [Total Amount] / [Rows]',
      '\tmeasure Rows = COUNTROWS(Sales)',
      '\tmeasure Customers = DISTINCTCOUNT(Sales[CustomerID])',
      '\tmeasure \'Share or Zero\' = DIVIDE([East Amount], [Total Amount], 0)',
      '\tmeasure \'Named Region\' = CALCULATE([Total Amount], Region[Name] = "North")',
      '\tpartition Sales = m',
      `\t\tmode: ${mode}`,
      '\t\tsource =',
      '\t\t\t\tlet',
      '\t\t\t\t    Source = Sql.Database("sql.acme.com", "Sales"),',
      '\t\t\t\t    dbo_FactSales = Source{[Schema="dbo",Item="FactSales"]}[Data],',
      `\t\t\t\t    Renamed = Table.RenameColumns(dbo_FactSales, {{"SalesAmount", "Amount"}})${steps}`,
      '\t\t\t\tin',
      '\t\t\t\t    Renamed',
    ].join('\n'),
  }, {
    path: 'tables/Region.tmdl',
    text: ['table Region', '\tcolumn Name', '\t\tdataType: string', '\t\tsourceColumn: Name', '\tpartition Region = m', '\t\tmode: import', '\t\tsource =', '\t\t\t\tlet', '\t\t\t\t    Source = Sql.Database("sql.acme.com", "Sales"),', '\t\t\t\t    t = Source{[Schema="dbo",Item="DimRegion"]}[Data]', '\t\t\t\tin', '\t\t\t\t    t'].join('\n'),
  }];
  const convert = (mode = 'import', steps = '') => {
    const file = extractPowerBiTmdl(tmdl(mode, steps), 'Sales.SemanticModel/definition');
    return convertCalculationsToMetricDrafts(file.inventory!.calculations, file.models!, { domain: 'sales', importedAt: '2026-10-31T12:00:00Z' });
  };
  const result = convert();

  it('reads the database column back through Power Query renames, and the table from the navigation step', () => {
    expect(draft(result, 'total_amount')).toMatchObject({ type: 'sum', sql: 'SalesAmount', table: 'dbo.FactSales', tags: ['imported', 'powerbi', 'human-review'] });
    expect(draft(result, 'total_amount')!.source!.extra!.readsTable).toBe('dbo.FactSales on SQL Server (server sql.acme.com, database Sales)');
  });

  it('writes a CALCULATE filter as Power BI compares: text ignoring case on imported tables, blanks as 0 or ""', () => {
    expect(draft(result, 'east_amount')).toMatchObject({ type: 'sum', sql: 'SalesAmount', filter: "lower(Region) = 'east'" });
    expect(draft(result, 'not_east')!.filter).toBe("(lower(Region) <> 'east' or Region is null)");
    expect(draft(result, 'small_orders')!.filter).toBe('coalesce(Qty, 0) < 5');
    expect(draft(result, 'large_orders')!.filter).toBe('Qty > 5');
    expect(outcome(result, 'East Amount').notes.join(' ')).toContain("ignores the report's own filter or grouping on region");
    expect(outcome(result, 'Not East').notes.join(' ')).not.toContain('ignores');
    const direct = convert('directQuery');
    expect(draft(direct, 'east_amount')!.filter).toBe("Region = 'East'");
  });

  it('turns DIVIDE into a ratio, + and - into a derived metric that counts a blank as 0, and COUNTROWS into a row count', () => {
    expect(draft(result, 'east_share')).toMatchObject({ metricType: 'ratio', typeParams: { numerator: 'east_amount', denominator: 'total_amount' } });
    expect(outcome(result, 'East Share').notes.join(' ')).not.toContain('infinity');
    expect(draft(result, 'margin')).toMatchObject({ metricType: 'derived', typeParams: { expr: 'COALESCE(total_amount, 0) - COALESCE(total_cost, 0)' } });
    expect(draft(result, 'rows')).toMatchObject({ type: 'count', sql: '*', table: 'dbo.FactSales' });
    expect(draft(result, 'amount_per_row')).toMatchObject({ metricType: 'ratio', typeParams: { numerator: 'total_amount', denominator: 'rows' } });
    expect(outcome(result, 'Amount per Row').notes.join(' ')).toContain('infinity');
  });

  it('counts empty values for DISTINCTCOUNT, which counts them as one more', () => {
    expect(result.drafts.find((candidate) => candidate.definition.name === 'customers')!.check).toEqual({
      table: 'dbo.FactSales', expression: 'count(distinct CustomerID)', emptyValues: 'sum(case when CustomerID is null then 1 else 0 end)',
    });
  });

  it('leaves out DIVIDE with an alternate result, a filter on another table, and a table whose Power Query changes rows or a column type', () => {
    expect(outcome(result, 'Share or Zero')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('alternate result') });
    expect(outcome(result, 'Named Region')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('filters on Region, not Sales') });
    const filteredRows = convert('import', ',\n\t\t\t\t    Kept = Table.SelectRows(Renamed, each [Qty] > 0)');
    expect(outcome(filteredRows, 'Total Amount')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('Table.SelectRows') });
    const retyped = convert('import', ',\n\t\t\t\t    Typed = Table.TransformColumnTypes(Renamed, {{"Amount", Int64.Type}})');
    expect(outcome(retyped, 'Total Amount')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('to Int64.Type') });
    expect(outcome(retyped, 'Rows').outcome).toBe('drafted');
  });
});

describe('what the review of the converter found', () => {
  const tableau = (calculations: Array<[string, string, string?]>, options: Parameters<typeof convertTableau>[1] = {}) => convertTableau(calculations, options);

  it('keeps parentheses that hold only part of an expression', () => {
    const result = tableau([['Doubled', 'SUM((([Sales] + [Profit]) - ([Price] + [Qty])) * 2)']]);
    expect(draft(result, 'doubled')!.sql).toBe('((sales + profit) - (price + qty)) * 2');
    const filtered = tableau([['Kept', `SUM(IF NOT (([Region] = "a" OR [Region] = "b") AND ([Qty] > 1 OR [Qty] < 0)) THEN [Sales] END)`]]);
    expect(draft(filtered, 'kept')!.filter).toBe("not ((region = 'a' or region = 'b') and (qty > 1 or qty < 0))");
  });

  it('never reuses a metric whose filter it cannot compare, and tells text of another case apart', () => {
    const existing: MetricDefinition = { name: 'paid_sales', label: 'Paid', description: '', domain: 'sales', type: 'sum', sql: 'sales', table: 'analytics.orders', filter: { field: 'status', operator: 'equals', value: 'paid' } };
    expect(tableau([['Total Sales', 'SUM([Sales])']], { existing: [existing] }).conversions[0]).toMatchObject({ outcome: 'drafted', metric: 'total_sales' });
    const cased = tableau([['Open', 'SUM(IF [Region] = "Open" THEN [Sales] END)'], ['OPEN', 'SUM(IF [Region] = "OPEN" THEN [Sales] END)']]);
    expect(cased.drafts).toHaveLength(2);
  });

  it('leaves out a field of another data source, and says what ELSE 0 changes', () => {
    expect(outcome(tableau([['Blend', 'SUM([Other Source].[Sales])']]), 'Blend')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('a field of another data source') });
    expect(outcome(tableau([['East', 'SUM(IF [Region] = "East" THEN [Sales] ELSE 0 END)']]), 'East').notes.join(' ')).toContain('Tableau shows 0 for a group with no matching rows');
  });

  it('keeps whole numbers whole through arithmetic, so an average of them keeps its decimals', () => {
    expect(draft(tableau([['Avg', 'AVG([Qty] * 2)']]), 'avg')!.sql).toBe('1.0 * (qty * 2)');
    expect(draft(tableau([['Avg', 'AVG([Qty] * 1.5)']]), 'avg')!.sql).toBe('qty * 1.5');
  });

  it('writes numbers as metric expressions read them', () => {
    const result = tableau([['Half', 'SUM([Sales]) * .5'], ['Thousand', 'SUM([Sales]) * 1e3']]);
    expect(draft(result, 'half')!.typeParams).toMatchObject({ expr: 'sum_of_sales * 0.5' });
    expect(draft(result, 'thousand')!.typeParams).toMatchObject({ expr: 'sum_of_sales * 1000' });
  });

  it('keeps parentheses around a quoted name with an apostrophe', () => {
    const file = extractTableauWorkbook(workbook([['Odd', `SUM(IF ([Bob's] = 1 OR [Region] = "E") AND [Qty] = 2 THEN [Sales] END)`]]).replace(
      '<metadata-records>',
      "<metadata-records><metadata-record class='column'><remote-name>Bob's</remote-name><local-name>[Bob's]</local-name><parent-name>[ORDERS]</parent-name><local-type>integer</local-type></metadata-record>",
    ), 'Sales.twb');
    const result = convertCalculationsToMetricDrafts(file.inventory!.calculations, file.models!, { domain: 'sales', importedAt: 'now' });
    expect(result.drafts[0]!.definition.filter).toBe(`("Bob's" = 1 or REGION = 'E') and QTY = 2`);
  });

  it('turns any formula it cannot read into a reason, and carries on with the rest', () => {
    const deep = `SUM(${'('.repeat(20000)}[Sales]${')'.repeat(20000)})`;
    const result = tableau([
      ['Empty ZN', 'SUM(ZN())'], ['Empty IFNULL', 'SUM(IFNULL())'], ['Two ISNULL', 'SUM(IF ISNULL([Sales], [Qty]) THEN 1 END)'],
      ['Tableau ISBLANK', 'SUM(IF ISBLANK([Sales]) THEN 1 END)'], ['Deep', deep], ['Total Sales', 'SUM([Sales])'],
    ]);
    for (const name of ['Empty ZN', 'Empty IFNULL', 'Two ISNULL', 'Tableau ISBLANK', 'Deep']) expect(outcome(result, name).outcome, name).toBe('left-out');
    expect(outcome(result, 'Total Sales').outcome).toBe('drafted');
  });
});

describe('DAX rules the review checked against the docs', () => {
  const dax = (measures: string[], options: { columns?: string[] } = {}) => {
    const lines = [
      'table T', '\tcolumn Qty', '\t\tdataType: int64', '\t\tsourceColumn: Qty', '\tcolumn Region', '\t\tdataType: string', '\t\tsourceColumn: Region',
      '\tcolumn Amount', '\t\tdataType: decimal', '\t\tsourceColumn: Amount', '\tcolumn Cost', '\t\tdataType: decimal', '\t\tsourceColumn: Cost',
      ...(options.columns ?? []), ...measures.map((measure) => `\tmeasure ${measure}`),
      '\tpartition T = m', '\t\tmode: import', '\t\tsource =', '\t\t\t\tlet', '\t\t\t\t    Source = Sql.Database("s", "d"),', '\t\t\t\t    t = Source{[Schema="dbo",Item="T"]}[Data]', '\t\t\t\tin', '\t\t\t\t    t',
    ];
    const file = extractPowerBiTmdl([{ path: 'tables/T.tmdl', text: lines.join('\n') }], 'M.SemanticModel/definition');
    return convertCalculationsToMetricDrafts(file.inventory!.calculations, file.models!, { domain: 'sales', importedAt: 'now' });
  };
  const filterOf = (formula: string) => draft(dax([`M = ${formula}`]), 'm')?.filter;

  it('keeps == strict: a blank is not 0', () => {
    expect(filterOf('CALCULATE(SUM(T[Amount]), T[Qty] == 0)')).toBe('Qty = 0');
    expect(filterOf('CALCULATE(SUM(T[Amount]), T[Qty] = 0)')).toBe('coalesce(Qty, 0) = 0');
    expect(filterOf('CALCULATE(SUM(T[Amount]), T[Region] == BLANK())')).toBe('Region is null');
  });

  it('reads IN strictly: a blank matches only BLANK()', () => {
    expect(filterOf('CALCULATE(SUM(T[Amount]), T[Qty] IN {0, 1})')).toBe('Qty in (0, 1)');
    expect(filterOf('CALCULATE(SUM(T[Amount]), T[Region] IN {"", "East"})')).toBe("lower(Region) in ('', 'east')");
    expect(filterOf('CALCULATE(SUM(T[Amount]), T[Region] IN {BLANK(), "East"})')).toBe("(lower(Region) in ('east') or Region is null)");
  });

  it('pushes NOT down to the comparison, so empty rows stay as they do in DAX', () => {
    expect(filterOf('CALCULATE(SUM(T[Amount]), NOT T[Region] = "East")')).toBe("(lower(Region) <> 'east' or Region is null)");
    expect(filterOf('CALCULATE(SUM(T[Amount]), NOT T[Qty] > 5)')).toBe('coalesce(Qty, 0) <= 5');
    expect(filterOf('CALCULATE(SUM(T[Amount]), NOT T[Region] IN {"East"})')).toBe("(lower(Region) not in ('east') or Region is null)");
    // Sorted as advanced, so it stays out rather than being translated.
    expect(filterOf('CALCULATE(SUM(T[Amount]), NOT (T[Qty] > 5 && T[Qty] < 9))')).toBeUndefined();
  });

  it('reads a blank as 0 in a calculated column built with + or -, and leaves out what that would change', () => {
    const margin = ["column Margin = T[Amount] - T[Cost]".replace(/^/, '\t')];
    const result = dax(['Total = SUM(T[Margin])', 'Average = AVERAGE(T[Margin])'], { columns: margin });
    expect(draft(result, 'total')!.sql).toBe('coalesce(Amount, 0) - coalesce(Cost, 0)');
    expect(outcome(result, 'Average')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('a metric would read it as 0') });
  });

  it('keeps a long number\'s digits, leaves out a DATE that rolls over, and notes where both sides are empty', () => {
    expect(filterOf('CALCULATE(SUM(T[Amount]), T[Qty] = 12345678901234567890)')).toBe('Qty = 12345678901234567890');
    expect(outcome(dax(['M = CALCULATE(SUM(T[Amount]), T[Qty] = 1, T[Region] = "a", T[Cost] > DATE(2024, 13, 1))']), 'M')).toMatchObject({ outcome: 'left-out' });
    const result = dax(['A = SUM(T[Amount])', 'C = SUM(T[Cost])', 'Margin = [A] - [C]']);
    expect(outcome(result, 'Margin').notes.join(' ')).toContain('Where both sides are empty');
  });

  it('keeps DISTINCTCOUNT apart from DISTINCTCOUNTNOBLANK, since only its check counts empty values', () => {
    const result = dax(['Both = DISTINCTCOUNT(T[Region])', 'Plain = DISTINCTCOUNTNOBLANK(T[Region])']);
    expect(result.drafts.filter((candidate) => candidate.check?.emptyValues)).toHaveLength(1);
    expect(result.drafts).toHaveLength(2);
  });

  it('reads the model\'s default mode and a dual table', () => {
    const lines = (mode: string) => ['table T', '\tcolumn Region', '\t\tdataType: string', '\t\tsourceColumn: Region', '\tcolumn Amount', '\t\tdataType: decimal', '\t\tsourceColumn: Amount', '\tmeasure M = CALCULATE(SUM(T[Amount]), T[Region] = "East")', '\tpartition T = m', ...(mode ? [`\t\tmode: ${mode}`] : []), '\t\tsource =', '\t\t\t\tlet', '\t\t\t\t    Source = Sql.Database("s", "d"),', '\t\t\t\t    t = Source{[Schema="dbo",Item="T"]}[Data]', '\t\t\t\tin', '\t\t\t\t    t'].join('\n');
    const direct = extractPowerBiTmdl([{ path: 'model.tmdl', text: 'model Model\n\tdefaultMode: directQuery\n' }, { path: 'tables/T.tmdl', text: lines('') }], 'M.SemanticModel/definition');
    expect(draft(convertCalculationsToMetricDrafts(direct.inventory!.calculations, direct.models!, { domain: 'sales', importedAt: 'now' }), 'm')!.filter).toBe("Region = 'East'");
    const dual = extractPowerBiTmdl([{ path: 'tables/T.tmdl', text: lines('dual') }], 'M.SemanticModel/definition');
    expect(convertCalculationsToMetricDrafts(dual.inventory!.calculations, dual.models!, { domain: 'sales', importedAt: 'now' }).conversions[0]!.notes.join(' ')).toContain('is dual');
  });
});

describe('drafts compile in the semantic layer', () => {
  it('composes every drafted metric, ratios and derived ones included', () => {
    const file = extractTableauWorkbook(workbook([
      ['Total Sales', 'SUM([Sales])'],
      ['East Sales', 'SUM(IF [Region] = "East" THEN [Sales] END)'],
      ['Profit Ratio', 'SUM([Profit]) / SUM([Sales])', 'Calculation_ratio'],
      ['Profit %', '[Calculation_ratio] * 100'],
    ]), 'Sales Overview.twb');
    const result = convertCalculationsToMetricDrafts(file.inventory!.calculations, file.models!, { domain: 'sales', importedAt: '2026-10-31T12:00:00Z', resolveTable: resolveOrders });
    const layer = new SemanticLayer({ metrics: result.drafts.map((candidate) => candidate.definition), dimensions: [] });
    for (const candidate of result.drafts) {
      expect(layer.composeQuery({ metrics: [candidate.definition.name], dimensions: [], driver: 'postgres' }), candidate.definition.name).not.toBeNull();
    }
    expect(layer.composeQuery({ metrics: ['profit_pct'], dimensions: [], driver: 'postgres' })!.sql).toContain('sum_of_profit * 1.0 / NULLIF(ratio_inputs.total_sales, 0) * 100');
  });

  it('names a metric after its caption', () => {
    expect(metricName('Total Sales')).toBe('total_sales');
    expect(metricName('_SumTotalPrice')).toBe('sum_total_price');
    expect(metricName('% Passed')).toBe('pct_passed');
    expect(metricName('Profit %')).toBe('profit_pct');
    expect(metricName('2024 Sales')).toBe('metric_2024_sales');
  });
});
