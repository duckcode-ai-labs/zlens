import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlockStudioImportSession } from '../block-studio-import.js';
import { readBiFile } from './index.js';
import { readPowerQuery, readPowerQueryParameter } from './power-query.js';
import { readPowerBiReportLayout } from './powerbi.js';
import { listZipEntries, readZipFile } from './zip.js';

/**
 * Fixtures copy the structure of public samples (Tableau Server Insights
 * workbooks; Databricks' Power BI migration samples: .pbit and PBIP/TMDL),
 * written small by hand against the jaffle-shop tables.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with stored and deflated entries, like Tableau and Power BI write. */
function zip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CUSTOM_SQL = 'SELECT l.location_name, SUM(o.order_total) AS revenue&#13;&#10;FROM dev.orders o&#13;&#10;JOIN dev.locations l ON l.location_id = o.location_id&#13;&#10;WHERE o.ordered_at &gt;= &lt;[Parameters].[Parameter 1]&gt;&#13;&#10;  AND l.location_name = &lt;[Parameters].[Parameter 2]&gt;&#13;&#10;GROUP BY 1';
const WORKBOOK = `<?xml version='1.0' encoding='utf-8' ?>
<!-- build 20242.24.0807.0327 -->
<workbook source-build='2024.2.0' version='18.1'>
  <datasources>
    <datasource hasconnection='false' inline='true' name='Parameters' version='18.1'>
      <aliases enabled='yes' />
      <column caption='Start Date' datatype='date' name='[Parameter 1]' param-domain-type='any' role='measure' type='quantitative' value='#2024-01-01#'>
        <calculation class='tableau' formula='#2024-01-01#' />
      </column>
      <column caption='Store' datatype='string' name='[Parameter 2]' param-domain-type='list' role='measure' type='nominal' value='&quot;Philadelphia&quot;'>
        <calculation class='tableau' formula='&quot;Philadelphia&quot;' />
      </column>
    </datasource>
    <datasource caption='Orders' inline='true' name='federated.0abc123' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='warehouse' name='postgres.1xyz'>
            <connection class='postgres' dbname='jaffle_shop' one-time-sql='' port='5432' server='warehouse.internal' username='tableau' />
          </named-connection>
        </named-connections>
        <relation connection='postgres.1xyz' name='Revenue by store (Custom SQL)' type='text'>${CUSTOM_SQL}</relation>
      </connection>
      <column caption='Revenue per Store' datatype='real' name='[Calculation_1]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='SUM([revenue]) / COUNTD([location_name])' />
      </column>
      <object-graph>
        <objects>
          <object caption='Revenue by store (Custom SQL)' id='Custom SQL Query_1'>
            <properties context=''>
              <relation connection='postgres.1xyz' name='Revenue by store (Custom SQL)' type='text'>${CUSTOM_SQL}</relation>
            </properties>
          </object>
        </objects>
      </object-graph>
    </datasource>
    <datasource caption='Customers' inline='true' name='federated.9def' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='warehouse' name='sqlserver.2'>
            <connection class='sqlserver' dbname='jaffle' server='mssql.internal' />
          </named-connection>
        </named-connections>
        <relation connection='sqlserver.2' name='customers' table='[dev].[customers]' type='table' />
      </connection>
      <column caption='Number of Records' datatype='integer' name='[Number of Records]' role='measure' type='quantitative' user:auto-column='numrec'>
        <calculation class='tableau' formula='1' />
      </column>
    </datasource>
  </datasources>
  <worksheets>
    <worksheet name='Revenue by store'>
      <table><view><datasources><datasource caption='Orders' name='federated.0abc123' /><datasource name='Parameters' /></datasources></view></table>
    </worksheet>
  </worksheets>
</workbook>
`;

const mString = (text: string) => `"${text.replace(/"/g, '""')}"`;
const MODEL = {
  name: 'SemanticModel',
  compatibilityLevel: 1567,
  model: {
    expressions: [
      { name: 'StartDate', kind: 'm', expression: '#date(2024, 1, 1) meta [IsParameterQuery=true, Type="Date", IsParameterQueryRequired=true]' },
      { name: 'Region', kind: 'm', expression: '"Philadelphia" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]' },
      { name: 'SalesSql', kind: 'm', expression: mString('select location_id, sum(order_total) as revenue from dev.orders group by 1') },
    ],
    tables: [
      {
        name: 'Store revenue',
        partitions: [{
          name: 'Store revenue',
          mode: 'import',
          source: {
            type: 'm',
            expression: [
              'let',
              '    Source = PostgreSQL.Database("warehouse.internal", "jaffle_shop"),',
              `    Query = Value.NativeQuery(Source, "select l.location_name, sum(o.order_total) as revenue#(lf)from dev.orders o#(lf)join dev.locations l on l.location_id = o.location_id#(lf)where o.ordered_at >= '" & Date.ToText(StartDate, "yyyy-MM-dd") & "' and l.location_name = '" & Region & "'#(lf)group by 1", null, [EnableFolding=true])`,
              'in',
              '    Query',
            ],
          },
        }],
        measures: [{ name: 'Total Revenue', expression: "SUM('Store revenue'[revenue])" }],
      },
      {
        name: 'Orders by month',
        partitions: [{ name: 'Orders by month', mode: 'import', source: { type: 'm', expression: `let\n    Source = Sql.Database("mssql.internal", "jaffle", [Query=${mString("select date_trunc('month', ordered_at) as order_month, count(*) as orders from dev.orders group by 1")}])\nin\n    Source` } }],
      },
      {
        name: 'Location revenue',
        partitions: [{ name: 'Location revenue', mode: 'import', source: { type: 'm', expression: 'let\n    Source = Odbc.Query("dsn=warehouse", SalesSql)\nin\n    Source' } }],
      },
      {
        name: 'customers',
        partitions: [{ name: 'customers', mode: 'import', source: { type: 'm', expression: 'let\n    Source = Sql.Database("mssql.internal", "jaffle"),\n    dev_customers = Source{[Schema="dev",Item="customers"]}[Data]\nin\n    dev_customers' } }],
      },
      {
        name: 'Targets',
        partitions: [{ name: 'Targets', mode: 'import', source: { type: 'm', expression: 'let\n    Source = Csv.Document(File.Contents("C:\\\\targets.csv"),[Delimiter=","])\nin\n    Source' } }],
      },
      { name: '_Measures', partitions: [{ name: '_Measures', source: { type: 'calculated', expression: '{BLANK()}' } }] },
    ],
  },
};
const utf16 = (text: string) => Buffer.from(text, 'utf16le');

describe('Tableau workbooks', () => {
  it('reads each Custom SQL query once, with its parameters, connection and worksheets', () => {
    const extracted = readBiFile(Buffer.from(WORKBOOK), 'reports/revenue.twb');
    expect(extracted.sources).toHaveLength(1);
    const source = extracted.sources[0];
    expect(source.path).toBe('reports/revenue.twb#Orders/Revenue by store');
    expect(source.sourceKind).toBe('tableau-workbook');
    expect(source.content).toBe(`-- name: Revenue by store
-- zlens-note: From Tableau workbook revenue.twb, data source Orders on PostgreSQL.
-- zlens-note: Used by worksheet Revenue by store.
SELECT l.location_name, SUM(o.order_total) AS revenue
FROM dev.orders o
JOIN dev.locations l ON l.location_id = o.location_id
WHERE o.ordered_at >= \${start_date}
  AND l.location_name = \${store}
GROUP BY 1
`);
    expect(source.parameters).toEqual([
      { name: 'start_date', written: '<Parameters.Start Date>', valueType: 'date', default: '2024-01-01' },
      { name: 'store', written: '<Parameters.Store>', valueType: 'string', default: 'Philadelphia' },
    ]);
    expect(extracted.skipped.map((item) => [item.kind, item.reason, item.sql])).toEqual([
      ['calculations', '1 calculated field is not imported from data source Orders. Rebuild the ones your reports need as metrics.', 'Revenue per Store: SUM([revenue]) / COUNTD([location_name])'],
      ['no-sql', 'Tableau data source Customers reads a table directly, with no Custom SQL to import. ZLens reads those tables from the database itself.', 'dev.customers'],
    ]);
  });

  it('reads the workbook inside a packaged workbook (.twbx)', () => {
    const twbx = zip([
      { name: 'revenue.twb', data: Buffer.from(WORKBOOK), deflate: true },
      { name: 'Data/Extracts/orders.hyper', data: Buffer.alloc(64) },
    ]);
    expect(listZipEntries(twbx).map((entry) => entry.name)).toEqual(['revenue.twb', 'Data/Extracts/orders.hyper']);
    const extracted = readBiFile(twbx, 'reports/revenue.twbx');
    expect(extracted.sources.map((source) => source.path)).toEqual(['reports/revenue.twbx#Orders/Revenue by store']);
  });
});

describe('Power BI templates and projects', () => {
  const pbit = () => zip([
    { name: 'Version', data: utf16('1.28') },
    { name: 'DataModelSchema', data: utf16(JSON.stringify(MODEL)), deflate: true },
    { name: 'Report/Layout', data: utf16('{}'), deflate: true },
  ]);

  it('reads native SQL from Value.NativeQuery, a connector Query option and Odbc.Query, with parameters', () => {
    const extracted = readBiFile(pbit(), 'reports/Sales.pbit');
    expect(extracted.sources.map((source) => [source.path, source.content])).toEqual([
      ['reports/Sales.pbit#Store revenue', `-- name: Store revenue
-- zlens-note: From Power BI Sales.pbit, table Store revenue on PostgreSQL.
select l.location_name, sum(o.order_total) as revenue
from dev.orders o
join dev.locations l on l.location_id = o.location_id
where o.ordered_at >= \${start_date} and l.location_name = \${region}
group by 1
`],
      ['reports/Sales.pbit#Orders by month', `-- name: Orders by month
-- zlens-note: From Power BI Sales.pbit, table Orders by month on SQL Server.
select date_trunc('month', ordered_at) as order_month, count(*) as orders from dev.orders group by 1
`],
      ['reports/Sales.pbit#Location revenue', `-- name: Location revenue
-- zlens-note: From Power BI Sales.pbit, table Location revenue on ODBC.
select location_id, sum(order_total) as revenue from dev.orders group by 1
`],
    ]);
    expect(extracted.sources[0].parameters).toEqual([
      { name: 'start_date', written: 'StartDate', valueType: 'date', default: '2024-01-01' },
      { name: 'region', written: 'Region', valueType: 'string', default: 'Philadelphia' },
    ]);
    expect(extracted.skipped.map((item) => [item.kind, item.sql])).toEqual([
      ['no-sql', 'customers (dev.customers)'],
      ['no-sql', 'Targets (Csv.Document, File.Contents)'],
      ['calculations', "Total Revenue = SUM('Store revenue'[revenue])"],
    ]);
    expect(extracted.skipped[2].reason).toBe('1 DAX measure is not imported. Rebuild the ones your reports need as metrics.');
  });

  it('marks Power Query code it cannot read as a parameter to check', () => {
    const reading = readPowerQuery('let Source = Sql.Database("s", "d", [Query="select * from dev.orders where region = \'" & Text.Upper(Region) & "\'"]) in Source', { parameters: new Map(), shared: new Map() });
    expect(reading.queries[0].sql).toBe('select * from dev.orders where region = ${power_query_value_1}');
    expect(reading.queries[0].notes[0]).toMatch(/Power Query code ZLens cannot read \(Text\.Upper \( Region \)\)/);
    expect(readPowerQuery('let Source = Web.Contents("https://x", [Query=[a="b"]]) in Source', { parameters: new Map(), shared: new Map() }).queries).toEqual([]);
    expect(readPowerQueryParameter('RangeStart', '#datetime(1990, 1, 1, 0, 0, 0) meta [IsParameterQuery=true, Type="DateTime", IsParameterQueryRequired=true]'))
      .toEqual({ name: 'range_start', valueType: 'date', default: '1990-01-01' });
  });

  it('says how to get a template from a .pbix, and lists a damaged file instead of failing', () => {
    expect(readBiFile(Buffer.from('PK'), 'reports/Sales.pbix').skipped[0]).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('File → Export → Power BI template') });
    expect(readZipFile(pbit(), (name) => name === 'Version')?.data.toString('utf16le')).toBe('1.28');
  });

  it('reads uploaded files: a .pbit sent base64-encoded and a .twb as text', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-bi-upload-'));
    roots.push(root);
    const session = createBlockStudioImportSession(root, {
      inputMode: 'upload',
      sources: [
        { path: 'Sales.pbit', content: pbit().toString('base64'), encoding: 'base64' },
        { path: 'revenue.twb', content: WORKBOOK },
      ],
      domain: 'finance',
    });
    expect(session.inputPath).toBe('2 uploaded file(s)');
    expect(session.candidates.map((candidate) => candidate.sourcePath)).toEqual([
      'Sales.pbit#Store revenue',
      'Sales.pbit#Orders by month',
      'Sales.pbit#Location revenue',
      'revenue.twb#Orders/Revenue by store',
    ]);
  });

  it('imports a folder of SQL, Tableau and Power BI files into drafts, with defaults for their parameters', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-bi-import-'));
    roots.push(root);
    const legacy = join(root, 'legacy');
    const definition = join(legacy, 'Sales.SemanticModel', 'definition');
    mkdirSync(join(definition, 'tables'), { recursive: true });
    mkdirSync(join(legacy, 'Sales.SemanticModel', '.pbi'), { recursive: true });
    writeFileSync(join(legacy, 'revenue.twb'), WORKBOOK);
    writeFileSync(join(legacy, 'Sales.pbit'), pbit());
    writeFileSync(join(legacy, 'Old.pbix'), Buffer.from('PK not really'));
    writeFileSync(join(legacy, 'broken.twbx'), Buffer.from('not a zip'));
    writeFileSync(join(legacy, 'Sales.pbip'), '{"version":"1.0","artifacts":[{"report":{"path":"Sales.Report"}}]}');
    writeFileSync(join(definition, 'model.tmdl'), 'model Model\n\tculture: en-US\n');
    writeFileSync(join(definition, 'expressions.tmdl'), 'expression Since = "2024-06-01" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]\n\tlineageTag: 1\n\n\tannotation PBI_ResultType = Text\n');
    writeFileSync(join(definition, 'tables', 'recent_orders.tmdl'), `table recent_orders
\tlineageTag: 2

\tmeasure 'Order Count' = COUNTROWS(recent_orders)
\t\tformatString: 0
\t\tlineageTag: 3

\tcolumn order_id
\t\tdataType: int64
\t\tsourceColumn: order_id

\tpartition recent_orders = m
\t\tmode: directQuery
\t\tsource =
\t\t\t\tlet
\t\t\t\t    Source = Value.NativeQuery(PostgreSQL.Database("warehouse.internal", "jaffle_shop"), "select order_id, ordered_at from dev.orders where ordered_at >= '" & Since & "'", null, [EnableFolding=true])
\t\t\t\tin
\t\t\t\t    Source

\tannotation PBI_ResultType = Table
`);
    writeFileSync(join(legacy, 'Sales.SemanticModel', '.pbi', 'cache.tmdl'), 'table ignored\n');

    const session = createBlockStudioImportSession(root, { inputPath: 'legacy', domain: 'finance', owner: 'analytics@jaffle.shop' });
    expect(session.candidates.map((candidate) => [candidate.name, candidate.sourceKind, candidate.sourcePath])).toEqual([
      ['Store Revenue', 'powerbi-project', 'legacy/Sales.pbit#Store revenue'],
      ['Orders By Month', 'powerbi-project', 'legacy/Sales.pbit#Orders by month'],
      ['Location Revenue', 'powerbi-project', 'legacy/Sales.pbit#Location revenue'],
      ['Revenue By Store', 'tableau-workbook', 'legacy/revenue.twb#Orders/Revenue by store'],
      ['Recent Orders', 'powerbi-project', 'legacy/Sales.SemanticModel/definition#recent_orders'],
    ]);
    const tableau = session.candidates[3];
    expect(tableau.dqlSource).toContain('start_date = "2024-01-01"');
    expect(tableau.dqlSource).toContain('store = "Philadelphia"');
    expect(tableau.warnings.join(' ')).toContain('From Tableau workbook revenue.twb, data source Orders on PostgreSQL.');
    const tmdl = session.candidates[4];
    expect(tmdl.sql).toContain("where ordered_at >= ${since}");
    expect(tmdl.dqlSource).toContain('since = "2024-06-01"');
    expect(session.skippedStatements?.map((item) => [item.kind, item.sourcePath])).toEqual([
      ['unreadable', 'legacy/Old.pbix'],
      ['no-sql', 'legacy/Sales.pbit'],
      ['no-sql', 'legacy/Sales.pbit'],
      ['calculations', 'legacy/Sales.pbit'],
      ['unreadable', 'legacy/broken.twbx'],
      ['calculations', 'legacy/revenue.twb#Orders'],
      ['no-sql', 'legacy/revenue.twb#Customers'],
      ['calculations', 'legacy/Sales.SemanticModel/definition'],
    ]);
  });
});

describe('a Power BI report, counted', () => {
  it('reads pages and visual types from a template layout (Report/Layout) or an older report.json', () => {
    const layout = JSON.stringify({
      sections: [
        { displayName: 'Overview', visualContainers: [{ config: JSON.stringify({ singleVisual: { visualType: 'card' } }) }, { config: JSON.stringify({ singleVisual: { visualType: 'lineChart' } }) }] },
        { name: 'ReportSection2', visualContainers: [{ config: '{not json' }, { config: JSON.stringify({ singleVisualGroup: {} }) }] },
      ],
    });
    expect(readPowerBiReportLayout(layout)).toEqual([
      { name: 'Overview', kind: 'page', visuals: ['card', 'lineChart'] },
      { name: 'ReportSection2', kind: 'page', visuals: [] },
    ]);
  });
});

describe('a TMDL calculated column, read', () => {
  it('keeps its formula and leaves out the properties written under it', () => {
    const text = [
      'table Sales',
      '\tcolumn Weekday = FORMAT(Sales[Date], "dddd")',
      '\t\tdataType: string',
      '\t\tsummarizeBy: none',
      '\t\tlineageTag: 1234',
      '',
      '\tcolumn Amount',
      '\t\tdataType: double',
      '\t\tsourceColumn: amount',
    ].join('\n');
    const read = readBiFile(Buffer.from(text), 'Sales.SemanticModel/definition/tables/Sales.tmdl');
    expect(read.inventory!.calculations.map((calculation) => [calculation.name, calculation.role, calculation.formula])).toEqual([
      ['Weekday', 'column', 'FORMAT(Sales[Date], "dddd")'],
    ]);
  });
});

