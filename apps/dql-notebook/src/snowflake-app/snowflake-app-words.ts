import { readableColumnLabel, readablePhrase } from '../utils/column-label';

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
    ? { before: 'Detects ', after: ' and checks each table against the tables ZLens reads. Open the Source editor for the full script.' }
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

// ── V2: the words the V14 retest still found ────────────────────────────────

/** Import SQL's help line before anything is added: the app for Snowflake has no folder of files to point at. */
export function importHelpLine(snowflakeApp: boolean): string {
  return snowflakeApp
    ? 'Paste SQL or upload files. Analysis stays in this session until you save a saved query.'
    : 'Paste SQL, upload files, or choose a local path. Analysis stays in this session until you save a saved query.';
}

/**
 * Tags ZLens keeps for itself, never shown as a person's tags in the app for Snowflake: `app-source` marks a
 * draft as data an App may use (certifying drops it), and `local` is a word split from a table name
 * (LOCAL_TEAM_GAME_FACTS) that reads as if ZLens ran on a laptop.
 */
const SNOWFLAKE_HIDDEN_TAGS = new Set(['app-source', 'local']);

/** A saved query's tags as a person sees them. */
export function savedQueryTagsShown(tags: readonly string[] | undefined, snowflakeApp: boolean): string[] {
  const list = tags ?? [];
  return snowflakeApp ? list.filter((tag) => !SNOWFLAKE_HIDDEN_TAGS.has(tag.trim().toLowerCase())) : [...list];
}

/** Tags a person edited, with the ones the app for Snowflake hides kept as they were (editing never drops them). */
export function editedSavedQueryTags(edited: readonly string[], previous: readonly string[] | undefined, snowflakeApp: boolean): string[] {
  if (!snowflakeApp) return [...edited];
  const kept = (previous ?? []).filter((tag) => SNOWFLAKE_HIDDEN_TAGS.has(tag.trim().toLowerCase()));
  return Array.from(new Set([...edited, ...kept]));
}

/** A notebook row's tooltip: its file path, or in the app for Snowflake its title (no folder, no ".dqlnb"). */
export function notebookRowTooltip(
  file: { name: string; path: string; ownerDomain?: string; visibility?: string },
  snowflakeApp: boolean,
): string {
  const owner = file.ownerDomain ? ` · Owner domain: ${file.ownerDomain}` : '';
  if (!snowflakeApp) {
    return `${file.path}${owner}${file.visibility === 'private' ? ' · Private: not in Git until you publish it' : ''}`;
  }
  const title = file.name.replace(/\.(dqlnb|dqln|dql|ipynb)$/i, '');
  return `${title}${owner}${file.visibility === 'private' ? ' · Private: only you see it until you publish it' : ''}`;
}

/**
 * Where a notebook query cell runs. On a laptop: the local analysis workspace (DuckDB) or a named connection.
 * In the app for Snowflake the connection is the app's Snowflake warehouse, and the workspace holds only files
 * uploaded to the app.
 */
export function queryTargetWords(snowflakeApp: boolean): { local: string; connection: (name: string, isDefault: boolean) => string; localKind: string } {
  if (!snowflakeApp) {
    return {
      local: 'Local analysis workspace',
      connection: (name, isDefault) => `${name}${isDefault ? ' (default)' : ''}`,
      localKind: 'Local dataset SQL',
    };
  }
  return {
    local: 'Files uploaded to this app',
    connection: (name) => (name.toLowerCase() === 'snowflake' ? "This app's Snowflake warehouse" : name),
    localKind: 'Uploaded file SQL',
  };
}

/** The empty Modeling page's last two choices: the app for Snowflake reads tables, not a dbt project. */
export function modelingEmptyWords(snowflakeApp: boolean): { yamlDetail: string; manualDetail: string } {
  return snowflakeApp
    ? {
        yamlDetail: 'Upload or paste modeling YAML. Relationships it declares come across as draft edges for you to review.',
        manualDetail: 'Pick a single table and describe what one of its rows means. Connect it to others afterwards.',
      }
    : {
        yamlDetail: 'Discover DQL modeling or dbt YAML from this project, a safe local path, an upload, or pasted content. Relationships declared in dbt tests come across as draft edges.',
        manualDetail: 'Pick a single dbt model and describe what one of its rows means. Connect it to others afterwards.',
      };
}

// ── V4: the words the V3 retest still found ─────────────────────────────────

/** An AI answer's draft name, in Ask and Notebook AI: its file as a tooltip on the laptop, none in the app for Snowflake. */
export function draftNameTooltip(path: string, snowflakeApp: boolean): string | undefined {
  return snowflakeApp ? undefined : path;
}

/** The saved query editor's source view: "DQL Source" on the laptop, "Source" in the app for Snowflake. */
export function sourceEditorWords(snowflakeApp: boolean): { tab: string; section: string; open: string } {
  return snowflakeApp
    ? { tab: 'Source', section: 'Source', open: 'Open in Source' }
    : { tab: 'DQL Source', section: 'DQL source', open: 'Open in DQL Source' };
}

/** The semantic layer ZLens keeps itself: "DQL semantic layer" on the laptop, "Semantic layer" in the app for Snowflake. */
export function semanticLayerName(snowflakeApp: boolean): string {
  return snowflakeApp ? 'Semantic layer' : 'DQL semantic layer';
}

/** What a notebook is for, on the welcome screen. */
export function notebookWriteWords(snowflakeApp: boolean): string {
  return snowflakeApp ? 'write SQL' : 'write SQL/DQL';
}

/** Describe with AI: the button under a need no data covers yet. */
export function generateGapLabel(snowflakeApp: boolean): string {
  return snowflakeApp ? 'Generate a draft' : 'Generate draft DQL';
}

/** A column offered in a chart's axis picker: its name in words in the app for Snowflake (the value stays the column). */
export function axisOptionLabel(column: string, snowflakeApp: boolean): string {
  return snowflakeApp ? readableColumnLabel(column) : column;
}

/**
 * An Ask clarification choice as a person reads it. In the app for Snowflake a choice of meaning names its columns
 * in words ("TOTAL POINTS" reads "Total points", "game_count by SEASON" reads "Game count by season"); a choice of
 * member is a value from the data and is shown as it is. What is sent back is the choice's id, never these words.
 */
export function clarificationChoiceWords(
  option: { label: string; description?: string; kind?: string },
  snowflakeApp: boolean,
): { label: string; description?: string } {
  if (!snowflakeApp || option.kind === 'member') return { label: option.label, ...(option.description ? { description: option.description } : {}) };
  return { label: readablePhrase(option.label), ...(option.description ? { description: readablePhrase(option.description) } : {}) };
}
