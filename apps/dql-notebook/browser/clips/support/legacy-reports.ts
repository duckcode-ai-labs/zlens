import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/**
 * A folder of reports a team brings to ZLens, on the Jaffle Shop sample's tables: a Tableau workbook with two
 * Custom SQL queries (one with a parameter), a Power BI template with two native queries (one built from a
 * parameter), a table load and DAX measures, and an old SQL script whose last step drops a table. Import SQL turns
 * the five queries into drafts and lists the rest under Left out.
 */
export function writeLegacyReports(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'revenue.twb'), WORKBOOK);
  writeFileSync(join(dir, 'Sales.pbit'), powerBiTemplate());
  writeFileSync(join(dir, 'nightly_report.sql'), NIGHTLY_SQL);
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#13;&#10;');

const REVENUE_BY_STORE = `SELECT l.location_name, SUM(o.order_total) AS revenue
FROM dev.orders o
JOIN dev.locations l ON l.location_id = o.location_id
WHERE o.ordered_at >= <[Parameters].[Parameter 1]>
GROUP BY 1
ORDER BY 2 DESC`;

const CUSTOMER_SPEND = `SELECT customer_type, COUNT(*) AS customers, AVG(lifetime_spend) AS avg_lifetime_spend
FROM dev.customers
GROUP BY 1`;

const WORKBOOK = `<?xml version='1.0' encoding='utf-8' ?>
<workbook source-build='2024.2.0' version='18.1'>
  <datasources>
    <datasource hasconnection='false' inline='true' name='Parameters' version='18.1'>
      <column caption='Start Date' datatype='date' name='[Parameter 1]' param-domain-type='any' role='measure' type='quantitative' value='#2025-01-01#'>
        <calculation class='tableau' formula='#2025-01-01#' />
      </column>
    </datasource>
    <datasource caption='Orders' inline='true' name='federated.orders' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='warehouse' name='postgres.warehouse'>
            <connection class='postgres' dbname='jaffle_shop' port='5432' server='warehouse.internal' />
          </named-connection>
        </named-connections>
        <relation connection='postgres.warehouse' name='Revenue by store (Custom SQL)' type='text'>${xml(REVENUE_BY_STORE)}</relation>
      </connection>
      <column caption='Revenue per Order' datatype='real' name='[Calculation_1]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='SUM([revenue]) / COUNT([location_name])' />
      </column>
    </datasource>
    <datasource caption='Customers' inline='true' name='federated.customers' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='warehouse' name='postgres.warehouse'>
            <connection class='postgres' dbname='jaffle_shop' port='5432' server='warehouse.internal' />
          </named-connection>
        </named-connections>
        <relation connection='postgres.warehouse' name='Customer spend (Custom SQL)' type='text'>${xml(CUSTOMER_SPEND)}</relation>
      </connection>
    </datasource>
    <datasource caption='Stores' inline='true' name='federated.stores' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='warehouse' name='postgres.warehouse'>
            <connection class='postgres' dbname='jaffle_shop' port='5432' server='warehouse.internal' />
          </named-connection>
        </named-connections>
        <relation connection='postgres.warehouse' name='locations' table='[dev].[locations]' type='table' />
      </connection>
    </datasource>
  </datasources>
  <worksheets>
    <worksheet name='Revenue by store'><table><view><datasources><datasource caption='Orders' name='federated.orders' /></datasources></view></table></worksheet>
    <worksheet name='Customer types'><table><view><datasources><datasource caption='Customers' name='federated.customers' /></datasources></view></table></worksheet>
  </worksheets>
</workbook>
`;

const mText = (text: string) => `"${text.replace(/"/g, '""').replace(/\n/g, '#(lf)')}"`;

const MODEL = {
  name: 'SemanticModel',
  compatibilityLevel: 1567,
  model: {
    expressions: [
      { name: 'StartDate', kind: 'm', expression: '#date(2025, 1, 1) meta [IsParameterQuery=true, Type="Date", IsParameterQueryRequired=true]' },
    ],
    tables: [
      {
        name: 'Store revenue by month',
        partitions: [{
          name: 'Store revenue by month',
          mode: 'import',
          source: {
            type: 'm',
            expression: [
              'let',
              '    Source = PostgreSQL.Database("warehouse.internal", "jaffle_shop"),',
              `    Query = Value.NativeQuery(Source, ${mText("select date_trunc('month', o.ordered_at) as order_month, l.location_name, sum(o.order_total) as revenue\nfrom dev.orders o\njoin dev.locations l on l.location_id = o.location_id\nwhere o.ordered_at >= '")} & Date.ToText(StartDate, "yyyy-MM-dd") & ${mText("'\ngroup by 1, 2\norder by 1, 2")}, null, [EnableFolding=true])`,
              'in',
              '    Query',
            ],
          },
        }],
        measures: [
          { name: 'Total Revenue', expression: "SUM('Store revenue by month'[revenue])" },
          { name: 'Revenue YoY %', expression: "DIVIDE([Total Revenue] - CALCULATE([Total Revenue], SAMEPERIODLASTYEAR('Date'[Date])), CALCULATE([Total Revenue], SAMEPERIODLASTYEAR('Date'[Date])))" },
        ],
      },
      {
        name: 'Items sold by product',
        partitions: [{
          name: 'Items sold by product',
          mode: 'import',
          source: {
            type: 'm',
            expression: `let\n    Source = PostgreSQL.Database("warehouse.internal", "jaffle_shop", [Query=${mText('select p.product_type, count(*) as items_sold\nfrom dev.order_items oi\njoin dev.products p on p.product_id = oi.product_id\ngroup by 1')}])\nin\n    Source`,
          },
        }],
      },
      {
        name: 'customers',
        partitions: [{
          name: 'customers',
          mode: 'import',
          source: { type: 'm', expression: 'let\n    Source = PostgreSQL.Database("warehouse.internal", "jaffle_shop"),\n    dev_customers = Source{[Schema="dev",Item="customers"]}[Data]\nin\n    dev_customers' },
        }],
      },
    ],
  },
};

const NIGHTLY_SQL = `-- Weekly orders
select date_trunc('week', ordered_at) as order_week, count(*) as orders
from dev.orders
group by 1
order by 1;

-- cleanup step from the old nightly job
drop table dev.order_snapshot;
`;

/** A Power BI template: a zip whose DataModelSchema is the model as UTF-16 JSON. */
function powerBiTemplate(): Buffer {
  const utf16 = (text: string) => Buffer.from(text, 'utf16le');
  return zip([
    { name: 'Version', data: utf16('1.28') },
    { name: 'DataModelSchema', data: utf16(JSON.stringify(MODEL)) },
    { name: 'Report/Layout', data: utf16('{"sections":[]}') },
  ]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = deflateRawSync(entry.data);
    const header = (size: number) => Buffer.alloc(size);
    const local = header(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = header(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    directory.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
