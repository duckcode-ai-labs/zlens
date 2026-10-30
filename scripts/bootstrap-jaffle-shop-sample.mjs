import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../packages/dql-connectors/package.json', import.meta.url));
const { DuckDBInstance } = require('@duckdb/node-api');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const projectRoot = resolve(repoRoot, 'jaffle-shop');
const databasePath = join(projectRoot, 'jaffle_shop.duckdb');

const bootstrapSql = `
PRAGMA disable_progress_bar;

CREATE SCHEMA IF NOT EXISTS new_jaffle_shop;
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE OR REPLACE TABLE new_jaffle_shop.customers AS
SELECT *
FROM (
  VALUES
    (1, 'Alice Johnson'),
    (2, 'Brian Smith'),
    (3, 'Carla Gomez'),
    (4, 'Deepak Patel'),
    (5, 'Emma Davis'),
    (6, 'Farah Khan')
) AS customers(id, name);

CREATE OR REPLACE TABLE new_jaffle_shop.products AS
SELECT *
FROM (
  VALUES
    ('JF001', 'Classic Jaffle', 'jaffle', 'Ham and cheese jaffle', 1200),
    ('JF002', 'Veggie Jaffle', 'jaffle', 'Tomato, cheese, and basil jaffle', 1100),
    ('DR001', 'Cold Brew', 'beverage', 'Iced coffee', 450),
    ('DR002', 'Chai Latte', 'beverage', 'Spiced tea latte', 550),
    ('JF003', 'Breakfast Jaffle', 'jaffle', 'Egg and cheddar jaffle', 1350)
) AS products(sku, name, type, description, price);

CREATE OR REPLACE TABLE new_jaffle_shop.supplies AS
SELECT *
FROM (
  VALUES
    (1, 'JF001', 'Bread', 180, true),
    (2, 'JF001', 'Ham', 220, true),
    (3, 'JF001', 'Cheese', 140, true),
    (4, 'JF002', 'Bread', 180, true),
    (5, 'JF002', 'Tomato', 90, true),
    (6, 'JF002', 'Cheese', 140, true),
    (7, 'DR001', 'Coffee Beans', 110, false),
    (8, 'DR001', 'Milk', 60, true),
    (9, 'DR002', 'Tea', 70, false),
    (10, 'DR002', 'Milk', 60, true),
    (11, 'JF003', 'Bread', 180, true),
    (12, 'JF003', 'Egg', 150, true),
    (13, 'JF003', 'Cheese', 140, true)
) AS supplies(id, sku, name, cost, perishable);

CREATE OR REPLACE TABLE new_jaffle_shop.orders AS
SELECT *
FROM (
  VALUES
    (1001, 1, 1, 1650, 150, TIMESTAMP '2024-01-05 08:30:00'),
    (1002, 2, 2, 2300, 200, TIMESTAMP '2024-01-07 12:10:00'),
    (1003, 1, 1, 1200, 100, TIMESTAMP '2024-02-02 09:00:00'),
    (1004, 3, 3, 1900, 170, TIMESTAMP '2024-02-19 13:45:00'),
    (1005, 2, 4, 2550, 230, TIMESTAMP '2024-03-03 10:25:00'),
    (1006, 4, 5, 1350, 120, TIMESTAMP '2024-03-15 15:05:00'),
    (1007, 1, 2, 1750, 150, TIMESTAMP '2024-04-08 11:20:00'),
    (1008, 3, 6, 1800, 160, TIMESTAMP '2024-04-20 16:40:00'),
    (1009, 4, 1, 2450, 220, TIMESTAMP '2024-05-01 08:55:00'),
    (1010, 2, 3, 1550, 140, TIMESTAMP '2024-05-18 14:15:00'),
    (1011, 1, 4, 2100, 190, TIMESTAMP '2024-06-09 09:35:00'),
    (1012, 3, 5, 1650, 150, TIMESTAMP '2024-06-23 17:10:00')
) AS orders(id, store_id, customer, order_total, tax_paid, ordered_at);

CREATE OR REPLACE TABLE new_jaffle_shop.items AS
SELECT *
FROM (
  VALUES
    (1, 1001, 'JF001'),
    (2, 1001, 'DR001'),
    (3, 1002, 'JF002'),
    (4, 1002, 'DR002'),
    (5, 1002, 'DR001'),
    (6, 1003, 'JF001'),
    (7, 1004, 'JF003'),
    (8, 1004, 'DR002'),
    (9, 1005, 'JF001'),
    (10, 1005, 'JF002'),
    (11, 1005, 'DR001'),
    (12, 1006, 'JF003'),
    (13, 1007, 'JF002'),
    (14, 1007, 'DR002'),
    (15, 1008, 'JF001'),
    (16, 1008, 'DR001'),
    (17, 1009, 'JF003'),
    (18, 1009, 'DR002'),
    (19, 1009, 'DR001'),
    (20, 1010, 'JF002'),
    (21, 1010, 'DR001'),
    (22, 1011, 'JF001'),
    (23, 1011, 'JF003'),
    (24, 1012, 'JF002'),
    (25, 1012, 'DR002')
) AS items(id, order_id, sku);

CREATE OR REPLACE TABLE stg_customers AS
SELECT
  id AS customer_id,
  name
FROM new_jaffle_shop.customers;

CREATE OR REPLACE TABLE stg_orders AS
SELECT
  id AS order_id,
  store_id AS location_id,
  customer AS customer_id,
  CASE store_id
    WHEN 1 THEN 'Chicago'
    WHEN 2 THEN 'Austin'
    WHEN 3 THEN 'Seattle'
    WHEN 4 THEN 'Denver'
    ELSE 'Unknown'
  END AS location_name,
  order_total / 100.0 AS order_total,
  tax_paid / 100.0 AS tax_paid,
  ordered_at
FROM new_jaffle_shop.orders;

CREATE OR REPLACE TABLE stg_order_items AS
SELECT
  id AS order_item_id,
  order_id,
  sku AS product_id
FROM new_jaffle_shop.items;

CREATE OR REPLACE TABLE stg_products AS
SELECT
  sku AS product_id,
  name AS product_name,
  type AS product_type,
  description AS product_description,
  price / 100.0 AS product_price,
  CASE WHEN type = 'jaffle' THEN 1 ELSE 0 END AS is_food_item,
  CASE WHEN type = 'beverage' THEN 1 ELSE 0 END AS is_drink_item
FROM new_jaffle_shop.products;

CREATE OR REPLACE TABLE stg_supplies AS
SELECT
  md5(CAST(id AS VARCHAR) || '|' || sku) AS supply_uuid,
  id AS supply_id,
  sku AS product_id,
  name AS supply_name,
  cost / 100.0 AS supply_cost,
  perishable AS is_perishable_supply
FROM new_jaffle_shop.supplies;

CREATE OR REPLACE TABLE order_items AS
WITH order_supplies_summary AS (
  SELECT
    product_id,
    SUM(supply_cost) AS supply_cost
  FROM stg_supplies
  GROUP BY 1
)
SELECT
  order_items.order_item_id,
  order_items.order_id,
  order_items.product_id,
  products.product_name,
  products.product_type,
  products.product_description,
  products.product_price,
  order_supplies_summary.supply_cost,
  products.is_food_item,
  products.is_drink_item,
  orders.ordered_at
FROM stg_order_items AS order_items
LEFT JOIN stg_orders AS orders ON order_items.order_id = orders.order_id
LEFT JOIN stg_products AS products ON order_items.product_id = products.product_id
LEFT JOIN order_supplies_summary ON order_items.product_id = order_supplies_summary.product_id;

CREATE OR REPLACE TABLE fct_orders AS
WITH order_items_summary AS (
  SELECT
    order_id,
    SUM(COALESCE(supply_cost, 0)) AS order_cost,
    SUM(COALESCE(is_food_item, 0)) AS count_food_items,
    SUM(COALESCE(is_drink_item, 0)) AS count_drink_items,
    SUM(CASE WHEN COALESCE(is_food_item, 0) = 1 THEN COALESCE(product_price, 0) ELSE 0 END) AS subtotal_food_items,
    SUM(CASE WHEN COALESCE(is_drink_item, 0) = 1 THEN COALESCE(product_price, 0) ELSE 0 END) AS subtotal_drink_items,
    SUM(COALESCE(product_price, 0)) AS subtotal
  FROM order_items
  GROUP BY 1
),
customer_first_order AS (
  SELECT
    customer_id,
    MIN(ordered_at) AS first_ordered_at
  FROM stg_orders
  GROUP BY 1
)
SELECT
  orders.order_id,
  orders.customer_id,
  orders.location_id,
  orders.location_name,
  orders.order_total,
  orders.tax_paid,
  orders.ordered_at,
  COALESCE(summary.count_food_items, 0) AS count_food_items,
  COALESCE(summary.count_drink_items, 0) AS count_drink_items,
  COALESCE(summary.count_food_items, 0) + COALESCE(summary.count_drink_items, 0) AS count_items,
  COALESCE(summary.subtotal_food_items, 0) AS subtotal_food_items,
  COALESCE(summary.subtotal_drink_items, 0) AS subtotal_drink_items,
  COALESCE(summary.subtotal, 0) AS subtotal,
  COALESCE(summary.order_cost, 0) AS order_cost,
  COALESCE(summary.count_food_items, 0) > 0 AS is_food_order,
  COALESCE(summary.count_drink_items, 0) > 0 AS is_drink_order,
  orders.ordered_at = first_order.first_ordered_at AS is_first_order
FROM stg_orders AS orders
LEFT JOIN order_items_summary AS summary ON orders.order_id = summary.order_id
LEFT JOIN customer_first_order AS first_order ON orders.customer_id = first_order.customer_id;

CREATE OR REPLACE TABLE dim_customers AS
WITH order_summary AS (
  SELECT
    orders.customer_id,
    COUNT(DISTINCT orders.order_id) AS count_lifetime_orders,
    COUNT(DISTINCT orders.order_id) > 1 AS is_repeat_buyer,
    MIN(orders.ordered_at) AS first_ordered_at,
    MAX(orders.ordered_at) AS last_ordered_at,
    SUM(COALESCE(order_items.product_price, 0)) AS lifetime_spend_pretax,
    SUM(COALESCE(orders.order_total, 0)) AS lifetime_spend
  FROM fct_orders AS orders
  LEFT JOIN order_items ON orders.order_id = order_items.order_id
  GROUP BY 1
)
SELECT
  customers.customer_id,
  customers.name AS customer_name,
  order_summary.count_lifetime_orders,
  order_summary.first_ordered_at,
  order_summary.last_ordered_at,
  order_summary.lifetime_spend_pretax,
  order_summary.lifetime_spend,
  CASE
    WHEN order_summary.is_repeat_buyer THEN 'returning'
    ELSE 'new'
  END AS customer_type
FROM stg_customers AS customers
LEFT JOIN order_summary ON customers.customer_id = order_summary.customer_id;

CREATE OR REPLACE VIEW analytics.orders AS
SELECT * FROM fct_orders;

CREATE OR REPLACE VIEW analytics.customers AS
SELECT * FROM dim_customers;
`;

async function main() {
  if (existsSync(databasePath)) {
    rmSync(databasePath, { force: true });
  }

  const db = await DuckDBInstance.create(databasePath);
  const connection = await db.connect();
  try {
    await connection.run(bootstrapSql);
    console.log(`Created sample DuckDB database at ${databasePath}`);
  } finally {
    connection.closeSync();
    db.closeSync();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
