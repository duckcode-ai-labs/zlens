#!/usr/bin/env node
/**
 * Seed a warehouse with the deterministic execution-match eval dataset (W1.2).
 *
 * The dataset lives at apps/cli/test/fixtures/jaffle-supply-chain/seeds/seed.json
 * and is dialect-neutral. This script materializes it so that
 * `zlens agent eval --execute` (and its --min-execution-match gate) can run against
 * a real warehouse. DuckDB is the free offline/CI target; `--print` emits portable
 * ANSI SQL you can pipe into any engine (Snowflake, BigQuery, Postgres, …), which
 * is how the credentialed multi-engine matrix seeds itself.
 *
 * Usage:
 *   node scripts/seed-eval-warehouse.mjs                 # → jaffle.duckdb (duckdb)
 *   node scripts/seed-eval-warehouse.mjs --out /tmp/j.duckdb
 *   node scripts/seed-eval-warehouse.mjs --connector-root /tmp/dql-connectors --out /tmp/j.duckdb
 *   node scripts/seed-eval-warehouse.mjs --out /tmp/jaffle_shop.duckdb --schema dev
 *   node scripts/seed-eval-warehouse.mjs --print [--dialect ansi|duckdb|postgres|snowflake]
 *   node scripts/seed-eval-warehouse.mjs --seed <path/to/seed.json>
 */
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { print: false, dialect: null, out: null, seed: null, schema: null, connectorRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print' || a === '--dry-run') args.print = true;
    else if (a === '--dialect') args.dialect = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--seed') args.seed = argv[++i];
    else if (a === '--schema') args.schema = argv[++i];
    else if (a === '--connector-root') args.connectorRoot = argv[++i];
  }
  return args;
}

// Dialect-specific column types. Keep in one place so a new engine is one row.
const TYPE_MAP = {
  duckdb: { text: 'VARCHAR', int: 'INTEGER', decimal: 'DOUBLE', bool: 'BOOLEAN', timestamp: 'TIMESTAMP' },
  postgres: { text: 'text', int: 'integer', decimal: 'numeric', bool: 'boolean', timestamp: 'timestamp' },
  snowflake: { text: 'STRING', int: 'INTEGER', decimal: 'FLOAT', bool: 'BOOLEAN', timestamp: 'TIMESTAMP' },
  ansi: { text: 'VARCHAR(255)', int: 'INTEGER', decimal: 'DECIMAL(18,2)', bool: 'BOOLEAN', timestamp: 'TIMESTAMP' },
};

function sqlType(dialect, token) {
  const map = TYPE_MAP[dialect] ?? TYPE_MAP.ansi;
  return map[token] ?? map.text;
}

function literal(value, dialect) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') {
    // Engines with a real BOOLEAN take TRUE/FALSE; ansi keeps TRUE/FALSE too.
    return value ? 'TRUE' : 'FALSE';
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function buildStatements(seed, dialect, schema = null) {
  const statements = [];
  if (schema) statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
  const createdSchemas = new Set(schema ? [schema] : []);
  for (const [table, def] of Object.entries(seed.tables)) {
    // A seed may name its tables schema-qualified (`dev.orders`, as the
    // jaffle-golden seed does); that schema wins over --schema.
    const dot = table.lastIndexOf('.');
    const tableSchema = dot > 0 ? table.slice(0, dot) : schema;
    const tableName = dot > 0 ? table.slice(dot + 1) : table;
    if (tableSchema && !createdSchemas.has(tableSchema)) {
      statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(tableSchema)}`);
      createdSchemas.add(tableSchema);
    }
    const relation = tableSchema ? `${quoteIdentifier(tableSchema)}.${quoteIdentifier(tableName)}` : quoteIdentifier(tableName);
    const cols = def.columns.map((c) => `${quoteIdentifier(c.name)} ${sqlType(dialect, c.type)}`).join(', ');
    statements.push(`DROP TABLE IF EXISTS ${relation}`);
    statements.push(`CREATE TABLE ${relation} (${cols})`);
    const colNames = def.columns.map((c) => quoteIdentifier(c.name)).join(', ');
    for (const row of def.rows) {
      const vals = def.columns.map((c) => literal(row[c.name], dialect)).join(', ');
      statements.push(`INSERT INTO ${relation} (${colNames}) VALUES (${vals})`);
    }
  }
  return statements;
}

async function seedDuckDb(statements, outPath, connectorRoot) {
  // A supplied root is intentionally authoritative: CI installs DuckDB into a
  // disposable non-workspace directory so npm never has to interpret this
  // repository's `workspace:*` dependencies. Do not fall back to an ambient
  // module when the explicit root is wrong.
  const resolvedConnectorRoot = connectorRoot ? resolve(connectorRoot) : null;
  const req = resolvedConnectorRoot
    ? createRequire(join(realpathSync(resolvedConnectorRoot), 'package.json'))
    : createRequire(new URL('../packages/dql-connectors/package.json', import.meta.url));
  let duckdb;
  try {
    if (resolvedConnectorRoot) {
      const connectorRootReal = realpathSync(resolvedConnectorRoot);
      const packageRootReal = realpathSync(join(connectorRootReal, 'node_modules', '@duckdb', 'node-api'));
      const entryReal = realpathSync(req.resolve('@duckdb/node-api'));
      const packageRelativePath = relative(packageRootReal, entryReal);
      const entryIsInsidePackage = packageRelativePath !== ''
        && packageRelativePath !== '..'
        && !packageRelativePath.startsWith(`..${sep}`)
        && !isAbsolute(packageRelativePath);
      if (!entryIsInsidePackage) {
        throw new Error('Resolved DuckDB entry escapes the explicit connector root.');
      }
      duckdb = req(entryReal);
    } else {
      duckdb = req('@duckdb/node-api');
    }
  } catch {
    const install = resolvedConnectorRoot
      ? `npm --prefix ${resolvedConnectorRoot} install --no-save --no-package-lock '@duckdb/node-api@^1.5.6-r.1'`
      : "pnpm add '@duckdb/node-api@^1.5.6-r.1'";
    console.error(`The DuckDB driver (@duckdb/node-api) is not installed. Install it (${install}) or use --print to emit SQL.`);
    process.exit(1);
  }
  const db = await duckdb.DuckDBInstance.create(outPath);
  const connection = await db.connect();
  try {
    for (const sql of statements) await connection.run(sql);
  } finally {
    connection.closeSync();
    db.closeSync();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seedPath = args.seed
    ? resolve(args.seed)
    : join(repoRoot, 'apps/cli/test/fixtures/jaffle-supply-chain/seeds/seed.json');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  if (args.print) {
    const dialect = args.dialect ?? 'ansi';
    console.log(buildStatements(seed, dialect).map((s) => `${s};`).join('\n'));
    return;
  }

  const dialect = args.dialect ?? 'duckdb';
  const statements = buildStatements(seed, dialect, args.schema);
  const outPath = args.out ?? join(repoRoot, 'jaffle.duckdb');
  await seedDuckDb(statements, outPath, args.connectorRoot);
  console.log(`Seeded ${Object.keys(seed.tables).length} tables into ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
