import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessMigrationFolder, migrationAssessmentMarkdown, migrationAssessmentSummary } from './migrate-assess.js';

/**
 * A folder as a team leaving Tableau and Power BI would hand over: a workbook
 * with Custom SQL, calculated fields, worksheets and a dashboard; a Power BI
 * model (native SQL, measures, a calculated column) with its PBIP report; SQL
 * scripts with a duplicate and a cleanup step; and a .pbix ZLens cannot read.
 */

const WORKBOOK = `<?xml version='1.0' encoding='utf-8' ?>
<workbook source-build='2024.2.0' version='18.1'>
  <datasources>
    <datasource caption='Orders' inline='true' name='federated.1' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='warehouse' name='postgres.1'>
            <connection class='postgres' dbname='jaffle_shop' server='warehouse.internal' />
          </named-connection>
        </named-connections>
        <relation connection='postgres.1' name='Revenue by store (Custom SQL)' type='text'>SELECT l.location_name, SUM(o.order_total) AS revenue FROM dev.orders o JOIN dev.locations l ON l.location_id = o.location_id GROUP BY 1</relation>
      </connection>
      <column caption='Revenue' datatype='real' name='[Calculation_1]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='SUM([revenue])' />
      </column>
      <column caption='Philadelphia revenue' datatype='real' name='[Calculation_2]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='SUM(IF [location_name] = &quot;Philadelphia&quot; THEN [revenue] END)' />
      </column>
      <column caption='Share of revenue' datatype='real' name='[Calculation_3]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='[Calculation_1] / TOTAL([Calculation_1])' />
      </column>
      <column caption='Store label' datatype='string' name='[Calculation_4]' role='dimension' type='nominal'>
        <calculation class='tableau' formula='UPPER([location_name])' />
      </column>
    </datasource>
    <datasource caption='Customers' inline='true' name='federated.2' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='warehouse' name='snowflake.2'>
            <connection class='snowflake' dbname='ANALYTICS' server='acme.snowflakecomputing.com' />
          </named-connection>
        </named-connections>
        <relation connection='snowflake.2' name='customers' table='[dev].[customers]' type='table' />
        <relation connection='snowflake.2' name='orders' table='[dev].[orders]' type='table' />
      </connection>
    </datasource>
  </datasources>
  <worksheets>
    <worksheet name='Revenue by store'>
      <table><view><datasources><datasource caption='Orders' name='federated.1' /></datasources></view><panes><pane><mark class='Bar' /></pane></panes></table>
    </worksheet>
    <worksheet name='Revenue trend'>
      <table><view><datasources><datasource caption='Orders' name='federated.1' /></datasources></view><panes><pane><mark class='Line' /></pane></panes></table>
    </worksheet>
  </worksheets>
  <dashboards>
    <dashboard name='Store review'><zones /></dashboard>
  </dashboards>
</workbook>
`;

const MODEL = {
  name: 'SemanticModel',
  model: {
    tables: [
      {
        name: 'Orders',
        partitions: [{ name: 'Orders', mode: 'import', source: { type: 'm', expression: ['let', '    Source = Sql.Database("mssql.internal", "jaffle", [Query="select order_id, customer_id, order_total, price, cost from dbo.orders"])', 'in', '    Source'] } }],
        columns: [
          { name: 'order_total', dataType: 'double', sourceColumn: 'order_total' },
          { name: 'Margin', type: 'calculated', dataType: 'double', expression: 'Orders[price] - Orders[cost]' },
        ],
        measures: [
          { name: 'Total Sales', expression: 'SUM(Orders[order_total])' },
          { name: 'Sales YTD', expression: 'TOTALYTD([Total Sales], Dates[Date])' },
          { name: 'Average Order', expression: 'DIVIDE([Total Sales], COUNTROWS(Orders))' },
        ],
      },
      {
        name: 'Dates',
        partitions: [{ name: 'Dates', source: { type: 'm', expression: 'let Source = Snowflake.Databases("acme.snowflakecomputing.com", "WH"), Dates = Source{[Name="ANALYTICS"]}[Data]{[Name="DEV"]}[Data]{[Name="DATES"]}[Data] in Dates' } }],
      },
    ],
  },
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function handover(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-assess-'));
  roots.push(root);
  const files: Record<string, string> = {
    'reports/tableau/store-review.twb': WORKBOOK,
    'reports/powerbi/Sales.SemanticModel/model.bim': JSON.stringify(MODEL),
    'reports/powerbi/Sales.Report/definition/pages/p1/page.json': JSON.stringify({ name: 'p1', displayName: 'Overview' }),
    'reports/powerbi/Sales.Report/definition/pages/p1/visuals/v1/visual.json': JSON.stringify({ name: 'v1', visual: { visualType: 'clusteredBarChart' } }),
    'reports/powerbi/Sales.Report/definition/pages/p1/visuals/v2/visual.json': JSON.stringify({ name: 'v2', visual: { visualType: 'lineChart' } }),
    'reports/powerbi/Sales.Report/definition/pages/p2/page.json': JSON.stringify({ name: 'p2', displayName: 'Customers' }),
    // The report shows Customers first.
    'reports/powerbi/Sales.Report/definition/pages/pages.json': JSON.stringify({ pageOrder: ['p2', 'p1'], activePageName: 'p2' }),
    'reports/powerbi/Sales.Report/definition/pages/p2/visuals/v3/visual.json': JSON.stringify({ name: 'v3', visual: { visualType: 'tableEx' } }),
    'reports/sql/monthly.sql': '-- name: Monthly revenue\nselect date_trunc(\'month\', ordered_at) as month, sum(order_total) as revenue from dev.orders group by 1;\n\n-- name: Top customers\nselect customer_id, sum(order_total) as spend from dev.orders group by 1 order by 2 desc limit 10;\n',
    'reports/sql/copy-of-monthly.sql': '-- name: Monthly revenue (copy)\nselect date_trunc(\'month\', ordered_at) as month, sum(order_total) as revenue from dev.orders group by 1;\n',
    'reports/sql/cleanup.sql': 'drop table if exists tmp_orders;\n',
    'reports/old/finance.pbix': 'PK not really a report',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('zlens migrate assess', () => {
  it('counts what the import makes, the calculations by kind, the report and the databases', () => {
    const root = handover();
    const assessment = assessMigrationFolder('reports', { cwd: root, now: new Date('2026-10-30T12:00:00Z') });

    // Queries: Tableau Custom SQL 1, Power BI native SQL 1, SQL scripts 2 (the copy is counted once, the DROP left out).
    expect(assessment.queries).toEqual({ drafts: 4, withParameters: 0, duplicates: 1, writes: 1 });
    expect(assessment.tablesWithoutSql).toBe(3);

    const kinds = Object.fromEntries(assessment.calculations.map((calculation) => [calculation.name, calculation.kind]));
    expect(kinds).toEqual({
      Revenue: 'simple',
      'Philadelphia revenue': 'filtered',
      'Share of revenue': 'advanced',
      'Store label': 'row-level',
      'Total Sales': 'simple',
      'Sales YTD': 'advanced',
      'Average Order': 'ratio',
      Margin: 'row-level',
    });
    // Formulas read as in Tableau: other calculations by their captions.
    expect(assessment.calculations.find((calculation) => calculation.name === 'Share of revenue')!.formula).toBe('[Revenue] / TOTAL([Revenue])');

    const byPath = Object.fromEntries(assessment.files.map((file) => [file.path, file]));
    expect(byPath['reports/tableau/store-review.twb']).toMatchObject({ tool: 'tableau', queries: 1, calculations: 4 });
    expect(byPath['reports/tableau/store-review.twb']!.pages.map((page) => [page.kind, page.name, page.visuals])).toEqual([
      ['worksheet', 'Revenue by store', ['Bar']],
      ['worksheet', 'Revenue trend', ['Line']],
      ['dashboard', 'Store review', []],
    ]);
    expect(byPath['reports/powerbi/Sales.SemanticModel/model.bim']).toMatchObject({ tool: 'powerbi', queries: 1, calculations: 4 });
    expect(byPath['reports/powerbi/Sales.Report']!.pages).toEqual([
      { name: 'Customers', kind: 'page', visuals: ['tableEx'] },
      { name: 'Overview', kind: 'page', visuals: ['clusteredBarChart', 'lineChart'] },
    ]);
    // Files are read in name order: the copy comes first, so monthly.sql keeps only Top customers.
    expect(byPath['reports/sql/copy-of-monthly.sql']).toMatchObject({ tool: 'sql', queries: 1 });
    expect(byPath['reports/sql/monthly.sql']).toMatchObject({ tool: 'sql', queries: 1 });

    expect(assessment.databases.map((db) => [db.database, db.files, db.connects])).toEqual([
      ['Snowflake', 2, 'yes'],
      ['PostgreSQL', 1, 'yes'],
      ['SQL Server', 1, 'yes'],
    ]);
    expect(assessment.leftOut.map((item) => item.sourcePath)).toEqual(['reports/old/finance.pbix']);
  });

  it('writes a report people can share, and a short summary for the terminal', () => {
    const root = handover();
    const assessment = assessMigrationFolder('reports', { cwd: root, now: new Date('2026-10-30T12:00:00Z') });
    const markdown = migrationAssessmentMarkdown(assessment);
    expect(markdown).toContain('Read from `reports` on 2026-10-30');
    expect(markdown).toContain('nothing ran against a database, no AI was asked, and nothing left this computer');
    expect(markdown).toContain('| Queries (Custom SQL, native SQL, scripts) | 4 |');
    expect(markdown).toContain('| Calculations | 8 | Simple 2, Filtered 1, Ratio 1, Row-level 2, Advanced 2.');
    expect(markdown).toContain('| Report | 2 worksheets, 1 dashboard, 2 report pages with 3 visuals |');
    expect(markdown).toContain('npx zlens import sql reports');
    expect(markdown).toMatch(/\| Sales YTD \| Time intelligence \(TOTALYTD, SAMEPERIODLASTYEAR, DATEADD …\)\. \| `TOTALYTD\(\[Total Sales\], Dates\[Date\]\)` \|/);
    expect(markdown).toContain('| reports/old/finance.pbix | A .pbix stores its model compressed');

    const summary = migrationAssessmentSummary(assessment, 'zlens-migration-assessment.md').join('\n');
    expect(summary).toContain('Read:          reports (1 Tableau workbook, 2 Power BI files, 3 SQL files)');
    expect(summary).toContain('Queries:       4 queries become draft saved queries with zlens import sql');
    expect(summary).toContain('Calculations:  8 (4 simple, filtered or ratio that cannot yet, with why in the report; 2 row-level: a column or dimension; 2 advanced: rewrite by hand or with a coding agent)');
    // They read Custom SQL and a native query: a query, not a table a metric can sit on.
    expect(markdown).toContain('### Simple, filtered or ratio, but not a metric yet (4)');
    expect(markdown).toContain('| Revenue | Data source Orders reads Revenue by store (Custom SQL). It reads Custom SQL, a query rather than a table. |');
    expect(markdown).toContain('| Total Sales | The field order_total is in Orders. It loads a native query, not a table. |');
    expect(summary).toContain('Full report:   zlens-migration-assessment.md');
  });

  it('reads a folder with no SQL at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-assess-empty-'));
    roots.push(root);
    writeFileSync(join(root, 'finance.pbix'), 'PK');
    const assessment = assessMigrationFolder('.', { cwd: root });
    expect(assessment.queries.drafts).toBe(0);
    expect(assessment.leftOut).toHaveLength(1);
  });

  it('says when the queries could not be counted, instead of reporting none', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = handover();
    chmodSync(join(root, 'reports/sql/monthly.sql'), 0o000);
    try {
      const assessment = assessMigrationFolder('reports', { cwd: root });
      expect(assessment.queries.drafts).toBe(0);
      expect(assessment.leftOut.some((item) => /The queries could not be counted/.test(item.reason))).toBe(true);
    } finally {
      chmodSync(join(root, 'reports/sql/monthly.sql'), 0o644);
    }
  });

  it('keeps a # in a file name with its file', () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-assess-hash-'));
    roots.push(root);
    mkdirSync(join(root, 'sql'));
    writeFileSync(join(root, 'sql', 'report#1.sql'), 'select 1 as one;\n');
    const assessment = assessMigrationFolder('sql', { cwd: root });
    expect(assessment.files.map((file) => [file.path, file.tool, file.queries])).toEqual([['sql/report#1.sql', 'sql', 1]]);
  });

  it('reads a .pbip project file as its model and report, and a report folder on its own', () => {
    const root = handover();
    writeFileSync(join(root, 'reports/powerbi/Sales.pbip'), JSON.stringify({ version: '1.0', artifacts: [{ report: { path: 'Sales.Report' } }] }));
    const project = assessMigrationFolder('reports/powerbi/Sales.pbip', { cwd: root });
    expect(project.files.map((file) => file.path)).toEqual(['reports/powerbi/Sales.Report', 'reports/powerbi/Sales.SemanticModel/model.bim']);
    expect(project.queries.drafts).toBe(1);
    const report = assessMigrationFolder('reports/powerbi/Sales.Report', { cwd: root });
    expect(report.files.map((file) => [file.path, file.pages.length])).toEqual([['reports/powerbi/Sales.Report', 2]]);
  });

  it('names the files and web sources a Power BI table loads, and counts each table once', () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-assess-pbi-'));
    roots.push(root);
    const model = { model: { tables: [
      { name: 'Targets', partitions: [{ name: 'Targets', source: { type: 'm', expression: 'let Source = Csv.Document(File.Contents("C:\\targets.csv")) in Source' } }] },
      { name: 'Orders', partitions: [
        { name: 'Orders 2024', source: { type: 'm', expression: 'let Source = Sql.Database("db", "dw"), Orders = Source{[Schema="dbo",Item="orders_2024"]}[Data] in Orders' } },
        { name: 'Orders 2025', source: { type: 'm', expression: 'let Source = Sql.Database("db", "dw"), Orders = Source{[Schema="dbo",Item="orders_2025"]}[Data] in Orders' } },
      ] },
    ] } };
    writeFileSync(join(root, 'model.bim'), JSON.stringify(model));
    const assessment = assessMigrationFolder('model.bim', { cwd: root });
    expect(assessment.tablesWithoutSql).toBe(1);
    expect(assessment.databases.map((db) => [db.database, db.connects])).toEqual([['Csv.Document', 'check'], ['SQL Server', 'yes']]);
  });
});
