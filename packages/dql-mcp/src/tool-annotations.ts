import type { DqlToolName } from '@zlens/agent';

/**
 * MCP tool annotations (MCP spec 2025-03-26+): a human title and behaviour
 * hints a client uses to decide how much to ask the person first.
 *
 * Codex's default (`default_tools_approval_mode = "auto"`) runs a tool marked
 * `readOnlyHint` without asking and asks before any other; without
 * annotations every ZLens call needed an approval, so `codex exec` refused
 * them all. Claude Code and Cursor show the title.
 *
 * Read-only here means the tool changes nothing a person reviews: it may
 * refresh ZLens's own caches under `.dql/cache`, but it writes no block, App,
 * hint or other project file. A tool that saves a draft, a hint or feedback is
 * not read-only. No ZLens tool certifies, deletes or overwrites a certified
 * file, so none is destructive. `openWorldHint` is false throughout: every
 * tool reads only this project and its own local runtime.
 */
export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface AnnotationSpec {
  title: string;
  /** Writes a draft, hint, feedback or App file (never a certified one). */
  writes?: boolean;
  /** Repeating the call with the same input has no further effect. */
  idempotent?: boolean;
}

const SPECS: Record<DqlToolName, AnnotationSpec> = {
  ask_dql: { title: 'Route a question (certified or AI-written)' },
  answer_question: { title: 'Answer a question end to end (like Ask)', writes: true },
  inspect_dql_project: { title: 'Check the ZLens project' },
  search_blocks: { title: 'Find blocks' },
  get_block: { title: 'Read a block' },
  query_via_block: { title: 'Run a certified block' },
  inspect_metadata_context: { title: 'Build the SQL context for a question' },
  expand_context: { title: 'Add tables to a SQL context' },
  query_via_metadata: { title: 'Run AI-written SQL (review required)', writes: true },
  query_semantic_model: { title: 'Query the semantic layer', writes: true },
  kg_search: { title: 'Search the knowledge graph' },
  search_metadata: { title: 'Find tables for a request' },
  get_table_schema: { title: 'Read a table schema' },
  validate_sql: { title: 'Check SQL against the schema' },
  resolve_analytical_path: { title: 'Plan a certified join path' },
  explain_relationship_proof: { title: 'Explain a join relationship' },
  lineage_impact: { title: 'Show lineage and impact' },
  certify: { title: 'Check a block against the certification rules' },
  suggest_block: { title: 'Save a draft block', writes: true, idempotent: true },
  build_block_from_prompt: { title: 'Draft a block from a description', writes: true },
  build_dql_app: { title: 'Start an App in App Studio', writes: true },
  build_dql_block: { title: 'Save a draft block (old name of suggest_block)', writes: true, idempotent: true },
  list_datasets: { title: 'List App Datasets' },
  describe_dataset: { title: 'Describe an App Dataset' },
  preview_tile_query: { title: 'Check an App Dataset query' },
  query_dataset: { title: 'Query an App Dataset' },
  list_metrics: { title: 'List semantic metrics' },
  list_dimensions: { title: 'List semantic dimensions' },
  list_proposals: { title: 'List draft proposals' },
  feedback_record: { title: 'Record answer feedback', writes: true },
  record_correction: { title: 'Record a correction (candidate hint)', writes: true },
  approve_hint: { title: 'Approve or reject a hint', writes: true, idempotent: true },
  list_hints: { title: 'List correction hints' },
  list_apps: { title: 'List Apps, dashboards and tiles' },
  list_notebooks: { title: 'Read notebooks' },
};

export function mcpToolAnnotations(name: DqlToolName): McpToolAnnotations {
  const spec = SPECS[name];
  if (!spec) throw new Error(`MCP annotations are missing for ${name}`);
  const readOnly = !spec.writes;
  return {
    title: spec.title,
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: readOnly || spec.idempotent === true,
    openWorldHint: false,
  };
}
