import { describe, expect, it } from 'vitest';
import { DBT_SOURCES_CATALOG, dbtExternalSource, dbtExternalSources, dbtPhysicalRelation, isDbtExternalRelationName } from './dbt-external-sources.js';

/** Source nodes as dbt-duckdb 1.10 writes them (dbt-core 1.12 manifest). */
const manifest = {
  metadata: { adapter_type: 'duckdb' },
  sources: {
    'source.shop_ext.shop.orders': {
      resource_type: 'source', source_name: 'shop', name: 'orders', identifier: 'orders', database: 'shop', schema: 'shop',
      relation_name: "'s3://lake/shop/orders.parquet'",
      meta: { external_location: 's3://lake/shop/{name}.parquet' },
    },
    'source.shop_ext.shop.customers': {
      resource_type: 'source', source_name: 'shop', name: 'customers', identifier: 'customers', database: 'shop', schema: 'shop',
      relation_name: "read_csv('s3://lake/shop/customers.csv', header = true)",
    },
    'source.shop_ext.local_files.customers': {
      resource_type: 'source', source_name: 'local_files', name: 'customers', identifier: 'customers', database: 'shop', schema: 'local_files',
      relation_name: "'../l1/customers.csv'",
      config: { external_location: '../l1/{name}.csv' },
    },
    'source.shop_ext.plain.regions': {
      resource_type: 'source', source_name: 'plain', name: 'regions', identifier: 'regions', database: 'shop', schema: 'main',
      relation_name: '"shop"."main"."regions"',
    },
    'source.shop_ext.lake.events': {
      resource_type: 'source', source_name: 'Lake Raw', name: 'Events-2025', database: 'shop', schema: 'lake',
      relation_name: "delta_scan('s3://lake/events')",
    },
    'source.shop_ext.lake.many': {
      resource_type: 'source', source_name: 'lake', name: 'many', database: 'shop', schema: 'lake',
      relation_name: "read_parquet(['s3://a/1.parquet', 's3://a/2.parquet'])",
    },
  },
};

describe('dbt-duckdb external sources', () => {
  it('reads each location dbt wrote: a quoted path, or a reader call (its options are not carried)', () => {
    expect(dbtExternalSources(manifest)).toEqual([
      { uniqueId: 'source.shop_ext.lake.events', source: 'lake_raw', table: 'events_2025', relation: 'dbt_sources.lake_raw.events_2025', path: 's3://lake/events', format: 'delta' },
      { uniqueId: 'source.shop_ext.local_files.customers', source: 'local_files', table: 'customers', relation: 'dbt_sources.local_files.customers', path: '../l1/customers.csv', format: 'auto' },
      { uniqueId: 'source.shop_ext.shop.customers', source: 'shop', table: 'customers', relation: 'dbt_sources.shop.customers', path: 's3://lake/shop/customers.csv', format: 'csv', options: 'header = true' },
      { uniqueId: 'source.shop_ext.shop.orders', source: 'shop', table: 'orders', relation: 'dbt_sources.shop.orders', path: 's3://lake/shop/orders.parquet', format: 'auto' },
    ]);
  });

  it('a table in the database, or a location it cannot read (a list of paths), is not an external source', () => {
    expect(dbtExternalSource('source.shop_ext.plain.regions', manifest.sources['source.shop_ext.plain.regions'])).toBeUndefined();
    expect(dbtExternalSource('source.shop_ext.lake.many', manifest.sources['source.shop_ext.lake.many'])).toBeUndefined();
    expect(dbtExternalSource('model.x.y', { resource_type: 'model', relation_name: "'s3://x/y.parquet'" })).toBeUndefined();
  });

  it('an external_location without a relation_name (an older manifest) fills in its fields', () => {
    expect(dbtExternalSource('source.p.raw.orders', {
      resource_type: 'source', source_name: 'raw', name: 'orders', schema: 'raw',
      source_meta: { external_location: "read_parquet('s3://lake/{schema}/{name}.parquet')" },
    })).toEqual({ uniqueId: 'source.p.raw.orders', source: 'raw', table: 'orders', relation: 'dbt_sources.raw.orders', path: 's3://lake/raw/orders.parquet', format: 'parquet' });
    expect(dbtExternalSource('source.p.raw.o', { source_name: 'raw', name: "it's", config: { external_location: "/data/{name}.csv" } })?.path).toBe("/data/it's.csv");
  });

  it('the physical relation: the ZLens table of an external source, nothing for an unreadable location, else dbt\'s own name', () => {
    expect(dbtPhysicalRelation('source.shop_ext.shop.orders', manifest.sources['source.shop_ext.shop.orders'])).toMatchObject({
      relation: 'dbt_sources.shop.orders', database: DBT_SOURCES_CATALOG, schema: 'shop',
    });
    expect(dbtPhysicalRelation('source.shop_ext.lake.many', manifest.sources['source.shop_ext.lake.many'])).toEqual({});
    expect(dbtPhysicalRelation('source.shop_ext.plain.regions', manifest.sources['source.shop_ext.plain.regions']))
      .toEqual({ relation: '"shop"."main"."regions"', database: 'shop', schema: 'main' });
    expect(isDbtExternalRelationName("'s3://x.parquet'")).toBe(true);
    expect(isDbtExternalRelationName('read_csv(\'a.csv\')')).toBe(true);
    expect(isDbtExternalRelationName('"db"."main"."orders"')).toBe(false);
    expect(isDbtExternalRelationName('db.main.orders')).toBe(false);
  });
});
