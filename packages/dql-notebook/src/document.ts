import { canonicalizeNotebook } from "@zlens/core/format";
import { normalizeProductDomainContext, type ProductDomainContext } from "@zlens/core";

export type NotebookCellType =
  | "markdown"
  | "sql"
  | "dql"
  | "param"
  | "chart"
  | "pivot"
  | "single_value"
  | "filter"
  | "table"
  | "map"
  | "writeback"
  | "python"
  | "chat";

export interface NotebookMetadata extends ProductDomainContext {
  title: string;
  description?: string;
  createdWith: 'dql';
  template?: string;
}

export interface NotebookChartConfig {
  sourceCellId?: string;
  chart?: string;
  x?: string;
  y?: string;
  y2?: string;
  color?: string;
  title?: string;
}

export interface NotebookCell {
  id: string;
  type: NotebookCellType;
  title?: string;
  source: string;
  config?: NotebookChartConfig;
  executionTarget?: { target: "connection" | "local"; connectionName?: string };
  datasetRefs?: Array<{
    id: string;
    alias?: string;
    role?: "source" | "staged" | "output";
    fingerprint?: string;
  }>;
  dependencies?: Array<{ cellId: string; output?: string }>;
  annotations?: Array<{
    id: string;
    body: string;
    createdAt: string;
    updatedAt?: string;
    author?: string;
  }>;
  mixedSourcePlan?: {
    datasetId?: string;
    datasetName?: string;
    localDataset: string;
    localAlias: string;
    localKey: string;
    warehouseKey: string;
    warehouseExpression: string;
    warehouseSql: string;
    warehouseRelations?: string[];
  };
  dqlArtifact?: Record<string, unknown>;
  chatConfig?: Record<string, unknown>;
  kernel?: Record<string, unknown>;
  /** Future cell metadata is intentionally retained by the document reader. */
  [key: string]: unknown;
}

export interface NotebookDocument {
  dqlnbVersion: 2;
  version: 1;
  metadata: NotebookMetadata;
  cells: NotebookCell[];
}

export function createNotebookDocument(
  title: string,
  cells: NotebookCell[],
  metadata: Partial<NotebookMetadata> = {},
): NotebookDocument {
  return {
    dqlnbVersion: 2,
    version: 1,
    metadata: {
      title,
      createdWith: 'dql',
      ...metadata,
      ...normalizeProductDomainContext(metadata),
    },
    cells,
  };
}

export function serializeNotebook(document: NotebookDocument): string {
  const { title, ...metadata } = document.metadata;
  return canonicalizeNotebook(
    JSON.stringify({
      dqlnbVersion: 2,
      version: 1,
      title,
      metadata,
      cells: document.cells.map((cell) => {
        const { source, title: cellTitle, config, ...rest } = cell;
        return {
          ...rest,
          ...(cellTitle ? { name: cellTitle } : {}),
          content: source,
          ...(config ? { chartConfig: config } : {}),
        };
      }),
    }),
  );
}

export function deserializeNotebook(raw: string): NotebookDocument {
  const parsed = JSON.parse(raw) as Partial<NotebookDocument>;
  const parsedRecord = parsed as Partial<NotebookDocument> & { title?: string };
  const documentTitle = parsed.metadata?.title ?? parsedRecord.title;
  if (parsed.version !== 1 || !documentTitle || !Array.isArray(parsed.cells)) {
    throw new Error("Invalid .dqlnb document.");
  }

  return {
    dqlnbVersion: 2,
    version: 1,
    metadata: {
      title: documentTitle,
      description: parsed.metadata?.description,
      createdWith: "dql",
      template: parsed.metadata?.template,
      ...normalizeProductDomainContext(parsed.metadata ?? {}, parsed.metadata?.ownerDomain),
    },
    cells: parsed.cells.map((cell, index) => {
      const raw = cell as NotebookCell & {
        content?: string;
        name?: string;
        chartConfig?: NotebookChartConfig;
      };
      return {
        ...cell,
        id: cell.id ?? `cell-${index + 1}`,
        type: cell.type ?? "markdown",
        title: cell.title ?? raw.name,
        source: cell.source ?? raw.content ?? "",
        config: cell.config ?? raw.chartConfig,
      };
    }),
  };
}

function listTablesSQL(driver?: string): string {
  if (!driver) {
    return `SELECT 1 AS ready;`;
  }

  switch (driver.toLowerCase()) {
    case 'duckdb':
    case 'sqlite':
    case 'file':
      return `SHOW TABLES;`;
    case 'postgresql':
    case 'redshift':
      return `SELECT table_schema, table_name FROM information_schema.tables\nWHERE table_schema NOT IN ('information_schema', 'pg_catalog')\nORDER BY table_schema, table_name LIMIT 20;`;
    case 'mysql':
      return `SELECT table_schema, table_name FROM information_schema.tables\nWHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')\nORDER BY table_schema, table_name LIMIT 20;`;
    case 'snowflake':
    case 'mssql':
    case 'databricks':
    case 'trino':
    case 'fabric':
      return `SELECT table_schema, table_name FROM information_schema.tables\nWHERE table_schema NOT IN ('INFORMATION_SCHEMA')\nORDER BY table_schema, table_name LIMIT 20;`;
    default:
      return `SELECT table_schema, table_name FROM information_schema.tables\nLIMIT 20;`;
  }
}

/**
 * How a saved query looks, as text: the welcome notebook no longer carries a
 * runnable placeholder block ("Example Customer Rollup", `SELECT 1`), which
 * showed up in every new App's Data step as data to add (design D7).
 */
const SAVE_A_QUERY_MARKDOWN = [
  '## Save a query',
  '',
  'When a query answers a question people ask again, choose **Save as saved query** on its cell. ZLens saves it as a saved query (a `.dql` block file) in `domains/`, and it appears in Apps under **Data** once it is certified:',
  '',
  '```dql',
  'block "Revenue by month" {',
  '  domain = "sales"',
  '  owner = "you@example.com"',
  '  query = """',
  '    SELECT date_trunc(\'month\', ordered_at) AS month, SUM(order_total) AS revenue',
  '    FROM orders',
  '    GROUP BY 1',
  '  """',
  '}',
  '```',
].join('\n');

export function createWelcomeNotebook(template: string, projectTitle: string, driver?: string): NotebookDocument {
  const normalized = template.toLowerCase();
  const showTablesQuery = listTablesSQL(driver);

  if (normalized === 'dbt') {
    return createNotebookDocument(`${projectTitle} - ZLens Workbench`, [
      {
        id: 'intro',
        type: 'markdown',
        title: 'Welcome',
        source: `# ${projectTitle}\n\nZLens is governed analytics written in DQL (**Domain Query Language**), its query language. DQL is the domain layer that turns dbt models, SQL, metrics, notebooks, dashboards, apps, and business definitions into one trusted analytics project.\n\n**Core path:** source data -> dbt model -> DQL block -> business_view -> dashboard/app/AI answer.\n\nThis notebook is your workbench. Explore the dbt-backed database below, then promote useful queries into blocks and business views so the compiler can write \`dql-manifest.json\` with both technical lineage and business lineage.`,
      },
      {
        id: 'sql-tables',
        type: 'sql',
        title: 'Available Tables',
        source: `-- List tables in your database\n${showTablesQuery}`,
      },
      {
        id: 'sql-explore',
        type: 'sql',
        title: 'Explore Your Data',
        source: `-- Replace 'your_table' with a table name from the results above\n-- SELECT * FROM your_table LIMIT 20;`,
      },
      {
        id: 'save-a-query',
        type: 'markdown',
        title: 'Save a query',
        source: SAVE_A_QUERY_MARKDOWN,
      },
      {
        id: 'next-steps',
        type: 'markdown',
        title: 'Next Steps',
        source: `## Next steps\n\n1. Query a dbt model and save the useful logic as a saved query.\n2. Add business terms under \`terms/\` for the vocabulary stakeholders use.\n3. Compose saved queries into \`business_view\` files under \`business-views/\`.\n4. Run \`zlens compile .\` to refresh \`dql-manifest.json\`.\n5. Open Lineage to trace source -> model -> saved query -> business view -> consumption.`,
      },
    ], { description: 'ZLens workbench for turning a dbt project into business lineage.', template: 'dbt' });
  }

  // Default notebook for non-dbt projects
  return createNotebookDocument(`${projectTitle} - ZLens Workbench`, [
    {
      id: 'intro',
      type: 'markdown',
      title: 'Welcome',
      source: `# ${projectTitle}\n\nZLens is governed analytics written in DQL (**Domain Query Language**), its query language. Together they turn SQL, business terms, notebooks, dashboards, apps, and lineage into one trusted analytics project.\n\n**Core path:** source data -> DQL block -> business_view -> dashboard/app/AI answer.\n\nThis notebook is your workbench. Start with a table or local file, promote useful SQL into a block, then compose blocks into business views so the compiler can write \`dql-manifest.json\` with both technical lineage and business lineage.`,
    },
    {
      id: 'sql-tables',
      type: 'sql',
      title: 'Available Tables',
      source: `-- List tables in your database\n${showTablesQuery}`,
    },
    {
      id: 'sql-starter',
      type: 'sql',
      title: 'Starter Query',
      source: `-- Write your SQL here after connecting a warehouse or local DuckDB/file source\n-- Example: SELECT * FROM analytics.customers LIMIT 10;`,
    },
    {
      id: 'save-a-query',
      type: 'markdown',
      title: 'Save a query',
      source: SAVE_A_QUERY_MARKDOWN,
    },
    {
      id: 'next-steps',
      type: 'markdown',
      title: 'Next Steps',
      source: `## Next steps\n\n1. Add data by connecting a warehouse or adding a local DuckDB/file source.\n2. Save repeated SQL as saved queries (\`.dql\` block files) under \`blocks/\`.\n3. Add business terms under \`terms/\` for shared vocabulary.\n4. Compose saved queries into \`business_view\` files under \`business-views/\`.\n5. Run \`zlens compile .\` and open Lineage to inspect the business and technical path.`,
    },
  ], { description: 'DQL workbench for building a domain-first analytics project.', template: 'default' });
}
