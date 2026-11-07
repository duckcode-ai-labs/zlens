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
    expect(describeDataFolderStatus(lake)).toBe('Reads 2 tables and 1 attached database from data/ · 2 not read');
    expect(describeDataFolderStatus({ folder: '.', tables: [{ name: 'orders', source: 'orders.csv', kind: 'CSV file' }], catalogs: [], skipped: [], problems: [] }))
      .toBe('Reads 1 table from the project folder');
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
