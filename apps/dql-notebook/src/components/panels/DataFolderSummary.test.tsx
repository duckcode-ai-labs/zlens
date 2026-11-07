import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { themes } from '../../themes/notebook-theme';
import { DataFolderSummary, describeDataFolderStatus, type DataFolderStatusView } from './DataFolderSummary';

const lake: DataFolderStatusView = {
  folder: 'data',
  tables: [
    { name: 'customers_delta', source: 'customers_delta/', kind: 'Delta Lake table' },
    { name: 'orders_iceberg', source: 'orders_iceberg/', kind: 'Iceberg table (version 3)' },
  ],
  catalogs: [{ name: 'lake', source: 'lake.ducklake', kind: 'DuckLake catalog, attached as lake' }],
  skipped: [{ name: 'clicks.avro', kind: 'an Avro file (not read yet)' }],
  problems: [{ source: 'drift/', name: 'drift', reason: 'its files have different columns: a.csv has id, b.csv has id, name' }],
};

describe('the data folder under a connection', () => {
  it('says in one line what it reads and how much it does not', () => {
    expect(describeDataFolderStatus(lake)).toBe('Reads 2 tables from data/ and 1 catalog · 2 not read');
    // A connection of catalogs only: its catalogs are what it reads.
    expect(describeDataFolderStatus({
      folder: '', tables: [], skipped: [],
      catalogs: [
        { name: 'lake', source: 'http://127.0.0.1:8181/catalog (warehouse lab; no sign-in; files read with this connection\'s storage)', kind: 'Iceberg REST catalog, attached as lake' },
        { name: 'unity', source: 'http://127.0.0.1:8080 (catalog main; no sign-in)', kind: 'Unity Catalog, attached as unity' },
      ],
      problems: [{ source: 'AWS Glue, account 1 (us-east-1)', name: 'glue', reason: 'the AWS Glue catalog refused the sign-in' }],
    })).toBe('Reads 2 catalogs · 1 not read');
    expect(describeDataFolderStatus({ folder: '.', tables: [{ name: 'orders', source: 'orders.csv', kind: 'CSV file' }], catalogs: [], skipped: [], problems: [] }))
      .toBe('Reads 1 table from the project folder');
    expect(describeDataFolderStatus({ folder: 's3://acme/sales/', tables: [], catalogs: [], skipped: [], problems: [{ source: 's3://acme/sales/', name: '', reason: 'HTTP 403' }] }))
      .toBe('Reads 0 tables from s3://acme/sales/ · 1 not read');
  });

  it('names a catalog that could not be read by its name, its long description on hover', () => {
    const source = 'http://127.0.0.1:8199/catalog (warehouse lab; no sign-in; files read with the credentials the catalog hands out)';
    const html = renderToStaticMarkup(<DataFolderSummary status={{ folder: '', tables: [], skipped: [], catalogs: [], problems: [{ source, name: 'offline', reason: 'the Iceberg REST catalog cannot be reached: check its address' }] }} t={themes.light} />);
    expect(html).toContain('>offline</span>');
    expect(html).toContain(`title="${source}"`);
    expect(html).toContain('max-width:40%');
    expect(html).toContain('the Iceberg REST catalog cannot be reached');
  });

  it('always shows what could not be read, with the reason; the tables open on demand', () => {
    const html = renderToStaticMarkup(<DataFolderSummary status={lake} t={themes.light} />);
    expect(html).toContain('Could not read');
    expect(html).toContain('drift/');
    expect(html).toContain('its files have different columns');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('customers_delta/');
  });
});
