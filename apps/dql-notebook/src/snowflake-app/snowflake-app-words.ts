/**
 * V14: words that still read like the laptop install or a dbt project (file paths, "local SQLite",
 * "dbt truth", "Local path"), said for the ZLens app for Snowflake. Every helper returns the
 * open-source wording unchanged when `snowflakeApp` is false.
 */

/** Settings » Agent memory: what the context people add never overrides. */
export function agentMemoryDetail(snowflakeApp: boolean): string {
  return snowflakeApp
    ? 'Durable business context you add explicitly, plus a separate governed correction queue. Advisory context never overrides certified metadata, the definitions of your Snowflake tables, or routing.'
    : 'Durable business context you add explicitly, plus a separate governed correction queue. Advisory context never overrides current certified metadata, dbt truth, or routing.';
}

/** Settings » Database: where the index of the tables ZLens reads is kept. */
export function metadataIndexDetail(snowflakeApp: boolean): string {
  return snowflakeApp
    ? 'ZLens keeps an index of these tables and columns on its own volume in your Snowflake account. Ask, Notebooks and Saved queries search that index instead of scanning the warehouse.'
    : 'ZLens synchronizes this authorized scope into local SQLite. Warm Ask, Notebook, and Saved queries searches use that index instead of scanning the warehouse.';
}

/** Settings » Database, while the index is rebuilt. */
export function metadataSyncingMessage(snowflakeApp: boolean): string {
  return snowflakeApp ? 'Reading the selected schemas…' : 'Synchronizing selected metadata into local SQLite…';
}

/** The line under Notebook AI's question box: what it reads. */
export function notebookAiScopeHint(cell: boolean, snowflakeApp: boolean): string {
  const scope = cell ? 'This cell' : 'Whole notebook';
  return snowflakeApp
    ? `${scope} + your tables, semantic metadata, certified saved queries, prior AI history`
    : `${scope} + dbt, semantic metadata, certified saved queries, prior AI history`;
}

/** A notebook's breadcrumb: its file path, or in the app for Snowflake its place and title (no ".dqlnb"). */
export function notebookBreadcrumbParts(path: string, snowflakeApp: boolean): string[] {
  const parts = path.split('/').filter(Boolean);
  if (!snowflakeApp || parts.length === 0) return parts;
  const last = parts.length - 1;
  return parts.map((part, index) => {
    if (index === last) return part.replace(/\.(dqlnb|dql|ipynb)$/i, '');
    if (index === 0 && part === 'notebooks') return 'Notebooks';
    return part;
  });
}

/** The chip before the open file's title in the header: a saved query is never called a "block" there. */
export function openFileKind(type: string, snowflakeApp: boolean): string {
  return snowflakeApp && type === 'block' ? 'saved query' : type;
}

/** Import SQL's source choices: the app for Snowflake has no folder of files to point at. */
export function importSourceModes(snowflakeApp: boolean): Array<'paste' | 'upload' | 'path'> {
  return snowflakeApp ? ['paste', 'upload'] : ['paste', 'upload', 'path'];
}

/** Under Import SQL's Generate button: what the drafts are grounded in. */
export function importContextHint(snowflakeApp: boolean): string {
  return snowflakeApp
    ? 'Uses your Snowflake tables, the semantic layer and your saved queries.'
    : 'Uses dbt, MetricFlow, warehouse catalog, and existing DQL context when available.';
}

/** Import SQL before any SQL is added. */
export function importEmptyMessage(snowflakeApp: boolean): string {
  return snowflakeApp
    ? 'Add SQL and ZLens drafts saved queries from it. Nothing is saved until you choose Save draft.'
    : 'Add SQL to analyze DQL candidates without creating saved query files.';
}

/** Import SQL's first step, in its three-step guide. */
export function importAddSqlStep(snowflakeApp: boolean): string {
  return snowflakeApp
    ? 'Paste SQL, or upload SQL, Tableau or Power BI files.'
    : 'Paste SQL, upload SQL, Tableau or Power BI files, or point to a folder of them.';
}

/** The Import SQL card on the Saved queries home. */
export function importStartDetail(snowflakeApp: boolean): string {
  return snowflakeApp
    ? 'Paste SQL, or upload SQL, Tableau or Power BI files. ZLens drafts saved queries from them; nothing is saved until you save.'
    : 'Paste scripts, upload files, or point at a folder. ZLens analyzes candidates without writing files until you save.';
}

/** Under the saved query builder's SQL box. */
export function sqlConvertHint(snowflakeApp: boolean): { before: string; after: string } {
  return snowflakeApp
    ? { before: 'Detects ', after: ' and checks each table against the tables ZLens reads. Open the DQL Source editor for the full script.' }
    : { before: 'Detects ', after: ' and grounds tables against dbt. Open the DQL Source editor for the full script.' };
}

/** The saved query builder's empty SQL box. */
export function sqlPlaceholder(snowflakeApp: boolean): string {
  return snowflakeApp
    ? 'SELECT\n  category,\n  SUM(revenue) AS revenue\nFROM MY_DB.MY_SCHEMA.ORDERS\nGROUP BY 1'
    : "SELECT\n  category,\n  SUM(revenue) AS revenue\nFROM {{ ref('orders') }}\nGROUP BY 1";
}

/**
 * The line under a saved query's name: its domain, folder, owner and tags. ZLens's own folders
 * (`_drafts`) are where it keeps files, not places a person made: the app for Snowflake leaves them out.
 */
export function savedQueryFolderWords(folderPath: string | undefined, snowflakeApp: boolean): string | null {
  const folder = folderPath?.trim();
  if (!folder) return null;
  if (snowflakeApp && folder.split('/').some((part) => part.startsWith('_'))) return null;
  return `folder: ${folder}`;
}
