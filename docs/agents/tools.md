# MCP tools

The ZLens MCP server (`zlens mcp`) offers tools only: no resources and no
prompts. Every result is JSON. The server's instructions tell the agent to
use the trust labels it returns (Certified, Governed, Reviewed, AI-Generated,
Insufficient-Context, Conflict) as given, and never upgrade them. Governed
means the answer was compiled from semantic metrics and dimensions, as the
Ask page's "Governed answer"; it is not certified.

The default profile serves 27 tools. Set `ZLENS_MCP_TOOL_PROFILE=full` in the
server's environment for 8 more, for maintenance and governance sessions.

Every tool carries an MCP title and behaviour hints. A tool marked
**read-only** changes nothing you review (it may refresh ZLens's own cache);
the others save a draft saved query, a draft App, a hint or feedback. No tool
certifies, deletes or overwrites a certified file. Clients use the hints to
decide when to ask you first: Codex runs read-only tools without asking.

A call that fails is marked as an error (MCP `isError`) and its message says
what to do, for example which command starts the workbench.

## Which tool serves which feature

| Feature | Tools | Needs the workbench |
|---|---|---|
| Start a session | `inspect_dql_project` | no |
| Ask (route a question) | `ask_dql` | no |
| Ask (answer end to end, like the Ask page) | `answer_question` | yes, with an AI model set up in ZLens |
| Certified saved queries | `search_blocks`, `get_block`, `query_via_block` | `query_via_block` only |
| AI-written SQL, review required | `inspect_metadata_context`, `expand_context`, `query_via_metadata` | `query_via_metadata` (to run the query) |
| Schema and grounding | `search_metadata`, `get_table_schema`, `validate_sql` | no |
| Semantic metrics | `query_semantic_model` (full profile adds `list_metrics`, `list_dimensions`) | for the preview rows |
| Modeling: joins and relationships | `resolve_analytical_path`, `explain_relationship_proof` | no |
| Lineage and impact | `lineage_impact` | no |
| Certification | `certify` (a check; people certify) | for the full check |
| Build a saved query (draft) | `build_block_from_prompt`, `suggest_block` | `build_block_from_prompt` only |
| Apps and dashboards | `list_apps`, `build_dql_app` | no |
| App Datasets | `list_datasets`, `describe_dataset`, `preview_tile_query`, `query_dataset` | yes |
| Notebooks | `list_notebooks` | no |
| Search everything | `kg_search` | no |
| Corrections and feedback | full profile: `record_correction`, `list_hints`, `approve_hint`, `feedback_record`, `list_proposals` | no |

The workbench is the ZLens runtime that `npm run notebook` (or
`zlens notebook <project>`) starts. See [The ZLens runtime](#the-zlens-runtime).

## Default tools

### Start here

| Tool | What it does | Read-only |
|---|---|---|
| `inspect_dql_project` | Checks the project and refreshes its metadata and index: saved queries, Apps, semantic layer, catalog. Call it first. | yes |
| `ask_dql` | Decides how a question should be answered (certified, generated SQL, conflict or missing context), returns the trust label and the next tool. On a conflict, the agent must ask the user which source is authoritative. | yes |
| `answer_question` | Answers a question end to end, like Ask: certified saved query, then semantic metric, then AI-written SQL. Returns the rows, the trust label and, when the answer needs review, the draft saved query it saved. Needs the workbench with an AI model set up in ZLens; without one it returns `modelUnavailable` and says to use `ask_dql` instead. | no (saves a review draft) |

### Certified saved queries

A saved query is what files and tool names call a block (a `.dql` block
file), so these tools keep `block` in their names.

| Tool | What it does | Read-only |
|---|---|---|
| `search_blocks` | Finds saved queries by keyword, domain or status. Each result carries its status. | yes |
| `get_block` | Returns a saved query's metadata, SQL and source. | yes |
| `query_via_block` | Runs a certified saved query and returns its rows with the trust label (`Certified`, or `Certified · stale data` and similar when the data is not healthy). Refuses saved queries that are not certified, and saved queries whose grain does not fit the question. | yes |

### Writing SQL safely

| Tool | What it does | Read-only |
|---|---|---|
| `inspect_metadata_context` | Builds the context the agent may use for a question: tables, columns, governed joins, evidence. Returns a compact pack; `includeDiagnostics: true` returns everything. | yes |
| `search_metadata` | Ranks tables for a request: dbt models, or the synced warehouse catalog in a project without dbt. | yes |
| `get_table_schema` | Columns, types, suggested join keys and governed relationships for a table. | yes |
| `validate_sql` | Checks that SQL only uses tables and columns that exist and only governed joins. | yes |
| `resolve_analytical_path` | The certified join plan between entities. Takes entity ids such as `commerce::entity::order`, or bare names such as `order`; an unknown name returns the available ids. | yes |
| `explain_relationship_proof` | Why two entities may (or may not) be joined: keys, cardinality, warehouse evidence. Takes a relationship id or its short name. | yes |
| `expand_context` | Adds missing tables to the context so a failed query can be retried. | yes |
| `query_via_metadata` | Runs one read-only `SELECT` or `WITH` query as a bounded preview. Marks the result `uncertified` (AI-Generated) and saves a draft saved query unless asked not to. | no (saves a draft) |
| `query_semantic_model` | Compiles and previews a semantic-layer query, labels it Governed, and saves it as a draft. It picks the metric whose name or label the question uses, and says "No semantic match" rather than answer with a different metric. | no (saves a draft) |
| `kg_search` | Searches the project's knowledge graph: saved queries, terms, metrics, Apps, notebooks, dbt models, entities, relationships, skills. | yes |

### Saved queries, lineage and checks

| Tool | What it does | Read-only |
|---|---|---|
| `build_block_from_prompt` | Drafts a reusable saved query from a description and returns its path, SQL and the certification verdict. Never certifies. Needs the workbench; without an AI model in ZLens it returns `modelUnavailable` (unless a governed metric answers the request). | no (saves a draft) |
| `suggest_block` | Saves a draft saved query you wrote under `_drafts/` with the rule check result. | no (saves a draft) |
| `certify` | Checks a saved query against the certification rules. With the workbench running it runs the same check as the saved query editor (owner, compile, run, tests); without it, the declared metadata only, and it says tests were not run. It changes no status. | yes |
| `lineage_impact` | Upstream and downstream of a saved query, model, table or App, and the re-certification impact of a change. A bare table name works. | yes |

### Apps, App Datasets and notebooks

| Tool | What it does | Read-only |
|---|---|---|
| `list_apps` | The Apps with their dashboards and tiles: each tile's saved query, that saved query's status, and the trust label the tile carries (Certified only when its saved query is). Also each App's schedules. | yes |
| `build_dql_app` | Starts a new App from a description as an App Studio draft. Picks certified data (checked tables, Metrics, saved queries) with a reason for each, and lists what no certified data covers. Returns the draft id and a link that opens it in App Studio at the Data step (`openUrl` when the workbench is running, always `openPath`). `name` sets the App name and `blocks` the exact certified saved queries to use; `saveDraft: false` returns the picks only. Writes no App files; never certifies or publishes. | no (writes a local App Studio draft) |
| `list_notebooks` | The notebooks and their cells (markdown and SQL). Pass `path` for one notebook in full. | yes |
| `list_datasets`, `describe_dataset` | The approved App Datasets and their fields. | yes |
| `preview_tile_query`, `query_dataset` | Query an App Dataset by fields, without SQL. Creates no App or draft. | yes |

## Extra tools

Set `ZLENS_MCP_TOOL_PROFILE=full` in the server's environment to add:

| Tool | What it does | Read-only |
|---|---|---|
| `list_metrics`, `list_dimensions` | The semantic layer's metrics and dimensions. | yes |
| `build_dql_block` | Older name for `suggest_block`. | no |
| `list_proposals` | Draft saved queries and semantic proposals, most asked first. | yes |
| `feedback_record` | Records thumbs up or down on an answer. Never upgrades trust. | no |
| `record_correction`, `list_hints`, `approve_hint` | Capture an analyst's correction as a candidate hint, and approve or reject it with an evidence note. | `list_hints` only |

## Not served as tools

These features are not MCP tools. Use the workbench or the CLI:

- Running a notebook cell or an App tile: open it in the workbench.
- Certifying or publishing: the saved query editor, or `zlens certify --from-draft <path>`.
- Scheduled saved queries: `zlens schedule list`. (App schedules are listed by `list_apps`.)
- Version history and diffs: `zlens diff <path>`.
- Team documents and chat attachments: ZLens reads them for Ask through its
  own outbound connectors; they are not exposed to your agent.

## The ZLens runtime

`answer_question`, `build_block_from_prompt`, the query tools, the App Dataset
tools and the full `certify` check call the ZLens runtime: the server that
`zlens notebook` (`npm run notebook`) starts. Keep it running. The tools look
for it at `http://127.0.0.1:3474`, or at `ZLENS_RUNTIME_URL`, or at a
`serverUrl` argument. `zlens mcp test` checks it.

A runtime call that gets no answer ends after 120 seconds (600 for
`answer_question` and `build_block_from_prompt`) with a message saying so.
Set `ZLENS_MCP_RUNTIME_TIMEOUT_MS` in the server's environment to change it.
