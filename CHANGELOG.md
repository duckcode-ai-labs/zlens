# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## Unreleased

## v0.2.10 - 2026-10-27

Sign in with your Claude or ChatGPT subscription when ZLens runs somewhere
else: in a GitHub codespace, a Docker container or on another computer.
- Paste the address your browser lands on to finish the sign-in.
- The sign-in page has a link, in case the pop-up is blocked.
- Home card headings are readable in every theme.
- Hosts that review certification through pull requests can make the App
  Studio say "propose" instead of "certify".

To upgrade, run `npm i -D @zlens/cli@^0.2.10` in each project.

### AI provider: subscription sign-in away from your computer

- **Finish a sign-in by pasting an address.** Claude and ChatGPT send your
  browser back to `localhost` on your own computer after you sign in. When
  ZLens runs in a codespace, a container or on another host, that page can't
  load and the sign-in never finished. Now, while a sign-in waits,
  **Settings → AI provider → Subscription** shows a box: paste the address
  from your browser's address bar and click **Finish sign-in**. ZLens checks
  it belongs to this sign-in before it accepts it. (#208)
- **A link to the sign-in page.** The page opens in a pop-up, which some
  browsers block inside an embedded panel (for example a codespace's preview).
  The waiting screen now shows **Open the Claude sign-in page** (or ChatGPT).
- **Docker:** the demo image's command maps the two return ports, so the
  sign-in finishes inside the container without pasting:
  `docker run --rm -p 127.0.0.1:3474:3474 -p 127.0.0.1:54545:54545 -p 127.0.0.1:1455:1455 ghcr.io/duckcode-ai/zlens-demo`.

### Workbench

- **Home card headings read at 4.5:1 contrast in every theme.** (#199)
- **Hosts:** a host whose review certifies through pull requests can answer
  `certification: 'proposes'`; the App Studio then says "Propose for
  certification" wherever it said "certify". Only the words change. (#198)

### Try it and docs

- Try ZLens without installing: an **Open in GitHub Codespaces** button and a
  one-command **Docker** demo image (`ghcr.io/duckcode-ai/zlens-demo`), both
  opening the Jaffle Shop sample's certified App. (#205, #207)
- The docs moved to **https://docs.zlens.app**; old links redirect. (#201)
- Every docs page shows its YouTube tutorial, and the steps match the videos.
  (#204)
- Questions go to **GitHub Discussions**. (#200)

## v0.2.9 - 2026-10-24

A patch for Apps, found by walking the Jaffle sample on 0.2.8.
- Receipts name a reader's filter value on saved-query tiles.
- The certify button keeps its label inside it.
- A related-table field is named once.
- Published App files use your git identity, and the App's README lists its
  data.

To upgrade, run `npm i -D @zlens/cli@^0.2.9` in each project.

### Apps: fixes found while walking the Jaffle sample

- **Receipts name a reader's filter value on saved-query tiles.** A tile's
  receipt read "Filters: Customer Name any" after Filter by Customer Name =
  Melissa Lopez; it now reads "Customer Name Melissa Lopez", like table tiles.
- **"Certify now (recommended)" stays inside its button** in the publish
  dialog when the item's text wraps; the text wraps instead.
- **The Filters tab names a related-table field once:** "…has no Location
  Name field.", not "Location Location Name".
- **Published App files name your git identity.** `dql.app.json` members and
  the App's `README.md` use git `user.name` and `user.email`, as certification
  receipts do; `$USER@local` only when git has none. The README lists the
  App's saved queries, tables and Metrics instead of "No blocks selected yet".

## v0.2.8 - 2026-10-24

A branding patch: ZLens replaces DuckCode in everything people read. There are
no behaviour changes.

To upgrade, run `npm i -D @zlens/cli@^0.2.8` in each project.

### Brand: ZLens replaces DuckCode in everything people read

- The docs, code comments and package metadata say **ZLens**:
  - `create-zlens-app`'s author is ZLens.
  - `NOTICE` reads "ZLens is a product of DuckCode AI Labs".
- DuckCode AI Labs remains the copyright holder and the GitHub organisation.
- Theme token names and values are unchanged, so embedding hosts need no
  change.

## v0.2.7 - 2026-10-23

A patch for MCP clients. Every answer's trust line now arrives as its own text
block, so Claude Desktop, Codex and other clients start their answer with
`🟢 Certified`, `🔵 From Metrics` or `🟠 AI-Generated` rather than burying it.

To upgrade, run `npm i -D @zlens/cli@^0.2.7` in each project.

### MCP: the trust line is its own text block

- In Claude Desktop the `trustLine` inside the JSON result was easy to miss:
  the model wrote the label somewhere in its prose, or not at all. Answer
  results with a trust line now also send it as a second plain-text block,
  `**🟢 Certified · saved query …**`, with the rule to start the answer with
  it, and the MCP descriptions of `query_via_block`, `query_semantic_model`,
  `query_via_metadata` and `answer_question` say the same. The JSON is still
  the first block, unchanged; a client that joins every text block before
  parsing JSON should parse the first block only.

## v0.2.6 - 2026-10-23

A patch for honest answers over MCP and Ask.
- **Semantic route:** a semantic answer covers the whole question or none of
  it; it never drops a breakdown, a filter or a date range.
- **From Metrics:** "Governed" is now **From Metrics** everywhere people read
  it, and it applies only when every join is a certified relationship.
- **MCP:** every answer starts with a ready-made trust line, and empty
  discovery results point back to `ask_dql`.
- **Apps:** certified saved queries are adopted in place.

To upgrade, run `npm i -D @zlens/cli@^0.2.6` in each project.

### The semantic route answers the whole question or not at all

- **`query_semantic_model` no longer drops a breakdown or a filter the question
  asks for.** In 0.2.5, "What was the busiest hour of the day for orders in
  Philadelphia?" compiled the `orders` metric with no breakdown and no filter:
  one total of all orders, labelled Governed. A question-mode compile now
  checks that its members express every breakdown ("hour of the day", "by
  customer type"), named member ("in Philadelphia") and date range ("in March
  2025", "last quarter") in the question. When one is missing it returns
  `matched: false` with `unexpressed` (the missing parts), `nearestMetric` and
  `nextTool: query_via_metadata`. Explicit `metrics[]` passed with a `question`
  get the same check. `ask_dql` no longer offers such a question to
  `query_semantic_model`: it sends it to `query_via_metadata` and adds
  `semanticGap` with the same parts. "How many orders at the Philadelphia
  location?" now compiles `location_name = 'Philadelphia'`.

### MCP: every answer starts with its trust line

- Claude Desktop and other MCP clients show a ZLens answer as their own text,
  so the trust label reached the reader only when the model happened to write
  it, often halfway down. Every answer result with rows (`query_via_block`,
  `query_semantic_model`, `query_via_metadata`, `answer_question`) now starts
  with a ready-made `trustLine`, and the server instructions tell the client to
  open its answer with it, word for word:
  - `🟢 Certified · saved query monthly_revenue · owner analytics@jaffle.shop`
    (`🟡` when a certified saved query is downgraded, e.g. `Certified · stale data`)
  - `🔵 From Metrics · metric large_orders · not certified`
  - `🟠 AI-Generated · SQL written for this question · needs review · draft saved for review at …`
  Failures, dry runs and non-answer tools get no line. The other fields are unchanged.

### From Metrics only through certified joins

- **A semantic compile that joins through a draft relationship is no longer
  labelled From Metrics.** In 0.2.5, `query_semantic_model` labelled "How many
  large orders did each location get?" Governed although it joins orders to
  locations through `order_to_location`, a draft relationship. A semantic
  compile is now From Metrics only when every join it takes is a certified
  relationship that passes the check `resolve_analytical_path` and
  `explain_relationship_proof` apply. A compile through a draft relationship,
  or a join no relationship models, is **AI-Generated** in MCP
  (`certification: 'ai_generated'`, display `AI-Generated · uncertified join`),
  and its caveat names the relationship. A single-table compile ("How many
  large orders did we get each month?") stays From Metrics. `ask_dql`'s
  `semanticCandidate` carries the same label.
- **Ask follows the same rule**: such an answer is headed **Answer to review,
  from governed definitions**, and the answer and its Trust & evidence name
  the join. The figures still come from the semantic layer, not from AI-written
  SQL.
- **Note for MCP clients:** `query_semantic_model` adds `aiGenerated` (boolean)
  and `relationshipProof` (each join and the relationship it matched).
  `uncertified: true` is unchanged and means no certified saved query backs
  the result and the draft needs review; it does not mean AI-generated. Read
  the label from `trustLabelInfo.display`, `certification` or `aiGenerated`.
  The server instructions say so.

### Wording

- **Ask's "Governed" label is now "From Metrics"**, so Ask matches Help. The
  answer heading reads **Answer from Metrics** (**Answer from Metrics, in this
  App** on an App page), the badge, the run card and the Ask observability
  Trust filter read **From Metrics**, and `zlens agent ask` prints
  `· From Metrics` instead of `· Reply` for such an answer. A certified saved
  query served as evidence for a question it is not certified for is headed
  **Answer from a certified saved query, not certified for this question**,
  since its figures do not come from Metrics. The `trustState: 'governed'`
  value, the `governed` filter value, API and JSON field names and test ids
  are unchanged.
- **Note for MCP clients:** `trustLabelInfo.base` and `.display` for the
  `governed` id are now `"From Metrics"` (were `"Governed"`); `ask_dql`'s
  `answerContract.trustLabels` lists `From Metrics`; the semantic compile's
  `trustStatus.label` is `"From Metrics: semantic compile"`; the server
  instructions use the new word. The `id` stays `governed` and tool names
  are unchanged; match on `id`, not on the display text.

### MCP: empty results point back to ask_dql

- An MCP client that skipped `ask_dql` could stop at an empty `list_datasets`
  and tell the user the project had no governed data, though it had certified
  saved queries. When `list_datasets`, `search_blocks`, `search_metadata` or
  `kg_search` comes back empty and the project has certified saved queries or
  semantic metrics, the result now adds a `note` with their counts and
  `nextTool: "ask_dql"`. Results with data are unchanged.
- `answer_question` without an AI model set up in ZLens now also returns
  `nextTool: "ask_dql"` and `nextArgs: { question }`, besides its message.
- `list_datasets`' description says Datasets are warehouse tables approved for
  App tiles and that business questions go to `ask_dql`.

### Apps: certified saved queries are adopted in place, plain recovery words, certifier on every row

- **A saved query certified from its App moves the App to the certified
  version.** Certifying writes a new version of the saved query's file, and
  a saved query's fields are read once per version, so the App's catalog card
  had no fields for the certified version and the App refused it ("does not
  expose one complete current data version and contract"); the count stayed
  0 of 1. The App now reads the fields of the new version when it adopts or
  refreshes a saved query it uses through fields, so "I vouch for this —
  certify" turns 0 of 1 into All tiles certified in place, for result-field
  and row-level saved queries alike. **Refresh this data** recovers the same
  case.
- **When the App can't switch, it says what to do.** "This App couldn't
  switch to the newly certified version of Rerun Cert Probe. Refresh its
  data, or choose it again from Add data.", with **Refresh this data** and
  **Choose it again from Add data** buttons. File names, ids and "data version
  and contract" are under **Technical details** only. A tile over data that
  changed says "This data changed after the tile was made. Refresh this data
  in the Data pane, or choose it again from Add data."
- **A database table says who certified the data made from it.** Add data
  showed "Table · Certified" on the table while the data made from it said
  "Certified by you · 23 Oct"; both now say "Certified by you · 23 Oct".
- **Help explains Ask without "governed".** Saved queries are "questions you
  save once and reuse"; the middle kind of Ask answer is described as built
  from your Metrics and checked joins. Ask's own labels are unchanged.
- **A one-value filter control is a "Searchable list"**, not "Dropdown": it
  searches every value.
- **`zlens doctor` no longer reports drift for working App tiles.** Its
  output-contract check compared a tile's fields only with fields a saved
  query's file declares. A saved query used through its result columns
  declares none, and a field from a related table (`customer__customer_name`)
  comes through the model's joins, so every such tile was reported as
  "no longer declared". The check now accepts a saved query's result columns
  (with the Min, Max and row-count measures ZLens adds) and leaves related
  fields to the runtime, which checks them on every run. A column a saved
  query no longer returns is still reported.
- Reading a saved query's columns works when its SQL ends with a line
  comment.

## v0.2.5 - 2026-10-23

A patch for MCP and Apps.
- **MCP:** a certified route only when the block returns the requested
  measure; `query_semantic_model` picks the metric the question names (derived
  metrics now compile); a semantic compile is labelled Governed, as on the Ask
  page.
- **Apps:** editing a changed App keeps its saved queries and receipts, every
  Certified says who and when, Publish waits for pending changes, the Jaffle
  sample opens as an existing project, and App links open a page.

To upgrade, run `npm i -D @zlens/cli@^0.2.5` in each project.

### MCP: truthful certified routes, the metric the question names, and Governed

- **A certified block answers only a measure it returns.** `ask_dql` sent
  "How many large orders did we get each month?" to `monthly_revenue` as
  Certified, although its `order_count` counts every order. A semantic metric
  the question names whose name carries a qualifier (`large_orders`,
  `food_revenue_pct`, `new_customer_orders`) is now a required measure. A block
  answers it only when an output or the block's own scope (WHERE, name, tags)
  says so. Otherwise the question goes to the semantic or generated route.
  "How has revenue changed by month?" still answers from `monthly_revenue`.
- **`query_semantic_model` picks the metric the question names.**
  - "Average order value by customer type" now answers with
    `average_order_value`, not `drink_orders`.
  - "New versus returning customers" groups by `customer_type`, whose
    description lists those values.
  - "What share of revenue comes from food each month?" answers with
    `food_revenue_pct` by month.
  - "Each month" keeps the month grain on the metric's own time dimension.
  - When the named metric cannot compile, the result says "No semantic match"
    and why, and never answers with a metric that only shares a word.
- **Derived metrics compile natively** when their expression is arithmetic
  over simple metrics with no offset window (`average_order_value`,
  `order_gross_profit`). Explicit
  `metrics: ["average_order_value"], dimensions: ["customer_type"]` now
  compiles. Offset-window metrics such as `revenue_growth_mom` are still
  refused, with the reason.
- **Governed is a trust label over MCP too.** The canonical labels are now
  Certified, Governed, Reviewed, AI-Generated, Insufficient-Context and
  Conflict. A `query_semantic_model` compile is labelled **Governed** (built
  from semantic metrics and dimensions, not certified), matching its
  `dqlArtifact.trustState` and the Ask page's "Governed answer".
  `answer_question` adds the same label for the run's `trustState`.

### Apps: Publish waits for pending changes

- **Publish no longer does nothing while a change is saving.** Clicking
  Publish right after choosing data or adding a tile was ignored without a
  word, because the button was disabled until the save landed. Publish now
  takes the click, says "Saving changes…", and opens the review on the saved
  draft. If the save fails it says "Your last change was not saved, so Publish
  did not start." with **Try again**. Run waits the same way ("Saving…").

### Apps: editing a changed App keeps its data, every Certified says who and when

- **Editing a published App keeps its saved queries and their receipts.** An
  App whose tiles name saved queries by name (as the sample's Jaffle Growth
  Review does) opened in Edit with every tile "Not certified yet", "Nobody has
  certified this saved query yet", and Certify now answered "That data is not
  in this project any more". Edit now reads each saved query from the project
  as it is now: certified ones stay certified, one changed since it was
  certified reads **Not certified yet** with "Changed since it was certified
  on 15 Oct", and Certify now opens its short review right in the publish
  dialog. Edit drafts opened with 0.2.4 are repaired the next time Studio
  lists them.
- **Every Certified in App Studio says who and when**: tiles, the Data panel
  and the publish dialog read "Certified by Analytics (jaffle.shop) · 15 Oct"
  or "Certified by you · 23 Oct". Data rows show the owner as
  "Owner: Analytics (jaffle.shop)", so it is not read as the certifier.
- **The tile count is everywhere**: the App Studio header shows "3 of 4 tiles
  certified", and a draft's Apps card "Not published yet · 3 of 5 tiles
  certified".
- **The Data panel's byline wraps** instead of cutting a word ("Certified by
  yo…") at 1280 and 1440 wide.
- **An App changed in another tab says so**: "This App changed in another tab.
  Refresh to review the latest version.", with a Refresh button; the code
  (`APP_BUILD_REVISION_CONFLICT`) moves under Technical details. Other common
  App build codes in App Studio read as plain sentences too.
- **Keyword suggestions say "Certified saved query"**, never "Certified
  Dataset", and the MCP `build_dql_app` tool says "Check the suggested data"
  (or "the data you named"), not "the data AI picked".
- The saved-query review says "One row per beverage product.", not "Each row
  is one one row per beverage product."

### Setup, App links, reader filters and search (Codex end-to-end report)

- **The Jaffle sample opens as an existing project.** Guided Setup selects
  **Open an existing ZLens project** when the folder's `dql.config.json`
  already configures a built dbt project (or dbt + database), instead of
  **dbt project**, and the dbt card no longer flashes "dbt project missing"
  while it loads. Step 2, **Check the connection**, has **Refresh dbt data** as
  its action; extra warehouse schemas are under **Advanced** ("Optional: add
  warehouse schemas dbt doesn't cover").
- **App links open a page.** The Apps card title links to the App's home page
  (`?app=jaffle-growth&page=overview`), and an app-only link opens that page
  instead of "Pages 0 · No dashboard page selected".
- **Readers can pick any value in Filter by….** The ad-hoc picker lists the
  column's values from the server with "Type to search all 930 values", and
  typed text searches every value, so a customer past the first 500 is found.
  It no longer offers only the 24 names the tiles happened to return.
  `/api/dashboard/filter-options` takes `search` and reports `valueCount`.
- **Local embeddings only when you choose them.** Search is word-based unless
  the project turns on **Use local Ollama embeddings (nomic-embed-text) — runs
  on this computer, nothing leaves it** in Settings → AI provider → Search. A
  running Ollama is offered (once, in the terminal and in Settings), never
  adopted silently; an index an earlier version switched by itself goes back to
  word-based search. Projects that set `ai.embeddings` keep it.
  `ZLENS_EMBEDDINGS_AUTODETECT=on` is the operator's opt-in to the old
  automatic switch. Provider ids sit under **Technical details**.
- **Plain words.** "Not filtered by Customer Name", not `customer_name`;
  "Date range", not "Daterange"; "Continue to data", not "Open blank Studio";
  "No matching rows for these filters." on an empty filtered tile; "Choose which
  tiles each filter affects."; "AI answers questions and helps you build. You
  can run queries and build Apps without AI."; no "candidate" or "synchronize"
  on the existing-project step.
- **The click-to-filter hint keeps its own row** under a chart in App Studio,
  so it no longer covers the axis labels at 1440×900.

## v0.2.4 - 2026-10-22

A patch for Apps: a total over a Top N saved query is no longer labelled
Certified, Certify always leaves a receipt, and the Apps docs match the
product. The Jaffle Shop sample now has a certification receipt for every
Jaffle Growth tile.

To upgrade, run `npm i -D @zlens/cli@^0.2.4` in each project.

### Apps: honest totals, one scope line, no AI controls without AI

- **A total over a Top N saved query is not labelled Certified.** A saved
  query that keeps only its first N rows (an outer `LIMIT N`, such as
  `top_beverage_customers`) gave a Total or a KPI over its result the label
  Certified, though it summed the top 10 only. Such a tile still runs, but it
  reads **Not certified yet**: "Totals only the 10 rows top_beverage_customers
  keeps (it is a Top 10), not all of the data, so it is not a certified
  total." A tile that shows the rows as they are keeps its label.
- **Certify records a receipt for a block with no companion YAML.** A
  hand-written block certified in Saved queries passed the rules and recorded
  nothing, so its tile could not say who certified it or notice a later edit.
  Certify now writes the companion YAML with the receipt, as a save would.
- **Ask about this App cites "saved query"**, not "block": "“Monthly gross
  revenue” reads saved query monthly_revenue (domains/commerce/blocks/…)".
- **The Ask scope line names the page only when it differs from the App**:
  "Scoped to Jaffle Growth Review", not "Scoped to Jaffle Growth Review ·
  Jaffle Growth Review".
- **No "Show AI copilot" button without an AI provider**, like the other AI
  controls since 0.2.3.
- The docs clips and README screenshots wait for "All tiles certified".

## v0.2.3 - 2026-10-22

Apps are built from the data you choose, with one trust answer on every
screen: a tile is Certified or Not certified yet, and publishing never blocks
unless the project requires it. A database-only first run reads plainly,
`zlens ci init` writes a CI check that works on a clean clone, and chat
clients with no guide file, such as Claude Desktop, answer from certified
blocks first.

To upgrade, run `npm i -D @zlens/cli@^0.2.3` in each project. Use Node 20, 22
or 24 (Node 24 LTS recommended). `build_dql_app` over MCP has a breaking
change: see AI agents (MCP) below.

### CI that works on a clean clone: `zlens ci init`, honest eval and verify docs

- **`zlens ci init [path] [--force]`** writes
  `.github/workflows/zlens-eval.yml` at the git root. On every pull request it
  runs `npx -y --package=@zlens/cli@<this version> zlens eval .
  --min-route-accuracy 1 --min-refusal 1`. It has no install step (samples ship
  no lockfile) and no compile or verify step. A project in a subfolder gets a
  `working-directory`. `zlens eval` needs no `*.duckdb`, dbt `target/`,
  `dql-manifest.json` or API key.
- **Threshold flags refuse out-of-range values.** `--min-route-accuracy 90`
  used to be silently dropped, leaving the gate off. Every `<0..1>` flag on
  `zlens eval` and `zlens agent eval` now prints "expects a share between 0
  and 1 (for 90% use 0.9)" and exits 1. The text report says when a
  threshold is not applied because no case measures it.
- **`zlens agent eval --judge` is parsed**, so `--min-judge-pass` has judge
  scores to gate on. `--via loop` (the removed in-process driver) and any
  `--via` or `--cassette` value that is not supported are rejected when the
  arguments are parsed. Help now lists `--via runtime` only.
- **`zlens eval --init`** writes examples for the Jaffle Shop sample's blocks
  (`monthly_revenue`, a member-filter generated case, a follow-up, a refusal).
  The old examples came from another project. The no-cases message no longer
  says to run `zlens compile`; eval builds the manifest itself.
- **`zlens eval` scores line up.** Every Scores and Cascade distribution value
  starts in one column; "Block-selection accuracy:" no longer pushes its value
  out of line.
- **`zlens agent eval` in cassette replay mode no longer says "Real-provider
  quality evidence: eligible."** No provider was called, so it now says "none
  from this run — every provider call was replayed from N recorded
  response(s)". The JSON `cassetteEvidence` gains `mode`. Record mode still
  reports eligible when every entry came from a real provider.
- **`zlens agent eval --cassette <mode>` checks the workbench's mode.** The
  workbench makes the provider calls, and it replays only when started with
  `ZLENS_EVAL_CASSETTE_DIR` / `ZLENS_EVAL_CASSETTE_MODE`. So `--cassette replay`
  against a normally started workbench used to make live calls while the
  report claimed cassette evidence. `/api/health` now reports
  `evalCassetteMode` (`off`, `record`, `replay` or `live`). When it differs
  from `--cassette`, or is missing, the eval stops before any case and prints
  the command to start the workbench in that mode.
- **`zlens verify`** prints its drift report to stdout, like its success line.
  Its help says what it compares, and that it is a local check because
  `dql-manifest.json` is gitignored.
- **Docs.** Tutorial 05 is now "CI with `zlens eval`". The old workflow could
  not run or always passed: `npm ci` with no lockfile, a wrong
  `working-directory: dql`, `^dql/blocks/` filters that miss
  `domains/<d>/blocks/`, `git add` of an ignored manifest, and compile-then-verify.
  The tutorial now shows the generated workflow, how to fix a block example
  that routes to generated, `agent eval` in replay mode, and verify as a
  local check. The CLI reference documents `zlens ci`,
  `--min-candidate-recall`, `--init`, `--via`, `--cassette`, `--judge`,
  `--max-false-refusal`, `--min-refusal-recall` and the other agent eval
  gates. It also corrects the `diff --impact` exit rule and the certify JSON,
  and removes exit code 2, which no command returns. The troubleshooting
  section on CI is rewritten to match.

### New Apps show after Back, no AI controls without AI, two trust words, steadier canvas

Round-3 new-user review, problems 1, 5, 6 and 10.

- **Back to Apps lists the new App at once.** Back from App Studio puts the
  draft you just left on the Apps list straight away and reads the list again
  (it used to show the list from before the App existed until a reload);
  deleting an App re-reads the drafts too.
- **One wording for Apps nobody else can see yet.** A new App says **Not
  published yet** (Studio header: *Not published yet (only you can see it)*;
  card: **Only you**, **Not published yet**); a published App you are editing
  says **Unpublished changes (only you can see them)**, and right after you
  open it **No changes yet · readers see the published App**. "Local draft"
  and "Private draft" are gone; the library tab is **Not published yet** and
  its counters count the cards it shows (a published App's draft is not
  counted as a second App).
- **Two trust words in the Data list.** A database table reads **Not
  certified yet**, with **drafted — review in Modeling** when setup drafted it;
  "Modeled", "Drafted — review to use" and "Not checked yet" are gone (how the
  model knows the table is in the tooltip). "Governed" no longer appears in
  App page text (stories, custom layouts, driver and explore notes).
- **No AI controls without an AI provider.** Tiles have no **Edit with AI** /
  **Change with AI** / **Ask about this tile**, and block tiles in the reader
  no **Ask AI**; Quick tiles and Tile settings stay. The reader's Ask box (and
  its Preview) says *Ask needs an AI provider. The owner can connect one in
  Settings.* A run refused because no model is configured is marked
  `providerMissing` and headed **Ask needs an AI provider** · **Not
  answered**; any other refusal reads **No answer** · **Refused**. Neither is
  ever called "AI-generated".
- **Steadier canvas.** A new tile's preview never draws the previous query's
  result as the new chart (a KPI's total drawn as a one-row trend); it shows
  *Running…* until the matching result arrives, and runs sooner after a click.
  **Add to page** clears the tile at once, so a field clicked right after
  starts the next tile instead of changing this one. Field clicks on a saved
  tile and adds queue behind earlier saves and work from the newest draft.
  The tile being built and a tile just added are scrolled into view. Tile
  charts redraw only when their own data changes (no long tasks on a field
  click at 6x CPU throttling, down from 75–125 ms).
- **Filters re-run only the tiles they reach.** Applying a filter offer to a
  new tile re-runs that tile; the rest keep their results. In the reader, a
  filter change re-runs only the tiles linked to the filters that changed
  (pages with a Summary still run whole); tiles that did not run say *Not
  filtered by …* for the new value. Asking about the App or a chart after such
  a change runs the whole page once first, so Ask reads every tile's result.
- Setup's status reads *Indexed N items from your project for search* instead
  of "governed objects".

### No customers merged by name, the order date first, honest table states, one cents question, date presets

New-user review, round 3 (problems 2, 4, 7, 8, 9 and the Show Me "does not add
up" explanation).

- **Names group by their key.** A tile grouped by a name (Customer Name)
  groups by the key of what the name belongs to and shows the name, so two
  customers called Maria Lopez stay two bars, told apart by their key only
  when they share a name ("Maria Lopez (#1043)"). A related table's name uses
  the join's own key column (Orders → Customer Name groups by
  `orders.customer_id`); a name of the row uses the row key; `store_name`
  beside `store_id` uses that id. Quick start's Top list, field clicks and Show
  Me all compile through it. Clicking a bar told apart by its key (Keep only,
  Exclude, cross-filter) filters that one key; a filter's value list still
  reads plain names. A name whose key ZLens does not know carries a **Names may
  repeat** notice on the tile ("Store Name may not be unique: …"; run
  responses add `dataset.nameWarnings`). Period comparisons keep grouping by
  the name alone.
- **The order date first.** The filter field list ranks the date of the rows
  the tiles count first (the date a trend groups by, a Dataset's own main
  date), then other own dates, then a related table's dates, labelled by their
  table (**Customer · First Ordered At**, "the customer's date"), however many
  tiles a join lets them reach. A tile without the filter's date no longer
  offers one-click **Use First Ordered At on Customers**: a picker offers other
  dates as **Different meaning: the customer's First Ordered At**, and a mapped
  tile says "uses First Ordered At, a different date".
- **Added tables say so.** `GET /api/app-datasets/tables` lists the Datasets
  made from each table (`datasets: [{ sourceId, name, state }]`). Add data
  shows **Not certified yet · added** (or **Certified · added**) for a table in
  this App, **Not certified yet** with **Add to App** for one made elsewhere (added as that Dataset, never checked
  into a second copy), and **Check and add** only for a table not made into a
  Dataset yet. Check and add opens straight on the check, without flashing the
  table list.
- **One cents question per table.** "These columns are stored twice, in
  dollars and in cents: Subtotal, Tax paid and Order total. ZLens will use the
  dollar columns and hide the cents copies." **[OK] [Show both]** replaces a
  Yes/No per column whose answers both gave dollars. OK uses the dollar column
  when the rows show it is the same amount (else reads the cents in dollars);
  Show both keeps the cents copies as plain numbers. Counts of dates
  ("Ordered at count") and of running numbers ("Customer order count") are
  offered but no longer ticked.
- **Date presets and labels.** Date range controls in Studio and the reader
  offer **Last 7 days, Last 30 days, This month, This quarter, This year,
  Custom**; the reader's date control shows its name. A new bar of names (930
  customers) starts as an explicit **Top 10** on the measure pill. Tile
  captions read "Top customer: Maria Lopez, $3.1K lifetime spend" and "Highest
  month: Aug 2025, $94.2K order total"; a KPI no longer repeats its number
  under the raw field name.
- **Show Me's "does not add up" fixed.** A table's measure shares its column's
  name (`lifetime_spend` is the column and its sum); Show Me read the column
  and called a summed amount non-additive ("Lifetime Spend does not add up
  across Customer Name"). It now reads the measure. Its value count uses the
  result's full row count (930), not the rows loaded (500).

### Certify tables, saved queries and joins without leaving the publish dialog

Trust and publishing design, phase 2 (T4).

- **Saved queries certify inline.** **Certify now** on a saved query tile in
  the publish dialog (and **⋯ → Certify…** on a saved query in the Data tab or
  Add data) opens the same short review as a table instead of Block Studio:
  **It runs** (run now), **Its tests pass** (each test and its result), **Who
  owns it** and **What one row is** (its grain or grouping columns), then **I
  vouch for this — certify**. When the saved query names no owner, the review
  asks for one and writes `owner = "…"` into the `.dql` with the
  certification. It goes through the same certification rules and receipt as
  Block Studio's **Certify** (`POST /api/app-datasets/certify`, with an
  optional `owner`); a failing test or a query that does not run refuses and
  writes nothing (`OWNER_REQUIRED`, `CERTIFICATION_CHECKS_FAILED`). The saved
  query editor stays one small link away.
- **Joins certify inline.** **Certify this join** (publish dialog) and **⋯ →
  Certify the join to …** (Data tab) open a join review: the keys, *each order
  has one location — checked on N rows* from a fresh bounded check (Modeling's
  one validation statement), and what would double-count if the join were
  wrong. When Modeling lacks a side's grain or key columns they are filled from
  the checks just run — the "one" side's join key (unique and filled on every
  row) and the Dataset's own row key — never from anything a check did not
  prove. **I vouch for this join — certify** writes through Modeling's own
  path (a modeling proposal, saved at once: the entities' grain and keys and
  the relationship certified against them, with who and when), so Modeling
  shows it certified; a setup draft's join leaves the draft. A failing check
  says why and writes nothing. New routes: `GET
  /api/app-datasets/joins/certify-review` and `POST
  /api/app-datasets/joins/certify` (a host gates the POST as `dataset.certify`).
- **The count updates in place.** After any certification in the dialog the
  pages run again, the count updates ("All tiles certified") and the item
  leaves the list, without closing the dialog or reloading.
- **"Changed since it was certified on 22 Oct" keeps its date.** A certified
  table or saved query edited afterwards (sha256 mismatch) and a certified join
  whose keys or a side's grain changed now keep who certified them and when on
  the catalog, run and review records, so receipts and the publish list say
  *Changed since it was certified on …* (for a join, *Uses a join that changed
  since it was certified on …*) instead of *Nobody has certified it yet*. A
  block ZLens sends back to draft or review keeps a `previousCertification`
  record in its companion YAML; a join keeps `certifiedAt`, `certifiedBy` and
  `certifiedByName` inside `certifiedAgainst` (not part of the proof).

### One trust model: Certified or Not certified yet, per tile, and publishing that never blocks unless the project requires it

Trust and publishing design, phase 1 (T1–T3).

- **Two words.** Every App, Data, publish and reader surface says a tile,
  table, saved query or join is **Certified by** *name* **·** *date* (or **by
  you**) or **Not certified yet**. "Needs review", "Checked · Needs
  certifying", "Needs certifying", "Governed", "draft" as a trust word, the
  "review lane" and the data rule's "Only certified data" / "Also allow data
  that needs review" are gone from these screens. Why a tile is not certified
  is detail in its receipt or tooltip: *Checked by you, not certified yet*,
  *Changed since it was certified on 22 Oct*, *Uses a join nobody has
  certified*. Ask's answer labels are unchanged.
- **Trust lives at the tile.** A tile is certified only when everything it
  can use is: its data, every join it can reach (also through a filter) and,
  for a calculation, every input — a calculation over certified data is now
  **Certified**, not "Governed". The App header, the trust line, the Apps card
  ("App certified" is gone), the publish dialog and the published
  `dql.app.json` (`tileTrust`) all show one count from one shared function:
  **All tiles certified** or **3 of 4 tiles certified**.
- **Per-App data rules are gone.** The Start form's "Only certified data"
  switch, App settings' **Data rule**, the Data step's "Data rule: … Change"
  line and the publish dialog's **Allow data that needs review** button are
  removed. Every App can use any data, certified first; data nobody certified
  is added with the same **Add to App**, and the AI, keyword and quick-choice
  planners prefer certified data without leaving the rest out. An older App's
  stored `sourcePolicy` is read and ignored (old files still open); new Apps
  no longer write it. ZLens no longer opens "needs certifying" review tasks,
  and the ones older drafts kept never block publishing.
- **Publishing never blocks on trust by default.** The publish dialog shows
  the count, lists the tiles not certified yet with **Certify now
  (recommended)** (each opens its short review in the dialog; see phase 2
  above), and a **Publish** button
  that says *Readers will see 'Not certified yet' on N tiles*. Readers see
  **Not certified yet** on those tiles. The button is **Publish**, no longer
  "Publish to Project".
- **New project setting: `apps.requireCertifiedToPublish`.** `true` in
  `dql.config.json` makes every tile need to be certified before an App is
  published: the dialog says *This project requires every tile to be
  certified before an App is published.* with the certify actions and no
  Publish button, and the server refuses with one message
  (`APP_BUILD_REQUIRES_CERTIFIED`). It is read at every publish
  (`GET /api/apps/settings`), validated by `zlens doctor` (**App publishing**),
  and off by default in the open-source edition. A host's admin policy can
  turn it on for a project.

### Drafted models save the first time, revenue first, plain names, no joins on names

New-user review round 2, problems 4, 7, 8, 9 and 10.

- **Drafted models save the first time.** Save no longer fails with "Project
  sources changed after this proposal was reviewed" because something else
  changed after drafting (certifying a table in an App, a setup step writing
  `dql.config.json`). Save previews the reviewed changes again on the current
  project and writes them as they are when every file they write is exactly
  as reviewed; it asks only when a drafted file changed, in plain words that
  name the tables ("…was edited after you reviewed them (Orders). Update the
  drafts to the latest project and review them again before saving."). The
  button is **Update drafts and review again**, never "Rebase proposal".
  Draft my models says "Not saved yet: review and save them in Modeling."
- **Cents questions say what the data shows.** "Subtotal is stored twice:
  Subtotal (dollars) and Subtotal cents. Use Subtotal in dollars?" The check
  reads the rows: the same amount in two units (×100), or the same number
  twice (both in cents, where keeping the plain column shows a number, never
  Money 100 times too large). Columns are named as people read them.
- **Quick start leads with money.** Default measures rank Money-formatted
  measures first, then money names (revenue, sales, amount, total, spend…),
  then other sums, then counts, and counts of yes/no flags ("Count Drink
  Items") last. The trend is that measure by month; the top list ranks the
  most name-like field (Customer Name, never an id).
- **Plain names.** "Customer Name affects 3 of 4 tiles", never "Customer
  Customer Name"; "not mapped to Beverage Revenue By Product" and "Also filter
  Beverage Revenue By Product", never the saved query's id — in filter chips,
  "Not filtered by" reasons (also ones older Apps stored) and the Filters tab.
- **No joins on names.** Database-only setup drafts joins only on key-like
  columns (`*_id`, declared keys, whole-number or uuid keys the data proves
  unique), and never a second join between two tables that already have one:
  no more `order_item → product` on `product_name` next to `product_id`. The
  field list never shows two groups that read the same: one join per related
  table and name, a key join over a label join, a certified one over a draft
  (an older descriptor's twins are named by their keys).
- **Smaller fixes.** Closing the relationship editor asks "Discard your changes? The
  relationship stays as it was." **Finish setup · Build an App** opens the new
  App form, also when Apps already exist. **View as** is hidden for a
  one-person App without row rules, where every role sees the same rows
  ("Sees all rows" replaces "no RLS narrowing"). Publishing keeps the
  description the author wrote, or the App's existing one, and fills "A
  dashboard of live numbers for <Domain>." only when there is none — never
  "Governed analytical App for …". `zlens doctor` says "19 metrics and 5
  measures" where it said "24 metrics", matching `zlens sync` and Setup;
  `zlens sync` reads `semantic_manifest.json` when the manifest lists no
  metrics, and says so when the manifest cannot be read instead of "0
  metric(s)".

### Trust: one answer on every screen

- **One trust answer for an App.** The publish check, the editor's tile dots
  and Data & trust panel, the App header, the reader's trust line, the Apps
  card and the `dql.app.json` written at publish now read the same answer
  (`appTrustAnswer` in `@zlens/core/apps/app-trust`): every tile's source,
  every join it can run through (its own fields, and page filters that reach
  it through a related field), its calculations, and whether data that needs
  review was allowed. An App is published as certified only when every data
  tile is; `dql.app.json` records `tileTrust: { certified, total }` and the
  Apps card shows the App header's words ("1 of 3 tiles certified"), after a
  reload too, never "App certified" over a tile that needs review.
- **Ready, with review data allowed, says so.** After **Allow data that needs
  review** the publish dialog reads "Ready to publish · 2 tiles need review
  (allowed)" and what the App will say; "All checks passed" / "Every check
  passed" only appear when every tile is certified.
- **A reader's filter no longer changes trust.** A tile a page filter reaches
  through a join nobody certified is Needs review whether or not a value is
  picked, so picking a customer no longer flips "3 of 4" to "1 of 4". The run
  receipt says "A page filter can join it to customers on customer_id; the
  join is not certified yet" for a join the run did not read.
- **"Certified by you" means you.** Only your own identity (git `user.email`,
  `$USER@local`, or the host's signed-in person) makes a certification "by
  you"; the project's `identity.owner` (a sample's "analytics@jaffle.shop")
  no longer does, and is no longer shown under your name. New certifications
  and checks record your identity, not the project owner. A team mailbox is
  named with its domain: "Certified by Analytics (jaffle.shop)".
- **An honest fix count.** The Publish button and the publish dialog count
  one list, so "5 fixes" no longer opens "9 fixes": a review task or a server
  message about data or a tile already listed is not repeated, and the page
  Publish runs itself is not counted. Plain words replace "Scoped review",
  "Orders is review" ("Orders needs certifying before this App is
  published…") and "Complete governed validation" ("Run the page once to
  check it", with the server's words under **Technical details**).
- **A checked draft join reads Draft** in Modeling, the level its editor
  opens on, instead of "Validated".


### Trust: checking is not certifying

- **Adding a table no longer certifies it.** **Check and add** runs the same
  checks as before and adds the table as **Checked · Needs certifying**; its
  main button is **Check and use** (there is no "Certify and use this data").
  Tiles work right away, under "Only certified data" too. **Make row-level**
  on a saved query does the same. The block is written `status = "review"`
  with a `check:` record (who, when, what was found, for exactly that source)
  in its companion YAML.
- **Certify on purpose, at publish.** The publish check lists data that is
  not certified yet ("2 tables not certified yet"); each opens a short review
  — what one row is, the row key checked again, number formats (cents in
  dollars), joins used, columns hidden as duplicates — and one button, **I
  vouch for this — certify**. The same review is under the data's **⋯ →
  Certify…**. Saved queries keep their own **Certify** in Block Studio and are
  listed too. "Only certified data" still blocks publishing until it is done,
  and the server's preflight and publish refuse uncertified data
  (`APP_BUILD_DATASET_NOT_CERTIFIED`). New route: `POST /api/app-datasets/certify`
  (gated as `dataset.certify` with a host, so steward rules are unchanged);
  `GET /api/app-datasets/certify-review`. `tables/create` and
  `saved-queries/create` are authoring (`dataset.author`) now and answer
  `status: "checked"` with `check` instead of `certification`.
- **Who certified, from the reader's side.** "Certified by you · 22 Oct" when
  you certified it, "Certified by Kranthi · 22 Oct" for anyone else, and the
  App header reads "All data certified by you". A checked tile says **Needs
  certifying**.
- **Duplicate columns, one question.** When a table has `order_total` and
  `order_total_cents`, the check asks once, "Use Order total in dollars?"
  (recommended), and hides the other column; the choice is kept in the
  Dataset's definition.
- Data certified before this change stays certified.

### Wording

- **Blocks are now called Saved queries** everywhere people read: the left
  rail, the saved query editor and library, notebooks, Ask, Apps, the App
  reader's receipts ("Runs a certified saved query exactly as it was
  reviewed"), in-app Help and the user guides. Nothing changes on disk:
  `.dql` block files, the DQL `block` keyword, the `zlens block` CLI, MCP tool
  names, the API and the reference docs keep the word `block`. Where a page
  needs the file or the CLI, it says so once: "saved query (a `.dql` block
  file)".
- **Fewer nouns in Apps.** App Studio and the reader say "data" instead of
  "Dataset" ("Choose data", "This App's data", "Define fields"), and no
  longer show "Model area", "Binding" or "Canvas" ("Refresh this data",
  "Pages"). Files, the API and the reference docs still say Dataset.
- **Domain is explained once.** The App Start form's Domain field says "A
  Domain groups data by business area, like Sales or Finance"; the domain
  chips in Add data carry the same line as a tooltip.

### Setup and first start

- **A database-only first run in plain words** (new-user round 2, Q3):
  - **Grouped notes.** Drafting no longer adds one `MODEL_AREA_DEFAULTED`
    note per table: one line says *13 tables placed in the default area*.
    The review drawer is titled **Review the models ZLens drafted**, shows one
    plain line per kind of note and says what each change does (*Add orders
    as Order in Jaffle shop*). Codes, operation ids (`scope:domain:…`), patch
    counts and the proposal hash are under **Technical details**.
  - **A real Domain name.** The first Domain is named after the database
    file or catalog (`jaffle_shop.duckdb` → **Jaffle shop**), never a schema
    named for a layer or environment (`dev`, `main`, `public`); schemas like
    those map into it. A business-area schema (`sales`) keeps its own Domain,
    and so does a schema Domain the project already has. Setup offers
    **Rename**; `zlens model discover --domain` still names one.
  - **No staging clutter.** When a staging copy (`stg_*`, or a table in a
    `staging`, `stg` or `raw` schema) and a final table hold the same thing,
    the final one is shown and drafted. **Show staging tables** brings them
    back in setup's schema list, **Draft my models** and Modeling's
    **Draft from warehouse**, and **Apps → Data**. `zlens model discover`
    leaves them out too; `--include-staging` drafts them.
  - **Drafts kept.** What **Draft my models** drafted waits until you save
    or discard it: leaving Setup or Modeling without Save, or reloading, loses
    nothing. Modeling, Setup and Apps say *N drafted models waiting for
    review*, with **Review drafts** and **Discard** (**Keep for later** in the
    review). A newer draft replaces the one before it. New endpoints:
    `GET /api/modeling/warehouse/drafts` and
    `POST /api/context-proposals/:id/discard` (a proposal's status can now
    be `discarded`).
  - **Honest wording about rows.** "never their rows" is gone: *ZLens reads
    table structure and counts rows to check keys. Sample rows are shown only
    to you, on this computer. Nothing is sent anywhere unless you turn on
    value profiles for AI answers.* With value profiles on, Setup says *Value
    profiles are on: a few column values are sent to your AI provider*
    (`GET /api/connections` reports `valueProfile`). Setup's sync line reads
    *Read 13 tables (86 columns)*.
  - The welcome screen, Guided Setup and Modeling's **Saved queries** tab say
    "saved query" where they still said "block" (**Save a query** / **New
    saved query**, "certified saved queries").

- **Start from any folder.** `zlens notebook <folder>` on a folder with no
  ZLens project asks **No ZLens project here. Create one? [Y/n]** and creates
  it. A database file and no dbt project make a **Database only** project
  with a connection to the file; `dbt_project.yml` makes a dbt project.
  Without a terminal it prints the one command to run
  (`npx zlens notebook <folder> --yes`); `--yes` creates without asking.
- `zlens init` on a folder with only a database file now creates a Database
  only (`warehouse-first`) project, and no longer suggests rerunning with
  `--warehouse-first`. An empty folder leaves the choice to Guided Setup.
  `zlens init --help` and `zlens notebook --help` explain both.
- **Two plain setup questions.** Guided Setup picks the card from what the
  folder holds (Database only, dbt project as before, or an existing
  project whose model is written). Step 2 asks **Which schemas should ZLens
  read?** and lists the schemas as soon as the connection test passes.
  Semantic execution adapters, Index mode, the typed schema list, index
  details and dbt profile import are under a closed **Advanced**; Database
  only never shows the dbt profiles from your home folder, never says
  "outside the dbt project", and no generated ids (`LOCAL_88B5…`) are printed.
- Setup progress is saved in `.dql/local/setup-progress.json`: a restart
  resumes at the same step with your answers and drafted models. Finishing or
  closing setup clears it.
- The connection test no longer races a save on the same DuckDB file, so
  **Find available databases & schemas** is never left disabled (it once
  hung a browser journey for four minutes). The footer says **Test passed**
  after an automatic test too.
- **Drafted tables are ready to use.** In **Apps → Data**, tables Setup
  drafted show **Drafted — review to use** with a link to Modeling, and tables
  the model binds show **Modeled**; both come first. **Check and add** reuses
  the row key the draft checked, so the check counts one column.
- New projects no longer get the **Example Customer Rollup** placeholder block
  (`SELECT 1`); an untouched copy in an older welcome notebook is no longer a
  block, so it leaves the Data step.
- In-app **Help** starts from a folder (database file or dbt project), covers
  Guided Setup and Apps, and has no image placeholders.

### Blocks

- **The SQL block builder saves.** Every edit lands inside the block also
  when the file opens with the `// dql-format: 1` header or has a comment
  after its closing brace, so Save draft no longer writes `owner = …` after
  `}`. SQL typed in the Visual Builder is kept in the draft, so it survives
  switching to DQL Source and back. Run, Save draft and Certify stay on
  screen at 1280 px. **Global / cross-domain** stays global instead of coming
  back as "uncategorized (missing Domain page)".
- A parse error names the line, column and token of the first problem
  (`Parse errors in <block-invocation>: line 14, column 3: Unexpected token
  'owner' …`).

### Apps

- **Without AI, build an App from three quick choices.** With no AI provider
  connected, **Build new App** opens on **Quick start** instead of a
  "Describe with AI" tab that matched the words of a request (it picked the
  wrong data and measure, made no KPI, gave tiles snake_case titles and named
  the App after the whole sentence). Pick the data, then **KPI** (Total of a
  measure), **Trend** (a measure by month, week, …, over the data's main
  date) and **Top** (Top 10 of a field by a measure); **Add another tile** goes
  up to six. **Build App** adds exactly those tiles as ordinary field tiles —
  a single value, a line, and a bar sorted by the measure showing the top N —
  with plain titles ("Total Lifetime Spend", "Order Total by month", "Top 10
  customers by Lifetime Spend"). The pickers list this App's fields as the
  Data pane names them, related fields included, Domain first and certified
  first. An App left unnamed is called "<Domain> overview". In the Studio,
  **Quick tiles** replaces "Suggest tiles" and adds the same choices to the
  open page. Free text and AI planning are unchanged with an AI provider;
  "Connect an AI provider to describe an App in your own words" links to
  Settings.
- **Filters follow dbt relationships.** In a dbt project, a Customer Name
  filter reaches the Orders tiles "via Customer", as in a database-only
  project. The jaffle-shop sample has a dbt `relationships` test from
  `orders.customer_id` to `stg_customers`, while its semantic model joins
  the same column to `customers`; Orders followed both, so its field
  list showed "Customer · 8 fields" and "Customer · 1 field", and Customer
  Name was ambiguous ("Orders has no Customer Name field"). Each foreign key
  is now followed to one table: a certified or model join wins over a dbt
  test, and a mart over its staging copy. **Add data** also lists a dbt
  project's joins ("joins customers, locations"), which it missed when the
  warehouse named the table without its database.
- **New tiles can join existing filters.** A tile added after a filter says
  **Customer Name filter can apply to this tile** with **Apply** and **Not
  now** when it has the field or reaches it through a join. Nothing links on
  its own.
- **Dates rank by the tile's own main date.** In the filter field list a
  Dataset's main date comes first (Orders → **Ordered At**), and counts say
  how many tiles a field reaches only through a join, so a customer's
  **First Ordered At** no longer looks like the best date for Orders. A tile
  without the filter's date offers its own main date first.
- **Steadier editor.** The Data pane's field list no longer moves down a line
  when a new tile starts (a click meant for Customer Name landed on Customer
  Id). A measure pill shows **Top 10 ▾** or **Sorted ↓**, and **Sort & top**
  is first in its menu. A KPI's figure fits its tile when a **Not filtered
  by** pill sits above it (no scrollbar), and bar-chart value ticks never run
  together (`$500`, `$1K`, `$1.5K`, not `$500.0$1.0K`).
- Readers no longer see a tile's source id or **text** under a text tile's
  title. A text tile's heading is its own line in the editor ("Sales Manager
  Overview" above the sentence). Starting layouts say what they make (an
  intro to edit; you add the tiles), and the manual button reads **Open
  Studio with an intro** unless the layout is Blank. The intro tile is named
  **Intro**.
- **Plainer copy and state.** A value list counts the field's values ("Type
  to search all 930 values", not the first run's 500 rows), and a search
  under it says "4 matches", not "200+ available values". The filter field
  search starts empty for each new filter. Publish says the App is saved as
  files in your project folder, and mentions git only in a git repository. A
  published App with an unpublished draft is one card (**Unpublished
  changes**, **View**, **Continue editing**), not two of the same name. Apps
  cards and the Data list show this machine's person by one name (the
  "Certified by" name: git `user.name`), not a noreply email or
  `name@local`.
- A table's caption talks about the measure it is sorted by: the sample's
  "Customer lifetime profiles" (sorted by spend) said "Melissa Lopez leads
  Count Lifetime Orders at 231", naming someone not in view; it now names the
  top spender.

- **Fields from related tables (design D2).** A table Dataset now shows the
  fields of the tables its rows point to through a checked many-to-one join:
  under **Orders**, **Orders → Customer → Customer Name** and **Orders →
  Location → Location Name**, up to two steps when each is many-to-one. A bar
  of **Order Total** by **Location Name** reads store names, not UUIDs. The
  tile query adds a LEFT JOIN on the join's keys only for the related fields
  it uses, and only when the related table holds each key once: current
  warehouse evidence covers that, otherwise one bounded query checks it before
  the tile runs, and a repeated key stops the tile with a plain message. A
  test checks that totals and counts are identical with and without a joined
  field. One-to-many joins are never followed; the field list says *Orders per
  customer: add it from Orders*. Joins come from Modeling relationships (with
  the ones imported from dbt and MetricFlow), joins **Draft my models**
  drafted in setup, and dbt `relationships` tests. A certified join keeps the
  tile's trust; a drafted one shows **Needs review** on its group and makes a
  tile that uses it **Needs review**. The receipt lists each join: *Joined to
  customers on customer_id (each order has one customer — checked)*. **Add
  data** says which tables a table reaches (*joins: customers, locations*).
  - **Filters reach joined tiles.** A **Customer Name** filter offers the
    Orders trend as *Orders · via Customer* under **Also filter these
    tiles?** (still unchecked until you check it), and the field appears once
    in the filter list. Unlinked tiles still say **Not filtered by**.
  - Descriptors gain optional `joins`, `joinNotes` and a field's `related`
    (read, checked and round-tripped by the descriptor reader); existing
    Datasets and tiles are unchanged, and a tile on a Dataset's own fields
    compiles to the same SQL as before. The App source catalog takes a
    runtime record decorator (`registerAppSourceRecordDecorator`), so the Data
    pane, planner, previews and runs read one descriptor.
- **Honest when no AI is connected.** With no AI provider, **Build new App**
  opens on **Start manually**, and **Describe with AI** says **Connect an AI
  provider to describe an App** (to Settings → AI provider) with **Try keyword
  suggestions** as the second choice. The built-in keyword matcher is never
  called AI: its Data step says **Suggested from keywords · no AI connected**,
  and its activity steps, notes, canvas tile review and the Studio's **Suggest
  tiles** entry point say the same. What only an AI can do (changing one tile,
  designing a layout) says **Connect an AI provider**. With a provider
  connected, nothing changes. The providers settings answer now includes
  `assistAvailable`, so this also holds under a host's model.
  - Parts of a request the keywords did not match are notes under **Not
    covered yet**, never publish fixes: no more **Unanswered App question** for
    *Keep it short and clear*.
  - A proposal never adds a tile the page already shows (it says so in its
    notes), and the review counts only the tiles it adds, so a revise no longer
    duplicates tiles.
- **Filters say where they don't apply while you edit.** The builder and
  Preview now mark every tile a filter skips with "Not filtered by <filter>",
  the same notice readers see: pick a customer, and a revenue KPI the customer
  filter doesn't reach says so. The notice comes from the run's own report of
  which filters applied, and from the page's link choices before a tile has
  run with the new value. Edit also shows each tile's reach before a value is
  set; Preview shows notices only for filters that have a value, as readers
  see them.
- **The page summary describes filters correctly.** A date range reads
  "1 Jan 2025 – 30 Jun 2025" (not `[object Object]`), filters use their
  labels, and tiles narrowed by different filters are each described with the
  filters that reached them ("For Month … (not filtered by Customer Name)")
  instead of claiming no tile was filtered.
- **Search every value in a filter.** A filter's value list loads the first
  200 values and says "Type to search all 930 values"; typing searches every
  value of the field on the server (a bound, escaped match through the
  governed query compiler), in the builder and in the published App, where the
  long native list is now a searchable control. `POST
  /api/app-datasets/field-values` takes an optional `search` and returns
  `valueCount` when browsing.
- **Map a date filter to a tile's own date field.** When a date filter's field
  isn't on a tile's data, the Filters tab offers that data's date and time
  fields ("Use Ordered At on Order Items"). Nothing maps on its own; the choice
  is saved as that data's filter binding and kept when the filter is reopened.
- **Numbers and labels stay visible.** "Rolled up from a saved query" moved to
  an info icon in the tile header, so a KPI's value shows at the default tile
  size; "Not filtered by" notices are one line. Bar charts name every bar
  (long names are shortened, with the full name in the tooltip; crowded
  columns rotate their labels), draw every bar a "Showing top 25" note counts
  (they drew only 20), and a top-25 list gets one row per bar, scrolling in a
  short tile. The click-to-filter hint under a chart shows on hover or while a
  click-filter is active, not all the time.

- **"Certified by <name> · <date>" everywhere.** "Certified" now always says
  who and when: on tiles and their receipts, the Data list and Add data rows,
  the App header (**All data certified by Kranthi · 21 Oct**), the Apps card
  (**App certified by Kranthi · 21 Oct**), block pages, and the result of
  **Certify and use this data** and **Make row-level**. Certifying records the
  person's display name (the host's signed-in person, else git `user.name`)
  beside the identity and time it already recorded, and publishing an App as
  certified records who and when in `dql.app.json` (`certifiedBy`,
  `certifiedAt`). Data certified before this shows **Certified · date** or
  **Certified**. Receipts list the **Checks passed** in plain words: what one
  row is (the row key), how each number is shown (money stored as cents is
  shown in dollars), and the Certify checklist (ran without errors, tests
  passed). Enterprise steward rules are unchanged.
- **Plain words; technical details on request.** App Studio and the reader say
  **All tiles up to date** (not "Preview settled · 3/3 ready"),
  **Unpublished changes (only you can see them)** (not "Safe local edit draft"
  or "LOCAL DRAFT · Not in Project source · Revision N"), **Page style:
  Dashboard**, **Summarise / Show rows**, **12 rows**, and
  **Clicking a bar filters other Customers tiles** instead of "Keep only
  reaches tiles on this Dataset". Ids, hashes, run and snapshot ids, raw trust
  states and fingerprints in tile receipts, the evidence appendix, block
  receipts and the Dataset definition dialog sit under a **Technical details**
  toggle that starts closed. Table headers show column types as icons with
  **Number**, **Text** and **Date** tooltips.
- **The auto-written Summary is off by default.** Reader pages, new and
  existing, show the Summary (formerly "Business Story") only when the
  page's author added it with **Summary** under **Page elements**
  (`metadata.summary` on the page). Preview now shows exactly what readers
  see: the Ask box, the trust line, the Summary when added, then the tiles.
- **Apps cards show Pages and Updated.** "Books", zero "analysis" and
  "local insights" counts and "Shared Project" are gone; counts appear only
  when they are above zero.
- **Everything you add has fields.** A saved query's result columns are now
  fields on the same shelves as any other data, with no review step: numbers
  are Measures, text and true/false columns are Dimensions, dates are Time
  fields by day, week or month, and Count of rows is always there. Month +
  Gross Revenue on a monthly saved query is one line; Customer Name +
  Lifetime Spend is a bar that adds up.
  - Tiles run as one query over the saved query's complete result. Grouped by
    the saved query's own columns, values show as they are; any other tile
    rolls rows up with Sum, says **Rolled up from a saved query**, and its
    receipt says "Rolled up from the certified result of <name>". A column
    named like an average or a ratio (`avg_`, `pct`, `rate`, `ratio`,
    `_share`, `margin`) is never summed: ZLens offers Min and Max instead.
  - Trust is unchanged: a certified saved query's tiles are Certified, and
    ones that need review stay Needs review. Page filters and click-to-filter
    reach these tiles like any Dataset tile, and they publish like one.
  - The column types are read once per saved query revision (a one-row read
    through the usual execution path) and kept in `.dql/local`; a fresh
    checkout reads them again on first use. Existing pages with fixed saved
    query tiles keep working unchanged.
  - **Data for this App** is one list: each row says where it comes from
    (Table · Saved query · Metrics), its trust and domain, and shows its fields
    when opened. Chips (All · Tables · Saved queries · Metrics) replace the
    three tabs; tables not checked yet are in the same list.
  - "Add fields" is now **⋯ → Make row-level**, only needed for row-safe
    measures such as distinct counts.
  - **Describe with AI** (the planner and the AI Data step) and Ask's **Open
    in App Studio** read a saved query's fields the same way, so AI-built tiles
    use them; a saved query whose fields can't answer is shown as it is.
- **Sort and Top N on the field menu.** A measure pill's **⋯** menu now has
  **Show top** **5**, **10**, **25**, **All** or another number, next to
  **Ascending** and **Descending**. It writes the same sort and row limit as
  **Filters, sort and more**, so the two always agree.
  - A new bar chart over categories is sorted by its measure, highest first.
    Saved tiles are unchanged.
  - A bar chart with more than 50 categories draws the top 25 with
    "Showing top 25 of 935 · Show all", in the editor and for readers. A tile
    with its own **Show top** number is drawn as set.
- **Source names instead of internal IDs.** The filter field list says
  "from Customers", not `General::Block::Customers::8f7f…`. A tile a filter
  can't reach says "Monthly Revenue has no Customer Name field." instead of
  "not exposed by commerce::block::monthly_revenue::88e1…" or "approved
  physical field", in the editor, the Filters tab and for readers (older Apps'
  stored reasons read the same way). Filter field search ignores spaces,
  underscores and capitals: "customer name" finds Customer Name.
- **Smaller editor fixes.**
  - After **Add to page** the new tile is not selected, so the next field
    click starts a new tile instead of changing the one just added.
  - **Delete** removes the selected tile while focus is in its **Tile
    settings** (not while typing in a field).
  - A tile's **⋯** menu opens above its own table and the tiles after it.
  - Tile titles wrap to a second line instead of "Lif…", and a KPI figure
    shrinks to fit its tile instead of "$2,880.…". A tile's tools keep their
    own room in the header (on their own row in a narrow tile), so they never
    cover the title or the trust dot.
  - A table holding the first 500 of 935 rows says "Showing 1–10 of the first
    500 rows · 935 in total", and **Tile settings** says "Live · 935 rows ·
    first 500 loaded".
  - **Add data** shows "Finding data…" while it loads, not "No certified data
    yet" and a 0 count.
  - The App editor's top bar no longer scrolls out of view.
  - The reader's top bar shows the App's name, not its id.
  - Two items with the same name show where they come from: "Orders · Table"
    and "Orders · Metrics".

- **Editor filters apply at once, to linked tiles only.** Changing a filter
  in App Studio re-runs just the tiles it applies to, without pressing
  **Run**; other tiles keep their result. A second change now runs the new
  choice (before, an App-wide filter ran the previous one).
  - A date range can have one end: only a start means "from that day"
    (**From 1 Mar 2025**), only an end "until that day". This works on every
    tile type, in the editor and for readers.
  - Date filters compare calendar days on timestamp columns too, the same
    calendar a chart's day or month buckets use, so a range ending 30 June no
    longer plots a July point.
  - No more "No date values exist for this field" when values just weren't
    read yet, and no "could not be converted into a predicate" from a
    half-filled range. A date filter can be created before the page has run.
- **A just-published App opens on its results.** It no longer opens on
  "0 of N tiles certified", "No result." and "A newer dashboard interaction
  superseded this run." An App page runs once when it opens, also when it has
  filters, and runs again only when the page or a filter value changes. The
  local server orders one viewer's runs by when they were asked for, not when
  they arrived, and an identical request shares the run already in progress
  instead of cancelling it. If a run still comes back stale, the reader runs
  it again by itself. The Apps card no longer says "App certified" while the
  App's last run in that session found tiles that are not certified.
  - Page-run requests take an optional `runSequence`; a stale response says
    why in `staleCause` (`superseded` or `project_changed`).

- **Smaller App builder fixes for a first-time user.**
  - A line or area chart plots only the field chosen as **Y / value**, as bars
    already did.
  - **Check the numbers** reads `…_cents` and `…_pennies` columns divided by
    100 in the Dataset's own SQL and shows them as Money, with "Shown in
    dollars (stored as cents)", so tiles, KPIs, tables and filters agree.
    **Add fields** on a saved query keeps them a plain number, because it
    does not change the saved query's SQL.
  - **Add fields** accepts a month (or another period, or a date) that is
    filled and different on every row as the row key. It stays a time field,
    and tiles can roll it up to quarters, years and one total.
  - Every field the check confirms is written as approved, and the keyword
    planner (no AI) builds tiles from a table checked a moment ago: it picks
    the number and the grouping your request names, and no longer says the
    table "can't answer".
  - **Describe with AI** starts empty; its example is a placeholder. The App
    is named from the first line of the request (at most 60 characters), and
    you can rename it.
  - **Finish setup** goes where the highlighted card says: **Build an App**,
    or Modeling when models were drafted.

- **App filters work the same on every tile.** Each tile on a filter's page
  is now **Applies** or **Does not apply** in the Filters tab, and both
  choices are saved. **Does not apply** no longer blocks publishing; only a
  tile with neither choice does, and the publish check points to the Filters
  tab. Readers see **Not filtered by** *filter* on those tiles.
  - Metrics tiles filter on any dimension of the metric's model, so a KPI is
    filtered too. A date range is no longer sent as a list of two days.
  - One date rule everywhere: a date range runs from the start date through
    the whole end date, a single date is that whole day, and a relative date
    becomes a range first. Saved query `_end` parameters still receive the
    last day you picked.
  - Draft tiles take linked filters the same way Saved query tiles do, and
    their evidence says which filters applied and which didn't.
  - A Saved query tile marked **Does not apply** is not filtered through a
    parameter with the filter's name.
  - Each tile in a page-run response has `filterReport`: the page filters
    that applied and the ones that didn't, with why. Readers' pills use it.
  - The publish message for a tile with no choice is now *page/tile* **has no
    choice for filter** *Label*.

- **Field-based tiles are on by default.** App Studio builds tiles from a
  Dataset's measures and dimensions without first asking you to turn the
  feature on, and the "Turn on field-based tiles" banner is gone. To turn
  them off for a project, set `"apps": { "datasets": false }` in
  `dql.config.json`; Studio then says so in one line.
- **Apps that AI builds in Ask open in App Studio.** The Ask Build Brief's
  button is now **Open in App Studio**. It makes a local App Studio draft that
  opens at the Data step: the data behind the tiles you kept becomes the
  App's data, and it uses **Only certified data** unless you kept data that
  needs review. No App files are written until you publish, and publishing
  goes through the publish checks. AI-written SQL is never added as a tile;
  its question is listed under **Not covered yet**. The Build Brief says
  **Certified**, **Metrics · Needs review** and **Draft SQL · Needs review**.
- **Removed: `POST /api/apps/ai-builds/:id/commit`.** It wrote an Ask
  proposal straight into `apps/<id>`. Use
  `POST /api/apps/ai-builds/:id/open-in-studio`, which returns the App Studio
  draft instead.

### AI agents (MCP)

- **Breaking: `build_dql_app` starts an App Studio draft and writes no App
  files.** It used to write a draft App under `apps/`. It now returns
  `draftId`, `appId`, `name`, `domain`, `sourcePolicy`, `openPath`
  (`/?appDraft=<id>`), `openUrl` when `zlens notebook` is running on the
  project, `sources` (each with its kind, trust and the reason it was picked),
  `notCoveredYet`, `warnings` and `nextActions`. Open the link to check the
  data, build the pages and publish in App Studio.
  - Removed from the result: `plan`, `generated`, `validation`,
    `certifiedTiles`, `draftTiles` and `lifecycle`.
  - `owner`, `aiLayout` and `overwrite` are still accepted but ignored.
  - `saveDraft: false` returns the picked data without creating a draft.
  - `blocks` still names the exact certified blocks to use, now as the App's
    data.
- **Certified blocks first for chat clients with no guide file.** Claude
  Desktop reads only the MCP server instructions; asked "How has revenue
  changed by month?" it called `query_semantic_model` and said no certified
  block answered, while `monthly_revenue` did. The instructions now give one
  order: `ask_dql` first, a `certified` route goes to `query_via_block`, and
  the semantic layer only when `ask_dql` finds no certified block.
  - `inspect_dql_project` lists `certifiedBlocks` (name, domain, grain,
    description) and returns `nextTool: "ask_dql"`.
  - `query_semantic_model` checks for a certified block first: through the
    `ask_dql` router for a question, and by measure, table and time grain for
    explicit members. When one answers, the result leads with
    `certifiedBlock` and `nextTool: "query_via_block"`, and no duplicate
    draft is saved. It no longer says "No certified block exactly answered
    this question" unless the check ran and found none.

## v0.2.2 - 2026-10-19

Sharing through your own git repository now works from the workbench without
a terminal, and the DuckDB driver says which Node to use instead of failing
on Node 25 and 26.

To upgrade, run `npm i -D @zlens/cli@^0.2.2` in each project. Use Node 20, 22
or 24 (Node 24 LTS recommended).

### Source control

- **Connecting your own repository works on the first send.** A repository
  the host created with a README, licence or `.gitignore` no longer loops
  between "Get updates first" and "Send the branch first": ZLens brings those
  files in (your project's README wins; missing `.gitignore` lines are added)
  and sends. A repository holding other, unrelated work is never combined
  with the project; the message says how to add ZLens to it instead.
- **Know before you send.** The Source control page checks the remote in the
  background and says "3 new on the remote · 1 of yours not sent", "Up to
  date" or "Can't reach the remote". Send asks you to get updates first
  instead of failing.
- **Send from the main branch goes to a new branch by default**, ready for a
  pull request, and leaves the main branch as the team has it. Sending
  straight to the main branch asks again.
- **Get updates works when you and the remote both changed.** Your unsent
  changes are replayed on top of the team's; changes you already sent are
  never rewritten. Files changed on both sides get Compare, Keep mine and Keep
  theirs, then Continue, or Cancel update to put everything back. Undo update
  reverses a finished update.
- **Review branches stay current.** Get updates on a review branch also brings
  in what the team merged into the main branch.
- **The ZLens sample is read-only.** In a folder cloned from
  `jaffle-shop-duckdb` or `jaffle-shop-warehouse`, Send is not offered;
  Connect your own repository keeps the sample as `upstream`.
- **Pull requests target your repository's default branch** (`main`,
  `master`, `develop`…), not a guess.
- **New projects start on `main`** (or your `init.defaultBranch`), not git's
  `master` fallback.
- New guide: [Share your work with your team](docs/notebooks/share-with-your-team.md).

### Fixed

- **Remembered filter values are checked before they apply.** A reader's App
  filter values are kept in the browser between visits. A value left by an
  earlier App with the same id (same port), or by a filter that was since
  re-created or moved to another field, was applied without a check: the
  control said **All** while a tile was narrowed to a customer the reader
  never picked. Each remembered value now carries the filter it was chosen
  for (id, control type and field, including each Dataset's mapped field) and
  applies only to that same filter, as a value its control can show; anything
  else is dropped and forgotten. A value that does come back is shown in the
  control, with **Opened with your last filters** and **Reset** beside it. A
  multi-select given a single name shows that name, never **All**. The Share
  note now says the link does not carry your filter choices.
- **The review appendix reads plainly.** The reader's **Evidence & review
  appendix** printed `ordered_at: [object Object]` for a date range and
  "1 sources" for two data sources. Filters now read by their label and in
  words (**Ordered At: 1 Jan 2025 – 30 Jun 2025**, **From 1 Jan 2025**,
  **At least 500**), and the count is of distinct data sources ("1 data
  source", "2 data sources"; two tiles on one Dataset are one). The same
  wording is used by the summary story (which used to leave a date range
  out), tile receipts (**Ordered At from 1 Jan 2025** instead of `ordered_at
  gte 2025-01-01`), result-mark chips, Ask's filter chips and Research.
- **Joins count in the publish check.** Under **Only certified data**, an App
  published with a tile marked Needs review because it read a field through a
  join nobody certified yet (drafted in setup), and the check said **Every
  check passed**: it looked only at sources. Publish readiness, in App Studio
  and on the server (preflight and publish), now looks at every Dataset tile:
  its groupings, filters, detail columns, calculations, driver, and the page
  filters mapped to it through a related field. Each such tile is a fix,
  **Tile needs review**, with **Certify the join in Modeling**, **Remove the
  related field** and **Allow data that needs review**; the server refuses with
  `APP_BUILD_TILE_NEEDS_REVIEW`. A join certified since passes, and with
  **Also allow data that needs review** the tile publishes as Needs review.

- **DuckDB on Node 25 and 26.** ZLens's DuckDB driver has no prebuilt binary
  for those versions, so its install fell back to a 10-minute source build
  that usually failed, and the Connections test said the driver was missing.
  Startup, Connections (Test and Install) and `zlens doctor` now say "use Node
  24 LTS or 22" and never start that build on their own
  (`ZLENS_DUCKDB_BUILD_FROM_SOURCE=1` opts in). `@zlens/cli` declares Node 20,
  22 or 24 in `engines`. Moving to `@duckdb/node-api` is proposed in
  [RFC 0011](docs/rfcs/0011-duckdb-node-api.md).
- **A DuckDB file written by DuckDB 2.0 says how to fix it.** ZLens reads
  DuckDB files with DuckDB 1.4, and Python `duckdb` 2.0 (which `dbt-duckdb`
  now installs) writes files 1.4 can't open. Instead of only DuckDB's "version
  number 999 … newer version of DuckDB", the connection Test and `zlens
  doctor` now say the file came from DuckDB 2.x and to rebuild it with
  `pip install 'duckdb<1.5'` (then rerun dbt), with DuckDB's message
  underneath. Both samples now pin Python `duckdb` to 1.4.

## v0.2.1 - 2026-10-16

ZLens on npm 12. npm 12 (the current `latest`) runs a dependency's install
script only when `package.json` lists the package in `allowScripts`.
`better-sqlite3`, which holds ZLens's local index, and the `duckdb` driver
download their native binary in that script, so on npm 12 the JavaScript
installed without the binary: `npm run sync` failed with "Failed to compile
project: Could not locate the bindings file", `npm run notebook` with
"Error: Could not locate the bindings file", and the DuckDB driver reported
itself missing although it was installed.

To upgrade, run `npm i -D @zlens/cli@^0.2.1` in each project. On npm 12, also
add `"allowScripts": { "better-sqlite3": true }` to the project's
`package.json` (the two samples already have it), or, in a folder that is
already installed, run `npm install-scripts approve better-sqlite3` and then
`npm rebuild better-sqlite3`. For a global install, run
`npm i -g @zlens/cli --allow-scripts=better-sqlite3`.

### Fixed

- **A clear message instead of "Could not locate the bindings file".** When
  better-sqlite3 cannot load its native binary, every command that opens
  ZLens's index stops before it starts, says what happened (npm 12 blocked
  the install script), prints the commands that fix it for this kind of
  install (project, global or npx; pnpm 10 gets `pnpm approve-builds`), and
  exits 1. A binary built for another Node version gets `npm rebuild`.
- **`zlens doctor` checks the native modules.** A new **SQLite native
  module** check, and the **DuckDB connector package** check now fails, with
  the repair commands, when the driver is installed but its binary is
  missing.
- **The DuckDB driver repairs itself.** When ZLens installs a driver into
  `.dql/connectors` (the Connections page, a saved connection, or workbench
  startup), it writes `"allowScripts": { "duckdb": true }` into
  `.dql/connectors/package.json` first. A duckdb installed by hand without
  its binary is rebuilt when the workbench starts or `zlens sync warehouse`
  runs, and loading one that still cannot load names the two commands
  instead of asking you to install it again.
- **`create-zlens-app` projects work on npm 12.** Every project it writes
  (dbt and `--warehouse` modes) allows better-sqlite3's install script in
  `package.json` (and in `pnpm.onlyBuiltDependencies` for pnpm 10), and gets
  a `.dql/connectors/package.json` that allows duckdb's, so the driver step
  it prints works as written. New projects ask for `@zlens/cli` `^0.2.1`.

### Docs

- The Quickstart, Install (a new **npm 12 and install scripts** section),
  Troubleshooting, Connectors and the README have the `allowScripts` entry,
  the two commands for an existing folder, and the `--allow-scripts` flag for
  a global install.

### Release checks

- The launch gate runs every sample and `create-zlens-app` under npm 12 as
  well as the system npm (`--npm system,12`, with `--node` for a Node that
  npm 12 supports). It fails when `npm install` blocks an install script,
  and checks that better-sqlite3 and the DuckDB driver load.

## v0.2.0 - 2026-10-16

Certified answers on your warehouse. This release adds a database-only path,
from install to a certified join, and fixes what testing 0.1.0 found in Ask,
Apps, Modeling, lineage and the CLI.

To upgrade, run `npm i -D @zlens/cli@^0.2.0` in each project, or
`npm i -g @zlens/cli` for a global install. A project that declares
`"@zlens/cli": "^0.1.0"` stays on 0.1.x, because a caret range below 1.0 does
not cross minor versions. No project files need to change, unless a model
or join declares a `status:` ZLens does not know (see Modeling).

### New: start from your database, no dbt needed

- **Guided Setup asks "Where does your data model live?"** Pick **dbt
  project**, **Database only**, **Both** (a dbt project plus schemas dbt does
  not cover), or **Open an existing ZLens project**. The Welcome screen offers
  the same choice.
  - **Database only** connects your database, lets you choose schemas,
    synchronizes them, then **Draft my models** drafts entities and joins
    from the tables, keys and comments and checks each join on the data.
    The drafts open in **Modeling** for you to review and certify.
  - **Open an existing ZLens project** (a teammate's repository) uses the
    mode `dql.config.json` already sets. It asks only for the connection's
    credentials, lists the `${NAME}` environment variables the connection
    reads and which are not set, tests the connection and synchronizes.
- **`create-zlens-app --warehouse <driver>`** creates a database-only
  workspace: `warehouse-first` modeling, no dbt block, a `default`
  connection stub with secrets as `${ENV_VAR}` placeholders, and
  `npm run sync` running `zlens sync warehouse`. `--database-path <file>`
  sets a DuckDB or SQLite file. `--dbt <path>` wires a dbt project without
  detection or prompts. Run without either flag and with no dbt project
  nearby, it asks whether the workspace is for a dbt project or a database
  only; CI and piped runs keep the old default. Ctrl-C at that prompt now
  exits without writing anything.
- A new sample, [jaffle-shop-warehouse](https://github.com/duckcode-ai/jaffle-shop-warehouse),
  is the Jaffle Shop as a plain DuckDB file with a database-only workspace
  already set up.
- A connection test with an unset `${NAME}` placeholder now fails and names
  the variable, instead of testing the placeholder text (DuckDB used to
  create a file named after it).

### Modeling

- **Certifying a drafted join moves it.** Certifying a join that discovery
  drafted used to save the certified copy in the area file and leave the
  draft behind, so `zlens model validate` failed with a duplicate
  relationship. The same reviewed change now removes the draft, keeps its
  description, and the review shows both files. Editing an entity into an
  area works the same way.
- **Discovery picks the right grain.** A table's own unique `<table>_id` is
  its grain before any name column; when it repeats, `<table>_uuid`, `uuid`
  and `<table>_key` are checked. On the Jaffle Shop warehouse, `products` and
  `supplies` now get `product_id` and `supply_uuid`.
- **A join needs data behind it.** A many-to-one or one-to-one join fails its
  check when more than 5% of keyed rows find no match (`max_unmatched_share`
  changes the limit per relationship). `zlens model discover --validate`
  holds back a join that only a column name suggests when the data does not
  back it.
- New commands: `zlens model validate-relationship <id>|--all [--certify]
  [--dry-run]` checks joins on the warehouse, and
  `zlens model reject-discovery <id>` turns a drafted join down.
- An unknown `status:` on a model or join (for example `approved`) is now an
  error, not a silent draft.

### Ask

- **Answer labels agree.** An answer's heading, badge, note and result card
  now come from one trust decision. On an App, *What is beverage revenue by
  product?* was headed **AI-generated answer**, noted "Built from semantic
  metrics" and carded **Certified block answer**; it now reads **Governed**
  throughout, and only SQL the AI wrote is called AI-generated.
- **Drafted SQL joins names, not keys.** "What is the average order value at
  each store?" used to answer with store UUIDs. Ask now adds the table that
  holds the name, with the join spelled out, and sends back once a draft that
  groups by a bare key. Answers never read raw UUIDs or hashes aloud; rows
  keyed only by them say so.
- **Database-only projects: drafting reads the whole schema.** When the
  synced tables fit, the SQL drafter sees all of them (not five chosen by word
  overlap), with each table's declared primary and foreign keys. With no
  certified block or metric in scope, the question goes to the drafter as
  asked, so a restatement can no longer change its meaning.
  `ZLENS_ASK_DRAFT_FIRST=0` keeps the old order.
- **Checks on drafted SQL no longer block correct SQL**, and an answer gets
  one trust decision. Checking a join's row counts no longer runs the join, so
  `zlens model discover --validate` on a many-to-many view takes seconds,
  not minutes, and a real warehouse does not bill for it.
- A database-only project's tables now carry their columns into Ask, so Ask
  no longer reports columns it was never shown as missing.
- An entity named like a built-in JavaScript property (for example
  `constructor`, from a Formula 1 `constructors` table) no longer blocks every
  question on the project.
- **Optional: show the SQL drafter what the columns hold** (database-only
  projects). With `"agent": { "valueProfile": { "mode": "sampled" } }` in
  `dql.config.json`, `zlens sync warehouse` also reads the three most frequent
  values of each text column and the range of each number, and Ask's SQL
  drafter sees them. Off by default. These values reach your AI provider.
  Contact details, credentials, personal names and pay are never read, and
  values that look like emails, phone numbers, URLs or keys are dropped.
  Set `"mode": "off"` to stop; the next sync deletes the file. See
  [No dbt? Start from your database](docs/get-started/no-dbt.md#optional-show-the-drafter-what-the-columns-hold).
- **Optional: a second look at AI-drafted results.** With
  `"agent": { "resultReview": { "mode": "on" } }` in `dql.config.json`, or
  `ZLENS_ASK_RESULT_REVIEW=1`, every AI-drafted answer gets one more AI call
  that sees the question, the SQL and the result's shape (row count, distinct
  and empty values per column, never a value) and can ask for one revision.
  Off by default: it adds a few seconds per drafted answer.
  `ZLENS_ASK_RESULT_REVIEW=0` forces it off. See
  [Needs review](docs/ask/needs-review.md).
- Semantic layer: ratio metrics run in the native engine, and a metric is
  never offered a dimension it can only reach one-to-many (which would
  double-count). When a dimension is out of reach, the message names the join
  that blocks it.
- Every Ask on the Jaffle Shop sample failed with
  `(sql ?? '').trim is not a function` when MetricFlow was not installed (a
  dbt `count` measure with `expr: 1`). Fixed.

### Apps

- **Filter by… works.** A viewer's filter now narrows the tiles that can take
  it, shows a chip naming the tiles it narrowed (a tile it cannot reach says
  "Not filtered by …"), and reaches the page's story, **Ask about this App**
  and exports. Before, no value reached the run.
- The page story picks its clearest signals by value (the largest, ties
  settled by name), not by row order; a tile ordered on purpose, such as a
  bottom-N, is still read in its own order.
- The line under the App's Ask box is readable in every theme (it was below
  WCAG AA contrast).

### Lineage

- The status bar says what lineage was built from: **the dbt manifest**,
  **the synced warehouse catalog**, or both. A project without dbt was told
  its lineage was "Compiled from the dbt manifest".
- `FROM "main"."orders"` is read as the table `main.orders`, not the schema
  `main`.

### CLI while the workbench runs

- With `zlens notebook` running on a DuckDB project, `zlens certify`,
  `zlens sync warehouse`, `zlens model discover --validate`,
  `zlens model validate-relationship` and `zlens doctor` run their queries
  through the workbench instead of failing with DuckDB's "Could not set lock
  on file". They say so in one line. Only read queries go through it.
- When another program holds the DuckDB file, the error now says which
  process, and what to do: stop the workbench with Ctrl+C, or close dbt or
  the SQL client. See [Troubleshooting](docs/guides/troubleshooting.md).

### AI agents (MCP)

- **`zlens mcp test` fails honestly.** It printed **Ready** and exited 0 even
  when its checks failed. Every check is now required: **Ready** only when
  all pass, otherwise a **Fix:** line per failed check and exit code 1 (text
  and `--format json`).
- Hints and MCP tool errors now say to start the workbench with
  `zlens notebook` (or `npm run notebook`); they named `zlens serve`, which
  serves a built bundle and does not start in a project folder.

### DuckDB and other databases

- SQLite: Ask reads a table's columns (it asked for `information_schema`,
  which SQLite does not have).
- `ZLENS_DUCKDB_AUTOINSTALL=off` (`DQL_DUCKDB_AUTOINSTALL` is still read) now
  stops DuckDB from downloading any extension, on every connection ZLens
  opens. An `INSTALL` that would download, or a setting that turns automatic
  downloads back on, is refused. A query that needs a missing extension fails
  with one plain sentence that names it. Extensions already installed still
  load with `LOAD <name>`. See [Connectors](docs/reference/connectors.md),
  "Extension downloads".

### Docs

- New README and docs home with the tagline "Certified answers on your
  warehouse", the ZLens logo and real product screenshots.
- Docs reorganised around what you do: Get started, Ask and trust, Build
  blocks, Notebooks, Apps, Lineage, Connect your AI agent, Reference. Moved
  pages redirect.
- Short feature clips in the docs and README, recorded from the real product
  on the Jaffle Shop sample (`pnpm docs:clips`).
- The quickstart installs ZLens into the sample's own workspace
  (`npm install`, `npm run sync`, `npm run notebook`), and warns not to run
  `create-zlens-app` inside it.
- New page: [No dbt? Start from your database](https://docs.zlens.app/get-started/no-dbt/).
- CI checks that every `zlens` command and flag in the docs exists.

### Releasing

- The release workflow waits for npm to list the published packages before
  its install check. The 0.1.0 run published everything, then failed that
  check because npm was still processing the packages.
- `scripts/launch-gate.mjs` installs the packed release on a clean folder and
  follows the README quickstart for both samples, in a browser, before a tag
  is pushed.

## v0.1.0 - 2026-10-13

The first release under the name **ZLens**. ZLens is the product; DQL stays
the name of its query language and file format. Version numbers restart at
`0.1.0` for the new package names. The old `@duckcodeailabs/*` packages and
`create-dql-app` ended at `1.17.2`.

This release also ships every change listed below under
[Changes since v1.17.3](#changes-since-v1173-shipped-in-v010).

### What moved

| Before | Now |
| --- | --- |
| `@duckcodeailabs/dql-cli`, command `dql` | `@zlens/cli`, command `zlens` (`dql` still works, see below) |
| `create-dql-app` | `create-zlens-app` |
| `@duckcodeailabs/dql-compiler`, `@duckcodeailabs/dql-lsp` | `@zlens/dql-compiler`, `@zlens/dql-lsp` |
| `@duckcodeailabs/dql-<name>` (all other packages) | `@zlens/<name>`, e.g. `@zlens/core`, `@zlens/runtime`, `@zlens/agent` |
| Environment variables `DQL_<NAME>` | `ZLENS_<NAME>`, read first; `DQL_<NAME>` is still read when the new name is not set |
| Repository `github.com/duckcode-ai-labs/dql` | `github.com/duckcode-ai-labs/zlens` (GitHub redirects the old address) |
| Docs at `dql.duckcode.ai` | <https://docs.zlens.app/> |

- The `dql` command is an alias for `zlens`. It prints one line on stderr,
  "dql is now called zlens; the dql command will be removed in a future
  release.", then does exactly what `zlens` does. Standard output is
  unchanged, so `--json` output and pipes keep working.
- The VS Code extension keeps its id (`dql-language-support`) and is shown as
  "DQL for ZLens". It is released with the other packages, so its version also
  restarts at `0.1.0`.

### Upgrading from DQL

1. In each project, replace `@duckcodeailabs/dql-cli` with `@zlens/cli` and
   reinstall:

   ```bash
   npm uninstall @duckcodeailabs/dql-cli
   npm i -D @zlens/cli
   ```

2. For a global install, remove the old package first (both packages provide
   a `dql` command):

   ```bash
   npm uninstall -g @duckcodeailabs/dql-cli
   npm i -g @zlens/cli
   ```

3. Run `zlens doctor`. It reports a `package.json` that still declares
   `@duckcodeailabs/dql-cli` and says what to replace it with.
4. Code that imports a library changes the import name the same way, for
   example `@duckcodeailabs/dql-core` to `@zlens/core`.
5. Scripts that call `dql`, and `DQL_*` environment variables, keep working.
   Move them to `zlens` and `ZLENS_*` when convenient.

### What did not change

- `.dql` files, the DQL grammar, `dql.config.json`, `dql.app.json` and the
  `.dql/` project folder keep their names and formats. No project files need
  to change.
- The MCP server key `dql` that `zlens connect` writes, and the MCP tool
  names, are the same, so configured agents keep working.
- The `x-dql-*` HTTP headers are the same.

## Changes since v1.17.3 (shipped in v0.1.0)

Changes merged after `v1.17.3` (`git log 2ad841be..v0.1.0`). Package names in
this section are the names from before the ZLens rename.

### Highlights

- **Rules for hosted servers (RFC 0010).** When a host resolves a person for
  each request, the server keeps each person's records separate, opens project
  content only, chooses the connection itself, reads person- and model-written
  SQL with each engine's own rules and refuses anything but reads, applies one
  figures decision on every route, and reaches a model only through the
  boundary check. See [Hosted servers](docs/guides/hosted-servers.md) and
  [RFC 0010](docs/rfcs/0010-host-hooks.md).
- **What changes for a single-user `dql notebook`:** fonts and driver icons
  are served by DQL itself; an export holds the whole result up to 100,000
  rows and refuses a larger one with `EXPORT_TOO_LARGE` (it used to stop at
  the 500 rows on screen); a local Ollama model contacts only its configured
  address; research narration follows `providerResultRowEgress: disabled`.
  Everything else behaves as before.
- **For host authors:** new optional hooks and fields, time limits on every
  hook, and fail-closed handling of malformed answers; hooks belong to one
  server instance. The host package exports the statement check.

### Licence: Apache-2.0 for every package

- `create-dql-app`, `@duckcodeailabs/dql-openlineage`,
  `@duckcodeailabs/dql-plugin-api` and `@duckcodeailabs/dql-telemetry` change
  from MIT to Apache-2.0 from the next release, so every DQL package is now
  Apache-2.0. Versions already on npm (up to and including 1.17.2) keep the
  MIT licence they were published under.
- `LICENSE` is now the verbatim Apache License 2.0 text, and a new `NOTICE`
  names the copyright holder (DuckCode AI Labs). Every npm package and the VS
  Code extension now ship both files; a test packs each one to check.
- Every published `package.json` links the repository home page and issue
  tracker. `THIRD_PARTY_NOTICES.md` records the upstream licences of the
  GitLab and jaffle-shop test fixtures.

### Certified answers first

- A certified block now answers a question when it computes the same thing as
  the metric the question resolved to, whatever its output column is called.
  Ask compares the aggregate (including distinct), the column, the table, the
  rows kept and the grouping. Anything that differs, or that Ask cannot read,
  is not a match, and the trace says why in plain words. A block whose SQL is
  too complex to compare can declare the metric it answers with
  `metricMappings`; `dql compile` fails when the mapping names a metric that is
  not in the semantic layer.

### Local models

- The Ollama provider talks only to its configured base URL (the provider
  setting, else `OLLAMA_BASE_URL`, else `http://127.0.0.1:11434`), and says
  "Ollama is not running at <url>" when nothing answers there. Docker Compose
  already names its Ollama in `OLLAMA_BASE_URL`; any other container setup
  names it the same way.
- A model on this machine (Ollama on a loopback URL) stays the model for its
  prompts: it never fails over to another provider the project has
  configured. Whether a model is on this machine is judged from every address
  the provider can contact. This applies with and without a host.

### Notebook

- The Connections panel draws each driver's mark with the app's own icons,
  in the driver's colour, instead of loading a logo image from an icon
  service: opening it contacts no site but DQL's own. A test keeps image and
  script CDNs out of the app's sources.
- The built app ships Inter's licence (SIL Open Font License 1.1) beside its
  font files, as `assets/Inter-OFL.txt`; `THIRD_PARTY_NOTICES.md` lists it.
  `@duckcodeailabs/dql-ui/font-licence` is the Vite plugin that does this, for
  any app that loads the shared styles.

### For contributors

- New host-contract tests: `host-hook-faults`, `host-two-servers`,
  `host-request-concurrency`, `rfc-contract`, `model-boundary-egress`,
  `design-contract`; the notebook's entry point has its own test
  (`main-chunk-reload`).
- `pnpm --filter @duckcodeailabs/dql-cli test:offline` runs the CLI suite
  with every Node process recording each name lookup and connection to an
  address that is not this machine, and fails on any (a lookup is caught
  even when it fails before a socket exists). The test that reports a failing
  dbt Cloud connection answers its probe in-process.

### Hardening for hosted servers

- The host package (`@duckcodeailabs/dql-cli/host`) exports the statement
  check DQL runs on a hosted connection (`hostedStatementRefusal` and its
  refusals) and the per-engine reading it rests on (`lexStatement`,
  `knownLexicon`, `UnreadableStatement`), so a host that checks a statement
  before passing it on applies the same rules.
- A host's status and effect hooks are read the same way as its decisions:
  `answerStatus` passes on only well-formed statuses with same-origin links;
  `delivery` counts a message delivered only on `{ delivered: true }`, and a
  failing sink is "not delivered" with a reference instead of its own words;
  a `signing` service that fails, answers late or answers something that does
  not verify gives no export (a plain refusal with a reference); a review link
  from `git.openPullRequest` must be a web address or a path on the site;
  `pageEdition` failures are logged under a reference; a `traceSalt` that is
  not a text is not used.
- A hosted server's refusals that send a person to where only they work (a
  private draft, a block built with AI, a new draft of a certified block, a
  private notebook, uploading data) now say "your private workspace", which
  fits any host.
- Each server in a process runs its requests and its own work in its scope:
  its model, privacy boundary, delivery, git and tool gate are its own (none
  of a host's for a server without one), whatever other servers run beside
  it. "View as" is kept per person and per server. Process-wide hooks serve
  only work outside every server, and only while every server in the process
  has the same hooks.
- With a host, every model prompt that can carry result values asks the
  host's `isInBoundary` (or, without that rule, allows only a model on this
  machine) through one decision: story drafts, chart questions, a
  conversation's memory, a follow-up's earlier answer for the reading and the
  AI-drafted SQL, App Autopilot's preview facts and the Research narration.
  When it says no, the prompt carries the questions,
  readings, SQL, column names and shapes, never an answer's figures, rows or
  members. Research narration also follows the project's
  `providerResultRowEgress: disabled` switch, with or without a host. Without a
  host, prompts to the model the person chose are unchanged.
- A story or governed page drafted by a model outside the privacy boundary
  gets a grouped tile's per-member bindings named by position ("open claims
  for group 1"), mapped back to the real bindings once the draft is accepted;
  no binding's value travels with the prompt. A model inside the boundary
  sees them as before.
- With a host, the capability map (`GET /api/host/ui`) allows `export` only
  when the person may also run queries (`query.run`), as the SQL export route
  requires, and its refusal is the one the route gives (its reason and next
  link).
- A hosted page never shows the single-user screens (settings, source
  control, a browser-side CSV or JSON download) when the person's capability
  map has not arrived or fails to load: the server marks the page and every
  answer as hosted, the app shows "Connecting…" and retries, says "DQL can't
  be reached right now" after 15 seconds, and keeps a map that loaded once
  when a later reload fails (a 502 during a restart, a 429).
  `GET /api/host/ui` passes on each of a host's `ui` fields only in its own
  shape and never fails because of a malformed one.
- A host's `audience` answer that is neither `stakeholder` nor `analyst`
  (nor undefined) means `stakeholder`, as an error does. A `purposeAttributes`
  value that is not a list of names names none. When a host's `follows.set`
  fails, the person reads "Following could not be saved. Try again" with a
  reference, never the host's own error text.
- Every host hook DQL waits for has a time limit, so a host's hung policy
  store or database never holds a person's request: decisions and stores get
  `hostHookTimeoutMs` (a new `startLocalServer` option, 10 seconds by
  default), delivery, signing and git six times that, and the tool gate that
  long to decide. A hook that does not answer in time fails closed as on an
  error: "DQL could not check who you are right now" (503), "DQL could not
  check what you may do right now" (403), the statement refused, no figures,
  nothing listed. An answer after the limit is ignored.
- A host's runs, conversation or notes store that fails is never shown in
  its own words (a database's address, role or statement): the person reads
  "DQL could not reach its saved answers right now" (or conversations, notes)
  with a reference of eight letters, and the store's text goes to the
  server's log under it. A store answer of the wrong shape (a list that is
  not a list, a count that is not a number) is read as nothing instead of
  failing the request.
- A host's `rowPolicy` or `credentials` answer that is not one of its shapes
  (a bare string, a number, a list) is refused in DQL's own words ("DQL could
  not check what you may see…", "DQL could not get your warehouse sign-in…")
  and never repeated back. With a host, a failure DQL did not expect while
  serving a request reads as a plain sentence with a reference of eight
  letters; its own text goes only to the server's log under that reference.
- A host's `answerFigures` shows needs-review figures only when it answers
  `show`. An error, `withhold_review`, or any other answer (nothing, a typo,
  another type) withholds them, on every asking door.
- A part of the notebook app loaded later (a lazy chunk) that cannot be
  fetched, as when a host ended the person's session and sends the request to
  sign-in, reloads the page once (landing on sign-in) instead of showing
  "Failed to fetch dynamically imported module". At most one automatic
  reload, even in a browser that refuses session storage: the reload marks
  the page's address (`?dql-reloaded=…`, taken out of the address bar as the
  page starts), and a page reached that way within the minute, or a page that
  can mark neither its address nor storage, shows "DQL could not load part of
  the page. Reload the page." instead of reloading again. The app's files are
  still served only to a signed-in person.
- An answer that cites a team document keeps its own reading ("I read this
  as: claims paid in the last full week (14–20 September 2026)") even when the
  document happens to hold one of its numbers: only a sentence beyond the
  reading that states a figure a document alone holds is removed, and "A
  figure taken from a document was left out" is said only when one was.
  `knowledgeOnlyFigures` and `withoutKnowledgeOnlyFigures` take the reading
  (optional; without it, the answer's opening "I read this as:" sentence).
- When a statement fails on the warehouse, Ask names only tables the
  statement reads: a column or a function the warehouse does not have is said
  as such ("A column this answer reads (status) is not in the claims table on
  the warehouse"), never as a table the connection "cannot see", and literals,
  aliases and functions are never listed as tables. With a host, the
  warehouse's own words go to the server's log under a reference of eight
  letters (no digits, so a log scrubber keeps it whole), without the values a
  row policy's rewrite added, and the answer says "Ask your administrator
  about reference …"; they never
  reach the answer, its steps, the stream or the thread. Elsewhere (a notebook
  cell, a tile) the warehouse's diagnosis is shown without any excerpt of a
  statement the host's row policy rewrote, with the reference. Single-user
  `dql notebook` shows the warehouse's words as before. The DuckDB connector's
  "build your dbt models" hint is given only for a missing table, view or
  schema.
- With a host, an App schedule's digest baseline belongs to the person a run
  ran as: a run someone else starts (through
  `POST /api/apps/:app/schedules/:schedule/run`) keeps a baseline of its own
  and never sets the run-as person's, so a digest never compares one person's
  figures with another's. Without a host the schedule keeps one baseline, as
  before.
- With a host, AI pins are each person's own and not shared App content;
  creating one, the App's pin panel and the pin's tile now say "Only you see
  this pin; keep it as a live tile to share it."
- Promoting an AI pin answers with the draft block's project path
  (`apps/<id>/drafts/<name>.dql`, with `/` on every system), as other routes
  name project files, never a path on the server.
- With a host, each person's App persona ("view as") is kept in memory for
  at most 5,000 people; past that the least recently used person's goes and
  they see Apps as themselves again.
- Ask traces sent to a host's sink or an OpenTelemetry collector carry the
  question's fingerprint keyed with HMAC-SHA256 under the host's new
  `traceSalt` (or a key kept in `.dql/local/private/trace-salt`). The same
  question keys the same way on one install; fingerprints kept in the local
  trace store are unchanged.
- With a host whose rules make an answer's figures depend on who reads them
  (new hook `figuresDependOnReader`), an Ask answer is not added to an App
  page as its written text, which would show every reader its author's
  figures: adding it, a draft edit or page write that adds it, and the
  publish preflight refuse it with "This answer's figures depend on who is
  looking. Add it as a live tile instead." A live tile (`mode: 'live'`) runs
  the answer's SQL for each reader. Such tiles record the tables the answer
  read; ones published before are listed for stewards
  (`GET /api/app-answer-tiles`), not removed.
- With a host, an Ask answer published on an App page as its text before
  that rule shows everyone who does not replace such tiles (new optional
  hook `keepsAnswerText`; by default the App's authors and stewards) a
  placeholder in its place: "This answer's figures depend on who is
  looking. A steward needs to replace it with a live tile.", on the page and
  in every run of it (stories, snapshots, digests, agents).
- With a host, a statement reaches the connection's tables and views only.
  DuckDB and `file` connections open with external access off and their
  settings locked (after the database is open), and DQL refuses statements
  that read a file, the environment or a setting, or load an extension, on
  every engine, before they run (`ROW_POLICY_REFUSED`, plain text). A
  connection may name folders whose files stay readable
  (`allowedDirectories`, none by default). A draft space's uploaded datasets
  are read by DQL itself and kept as tables. Without a host nothing changes.
  Upgrading: a hosted project whose blocks or views read files (for example
  `read_csv_auto('./data/orders.csv')`) lists that folder in the
  connection's `allowedDirectories`.
- With a host, the statement check reads each statement the way its engine
  reads it: each engine's strings (backslash escapes, doubled quotes, dollar,
  triple-quoted and raw strings), quoted names and comments (`--`, `#`, `//`,
  block and executable comments); where that depends on a setting DQL cannot
  see, every reading must agree. A statement it cannot read that way is
  refused in plain words, and so is a connection to an engine it does not
  know. Each engine's own ways beyond the tables are refused too: stages,
  tables named by a file path, table functions that reach files, URLs or other
  servers, procedures, dynamic SQL, secrets and other statements' results.
  DQL's own value lookups escape their LIKE patterns with `!`.
- With a host, a statement a person or a model writes (Ask, notebook cells,
  App tiles, `/api/query`, MCP, Slack) only reads, on every connection
  whatever its protections: one `SELECT` (or `WITH`, `VALUES`, `TABLE`,
  `SHOW`, `DESCRIBE` or `EXPLAIN` of one). A change to data, tables, settings
  or the session, a row lock, `SELECT … INTO`, `nextval`, or several
  statements at once is refused (`ROW_POLICY_REFUSED`, plain words). DQL's own
  statements keep their shapes: a new query purpose, `platform`, marks them
  and is never taken from a request (a host's `rowPolicy` and `credentials`
  may see it). Give the warehouse account behind a hosted connection
  read-only grants all the same. Without a host nothing changes. Upgrading: a
  hosted notebook cell or block that wrote to its connection is refused; put
  data in through uploads.
- `QueryPurpose` (`@duckcodeailabs/dql-connectors`) gains an additive value,
  `platform`, for the statements DQL issues itself; with a host, `rowPolicy`
  and `credentials` may receive it. A host that switches exhaustively on
  `purpose` needs a case for it (treat it like `data` unless it wants
  otherwise); statement events (`statements`) still report `data` or
  `metadata`, a `platform` statement as `data`.
- With a host, a statement a person or a model writes does not read the
  warehouse's own record of other sessions, their queries, its users or its
  settings, on each engine: Snowflake's `ACCOUNT_USAGE` query, login, session
  and access history; Databricks `system.query.history`, `system.access` and
  `system.billing`; BigQuery `INFORMATION_SCHEMA.JOBS*` and `SESSIONS*`;
  Postgres and Redshift `pg_stat_activity`, `pg_stat_statements`,
  `pg_settings`, `current_setting` and Redshift's `stl_`, `svl_`, `stv_` and
  `sys_query_` views; MySQL `performance_schema`, `mysql`, `sys`,
  `information_schema.PROCESSLIST` and `@@` variables; DuckDB
  `duckdb_settings`, `duckdb_extensions`, `duckdb_databases`, `pg_settings`
  and `current_setting`; ClickHouse's `system` logs, processes, settings,
  users and grants; Trino and Athena `system.runtime`; SQL Server and Fabric
  `sys.dm_*`, configurations and logins. A name is matched in any case,
  quoted or not, however it is qualified; SHOW of sessions, users, grants or
  settings is refused the same way (on Postgres, SHOW altogether), and
  `SHOW CREATE TABLE` reads. The refusal is `ROW_POLICY_REFUSED` in plain
  words, and there is no setting to allow these: the warehouse role's grants
  stay the first control, so give it none on them. DQL's own statements are
  not affected. Upgrading: with a host, warehouse discovery does not read
  query history ("Use query history", `--query-history`); it says so and
  drafts from the catalog alone.
- Catalog lookups bind names on every engine: a connector's `listColumns`
  and `listTables` send schema and table names as bound values (SQLite
  describes a table through `pragma_table_info`), as do the schema search and
  Ask's member lookups, and BigQuery and ClickHouse quoted names escape a
  backslash. Databricks connections take `?` parameters, sent as the
  statement API's named parameters. With a host, a connector's catalog
  lookups run through the one checked path as metadata (the row policy sees
  them and the statement observer hears of them), and
  `GET /api/describe-table` refuses a name holding a quote, a backslash or a
  control character (`RELATION_NAME_REFUSED`).
- With a host, a statement that failed on the warehouse is logged as the
  warehouse's diagnosis (never its excerpt of the statement sent), the
  failure's kind and the statement's own tables; a value the engine cut short
  in its own words is left out as well.
- HH-14 holds on every read of a run: a run read by id while it is still going
  carries no wording, event payload, artifact or step note; a run that ended
  before its trust was settled (cancelled, interrupted, blocked) and kept a
  result that is not certified or governed is withheld whole, and otherwise
  keeps its own words but none of its workings; a replay, the run list and
  the host's answer facts take the decision when they are read; and what the
  run store keeps for such a person is withheld from the first write. A
  withheld run also leaves out the accepted answer text kept beside it and
  each task's outcome summary.
- HH-14 holds for AI pins too: for such a person an AI-written pin reads as
  its question, SQL and result shape only, when it is made (from Copilot or
  from an analysis memo), listed, refreshed, opened with its App and run on
  its page; a certified pin keeps its figures.
- With a host, a `modelProvider` hook that fails, or answers something other
  than `{ id, provider }`, refuses the model step in plain words: DQL then
  asks no model, never the project's own provider. A hook that answers
  undefined still uses the project's settings.
- With a host, outside the privacy boundary, a follow-up's earlier
  restriction values and its AI-drafted SQL's literals reach the model named
  by position (`[value 1]`), and what the model writes gets the real values
  back; member-spelling lookups (a stored spelling, the members a name could
  mean) are not made for such a model.
- With host hooks but no `resolvePrincipal`, `GET /api/identity` names no one
  (`{ owner: '', principal: null }`), never the machine's own owner.
- With a host, a notebook cell's or research run's query history (its SQL,
  cell name, row count) is not kept in the project-wide metadata cache,
  from which every person's context is drawn.
- With a host, a draft block made from an AI pin or an App's exploratory
  tile (project content) is described by the question it answers, never by
  the answer text with one person's figures. An AI pin is refreshed and
  promoted only through its own App.
- Promoting a notebook research run to a draft block
  (`POST /api/notebook/research/:id/promote-dql`) is authoring
  (`dataset.author`): it writes a draft block into the project.
- With a host, recording a correction (`POST /api/agent/learnings/correction`)
  is a change to the project (`project.write`): it writes a candidate hint
  and its trace under `.dql/hints` and `.dql/traces`, so a host that keeps a
  workspace read-only refuses it there (a draft space takes it, as a
  reviewed change). Until a hint is reviewed, only its author and people
  who may review hints list it (`GET /api/agent/hints`); reviewed hints are
  the project's, as before.
- HH-14 (a host keeping needs-review figures from a person) is decided in
  one place and applied on every asking door, not on Ask only: the notebook
  chat cell (`/api/llm/run`) is not available to such a person; notebook
  research runs and App analysis memos show them their question, SQL and
  result shape, never a value, and are not run for them; a repaired answer
  (`/api/agent-runs/:id/repair-execution`) is withheld and stored withheld,
  as an Ask answer is. Certified research runs and memos keep their
  figures.
- With a host, a block's last Block Studio run (row count, columns, time,
  decided by the runner's row rules) is kept in the runner's own folder and
  shown back only to them.
- With a host, a notebook's last run kept beside it (`*.run.json`, written
  without a host) is not project content: the file routes refuse it, as
  they refuse other runtime files.
- With a host several people share, private skills and private blocks (one
  folder of the server for everyone) follow the private-notebook rule: none
  are listed, made, changed, deleted or published there; a draft space
  (`onePerson`) keeps them as before.
- With a host several people share, the notebook's local dataset workspace
  (`/api/datasets`: uploads, staged warehouse rows, their previews and
  sample values) lists nothing and keeps nothing: it is one person's, and
  querying it was already refused there. A draft space (`onePerson`) keeps
  it as before; validating a governed Dataset's grain is unaffected.
- With a host, a Block Studio import or AI import session (its SQL,
  candidates and preview rows, run as the importer) is the importer's:
  listed, opened, changed, run, saved and deleted only by them; clearing
  imports clears only theirs, and someone else's id answers 404. Sessions
  kept before the host are no one's with one. Without a host nothing
  changes.
- With a host, an App build draft (its goal, pages and the Ask answers
  added to it) and an AI App build session (its prompt, plan, preview rows
  and answer) are the author's who started them: listed, opened, changed,
  run and published only by them, and an id someone else holds is never
  written over. Drafts and sessions kept before the host are no one's with
  one. Without a host nothing changes.
- With a host, an Ask `Idempotency-Key` is the person's own: the same key
  from someone else is a new submission, never a replay, a conflict naming
  the other run, or an attachment to it.
- With a host, keeping a conversation turn as a note makes it the person's
  own note unless they ask for a note for everyone, and a note for everyone
  keeps the question only: the answer's figures were read under one
  person's row rules.
- With a host, `GET /api/agent-runs/tier-distribution` counts the person's
  own conversation turns only (`tierDistribution({ ownerId })`).
- With a host, a page of the Ask trace list names only the reader's traces,
  in its entries and in its cursor (it reads further pages until it holds
  enough of theirs).
- With host hooks, a request the host names no one for (a host without
  `resolvePrincipal`) reads no one's Ask runs, traces, conversations, Home,
  follows, story editions or notebook runs, and keeps none of its own.
  Conversation lists and searches from a host's own store are filtered
  again by owner. Without a host nothing changes.
- With a host, an AI pin (an answer pinned to an App page, with its answer
  text and stored rows, computed under the pinner's row rules) is the
  pinner's: the pin list, the App document and a page run show its stored
  answer and rows only to them, and only they refresh it; for anyone else the
  pinned tile is not found. Pins kept before the host are no one's with one.
  Without a host nothing changes.
- With a host, an App's analysis memos (investigations: the question, its
  SQL and result previews, run as the person who asked) and App conversations
  are each person's: listed, opened, run, pinned, changed, deleted and reused
  for the same question only for them, and the App's own document lists only
  theirs. Memos and conversations kept before the host name no owner and are
  no one's with one. A host that names nobody for a request reads none.
  Without a host, the one local user sees every record as before. New
  `owner` option on `LocalAppStorage` (an `owner_id` column on both tables).
- With a host that withholds needs-review figures from a person (HH-14), a
  streamed Ask sends that person each run event with its kind, route,
  status and trust only: the event payloads (an answer artifact carries the
  answer text and its rows) and wording are left out while the run goes, as
  the answer deltas already were.
- With a host, notebook research runs (their questions, SQL and result
  previews) are each person's: listed, opened, changed, rerun and updated by
  a cell run only for the person who ran them (someone else's run is not
  found on every research route), and their owner is the person signed in,
  never a name in the request. With host hooks and nobody signed in, none are
  shown or kept. The shared store a server kept before it had a host is not
  read with one (those runs name no verified owner). A draft block they
  publish to the project is project content as before. Without a host, the
  one local store as before.
- With a host, a Dataset's grain check (run with a page) is kept in the
  person's own file, under the identity that decided their rows, and only
  that person's checks and the project's checked-in proofs are gone on: a
  check computed under one person's row rules is never shared evidence. The
  local proofs file a server kept before is moved aside when it starts with
  a host. Without a host nothing changes.
- A host's row policy may ask for a check on a statement's result
  (`groupRows`: a column with each group's row count, and a minimum): when
  any group holds fewer rows, DQL refuses with the host's plain message and
  hands over no row (a stream is held until the check), and the count column
  never reaches anyone. A host uses it to keep near-individual groups away
  from a model.
- With a host, every request field that names a file or folder follows the
  file routes' rule (project content only, refused whether or not it
  exists): a block run by its file on `/api/dql/artifacts/execute`
  (`artifact.sourcePath`, a `.dql` file), a diff by path (matched literally;
  the whole diff shows project content only), SQL and modeling YAML imports
  read from a path (only project content files under it), a semantic layer
  import's project path (the repository it clones is the project's own), a
  skills folder, a dbt profiles path, and a block opened in Block Studio or
  shown with its history (by real path, so a symlink is judged by where it
  points). A dataset is uploaded, never read
  from a path on the server, and a table description reads tables, not
  files. Import candidate, hint and trace ids are checked as ids, with or
  without a host.
- New host hook field `purposeAttributes`: the attributes a host sets on a
  person for one request to say where its values go (for the model, a
  delivery). They stay in every cache and proof key; DQL leaves them out
  only to find the person's own earlier run, so a question about a chart on
  screen finds the chart that person ran. The chart's rows reach the model
  only where the host's `isInBoundary` allows them for the tables they came
  from; otherwise the answer is written from the chart without the model.
- With a host, MetricFlow (semantic queries through dbt) runs with a minimal
  environment: dbt's own `DBT_*` settings and nothing else from the server's
  environment. Put the warehouse settings its profile reads in `DBT_*`
  variables.
- With a host, every route is classed by what it does: under the asking
  families (`/api/agent-runs`, `/api/ask`, `/api/ai`, `/api/agent`,
  `/api/llm`, research) only the routes listed as asking are `ask` or
  `research`; any other is `project.write`. Building a block with AI
  (`POST /api/ai/build`) is authoring (`dataset.author`), and a notebook
  cell is built with `POST /api/ai/build/cell` (asking; the notebook uses it).
  With a host, an AI-built draft is written only where one person works, a
  certified block is never rewritten in place, an edit stays on a block file
  inside the project, and the draft's owner is the signed-in person (nothing
  is saved in `dql.config.json`). Favorites and recent items are each
  person's own. Single-user `dql notebook` builds as before.
- The MCP client for a knowledge server sends every request to the server's
  own address: a redirect is an error, never followed.
- Knowledge sources: the check that keeps a document's figures out of an
  answer's note, and out of the answer itself, reads a number however it is
  written: in English words ("twelve thousand"), in another script's digits,
  in full-width or circled digits, as spaced digits, or as a fraction. Years
  and one-digit counts are still left alone. This applies without a host too.
- New host hook `columnsVisible(principal, relation, columns)`: the schema
  routes (`/api/schema`, `/api/describe-table`) list only the columns the
  person may see; a hook that throws lists none.
- With a host, agent memory: a person's own notes (scope `user`) are keyed
  by who they are and listed, changed or removed by them alone; notes for
  everyone (project, notebook, artifact) need `project.write`.
- With a host, setting the project up (`/api/onboarding/*`) and installing
  drivers (`/api/connectors/*`) are `settings.manage` actions; onboarding's
  dbt project and profiles must be inside the project (judged by real path),
  and its `dbt parse` runs with a minimal environment (none of the server's
  keys or passwords). Single-user `dql notebook` is unchanged.
- A refusal by the host's row policy or credentials, or of a connection the
  server chooses, answers 403 with `POLICY_DENIED` on the SQL routes
  (`/api/query`, notebook cells, SQL draft previews, semantic queries), not
  a 500.
- An export (`/api/query/export`) holds the whole result, up to 100,000 rows;
  a larger result is refused with a plain message (`EXPORT_TOO_LARGE`), and a
  page tile that shows only part of its result is not exported as a file
  that would be cut. Before, a file held at most the screen's 500 rows and
  said nothing. This applies without a host too.
- With a host (RFC 0010), the server chooses the connection: a request may
  pick one of the project's own connections by name, a connection object in
  a request is ignored, and the host's hooks see the name the server
  resolved. The server's local DuckDB workspace is available to requests only
  where the host allows it (`onePerson`). Single-user `dql notebook` is
  unchanged.
- With a host, the file routes serve project content only (notebooks,
  blocks, Apps, domains, the semantic layer, docs): never the runtime's own
  folders, git's files, the connection settings, data or a database file,
  and a symlink is judged by where it points. A notebook's last run is kept
  per person, and private drafts are for a server one person uses.
- With a host, Ask scoped to an App ("Ask about this App") also asks the
  host whether the person may open that App, so an audience the host keeps
  (for example as access policies) holds for it too.
- With a host, the server's own configuration is for whoever may manage
  it: `GET /api/connections` shows others each connection's name and kind
  (no settings, dbt profiles of the server's user or driver install paths),
  the provider and environment settings say nothing about which keys the
  server's environment holds, and skill settings name no server folder.
- With a host, a certified block run by name or file
  (`/api/dql/artifacts/execute`) or from a notebook cell (`@block(...)`) is
  checked with the host's `sourceAccess`, as its Dataset's own runs are.
- With a host, Ask traces follow their runs: the trace list, a trace by id
  or by run, and its export show only the person's own (someone else's is
  "not found").
- With a host, operations (an Ask in progress, a page run, a refresh) are
  each person's own: the operations list, one operation by id, cancelling it
  and the live operations stream show only operations the person started.
  With host hooks but nobody signed in (a host without `resolvePrincipal`),
  none are shown.
  Cancelling a run and superseding a page run are the asker's alone.

### Screens: fonts from DQL itself, readable text, words for hosted readers

- The app no longer asks Google Fonts (or any other host) for its fonts:
  Inter ships in `@duckcodeailabs/dql-ui` (`src/styles/fonts/`, SIL Open
  Font License 1.1, Latin and Latin Extended subsets, about 95 KB) and loads
  from the DQL server. Code text uses JetBrains Mono when the computer has
  it installed, else the system's monospace face. Kalam and Caveat are no
  longer loaded (nothing used them). `@duckcodeailabs/dql-ui/styles/fonts`
  exports the `@font-face` rules for an app that embeds DQL's look.
- Text reads at WCAG AA (4.5:1) in every theme. Obsidian's tertiary text
  (`--text-tertiary`, hints, dates, captions) is `#8d93a3` (was `#626878`,
  3.1:1 on cards); Paper's is `#64676e` and White's `#56657a` (both were
  just under 4.5:1 on their page backgrounds). The certified and draft
  seals on Apps and the column-type badge in result tables draw their words
  in the status colour mixed toward the theme's text, so they read on their
  tint (the badge used the dark theme's colours in every theme); so do the
  environment chip, the current chat, a shared App's label, page counts,
  and the trust pill and source chip of an App's story. Token names
  are unchanged; an app that embeds DQL with its own copy of the shared
  tokens (for example a design-tokens package) should take the same three
  `--text-tertiary` values.
- No text under 11px on the Ask screen: the history list ("Recent", "just
  now"), the scope line, the composer's option labels and the line under the
  composer were 10 to 10.5px.
- The Ask box shows keyboard focus: the composer draws a ring in the focus
  colour (`--border-focus`) while its question box has focus.
- An App card on the library is a container, not a button holding buttons:
  its title is the one link that opens the App, and the favourite, View and
  Edit buttons beside it name the App they act on ("Add Claims Weekly to
  favourites", "View Claims Weekly").
- With a host, screens say up front what the person may not do, and speak to
  readers in plain words (RFC 0010 HH-9). `GET /api/host/ui` adds
  `refusals`: for each action that is not allowed, the reason and the
  same-origin `next` link the host's `authorize` gave. Ask uses it: someone
  who may not ask is no longer offered the question box and suggested
  questions only to be refused after asking; the screen shows the host's
  reason and its link (for example "Request access"). Two optional `ui`
  fields: `audience: 'reader'` leaves the single-user notebook's words out
  of the App library and Ask (local drafts, private counts, "local
  insights", "Local DQL App", "semantic next"), and `appNotFound` gives the
  App reader the host's words, and a link, when this project has no such
  App (with a host it may be in another project), instead of "could not be
  read from the local project. Check that the server is running". Without a
  host, or without these fields, nothing changes.
- For a hosted reader the header names the product "DQL" (not "DQL
  Workbench") and an App page's top bar its name, not its id, and an answer whose figures the host withholds says so once:
  the app's own "figures stay hidden" note shows only when the answer came
  without the host's words.

### Bounded caches and no downloads on demand

- Ask's context packs in `.dql/cache/metadata.sqlite` are kept bounded: the
  newest 200, none older than 7 days, at most 64 MB in all. Each question used
  to add a pack for good. `DQL_CONTEXT_PACK_MAX`, `DQL_CONTEXT_PACK_DAYS` and
  `DQL_CONTEXT_PACK_MAX_MB` change the bounds.
- `DQL_DUCKDB_AUTOINSTALL=off` keeps DuckDB from downloading an extension the
  first time a statement needs one; only installed extensions are used.
  Unset, DuckDB's default is unchanged.

### Retired blocks name their replacement (`replacedBy`, `deprecatedOn`)

- A deprecated block can declare `replacedBy = "<block>"` (name or `.dql`
  path) and `deprecatedOn = "YYYY-MM-DD"`. The parser, formatter, manifest
  and lineage carry both.
- Checks (`kind: 'retirement'` manifest diagnostics, shown by `dql validate`
  and `dql compile`): a replacement that is not a block or that loops is an
  error; a replacement that is itself deprecated, the fields on a block that
  is not deprecated, and blocks or App pages still using a deprecated block
  are warnings.
- Block Studio and the block library show **Replaced by `<name>`** with a link,
  and a retired block offers **Open the replacement**.
- Ask never answers from a deprecated block. A question naming one is
  answered from its replacement when that fits, under the replacement's own
  trust, and **How it answered** says "`<old>` was retired on `<date>`; answered
  from `<new>`".
- App Studio shows "Retired — replaced by `<new>`" on tiles bound to a retired
  block; the publish check names the replacement. Readers see the tile's
  normal trust state.
- Lineage adds a dashed `replaced_by` edge from the old block to the new
  one. Impact and path walks do not follow it.

### Where a result goes; downloads made on the server; your own connections (RFC 0010 HH-17)

- Every statement a request runs tells a host's `rowPolicy` where its
  result goes (`destination`: `person`, `model`, `delivery` or `export`) and
  the request's route action, so a host can treat a question, a scheduled
  delivery and a file differently.
- **Downloads made on the server**: `POST /api/query/export` and
  `POST /api/apps/:app/dashboards/:page/export` run a statement or one tile
  again for a CSV, JSON or Excel file, under the host's export rules. With a
  host, the app's download buttons use them; without one nothing changes.
  CSV cells a spreadsheet would read as a formula are prefixed with `'`.
- **`sensitiveQuestions: 'columns'`**: a host that refuses personal data by
  column replaces Ask's wording check for payment, health, contact and
  protected attributes (identifiers and one person's pay stay refused by
  wording). A row policy's refusal ends an answer with its reason.
- **Your own connections**: `.dql/local/private/connections.json` (outside
  git) adds or replaces connections for you alone and can set your default
  connection — for example a development copy of the warehouse.

### A Home that summarises, following pages, and who an App is for (RFC 0010 HH-16)

- **Home**, above Ask on a new chat: **My Apps** (followed first, then
  recently opened) and **What moved** on the pages you follow or opened —
  your own figures from your own last two runs (certified or governed
  single figures only; per person, never cached across people). A host can
  add cards such as **Open requests** (`homeCards`).
- **Follow** an App page. Without a host it is your own state in
  `.dql/local/private/home/`; a host's `follows` hook keeps it and tells you
  about each new edition — a scheduled run whose figures changed
  (`pageEdition`, which carries no figure).
- **Ask about this App**: one question box per App, scoped to the App, its
  domain and the filters on screen, through the governed Ask loop.
- **App audience groups**: `audienceGroups` in `dql.app.json`, edited in App
  settings (from a host's `directoryGroups`, or typed). With a host that
  signs people in, only those groups, the owners, granted people and authors
  open the App.
- Story editions are kept per person when a host signs people in (they held
  one person's values).
- Team documents: definition and conversation replies about a governed term
  cite them under the same contract; Research says **Team documents not
  read** when pages are held back from an off-machine model.

---

> The sections for `v1.14.4` to `v1.17.3` below were split out of the old
> Unreleased notes on 2026-10-11. Each lists the commit subjects between that
> release's `chore(release)` commit and the one before it (`git log
> <previous>..<release>`), without merges. The longer notes for `v1.15.0` are
> kept under it. These versions were published to npm by hand and have no git
> tags.

## v1.17.3 - 2026-09-17

- fix(ask): the tables that connect the others are described first
- feat(ask): AI-written SQL understands marker tables and wide questions
- feat(ask): AI-written SQL follows the Modeling map and reads the skills
- fix(ask): no machine path in answers; golden suite ignores a local mf
- feat(eval): each graded answer records what it sent to the AI model
- fix(ask): every Ask AI call says how hard to think again
- fix(eval): a question the runtime never answers fails on its own
- feat(eval): score an answer against a benchmark's correct rows
- fix(release): stopping a publish puts the package manifests back

## v1.17.2 - 2026-09-16

- fix(notebooks): the create dialog names the file the server writes
- feat(skills): a skill can start private and be published when it is ready
- feat(blocks): a block can start private and be published when it is ready
- feat(notebooks): a notebook can start private and be published when it is ready
- fix(git): discard keeps what git cannot return, and a commit takes only what was chosen
- fix(modeling): a follow-up may name the models its own draft added
- feat(modeling): a follow-up message edits the draft on screen instead of starting over
- fix(modeling): asking to build something out asks for the models it needs, and an AI change edits the model on the map
- fix(modeling): an entity id the AI spells in snake_case resolves to the model on the map
- fix(modeling): every door says what it opens, and authoring AI stays in the area you are looking at
- fix(modeling): a relationship key dbt does not document is unproven, not missing
- fix(modeling): certifying needs both models' grain and key columns, so a certified join binds Ask
- fix(modeling): columns come from the warehouse when dbt documents none, so relationships can be built without dbt docs
- fix(semantic): an empty dbt semantic manifest no longer replaces a native DQL semantic layer
- fix(modeling): What Ask will do describes a list of relationships at each level
- feat(ask): certified relationships bind AI-written joins; visible Ask scope; author what Ask enforces
- feat(modeling): one Modeling page, terms and concepts, and a relationship builder that checks the join

## v1.17.1 - 2026-09-14

- test(agent): lane audit counts the frame test for non-additive metrics
- test(research): golden lane investigation-revenue-drop replaces the hypothesis research case
- fix(research): investigate the level, and never add up a metric that is itself a change
- feat(research): the trace page draws an investigation as a branching flow; specs updated for drivers
- feat(research): consented AI wording checked against the figures, driver-breakdown actions, a shared driver chart
- feat(research): breakdowns run three at a time, and the report records each one's reconciliation
- feat(mcp): answer_question carries a Research investigation, compact
- test(research): Research finds a planted drop in real data, from governed queries and no AI call
- fix(research): breakdowns worth reading on real data
- feat(research): drivers in the notebook, and Ask offers "Investigate the drivers" for a why-question
- feat(research): the investigation breaks the change down, drills in, and reports the drivers
- feat(research): verdicts on drivers and dimensions, seasonality and confidence
- feat(research): choose the dimensions to break a change down by
- feat(research): split a change across a dimension's members, and a ratio's change into mix and rate

## v1.17.0 - 2026-09-12

- fix(ask): a governed composition shows its DQL in "How it was answered"
- fix(research): a filter on a raw column is the governed dimension over that column
- fix(notebook): a tab without the LAN access token asks for the link instead of loading forever
- feat(research): a numeric season or year is the period when no date field is known
- fix(research): read a period token as the period asked about, and a monthly stamp as a complete month
- fix(research): read a why-question for what it measures, and offer real choices when it names none
- fix(research): the coverage check may draft SQL when the headline had to
- fix(notebook): a Research answer is headed as a Research report, not an AI-generated answer
- fix(notebook): a Research run's actions and inspector name it as Research
- fix(research): frame the period asked about, measure a block through its metric, never sum before the data
- feat(notebook): the Research report and "How it was researched"
- feat(research)!: Research runs the investigation; the hypothesis engine is removed
- feat(research): the investigation executor, a three-minute Research budget and one receipt
- feat(research): the investigation core, framing a change and measuring it exactly
- refactor(ask-host): open one request's context once and run several readings over it
- feat(ask-pipeline): run a reading settled elsewhere without an AI reading
- fix(workbench): a quiet Ask composer, certified blocks that stay certified, and Git you can connect
- feat(ask): "How it was answered" as numbered steps and the full trace as a decision flow
- fix(ask): "How it was answered" shows the DQL the answer ran again, not only the SQL

## v1.16.0 - 2026-09-11

- fix(ask): AI-written SQL on the jaffle lane — one-to-many totals, percent points, draft budget, path-free prompts
- test(ask): office lane re-recorded with the drafter's identity and standard-term guidance
- fix(ask): AI-written SQL on a repo with no semantic layer — the NBA lane at 18/18
- fix(ask): AI-written SQL looks again at a zero count; a fiscal year on its field applies; office lane re-recorded
- feat(ask): two governed sources — certified blocks and authored semantics; everything else is AI-written SQL
- fix(ask): semantic metrics the engine did not run, names in other capitals, and the office readings

## v1.15.8 - 2026-09-11

- feat(ask): follow-ups edit the previous AI-drafted SQL; an office-shaped golden lane carries the office question
- fix(ask): a warehouse join proof tests a key named for the table it points at
- fix(ask): a join no governed relationship covers sends the full reading to AI-drafted SQL instead of shrinking the question
- feat(ask): AI-drafted SQL finds its tables through the catalog, locates stated values, and reads governed metric definitions
- fix(ask): AI-drafted SQL is checked before it runs, stays in scope, and says what it filters on
- fix(ask): AI-drafted SQL reads the user's context and looks across every table before declining

## v1.15.7 - 2026-09-11

- feat(ask): when no governed tier answers, the AI writes SQL from the schema, and every run tells its story

## v1.15.6 - 2026-09-11

- fix(ask): a reading's own checks no longer block a correct answer after fields are fetched
- fix(ask): an out-of-scope ref spelled with the wrong kind and a schema still names its owning domain

## v1.15.5 - 2026-09-11

- fix(ask): the relations a reading names are described before it is prepared
- fix(ask): the context assembles in seconds, the composer's SQL is proven by what it reads, and a warehouse observation joins the relation dbt spelled
- fix(ask): unify manifest discovery and physical execution bindings

## v1.15.4 - 2026-09-10

- feat(ask): the cascade is reachable again — ranked columns reach the reading, a retrieval gap is retrieved before it is a gap, and SQL is the last tier

## v1.15.3 - 2026-09-10

- fix(ask): every literal is proven against its field before SQL — a relative period becomes its dates, a value a field cannot take is asked back

## v1.15.2 - 2026-09-10

- fix(ask): the MetricFlow manifest lives with the dbt project, a Snowflake identifier keeps dbt's case, the context is assembled within a budget and on the record

## v1.15.1 - 2026-09-10

- fix(ask): coverage is satisfied through lineage, an aggregate has a number's type, a provider exit is classified, a denied scope is explained
- fix(context): a rule and a question intersect, a purpose keys its context, a hint matches its object, ownership is a set
- feat(context): a mandatory rule is one field, physical context follows its entity, a rate carries its period
- feat(context): Domain Studio reads Ask's warehouse proofs; the ledger names the compiler's joins
- docs(context): tracker W10 carries the fixture commit
- test(context): a multi-domain fixture with a decoy, and the term two domains could not share
- feat(modeling): a business concept — one thing known under several keys
- feat(ask): every surface reads the same projection
- feat(ask): the vocabulary is a view over the pack, a policy is enforced, a join has one proof
- docs(spec): amend the trust contract before the context-contract work

## v1.15.0 - 2026-09-09

63 commits since 1.14.6. `git log ec167df7..63f6e327` lists them; the notes
below were written while the release was being built.

### Ask analyst: one plan, five tools

- The model-facing tool surface is five tools: `describe_relation`,
  `search_values`, `propose_plan`, `request_clarification`, `finish_answer`.
  `propose_plan` is the one build contract — measures, dimensions, filters,
  time, ordering, a row bound — whose ids may name a certified block, a
  semantic metric, or a `<relation>.<column>`. The HOST resolves the tier
  (certified, then semantic, then a composed single-relation governed
  program; `sql {text, reads}` is the review-required last resort) and
  assigns trust; the model can no longer pick a trust label by picking a
  tool. `describe_relation` on a metric id describes the metric.
- The tier handlers (`run_certified`, `compile_and_run_semantic`,
  `compile_and_run_dql`, `validate_and_run_sql`, `describe_metric`, the
  `inspect_*` inspectors) stay in the dispatch table as hidden aliases of the
  advertised tool: still kernel-gated, still observed under their own names
  in the receipt, callable by the host floor, host-first and older
  transcripts, never declared to a model. Tool definitions gained
  `hidden`/`aliasOf`; the loops admit an alias exactly when its advertised
  tool is admitted.
- Inspections are host work: the certified, semantic and relational cards
  were already prefilled; a definition/business turn now also gets its
  business-context cards, and a follow-up its trusted prior-result bindings,
  before the first dispatch. A kernel that still wants an inspection
  recorded before an execution gets it from the plan dispatcher.
- A post-execution prose reply is the narration. Every transport used to
  discard a model that wrote the answer text without the `finish_answer`
  envelope and spend another send asking for the same words. The
  narration-phase prose now goes to the host's own finish control (the
  route, trust and facts were always host-composed); a turn that never
  executed is never adopted.
- Native multi-model semantic joins are proven. The composer's fanout probe
  runs BEFORE the governed query in the V2 lane: a join that multiplies base
  rows is a typed block (`SEMANTIC_FANOUT_DUPLICATE_KEY`, nothing shown); a
  probe that cannot be evaluated leaves the answer review-required.
- The deterministic display-key clarification is back, host-side: "the top
  names by revenue" over a metric whose capability contract declares several
  rank entities is asked, not guessed, before any dispatch; each option
  carries the authored dimension id and the question to resubmit.
- A semantic compile failure says what the compiler said. "MetricFlow could
  not group average_order_value by 'location_name' … valid options include
  location__location_name" replaces "the query did not complete on the
  current connection"; the failure's origin is validation (nothing reached
  the warehouse), so the host floor may still walk the lower tiers, and a
  plan proposed after a frozen plan failed counts as the one admitted
  same-plan repair without the model having to know the flag.
- An admitted relation card proves its own execution closure when the
  context pack's allowed-SQL list happens not to carry it.
- Every transport hides the tier handlers. The Claude Code SDK and native
  SDK loops declared every tool to the model, hidden ones included; a model
  then called `run_certified` by name until its budget died. Hidden names
  are also rewritten out of every string a tool returns and out of the
  opening cards, and a refused hidden certified call is answered with the
  plan-level guidance instead of a fifth identical denial.
- Contextual prefill is host evidence. Routing the host's own prior-result
  and business-context prefill through the analyst's tool gate had the
  kernel refuse it, and the follow-up lost the one fact it needed: which
  column the prior-result member came from. It is now recorded directly,
  and the bound member is carried into a prior-result plan as a filter on
  its own dimension.
- A bound member keeps its column. A filter that put a prior-result value
  on another dimension (`customer_type = 'Ryan Byrd'`) passed the literal
  proof and shipped a governed null; it is refused before compilation.
- A plan never broadens a qualified question silently. A plan whose
  measures, dimensions and filter values bind none of the question's
  qualifying terms still runs when the analyst bound the term by judgment
  (`beverage` → `drink_revenue`), but the answer is review-required and says
  which admitted cards carry the term; the host has no synonym authority to
  refuse it.
- A certified block's authored scope counts. `top_beverage_customers`
  (tags beverage/customer, output `beverage_revenue`, `WHERE is_drink_item`)
  is now complete for "top customers by beverage": a term the parser read as
  a grouping is satisfied by an output NAME that declares it, the column's
  structural words (`item`) are not scope, and a question that entails one
  of the block's non-structural tags has asked for the scope its WHERE
  clause implements. The verbatim-example rule still governs filters.
- A plan's `orderBy` that names none of the selected fields ("revenue" for
  `drink_revenue`) resolves to the selected field it names, else to the
  measure, instead of freezing an unrunnable plan.
- A frozen plan that failed ends the turn. After a frozen semantic plan's
  compilation failed, every different plan was correctly refused as a
  post-freeze mutation — and the analyst kept proposing anyway: four
  denials, seventeen tool calls and forty-two seconds to reach a refusal
  the first denial already knew. The first denial still teaches (the one
  permitted same-plan repair is unaffected); a second closes the turn with
  the execution failure that actually happened.
- A ranking of entities is labelled, not keyed. A plan that groups by an
  entity key when the snapshot admits a label for the same entity is
  rewritten to the label, so "top customers" cannot answer with opaque
  identifiers. The key is kept when the question asks for the identifier
  itself, and never replaced by a label the snapshot did not admit.
- The never-broaden rule covers follow-up turns, not only first questions.
- An Ask turn is executed once, and its answer is never replaced by a
  second, worse one. The engine's repair loop did not recognise a V2 Ask as
  frozen, so a failing evaluation ran the executor again; the second pass
  opened a fresh lane over a state that had already finished, and a result
  the first pass had validated and preserved was replaced by that pass's
  budget refusal. Live, a governed relational query returned rows and the
  run reported "DQL stopped at its own orchestration budget" with zero
  facts. The engine now treats an authoritative V2 decision as frozen, and
  the lane memoizes its answer per turn state so any other re-entry returns
  what the turn already proved.
- An unadmitted `expectedOutputIds` refusal names which identifier failed
  and offers real `<relation>.<column>` examples. It used to answer "not
  admitted" with a list of card ids while asking for column ids, so the
  model guessed again and the same refusal repeated until the budget died.
- A prior-result member filter binds the member's dimension, never the
  member-value card the host minted for it.
- A physical relation whose catalog name already carries a quoted segment
  (Snowflake's `"ANALYTICS_PROD".schema.table`) is quoted once per segment.
  Wrapping the quoted segment again produced a triple-quoted identifier that
  ended the composed block's own triple-quoted query, so the parser refused
  every governed relational program on the enterprise warehouse.

### The V1 answer loop is gone

- `answer()` and the V1 execution body of `answer-loop.ts` (≈9,900 lines)
  are deleted, with the V1-only tests. The file is now the answer CONTRACT
  (the `AgentAnswer` / `AnswerLoopInput` types) plus the small helper
  library the V2 host still uses; `cascade/packer.ts` went with it. Public
  export of `answer` is removed.
- `dql agent ask` and `dql agent eval` drive the running runtime over HTTP
  (`POST /api/agent-runs`), exactly as the notebook and the MCP server do;
  the eval's in-process `--via loop` driver is removed. The Slack bot proxies
  to the runtime at `DQL_RUNTIME_URL` (default `http://127.0.0.1:3474`).

### Persisted runs: each artifact payload once, each receipt once

- The SQLite run store is content-addressed: every artifact payload is
  stored once under the fingerprint of its canonical JSON
  (`agent_run_artifacts`), the run row keeps `{ id, kind, title,
  trustState, ref, payloadRef }`, a ref table ties blobs to the runs that
  cite them, and retention prunes orphans. Two runs with the same payload
  share one blob; `get` hydrates `payload` back so every reader sees the
  artifact as written; `list` returns index rows with `payloadRef` only.
  Rows written before this are externalized in batches as the store opens.
- Diagnostic receipts live on the run root only. The engine no longer
  stamps the eight receipt copies into the answer artifact's payload and
  the runtime no longer re-stamps them after dispatch accounting; the
  transport projection presents the root receipts on the answer artifact
  for readers that expect them there, as a view.
- `diagnosticReceiptV7` (the "concise inspector") is removed: nothing
  produced it. V1–V6 and V8 remain; unifying them into one receipt type is
  deliberately out of scope (V5/V6 are still produced by restart recovery
  and Research roots; V8 is the V2 kernel receipt).

### The hybrid router is gone

- `createHybridRouter` (`router.ts`, 7,255 lines) is deleted with its
  tests. It was unreachable: the engine routes every forced non-Ask mode
  (sql, block, app, modeling, skill) deterministically without consulting
  a router, and every Ask request (`auto`, `ask`, `research`) is the V2
  runtime's. The V2 runtime no longer takes a `legacyRouter`; a non-Ask
  request reaching it is reported as a wiring fault. Public exports
  `createHybridRouter`, `compileAskAnalyticalProgramV1`,
  `bindAskAnalystProgramMeaningV1`, `buildMeaningSystemPrompt`,
  `buildMeaningUserPrompt`, `parseMeaningResolution` and the router types
  are removed.

### Ask runtime: one runtime, and a floor under it

- `authoritative_v2` is now the default Ask runtime. `shadow_v2` — which built
  V2's decision for every question and then discarded it in favour of V1 —
  is removed, along with `dql agent shadow-report`. A project config or
  `--ask-runtime-mode` naming `shadow_v2` now fails loudly.
- The V1 analyst runtime (`createAskAnalystRuntimeV1`) and the `legacy_v1`
  rollback mode are deleted. `authoritative_v2` is the only Ask runtime;
  non-Ask modes (sql, block, app, modeling, skill) keep the hybrid router.
  Public exports of the V1 runtime are removed (minor version bump).
  Still present, deliberately: `answer()` in `answer-loop.ts` (the MCP
  `query-via-metadata` / `query-via-block` tools run through it), the Ask
  branches of `router.ts` (reachable only for non-Ask modes), and the V1–V4
  diagnostic receipts on persisted runs. Those go with the MCP tools' move to
  the V2 lane and the receipt collapse in a later release.
- The host floor: when the analyst's turn ends with nothing executed (a spent
  budget, a provider fault, a plan that would not compile, an analyst that
  declined to act), the host walks the tier ladder itself — the proven
  certified block, the exactly-bound semantic metric, a single-relation
  program composed from the question over admitted columns (labelled
  review-required), or a refusal that names the measures that exist. It never
  answers a narrower question more broadly and never replaces a plan that
  reached the warehouse.
- Deleted the gates that only ever spent dispatches: inspection-order
  requirements before execution, the refusal of a repeated parameterless
  inspector, the kernel's dead dispatch/duration budgets, the provider
  wrapper's hardcoded dispatch cap and the silent per-provider default of two
  sends. The run-scoped dispatch ledger is the one dispatch authority.
- Persisted runs keep each artifact payload once; the server no longer grows
  ~4 MB per question.
- Under a native tool loop (Claude OAuth, OpenAI) every Ask tool result —
  even `{ finished: true }` — was reported to the model as a blocked row
  payload by the egress guard, so the model never saw its finish and spent
  the whole budget re-calling it (nine or ten dispatches for a one-metric
  question). The lane now marks its tool outputs as host vocabulary; the
  guard keeps its strict reading of unmarked payloads. Live: "beverage
  revenue" went from 9 dispatches to 2.
- A composed relational program names the warehouse's physical relation
  (`"dev"."customers"`, quoted per segment), a refusal repeated twice steers
  the analyst to the next tier, and a semantic tier with no executable
  metric is no longer advertised as available.
- The run index reads only the requested page; stored runs written before
  slimming are slimmed in place a few at a time (a 1.2 GB history no longer
  crashes the server when the notebook lists runs).
- A project with no AI provider configured still gets its certified blocks,
  its exactly-bound semantic metrics and host-composed relational answers:
  the V2 lane runs host-first execution and the floor around an absent
  analyst instead of stopping at provider preflight.
- The certified top-N proof accepts a block whose fixed `LIMIT` equals the
  requested N on a verbatim authored example or a unique complete fit, and
  refuses a ranked block for an unranked "each customer" listing and a
  grouped block for a scalar ask. Only a verbatim example lets a block answer
  a question with a filter or a dropped qualifier ("top BCM customers").
- The native semantic compiler is selected for a metric it alone can serve
  even when a MetricFlow binary is installed but not ready.
- Known gap: the deterministic display-key clarification ("Show the top names
  by revenue" → choose Customer Name / Product Name) is a V1 mechanism. Under
  `authoritative_v2` a configured analyst may still ask through
  host-validated rival candidates; the zero-provider clarification returns
  with the single turn/clarification owner in the next release.

## v1.14.6 - 2026-09-01

- fix(ask): big-repo Ask reliability — catalog-truth refusals, budget walls, never-dead-end close

## v1.14.5 - 2026-09-01

- fix(ask): generic request nouns are not fields — stop false unmodeled refusals

## v1.14.4 - 2026-09-01

19 commits since `v1.14.3-rc.1` (`git log v1.14.3-rc.1..003e0dd4`); the features:

- feat(ask): deterministic member binding — grounded literals and clicked selections execute with zero dispatches
- feat(ask): meaningful deterministic answers for executed runs — P4 facts renderer wiring
- feat(ask): host-first semantic execution — zero-dispatch turns when no decision exists
- feat(ask): a typed time window, from the question all the way into the query
- feat: add authoritative Ask agent runtime v2
- feat(ask): restore retrieval-first analytical follow-ups
- feat(ask): rework orchestration and trace evidence
- feat(ask): add retrieval-first analytical orchestration

## v1.14.3-rc.1 - 2026-08-25

### Ask AI orchestration and observability

- Implemented the Ask-first analytical recovery contract: one host-owned
  analytical frame carries explicit measures, entities, display keys,
  dimensions, outputs, ranking, time, and conversation binding through the
  certified, semantic, governed-relational, and safe exploratory cascade.
- Hardened generated-SQL and relationship authorization around frozen plans,
  exact output/source bindings, target and snapshot closure, read-only policy,
  and one bounded in-lane repair. Exploratory results remain
  `review_required`; only proven certified or semantic execution can be
  governed.
- Added durable, redacted Ask/Research trace summaries that distinguish plan,
  compile, provider, execution, and branch failures; surface a meaningful
  partial-Research limitation and safe next action without turning a successful
  root finding into a false blocked run.
- Tightened provider dispatch and result-row egress: ordinary Ask retains no
  result-row narration; explicitly opted-in Research records bounded
  receipt-backed research narration and phase-aware provider attempts.

### Release-candidate status

- `1.14.3-rc.1` is an unpublished npm prerelease target for `next`, not a
  released `latest` version. The post-publish smoke must install the exact
  `@duckcodeailabs/dql-cli@1.14.3-rc.1` package.
- The changes above are implemented with local OSS test/build evidence. They
  do not independently verify private office metadata, fiscal calendars,
  provider configuration, vector indexes, or warehouse behavior; those remain
  separate office replay gates.

## v1.14.2 - 2026-08-21

### Ask AI analytical-cascade recovery

- Restored answerability without weakening the governed boundary: Ask AI now
  evaluates complete certified, semantic, governed-relational, and bounded
  exploratory-SQL routes in order before it asks for clarification or reports
  a gap.
- Preserved explicit analytical roles through retrieval and selection, so a
  requested measure, entity/display key, time role, or relationship cannot be
  replaced by an unrelated but lexically similar candidate.
- Tightened certified fit: a certified answer must prove the requested measure
  from its own declared output instead of borrowing coverage from a pooled
  candidate set.

### Conversation, diagnostics, and research receipts

- Persisted stable clarification selections, the original question, and the
  typed partial analytical frame so reloads and follow-ups do not repeat or
  reinterpret a completed choice.
- Added redacted, phase-specific provider diagnostics for authentication,
  model, rate-limit, gateway, network, timeout, admission, budget, and
  cancellation failures.
- Added structured Ask and Research receipts for source coverage, candidate
  admission/exclusion, cascade attempts, frozen-plan state, and
  evidence-supported Research branch verdicts.

### Validation limit

- This release candidate is verified against the local OSS fixtures and
  packaged runtime. The private office repository, its metadata/vector indexes,
  fiscal calendar, provider configuration, and warehouse remain outside this
  repository and require a separate office replay before claiming those
  customer-specific questions are fixed.

---

## v1.13.5 - 2026-08-14

### Ask AI answers in sentences again

Ordinary Ask had stopped narrating. Answer synthesis was gated on
`requestedMode === 'research'`, but the Ask panel sends `auto`, so every normal
question shipped the answer loop's internal `column: value` record as its
answer. This release restores the language lane and makes failures say what
actually went wrong.

### Added

- **Bounded result-row egress with an admin kill-switch.** A model that cannot
  see the values it is describing cannot describe them, so a redacted sample of
  up to 20 rows now accompanies narration. Set
  `agent.providerResultRowEgress.mode` to `"disabled"` in `dql.config.json` to
  keep every cell value on the host — narration still runs, grounded in column
  names and computed statistics only. Every run emits an egress receipt naming
  the policy that applied, whether or not rows were sent.
- **Claim-verified narration.** On analytical-graph routes the model drafts
  claims that each cite a fact id, and each is checked against the immutable
  fact set before display: causal wording, unknown facts, numbers absent from
  the cited facts, and hidden material caveats are all rejected, retried once,
  and only then replaced by the deterministic record — which now says so.

### Improved

- **Narration has its own dispatch budget.** It previously shared the generation
  bucket, so a run could compute the right numbers and then have nothing left to
  say them with.
- **Dispatch admission is latency-aware.** DQL measures what your provider
  actually costs and refuses to start a call the deadline cannot finish, instead
  of being killed mid-flight with nothing to show. Subscription-CLI providers
  benefit most.
- **Clarification cards are readable and answerable.** Duplicate labels are
  disambiguated by kind, raw semantic-layer records are summarized into a
  sentence instead of pasted as YAML, and choosing an option keeps your original
  question rather than re-asking the option's own label.
- **Follow-ups ask instead of guessing.** "This customer" after a ten-row answer
  silently bound the first row as the referent; ambiguous references now become
  clarification options.

### Fixed

- **A DQL-side stop is no longer reported as your AI provider failing.** Run
  budget exhaustion, the orchestration soft target, and a mid-run project
  snapshot rebuild were all surfaced as `<provider> failed`, sending users to
  re-authenticate a provider that was working.
- **A refusal no longer reads "Needs input".** Terminal refusals are labelled
  `Refused`, clarifications keep `Needs input`, and the reason the run actually
  recorded now reaches the card instead of a generic headline.

---

## v1.13.4 - 2026-08-11

### Reliable App authoring and durable Block certification

This patch makes App AI source selection deterministic, keeps manually authored
draft blocks available through an explicit local review lane, and makes Block
certification progress recover correctly across navigation and busy histories.

### Added

- **Visible App AI activity.** App Studio shows honest planning phases while it
  understands the request, searches certified and draft blocks, validates trust
  and capabilities, and prepares the source review.
- **Authoritative source selection.** Sources explicitly added in AI review are
  resolved by canonical ID and retained through proposal revision, composition,
  preview, retry, and resume.
- **One-click draft composition.** A manually authored draft can atomically
  enable the local review lane, add its source and tile, and create the required
  review task without changing its lifecycle or publication eligibility.

### Improved

- **Simpler App library and Studio layout.** Existing Apps appear first, the new
  App form expands on demand, source filters fit the compact sidebar, and source
  rows provide adding, added, retry, and add-another feedback.
- **Actionable publication review.** One toolbar action opens the governed
  checklist, and its blocker count now matches the exact actionable rows.
- **Durable certification progress.** Active operations survive list limits and
  remounts, exact operation IDs win recovery, terminal states remain monotonic,
  and Task Center coalesces superseded attempts by block artifact identity.

### Fixed

- **App source provenance.** Generated Ask and research drafts stay out of the
  reusable App catalog unless explicitly tagged for reuse, while ordinary
  semantic drafts with parameters or time metadata remain discoverable.
- **Large-repository freshness.** Root and domain block changes invalidate the
  indexed project snapshot without capped recursive warm scans.
- **AI coverage integrity.** Provider and fallback plans cannot claim that an
  unrelated measure, dimension, or filter satisfies a visible App requirement.
- **Draft publication boundary.** Draft and review-required sources execute in
  local preview but continue to block Project publication until certified,
  replaced, or removed.

### Verification

- Independent pre-release verification passed 1,331 agent tests, 306 Notebook
  tests, and 764 CLI tests with three intentional skips.
- Built `dql notebook` acceptance verified App AI activity, certified and draft
  source selection, server composition, partial preview, compact source filters,
  and fail-closed publication in an isolated local fixture.
- The synchronized release dry run passed all 22 workspace builds, all 41 test
  tasks, and packed all 19 npm packages.
- All 19 npm packages report `version=1.13.4` and
  `dist-tags.latest=1.13.4`.
- Fresh project-local and global CLI installs both report `dql 1.13.4`, and
  `create-dql-app@1.13.4 --help` resolves successfully.

## v1.13.3 - 2026-08-11

### Enterprise App AI and clearer Block Studio recovery

This patch replaces the split App Builder paths with one snapshot-backed,
server-owned Studio workflow and makes Block Studio runs and certification
failures easier to understand and correct. Certified and draft blocks are
discoverable without weakening the boundary that keeps review-required Apps
local until their sources are governed.

### Added

- **Dedicated App orchestration.** App AI uses a stateful App-specific
  orchestrator over the shared provider, immutable snapshot, meaning,
  execution, repair, trust, and evidence foundations used by Ask and Notebook.
- **Snapshot-backed source catalog.** Manual and AI authoring search the same
  paginated catalog across certified, review, and draft executable blocks,
  preserve qualified path identities and duplicate names, and resolve exact
  source revisions on the server.
- **Canonical App composition.** The server owns proposal revisions, source
  allow-lists, source-to-tile bindings, requirement coverage, four-worker
  preview coordination, filter capabilities, and restart-safe receipts.

### Improved

- **Block Studio guidance.** Draft, run, validation, and certification states
  now use focused step-level messages and corrective actions instead of noisy
  raw diagnostic text.
- **Results-first runs.** Successful Block runs foreground result data and keep
  generated SQL available as supporting evidence rather than the default view.
- **Draft-to-certification flow.** Save, run, validation, tests, chart, lineage,
  and certification blockers remain visible as one progressive checklist while
  unrelated background work stays out of the primary action path.

### Fixed

- **Draft App sources.** Review-required blocks remain visible and selectable
  for local Apps, execute with explicit trust labels, and are blocked from
  Project publication until certified, replaced, or removed.
- **Large and ambiguous catalogs.** Server search, cursor pagination, exact
  resolution, and path-qualified identity replace request-time top-50 scans
  and same-name collapse.
- **Publication drift safety.** Certified block sources and tiles without a
  bound revision now fail closed; current-looking preview or preflight receipts
  cannot publish an unversioned binding.

### Verification

- The synchronized release dry run passed all 22 workspace builds, the full
  workspace test graph, and packed all 19 npm packages.
- Independent focused verification passed all 76 Apps API tests, including the
  unversioned-source publication regression and zero-write assertion.
- All 19 npm packages report `version=1.13.3` and
  `dist-tags.latest=1.13.3`.
- Fresh project-local and global CLI installs both report `dql 1.13.3`, and
  `create-dql-app@1.13.3 --help` resolves successfully.

## v1.13.2 - 2026-08-10

### Governed App Studio authoring, filters, and publication

This patch completes the unified local App Studio workflow for manual and AI
authoring. Ask AI, source selection, dashboard filters, automatic previews, and
Project publication now share the same guarded `AppBuildDraft` lifecycle.

### Added

- **Governed dashboard filters.** Authors can select declared block filters,
  semantic dimensions, and safe settled-result columns, choose App or page
  scope, and explicitly include every compatible tile. Date controls show
  ephemeral data availability before save, and all linked tiles refresh from
  one filter change.
- **Ask AI to App Studio.** Certified Ask results retain their source identity
  and fingerprints, while exploratory SQL is stored as referenced local review
  DQL. Both open the exact editable App draft and page without writing governed
  Project source.
- **Direct publication fixes.** The publish review groups blockers and places a
  corrective action beside each one. The final Project write consumes the
  reviewed receipt and remains atomically revalidated server-side.

### Fixed

- **App navigation and draft continuity.** Back returns directly to the unified
  Apps library, clears stale App selection, and no longer opens the retired
  empty workspace. Ask, global Copilot, and App Copilot additions refresh the
  same Studio draft.
- **Filter compatibility and date feedback.** Certified computed result
  dimensions are available when safe, measures remain excluded, unsupported
  tiles explain why they are unaffected, and empty date fields cannot create a
  misleading filter.
- **Preview and review flow.** Adding a governed view runs the page preview
  automatically, stale responses are ignored, review-required local analysis
  has a direct remove/replace path, and repeated readiness-check loops are
  eliminated.

### Verification

- The synchronized release dry run passed all 22 workspace builds, the full
  workspace test graph, and packed all 19 npm packages.
- All 19 npm packages report `version=1.13.2` and
  `dist-tags.latest=1.13.2`.
- Fresh project-local and global CLI installs both report `dql 1.13.2`, and
  `create-dql-app@1.13.2 --help` resolves successfully.

## v1.13.1 - 2026-08-04

### Recoverable Block Studio editing and governed context authoring

This patch ships the post-`1.13.0` authoring work on `main`. Block Studio now
keeps invalid drafts editable and offers bounded AI repair, while Modeling and
Skills share a write-free proposal lifecycle with explicit review and commit.

### Added

- **Governed context proposals.** Manual Modeling, dbt discovery, YAML import,
  Modeling AI, and Skills AI can produce immutable, review-required proposals
  with source snapshots, dependency fingerprints, exact patches, validation,
  and explicit commit.
- **Atomic authoring review.** Context proposal commits validate the expected
  proposal hash, compile the complete candidate, reject source or dependency
  drift, and restore prior bytes instead of leaving partial writes.
- **Modeling workspace actions.** The dbt-first workspace exposes clearer
  connected-dbt, YAML import, manual-start, batch-binding, and relationship
  review paths without promoting suggestions to certified proof.

### Fixed

- **Editable Block Studio syntax failures.** Invalid DQL is rejected before a
  block file is written, the source editor remains available, and the error
  explains that the draft was not saved instead of reopening a frozen block.
- **Bounded AI repair and run.** `Fix with AI & run` repairs one malformed DQL
  draft on the same target, validates the repaired source, and returns its run
  result without automatically saving or certifying the change.
- **Recoverable validation.** Parameter parsing and structural diagnostics now
  return actionable validation responses, while missing semantic runtime setup
  does not incorrectly prevent a structurally valid draft from being saved.

### Verification

- The synchronized release dry run passed all 22 workspace builds, all 41 test
  tasks, and packed all 19 npm packages.
- All 19 npm packages report `version=1.13.1` and
  `dist-tags.latest=1.13.1`.
- Fresh project-local and global CLI installs both report `dql 1.13.1`, and
  `create-dql-app@1.13.1 --help` resolves successfully.

## v1.13.0 - 2026-08-03

### Governed App Builder, asynchronous workflows, and durable AI analysis

This minor release brings every post-`1.12.11` feature on `main` into one
synchronized distribution. It expands governed Apps into a multi-page story
builder, keeps long-running local work alive across navigation, and closes the
remaining Ask/Notebook target-continuity gaps without weakening review or
certification boundaries.

### Added

- **Governed multi-source App Builder.** Build complete Apps from certified
  blocks, governed semantic sources, and review-required exploratory sources,
  with incremental page generation, editable proposals, explicit commit, and
  source-tier evidence retained in each component.
- **App-level analysis controls.** App viewers can switch supported results
  between table and chart views, inspect DQL, SQL, lineage, and answer evidence,
  open work in Notebook, and run bounded same-target repair from an individual
  failed App component.
- **Responsive App Copilot.** Copilot results support wider/expandable layouts,
  adjustable height, readable wide tables, visible Add-to-App state, and quick
  navigation to the added component.
- **Durable background operations.** Ask AI, Notebook AI, and App Builder runs
  continue across route changes and remounts, with persisted run identity,
  recovery, cancellation, and a shared task center instead of blocking the UI.
- **Recoverable App deletion.** Apps can be removed through a confirmed,
  guarded action alongside View and Edit.

### Improved

- **Asynchronous application shell.** Project refresh, metadata refresh,
  Notebook execution, saving, certification, and other long-running local work
  use coordinated background operations so unrelated pages and activities stay
  responsive.
- **App presentation quality.** Auto-layout Apply is durable, component result
  cards expose complete context, and currency, date, time, and decimal values
  use meaningful display formatting.
- **Ask clarification continuity.** Structured clarification choices retain the
  original analytical question and receive the correct analytical deadline even
  after reload or when conversation storage is unavailable.
- **Research continuity.** Research deeper carries the successful Ask SQL, DQL,
  result sample, and exact execution target. If deeper composition cannot
  produce a safer executable query, DQL revalidates and retains the successful
  baseline instead of replacing it with a noisy failure.

### Fixed

- **Target-grounded schema repair.** Complete live Snowflake, Databricks, and
  DuckDB schemas remain authoritative for execution, while partial retrieval
  cards and certified source SQL are merged without reintroducing stale columns
  or triggering an unnecessary second AI generation.
- **Research target drift.** Research schema inspection, certified execution,
  generated SQL, preview, cancellation, and fallback now remain bound to the
  same connection selected by the originating Ask run.
- **Certified Block Studio state.** Save and certification actions retain their
  intended status while background work proceeds without freezing the page.

### Verification

- The synchronized release dry run passed all 22 workspace builds, every
  workspace test task, and packed all 19 npm packages.
- Full DQL Agent suite: 107 files and 1,299 tests passed.
- Full local-runtime integration suite: 259 tests passed.
- Full Notebook suite: 48 files and 224 tests passed.
- All 19 npm packages report `version=1.13.0` and
  `dist-tags.latest=1.13.0`.
- Fresh project-local and global CLI installs both report `dql 1.13.0`, and
  `create-dql-app@1.13.0 --help` resolves successfully.

## v1.12.11 - 2026-08-01

### Quiet Notebook repair and governed authoring context

This patch brings Ask AI's bounded repair experience into Notebook, makes
business-domain choices consistent across authoring surfaces, and replaces the
eager warehouse tree with a dbt-scoped database browser.

### Added

- **Quiet Notebook repair.** Failed SQL and SQL-backed DQL cells offer a simple
  `Fix and retry` action that repairs and reruns the same cell on the same data
  target without opening Notebook AI or adding repair chatter to its context.
- **Reviewable repair evidence.** A successful repair replaces only the current
  cell, marks changed artifacts as review-required, and retains the original
  source, SQL, error, run, and target evidence in Trust & Steps.
- **dbt-scoped Database browser.** Database search now returns only physical
  models and sources from the connected dbt manifest, loads 25 objects at a
  time, searches on the server, and fetches columns only when a relation is
  expanded.

### Fixed

- **Safe repair eligibility.** Permission, policy, credential, parameter,
  dependency, cross-engine, target-drift, semantic, ambiguous, and stale-cell
  failures remain explicit user decisions instead of being rewritten
  automatically.
- **Uniform authored domains.** Notebook, Block Studio, Models, Skills, Apps,
  and related filters now use only first-class domains created in the Domain
  workspace. Metric and dimension catalog folders no longer appear as business
  domains, while legacy assignments remain visible until the user remaps them.
- **Display-only catalog scope.** Restricting the Database browser to dbt
  relations does not mutate the DQL manifest or the metadata and indexes used
  by agent retrieval.

### Verification

- The synchronized release gate passed all 22 workspace builds and all 41
  workspace test tasks.
- Full DQL Agent suite: 107 files and 1,290 tests passed.
- Full CLI suite: 55 files passed with 685 tests passed and 3 skipped.
- Full Notebook suite: 47 files and 210 tests passed.
- The release dry run packed all 19 npm packages successfully.
- All 19 npm packages report `version` and `latest` as `1.12.11`.
- Fresh project-local and global CLI installs both report `dql 1.12.11`;
  published CLI help and `create-dql-app@1.12.11 --help` also resolve.

## v1.12.10 - 2026-08-01

### Smooth, bounded Ask AI query repair

This patch removes the main execution-path differences that let a query fail in
Ask AI even when the same analytical work could run in Notebook. Failed Ask
turns now offer a clean, reviewable repair action without contaminating the
context used by the user's next question.

### Fixed

- **Shared Ask and Notebook SQL preparation.** Both surfaces now use the same
  execution preparation path for generated SQL and DQL-derived SQL, including
  physical `source::` reference resolution and target-aware validation.
- **Bounded one-click repair.** A failed read-only analytical query can create
  one immutable derived repair attempt on the same execution target. DQL first
  applies deterministic corrections, then permits at most one AI repair retry
  instead of entering an open-ended regeneration loop.
- **Failure isolation.** Rejected SQL and repair-only diagnostics are excluded
  from the normal context for a following user question, so one bad turn does
  not cause otherwise valid follow-up questions to inherit the same failure.
- **Clean failure presentation.** Ask AI shows typed, concise failure states and
  replaces the failed answer in place after a successful repair instead of
  exposing internal blocker and parser noise as the primary result.
- **Notebook behavior preserved.** Notebook keeps its existing review-first AI
  correction flow while sharing the same preparation and execution boundary.

### Verification

- The synchronized release dry run passed all 22 workspace builds and all 41
  workspace test tasks.
- Full DQL Agent suite: 107 files and 1,290 tests passed.
- Full CLI suite: 55 files passed with 678 tests passed and 3 skipped.
- Full Notebook suite: 45 files and 204 tests passed.
- All 4 Ask AI and Notebook execution-parity tests passed.
- Built-CLI browser QA verified the repaired Ask AI experience.
- All 19 npm packages report `version` and `latest` as `1.12.10`.
- Fresh project-local and global CLI installs both report `dql 1.12.10`.

## v1.12.3 - 2026-07-30

### Durable Ask AI execution and faster Notebook navigation

This patch completes the Ask AI and Notebook execution-parity work, makes chat
deletion durable across refreshes, and removes avoidable UI and metadata-cache
work from normal Notebook navigation.

### Fixed

- **Connection-scoped Ask execution.** Ask AI now carries the selected
  connection and its current metadata snapshot through planning, generated DQL,
  semantic-table resolution, execution, and Notebook handoff instead of
  resolving part of the run against a stale or different catalog.
- **Durable conversation deletion.** Deleting an Ask session removes its
  persisted thread, turns, and search rows, while UI tombstones prevent an
  overlapping stale history response from restoring the deleted session.
- **Notebook handoff parity.** Generated answers preserve the execution target
  when opened in Notebook so rerunning the artifact uses the same connection as
  the original governed run.

### Performance

- **Route-level UI loading.** Notebook routes and large analytical surfaces are
  loaded on demand instead of entering the initial shell bundle.
- **Narrow lineage import.** The UI imports derivation helpers through a focused
  DQL Core subpath rather than pulling the SQL parser barrel into the main
  bundle.
- **Reusable startup metadata.** A valid fingerprinted catalog is reused at
  startup, and immutable fingerprinted assets receive long-lived browser cache
  headers while HTML remains revalidated.

### Verification

- Full DQL Agent suite: 103 files and 1,228 tests passed.
- Full Notebook suite: 42 files and 188 tests passed.
- Focused CLI runtime/metadata suite: 10 tests passed.
- DQL Core, Notebook UI, and CLI production builds passed.
- A real loopback API check verified that deleted chat sessions remain deleted.
- Built-CLI browser checks against `jaffle-shop-duckdb` verified cached
  navigation with no browser errors.
- The synchronized workspace release gate passed: all 22 workspace builds,
  the full test graph, and all 19 npm tarballs completed successfully.
- All 19 npm packages report `version` and `latest` as `1.12.3`.
- Fresh project-local and global CLI installs both report `dql 1.12.3`, and
  `create-dql-app@1.12.3 --help` resolves successfully.

## v1.12.2 - 2026-07-30

### Ask AI and Notebook warehouse execution parity

This patch removes the main execution differences that allowed a DQL artifact
to run in Notebook while the equivalent Ask AI answer failed against the same
warehouse.

### Added

- **Explicit Ask execution target.** Ask AI shows the selected database beside
  Thinking and uses that one connection for metadata grounding, semantic
  compilation, certified/generated execution, and bounded validation.
- **Safe stale-session recovery.** A terminated warehouse session is evicted and
  reconnected once for a single read-only `SELECT` or `WITH` statement. DQL
  never replays mutating or multi-statement SQL automatically.

### Fixed

- **Snowflake physical identifiers.** Governed compilation preserves dbt
  `relation_name`, explicit quoting, and Snowflake's normal unquoted
  case-folding instead of turning lowercase dbt schema and column names into
  different case-sensitive objects.
- **Cross-surface connection drift.** Certified blocks, generated DQL, schema
  context, semantic queries, and exploratory validation no longer silently
  fall back to a different default connection during an Ask run.
- **Warehouse recovery classification.** Terminated sessions are explicitly
  retryable, while Snowflake's combined “does not exist or not authorized”
  relation message routes through metadata refresh instead of fabricated SQL
  repair or an unrecoverable permission dead end.

### Verification

- Full DQL Agent suite: 103 files and 1,226 tests passed.
- Full Notebook suite: 41 files and 186 tests passed.
- Full CLI suite and all 28 connector tests passed.
- Core dbt-first modeling tests and Agent, Connector, Core, CLI, and Notebook
  production builds passed.
- The built CLI was browser-verified against a dbt-first fixture with the
  selected Ask database visible beside Thinking.
- The synchronized workspace release gate passed: 22/22 builds, 41/41 test
  tasks, and all 19 npm tarballs completed successfully.
- All 19 npm packages report `version` and `latest` as `1.12.2`.
- Fresh project-local and global CLI installs both report `dql 1.12.2`, and
  `create-dql-app@1.12.2 --help` resolves successfully.

## v1.12.1 - 2026-07-30

### Governed correction lessons and fail-closed DQL SQL repair

This patch makes Teach DQL corrections reusable and reviewable while preventing
internal Hint Graph relation identifiers from leaking into executable warehouse
SQL.

### Added

- **Structured Teach DQL review.** A successful edit now opens a before/after
  review where the analyst confirms a reusable lesson, at least one meaningful
  domain/metric/model/term/block scope anchor, and an optional rationale.
- **Reviewer-visible correction evidence.** Agent Learning shows the analyst's
  rationale alongside the original question, previous SQL, current snapshot,
  dependencies, graph connections, evaluations, and lifecycle exclusions.
- **DQL-cell AI repair.** Notebook DQL failures can use the same focused,
  review-required AI repair path as SQL cells while preserving the DQL artifact
  and extracting its embedded SQL as repair context.

### Fixed

- **Physical relation enforcement.** `source::`, `dbt::`, and `semantic::`
  identities remain retrieval and lineage keys; generation, validation,
  Notebook execution, preview execution, and repair now resolve a uniquely
  inspected physical relation or fail closed before reaching the warehouse.
- **Reusable correction guidance.** SQL-only corrections no longer silently use
  raw corrected SQL as their human-readable lesson. Older clients receive a
  conservative reviewable fallback, while explicit analyst guidance remains
  authoritative.
- **Accidental project-wide learning.** Notebook teaching requires a confirmed
  high-signal scope anchor; comments remain provenance and cannot approve,
  certify, or directly activate shared learning.

### Verification

- Full DQL Agent and Notebook test suites pass.
- Governed correction HTTP lifecycle tests pass against the real local runtime.
- Agent and Notebook production builds pass.
- The synchronized workspace build, test, pack, and publish gates passed; all
  19 npm packages report `version` and `latest` as `1.12.1`.
- Fresh project-local and global CLI installs both report `dql 1.12.1`.

## v1.12.0 - 2026-07-30

### Domain-wide libraries and conversation-aware analytical follow-ups

This minor release makes Git-backed analytical assets easier to navigate across
Domain Packages and improves in-session AI recaps without merging context
between Ask, Notebook AI, and Block AI.

### Added

- **All-domain asset views.** Blocks, Notebooks, and the Domain workspace can
  show every available domain or narrow to one domain through the same compact
  selector pattern.
- **Global related products.** Domain workspaces expose all Apps and Notebooks
  when no domain is selected, while domain-scoped views continue to use
  owner/uses-domain metadata.
- **Live notebook discovery.** Related-product results merge Git-tracked
  notebook files with the compiled manifest so newly created notebooks appear
  before the next compile.

### Fixed

- **Conversation recap routing.** Phrases such as “what are we reviewing in
  this chat” are treated as in-session recap requests instead of new analytical
  queries, including bounded normalization for common spelling mistakes.
- **Substantive recap context.** Consecutive recap questions summarize the
  latest analytical or authoring turn and ignore prior recap-only turns.
- **Result recap fidelity.** Tuple-shaped and object-shaped result samples are
  both converted into grounded recap facts.
- **Domain navigation consistency.** Blocks, Notebooks, and Domain views share
  consistent all-domain semantics, counts, filtering, and artifact routing.

### Verification

- Full DQL agent suite: 102 files and 1,205 tests passed.
- Full Notebook suite: 39 files and 178 tests passed.
- Targeted CLI domain-related-products API test passed.
- Agent, CLI, and Notebook production builds passed.
- The complete release build, test, pack, publish, registry, and clean-install
  gates are recorded by the release workflow for this version.

## v1.11.2 - 2026-07-26

### Complete unified AI orchestration and explicit Block AI commit

This patch closes the remaining gaps between Ask AI, Notebook AI, Block AI,
manual authoring, and runtime execution. All surfaces now share one canonical
semantic artifact contract while preserving complete repair evidence.

### Fixed

- **Complete multi-metric output.** Exact metric identifiers remain metrics
  through planning and semantic member selection, including requests with five
  measures, instead of collapsing to a single metric plus inferred dimension.
- **One canonical DQL shape.** Semantic drafts use the shared
  `metrics = [...]` and `dimensions = [...]` renderer throughout proposal,
  formatting, Notebook, Block Studio, CLI, import, and execution paths.
- **Explicit Block AI routing.** New Block Studio chats request the governed
  block route directly, including projects whose catalog domain is
  `uncategorized`, rather than entering the generic answer route.
- **Consent-bound block writes.** Block AI generation returns a transient,
  ownerless review artifact and does not create block or domain files. Only the
  user-selected Add to Block Studio action writes the draft and opens it in the
  visual builder.
- **Unified Notebook and Block execution.** Cold Block AI and carried Ask
  artifacts reuse the same durable answer executor and evidence model used by
  Ask and Notebook AI.
- **Repairable failed responses.** Compilation and execution failures keep the
  attempted canonical DQL, attempted or explicitly unavailable SQL, lineage,
  trust evidence, actual steps, diagnostics, and safe Notebook repair actions.
- **Navigation-safe async runs.** Active work continues through navigation and
  completed turns restore the same DQL, SQL, lineage, and Trust & Steps
  evidence instead of reconnecting to or hydrating an incomplete response.

### Acceptance and verification

- Implemented acceptance IDs: `CONTRACT-002`, `AGT-017`, `AGT-021`, `API-007`,
  `API-008`, `UI-012`, `UI-013`, `UI-014`, `UI-015`, `UI-016`, and `E2E-015`.
- Core, agent, CLI, and Notebook suites pass with 534, 1,128, 571 plus 3
  skipped, and 125 tests respectively; all affected production builds pass.
- Built-CLI browser verification confirms explicit Block AI routing and the
  canonical draft path. Provider-backed final Add-to-Block-Studio replay
  remains pending independent verification because the fixture's configured
  Claude subscription was unreachable.
- The existing `PERF-001` latency exception remains unchanged.

## v1.11.1 - 2026-07-26

### Canonical semantic DQL and durable failed-query repair

This patch aligns semantic authoring across Ask AI, Notebook AI, Block AI, the
CLI, and manual Block Studio workflows while keeping failed analytical work
fully inspectable and editable.

### Fixed

- **Canonical semantic blocks.** One shared renderer now emits
  `metrics = [...]` and `dimensions = [...]` across AI generation, Notebook,
  Block Studio, CLI scaffolding, formatting, and runtime artifacts. AI drafts
  remain ownerless until a human saves or promotes them.
- **Complete multi-metric selection.** Ask preserves every explicitly requested
  metric, avoids treating technical metric identifiers as filters, retains
  prior selections in follow-ups such as “other metrics,” and uses a lossless
  result contract when multiple measures are returned.
- **Block AI domain handling.** Catalog fallback labels such as
  `uncategorized` no longer block Block AI before orchestration can resolve the
  governed business context.
- **Durable compilation failures.** SQL compilation and execution failures
  retain the immutable plan, canonical DQL attempt, any attempted SQL, lineage,
  trust evidence, actual steps, stable diagnostics, and safe repair actions.
- **Editable Ask recovery.** Failed DQL or SQL can be opened directly from Ask
  as an editable Notebook cell with its trust and compilation metadata intact.
- **Navigation-safe evidence.** Conversation persistence retains the complete
  bounded DQL artifact contract so DQL, SQL, lineage, and Trust & Steps remain
  available after leaving and returning to the AI surface.

### Release exceptions

- Provider-backed multi-metric and failed-compilation browser replay remains
  pending independent verification because the designated built-CLI fixture
  did not have a reachable Claude subscription.
- The existing `PERF-001` latency exception remains unchanged.

## v1.11.0 - 2026-07-26

### Unified AI orchestration for Ask, Notebook, and Block authoring

This minor release gives Ask AI, Notebook AI, and Block AI one durable,
governed execution lifecycle while keeping the final actions appropriate to
each product surface.

### Added

- **Durable universal AI runs.** Agent progress, plans, artifacts, diagnostics,
  and terminal receipts are checkpointed so active requests continue across
  navigation and completed history restores the same canonical evidence.
- **Notebook authoring actions.** Successful governed output can be added as a
  new notebook cell or used to replace the selected cell only after an explicit
  user action, preserving cell identity and execution provenance.
- **Block AI draft handoff.** Successful DQL proposals can be saved as
  ownerless, Git-backed draft blocks and opened immediately in Block Studio's
  visual builder without silently certifying or mutating canonical blocks.

### Fixed

- **Multi-metric Ask fidelity.** Every explicitly requested metric is retained.
  Compatible metrics resolve through one safe semantic adapter and model;
  incompatible or missing metrics fail closed with stable diagnostics.
- **Complete failure evidence.** Failed runs preserve the plan, DQL, compiled
  SQL, lineage, trust evidence, actual steps, failure code, and safe repair
  actions instead of dropping the inspector or displaying a stale answer.
- **Canonical history hydration.** Returning to Ask AI restores DQL and lineage
  together with SQL and Trust & Steps, while unfinished work polls durable
  progress instead of presenting a misleading reconnect state.
- **Safe surface actions.** Blocked or clarification runs cannot be added to a
  notebook or Block Studio, and generated output never mutates either surface
  before the user selects an explicit action.

### Release exceptions

- Acceptance IDs `AGT-021`, `API-008`, `UI-014`, `UI-015`, and `UI-016`
  remain implementer-validated. `E2E-015` remains specified pending independent
  built-CLI verification against the designated fixture.
- The tracked `PERF-001` latency exception remains unchanged. This release
  improves lifecycle durability, diagnostic completeness, and surface wiring
  without claiming GA-scale latency.

## v1.10.9 - 2026-07-25

### Multi-measure governed answers and organized Block Studio authoring

This patch preserves every explicitly requested measure through planning,
execution, visualization, and narration while making Block Studio a complete,
live-synchronized workspace for semantic and Raw SQL blocks.

### Fixed

- **Multi-measure answer fidelity.** Explicitly requested metrics remain in the
  immutable analytical plan and result contract. Multi-measure results default
  to a lossless table instead of silently selecting one chart measure, and
  deterministic narration describes both leading and supporting measures.
- **Scope-aware SQL validation.** Generated SQL resolves identifiers within
  each `SELECT` and CTE scope. Ambiguous ownership now fails closed and repair
  prompts preserve the requested output contract instead of guessing the first
  relation.
- **Editable notebook handoff.** DQL and SQL shown in the answer inspector can
  be inserted into a notebook cell, focused, and scrolled into view for
  research, correction, and rerun.
- **One live Block Studio draft.** Semantic, Raw SQL, and DQL-source authoring
  share the same draft state. Pasted SQL opens the complete visual builder and
  visual/source changes round-trip before save.
- **Nested block organization.** Block libraries render Git-backed folders and
  subfolders. Saving to a new folder safely moves the exact `.dql` block and
  semantic companion while rejecting traversal and hidden path segments.
- **Visible guarded deletion.** Saved blocks expose confirmed delete actions in
  the library row, block detail, and toolbar; save, move, and delete refresh the
  library immediately.

### Release exceptions

- Acceptance IDs `API-006`, `UI-001`, `UI-009`, `E2E-008`, `AGT-015`,
  `AGT-017`, `AGT-018`, `AGT-020`, `UI-012`, `UI-013`, `E2E-012`, and
  `E2E-014` remain implementer-validated. Independent enterprise Snowflake,
  dbt Cloud, and local MetricFlow verification is still required.
- The tracked `PERF-001` latency exception remains unchanged. This release
  improves answer fidelity, SQL safety, and authoring UX without claiming
  GA-scale latency.

## v1.10.8 - 2026-07-23

### Governed semantic authoring parity and safe block deletion

This patch makes the metric-first semantic composer consistent across Notebook
and Block Studio, restores missing Raw SQL visual-authoring controls, and adds
an exact, confirmed deletion path for saved blocks.

### Fixed

- **Notebook insertion without a mandatory preview.** After metric
  compatibility resolves successfully, users can add the governed semantic
  selection to a notebook cell immediately. Preview remains available as an
  optional execution check rather than an unrelated enablement gate.
- **One semantic composer across authoring surfaces.** Block Studio reuses the
  Notebook metric-first picker and applies the chosen metrics and dimensions to
  the visual block. A metric selection exposes only fresh, runtime-compatible
  dimensions that share a governed path with every selected metric.
- **Fail-closed selection reconciliation.** Loading, failed, or stale
  compatibility plans do not expose unrelated dimensions. Metric changes also
  remove dimensions, time grains, and filters that are no longer approved by
  the current compatibility result.
- **Raw SQL visual parity.** SQL blocks now retain runtime parameters,
  parameter policies, filter bindings, chart series/color configuration, and a
  generated DQL preview while users edit the visual builder.
- **Targeted DQL source edits.** Visual changes update the intended query or
  semantic clauses without normalizing away unknown metadata, tests,
  visualization settings, parameters, policies, or bindings.
- **Guarded saved-block deletion.** Block Studio can delete one exact saved
  `.dql` block and its matching semantic companion after explicit
  confirmation. Traversal, broad deletion, missing targets, and unrelated
  blocks remain protected.

### Release exceptions

- Acceptance IDs `API-006`, `UI-001`, `UI-009`, and `E2E-008` are
  implementer-validated through full package suites, production builds, and a
  built-CLI browser replay. Independent enterprise Snowflake, dbt Cloud, and
  local MetricFlow verification remains required before they can be marked
  verified.
- The tracked `PERF-001` latency exception remains unchanged. This patch
  improves authoring correctness and UI/runtime wiring rather than claiming
  GA-scale latency.

## v1.10.7 - 2026-07-23

### Semantic-model composition and isolated notebook execution

This patch makes dbt semantic composition model-aware from catalog discovery
through runtime execution, and prevents one notebook cell failure or stale
response from contaminating another cell.

### Fixed

- **Model-scoped semantic catalog.** Business metrics retain direct and derived
  semantic-model ownership, projected measures no longer appear as duplicate
  business metrics, and model-qualified dimension variants stay distinct.
- **Compatibility-first composition.** Selecting a metric exposes only
  dimensions with a governed runtime path to every selected metric. The same
  compatibility evidence now guides the Notebook composer and agent member
  selection.
- **Pinned preview and execution target.** Semantic previews and inserted DQL
  cells carry the same named execution target, compiler trace, compiled SQL,
  target binding, and execution receipt.
- **Cell-isolated execution.** Notebook cells receive unique IDs and per-run
  correlation IDs. Older aborted responses cannot overwrite newer runs, and a
  failed dependency branch no longer prevents independent branches from
  running.
- **Stable upstream results.** A completed upstream result remains available
  after the transient success indicator returns to idle, while stale, failed,
  missing, or ambiguous dependencies fail closed with structured codes.
- **Trust & Steps for every cell.** SQL and DQL cells expose the governed
  request, compiled/executed SQL, semantic bindings, effective warehouse
  target, execution receipt, duration, and stable failure details.
- **Server survival and target truth.** Raw SQL and semantic execution responses
  echo the effective cell/run identity and actual default or selected target;
  one failed request does not poison the next request or terminate the
  Notebook server.

### Release exceptions

- Acceptance IDs `ID-001`, `CONTRACT-002`, `AGT-014`, `API-004`, `API-006`,
  `API-007`, `UI-009`, `UI-012`, `E2E-008`, and `E2E-014` are
  implementer-validated. Independent replay against the enterprise Snowflake,
  dbt Cloud, and local MetricFlow fixture remains required before they can be
  marked verified.
- The tracked `PERF-001` latency exception remains unchanged. This patch
  improves semantic identity and notebook execution correctness rather than
  claiming GA-scale latency.

## v1.10.6 - 2026-07-23

### Canonical Snowflake semantic target identity

This patch fixes false semantic target drift when Snowflake represents the same
account with an immutable account locator in one path and the preferred
`organization-account_name` identifier in another. Existing dbt Cloud bindings
and local MetricFlow profiles can now match the active warehouse without
weakening the governed database, schema, role, or warehouse checks.

### Fixed

- **Canonical Snowflake account proof.** DQL observes `CURRENT_ACCOUNT()`,
  `CURRENT_ACCOUNT_NAME()`, and `CURRENT_ORGANIZATION_NAME()` on the active
  execution connection and retains the locator and client-facing account
  identifier in the redacted target contract.
- **Legacy binding compatibility.** Persisted dbt Cloud locator bindings and
  dbt profile account identifiers are compared through bounded Snowflake
  aliases instead of an obsolete exact fingerprint requirement.
- **MetricFlow and dbt Cloud parity.** Both semantic adapters use the same
  field-aware target comparison, preventing identifier-format drift from being
  mistaken for a cross-account execution request.
- **Fail-closed identity acquisition.** A failed Snowflake identity query no
  longer saves or validates configured fallback values as observed warehouse
  proof. Apply and execution stop with
  `WAREHOUSE_TARGET_IDENTITY_UNAVAILABLE`.
- **Strict true-drift protection.** Real account, database, schema, role, and
  warehouse changes still fail before semantic compilation or SQL execution.

### Release exceptions

- Acceptance IDs `AGT-014`, `API-006`, `API-007`, `SEC-004`, and `E2E-014`
  are implementer-validated. Independent replay against the enterprise
  Snowflake, dbt Cloud, and local MetricFlow fixture remains required before
  they can be marked verified.
- The tracked `PERF-001` latency exception remains unchanged. This patch
  changes target identity acquisition and comparison, not enterprise-scale
  latency.

## v1.10.5 - 2026-07-23

### Semantic source integrity and resilient execution diagnostics

This patch closes the remaining gap between local dbt authoring metadata and
the semantic project actually deployed to dbt Cloud. DQL now persists a
complete compiler-owned metric inventory during explicit Test & Apply, binds
that proof to execution, and keeps Notebook and agent failures inspectable
without terminating the local server.

### Fixed

- **Verified dbt Cloud metric inventory.** Test & Apply walks the paginated dbt
  Cloud metric catalog, stores its deterministic fingerprint and completeness
  state, and keeps that runtime proof separate from the local dbt semantic
  snapshot.
- **Fail-closed semantic source drift.** A missing, partial, or incompatible
  cloud inventory now returns `SEMANTIC_SOURCE_DRIFT` with the unavailable
  metrics and safe reapply action. DQL no longer treats a locally discovered
  metric as proof that the configured cloud environment can compile it.
- **Compiler-source target binding.** dbt Cloud execution requires both the
  governed local snapshot and the persisted remote catalog fingerprint before
  compilation. Compatibility checks expose the exact source proof used by the
  selected adapter.
- **Actionable physical preflight failures.** Snowflake validation preserves
  the failing identifier, source line and position, bounded SQL excerpt,
  compiled-SQL fingerprint, target binding, and safe repair actions instead of
  reducing the failure to a generic query error.
- **Complete Trust & Steps evidence.** “How it was answered” distinguishes the
  local semantic snapshot from the runtime metric inventory, shows physical
  preflight evidence, and links users directly to Project & dbt settings when
  the semantic runtime must be reapplied.
- **Notebook server resilience.** Async HTTP request rejections are caught and
  returned as structured failures, preventing semantic catalog or compiler
  errors from terminating the local Notebook process.
- **Supported Snowflake runtime guard.** Snowflake startup accepts Node 20, 22,
  and 24 and rejects unsupported Node majors, including Node 26, before loading
  the driver.

### Release exceptions

- Acceptance IDs `API-004`, `API-007`, `UI-009`, `UI-012`, `SEC-004`,
  `E2E-008`, and `E2E-014` are implementer-validated. Independent replay
  against the enterprise Snowflake and dbt Cloud fixture remains required
  before they can be marked verified.
- The tracked `PERF-001` latency exception remains. Complete remote inventory
  capture occurs only on explicit Test & Apply and is paginated, but this patch
  makes no GA latency claim.

## v1.10.4 - 2026-07-23

### Target-bound semantic execution and bounded Snowflake runtime

This patch makes semantic compilation and warehouse execution one auditable
operation. DQL now proves that dbt Cloud or local MetricFlow compiled for the
same warehouse target that will execute the SQL, preflights the physical query,
and retains the exact adapter, target, SQL, query ID, and failure evidence.

### Fixed

- **Compiler-to-warehouse target binding.** DQL observes the active account,
  database, schema, role, and warehouse through the same pooled connection used
  for execution. A dbt Cloud or MetricFlow target mismatch now fails with
  `EXECUTION_TARGET_MISMATCH` before compilation or query execution.
- **One pinned semantic runtime.** Notebook, preview, agent, freshness, and
  semantic artifact execution share one gateway and one adapter decision.
  Adapter failures remain visible and never silently downgrade to another
  compiler or generated SQL route.
- **Bounded Snowflake discovery and execution.** Startup no longer materializes
  every warehouse column. Physical schema fallback is question-scoped and
  paginated, while Snowflake rows are streamed with row, byte, batch, and
  deadline limits plus cancellation support.
- **Physical SQL preflight.** Compiler output is checked on the active warehouse
  connection before execution, catching missing columns, ambiguous identifiers,
  and permission failures without inventing semantic explanations.
- **Structured connector diagnostics.** Snowflake vendor code, SQL state, query
  ID, line, position, truncation, and cancellation evidence survive the
  connector boundary and are available to repair flows.
- **Target proof in Trust & Steps.** “How it was answered” reports the selected
  adapter, compiler target, execution target, target fingerprint, preflight,
  executed SQL fingerprint, query ID, and bounded execution receipt.
- **Version-safe setup.** Existing OSS projects must preview and reapply their
  dbt context after upgrading so saved dbt Cloud target binding is refreshed
  for the running CLI version.
- **Supported Node guardrail.** Snowflake runtime diagnostics accept supported
  Node 20, 22, and 24 releases and refuse unsupported Node 26 instead of
  continuing into unstable connector behavior.

### Release exceptions

- Acceptance IDs `CTX-005`, `AGT-014`, `API-006`, `API-007`, `UI-012`,
  `PERF-001`, `E2E-008`, and `E2E-014` are implementer-validated. Independent
  replay against the enterprise Snowflake and dbt Cloud fixture remains
  required before they can be marked verified.
- The tracked `PERF-001` latency exception remains. Bounded discovery and
  streaming remove the observed eager-memory failure mode, but this patch makes
  no GA latency claim.

## v1.10.3 - 2026-07-23

### Governed semantic paths and transparent execution

This patch makes repeated MetricFlow dimensions executable when more than one
entity path can reach the same business dimension, while exposing the complete
semantic decision and execution trace to notebook users.

### Fixed

- **Explicit governed path selection.** dbt Cloud ambiguity responses are
  parsed into stable choices instead of triggering an invented cross-model
  explanation or an unsafe SQL fallback. Users choose the intended entity path
  before DQL executes anything.
- **Runtime-qualified MetricFlow members.** DQL keeps the model-scoped
  authoring identity and records a compiler-owned `@via(...)` selector, then
  emits the exact MetricFlow runtime member such as
  `bcm_ccu_pc__bcm_dtl__report_as_of_dt`.
- **Preview-before-add semantics.** Semantic notebook cells can be added only
  after the selected metric and dimensions compile and execute successfully.
  A changed selection invalidates the previous preview.
- **Trust & Steps execution trace.** “How it was answered” now reports the
  selected adapter, authoring and runtime members, entity paths, compile state,
  execution state, failure details, and governed repair choices.
- **Accurate timeout and refusal behavior.** A timeout no longer claims that a
  cross-model join caused the failure without evidence. Semantic path
  ambiguity returns a clarification request and does not execute or silently
  widen to generated SQL.

### Release exceptions

- Acceptance IDs `AGT-013`, `AGT-014`, `API-006`, `API-007`, `UI-012`,
  `UI-013`, `E2E-008`, `E2E-009`, and `E2E-014` are implementer-validated
  pending independent verification against the enterprise dbt Cloud fixture.
- The existing tracked `PERF-001` latency exception remains unchanged. This
  patch makes no GA latency claim.

## v1.10.2 - 2026-07-23

### Enterprise semantic identity and runtime authority

This patch makes dbt semantic execution preserve the distinction between
business labels, DQL's stable model-scoped identities, MetricFlow group-by
names, and physical warehouse expressions.

### Fixed

- **Model-scoped semantic identity.** Repeated local dimension names remain
  distinct across semantic models. DQL persists references such as
  `customers.customer_name` and resolves a bare alias only when the selected
  metric supplies an unambiguous model context.
- **Adapter-bound qualification.** MetricFlow group-by names such as
  `customer__customer_name` are derived only at the runtime boundary. Business
  labels and physical SQL expressions are never substituted as semantic IDs.
- **Runtime-first compilation.** A tested dbt Cloud or local MetricFlow adapter
  produces the authoritative SQL for semantic notebook, Block Studio, preview,
  and Ask execution. Once selected, adapter failures remain visible and never
  silently downgrade to native SQL.
- **Derived-metric execution.** Derived and other complex metrics route through
  the selected full semantic runtime instead of failing in DQL's native
  composer before that runtime is called.
- **Transparent technical names.** The built semantic explorer displays both
  the business label and exact dbt technical metric or group-by identifier,
  while generated DQL retains the provider-neutral model-scoped reference.
- **Stable failures and retrieval identity.** Import, compatibility, catalog,
  knowledge-graph, and semantic-bridge paths now carry the same canonical
  identity and preserve stable runtime error codes without invented fallback
  objects.

### Release exceptions

- The semantic identity/runtime acceptance set is implementer-validated pending
  independent verification. The maintainer approved this `v1.10.2` release
  with that condition disclosed.
- The existing tracked `PERF-001` latency exception remains unchanged:
  enterprise-scale correctness passes, but this release makes no GA latency
  claim.

## v1.10.1 - 2026-07-22

### Analytical composition and transparent repair

This patch completes the plan-first answer engine by connecting governed metrics
to compatible entity, dimension, member, time, comparison, ranking, and output
roles before execution, then retaining a safe repair path when execution fails.

### Added

- **Analytical composition.** Metric questions now bind entity grain,
  dimension roles, canonical members, governed time/freshness, aligned periods,
  comparisons, ranking/ties, and requested outputs before route execution.
- **Receipt-backed stories.** Analytical numbers, comparisons, ranks,
  freshness statements, and material caveats are generated only from validated
  result facts bound to an execution receipt.
- **Transparent repair.** The built notebook exposes Plan, DQL, Compiled SQL,
  Lineage, Trust & evidence, Actual steps, and Failure & repair for both success
  and failure. Stable redacted errors retain immutable fingerprints and derive
  repairs without widening permissions or mutating the source run.
- **Authorized latest-complete lookup.** Relative periods perform at most one
  route-locked semantic freshness query; warehouse relation and permission
  failures retain their precise stable class.

### Release exceptions

- RFC 0005 acceptance remains implementer-validated pending independent
  verification. The maintainer explicitly approved this `v1.10.1` release.
- The tracked `PERF-001` latency budgets remain above target on the release
  workstation. Correctness and route-parity gates pass; this is a disclosed OSS
  exception, not a GA performance claim.

## v1.10.0 - 2026-07-22

### Plan-first governed analytics answer engine

This release turns analytical questions into a typed, inspectable plan before
execution. Certified metrics remain the preferred path, while deeper questions
can use governed model and column evidence without silently inventing semantic
objects or bypassing policy.

### Added

- **Resolved analytical plans.** Every answer route records the requested
  measures, dimensions, time grain, filters, joins, domains, skills, evidence,
  and execution strategy before SQL is compiled.
- **Governed relational fallback.** When no certified semantic metric covers a
  question, DQL can discover dbt models and columns through exact, BM25,
  embedding, graph, and bounded repository-text evidence, then compile
  exploratory SQL with explicit uncertified status and governance checks.
- **Semantic-model relationship validation.** Metric selection validates its
  owning measures, dimensions, entities, and time dimensions before execution,
  returning actionable incompatibility errors instead of generating guessed
  joins or invalid groupings.
- **Domain- and skill-aware retrieval.** Domains narrow the eligible business
  graph; skills contribute versioned analytical instructions and required
  evidence. Both are carried into answer receipts and route diagnostics.
- **Deep-research governance.** Multi-step investigations retain source,
  transformation, route, and confidence receipts across follow-up queries.
- **Cross-surface plan parity.** Ask, CLI, MCP, and notebook execution share the
  same plan-first routing and governed compilation contracts.
- **OSS dbt reapply on upgrade.** Updating the npm CLI now sends existing users
  to Guided Setup to preview and explicitly reapply their dbt project context
  before answering questions with a changed DQL version.

### Changed

- **Hybrid retrieval remains local.** Semantic embeddings augment the existing
  exact, lexical/BM25, and knowledge-graph indexes; this release does not
  require a second external vector database.
- **Snapshot refresh is explicit.** Connecting or reapplying a dbt project
  rebuilds the immutable context snapshot, while normal questions read that
  versioned snapshot instead of rescanning the repository.

### Known limitations

- The enterprise-scale correctness fixture passes, but the tracked `PERF-001`
  cold-start and warm-context latency budgets remain above target on the release
  workstation. This is an accepted OSS release exception, not a GA performance
  claim; the detailed measurements are recorded in the DQL 2.0 implementation
  evidence.

## v1.8.8 - 2026-07-21

### Ask and Apply execution integrity

This patch gives certified, semantic, and generated answers one executable DQL
contract, so the result shown by Ask and the result produced by Apply cannot be
silently compiled from different source or inputs.

### Fixed

- **Artifacts are finalized before execution.** Ask now executes the same DQL
  source, compiled SQL, parameters, and row bound that it returns to the UI;
  certified results preserve their literal executed source instead of rebuilding
  it afterward from catalog metadata.
- **Apply detects execution drift.** Redacted fingerprints bind source, compiled
  SQL, parameters, and results. Changed source or compiler output is rejected
  with a refresh instruction rather than displaying mismatched data.
- **Saved paths cannot replace transient answer source.** A `sourcePath` remains
  useful metadata, but it no longer overrides the exact DQL source attached to
  an AI answer.
- **Nested aliases remain query-local.** Snowflake aliases such as `subq_2` from
  nested SELECTs are classified as derived relations and excluded from physical
  warehouse probes while their underlying tables are still validated.
- **Top-N is stable across reruns.** Certified, semantic, and generated routes
  execute with the same global limit recorded on the reusable artifact.

## v1.8.7 - 2026-07-20

### Amount aggregation integrity

This patch prevents AI-generated SQL from changing governed amount semantics
through premature rounding, approximate numeric casts, non-additive aggregation,
or proven one-to-many fanout.

### Fixed

- **Financial precision is preserved until final presentation.** Generated SQL
  aggregates native `DECIMAL`/`NUMERIC` values before applying null defaults or
  outer rounding, instead of rounding individual rows before `SUM` or `AVG`.
- **Unsafe amount SQL is blocked before execution.** The agent and exploratory
  CLI lanes reject premature rounding, lossy floating-point casts, proven
  fanout, and hand aggregation of non-additive semantic measures; one bounded
  repair may produce a safe native-grain query.
- **Wrapped aggregates retain source lineage.** Expressions such as
  `SUM(ROUND(COALESCE(amount, 0), 2))` are attributed to their source relation
  and column so deterministic grain checks cannot be bypassed by wrappers.
- **Semantic metric contracts survive retrieval.** Knowledge-graph objects now
  retain backing measures, aggregation, time-grain, and non-additive metadata so
  Ask can preserve the governed calculation even in metric-only context.

## v1.8.6 - 2026-07-20

### Reliable governed metric compilation

This patch repairs two deterministic orchestration gaps that could make valid
MetricFlow and Snowflake queries fail before execution.

### Fixed

- **Offset metrics include their required time grain.** The shared semantic
  runtime detects dbt metric offset metadata and adds `metric_time` at the
  appropriate grain for Ask, Notebook, Block Studio, local MetricFlow, and dbt
  Cloud without overriding an explicit user selection.
- **Generated CTE aliases stay query-local.** Quoted aliases such as
  `"subq_2"` are classified as CTEs instead of Snowflake tables, so bounded
  validation probes only real warehouse relations.
- **Governed compiler failures do not trigger noisy replanning.** Once an exact
  governed metric reaches its semantic runtime, a compiler failure is returned
  as an actionable governed error rather than causing another AI selection pass
  or silently falling through to exploratory SQL.

## v1.8.5 - 2026-07-20

### Managed MetricFlow setup

This patch lets dbt users install and activate a compatible local MetricFlow
runtime directly from Guided Setup or Settings, with the same actionable path
available wherever a runtime-owned semantic metric is disabled.

### Added

- **Managed local MetricFlow setup.** Settings and Guided Setup can install a
  DQL-tested MetricFlow runtime into an isolated project-local environment,
  show progress and redacted diagnostics, activate it without a server restart,
  and leave system Python and existing dbt environments untouched.
- **Actionable disabled metrics.** Notebook, Build, and Block Studio explain
  why a complex metric is unavailable and navigate directly to the shared
  semantic-runtime setup instead of relying on a tooltip or terminal command.

## v1.8.4 - 2026-07-20

### Enterprise semantic execution and reusable Ask inputs

This patch gives imported dbt semantic metrics one consistent execution path
across Ask, Notebook, and Block Studio, while restoring parameterized certified
answers that can be inspected and rerun without another AI planning pass.

### Added

- **Shared semantic runtime selector.** Supported metrics compile natively;
  derived and MetricFlow-owned definitions can use a compatible local
  MetricFlow CLI or tested regional dbt Cloud Semantic Layer connection.
- **Enterprise semantic setup and capability states.** Settings tests and saves
  redacted dbt Cloud credentials, and semantic discovery reports whether each
  metric is ready, requires setup, or is unsupported without hiding it.
- **Scalable semantic selection.** Block Studio and the notebook use indexed,
  model-aware metric and dimension trees designed for thousands of members.
- **Typed certified-block invocation parity.** Ask, Notebook, native tools, CLI,
  and MCP share one values-only parameter contract with question and
  prior-result provenance.

### Fixed

- **Ask retains reusable DQL inputs.** Certified result cards show applied
  parameter values and the shared input controls; Apply reruns the saved block
  directly instead of starting another AI search.
- **Semantic metrics no longer degrade into guessed leaf SQL.** Runtime-owned
  derived, ratio, cumulative, and non-additive metrics either compile through
  their configured adapter or return an actionable setup state.
- **Repeated dimensions remain model-qualified.** Common names such as
  `report_date` resolve through the selected metric's owning semantic model,
  avoiding ambiguous-column SQL.
- **Generated SQL validation respects the active warehouse dialect.** Valid
  Snowflake and Databricks syntax is checked with the configured dialect while
  malformed SQL still fails before execution.
- **Block Studio refresh is truthful and automatic.** Large semantic catalogs
  show loading/setup status accurately, saved blocks refresh compiled lineage,
  and focused block views avoid unrelated graph noise.

## v1.8.3 - 2026-07-20

### Durable agent runs and coherent retrieval diagnostics

This patch hardens the local governed-agent runtime, exposes actionable search
health, and aligns the MCP and Claude Code tool surfaces used for retrieval and
SQL validation.

### Added

- **SQLite-backed agent run history.** Governed runs are retained in a bounded,
  WAL-enabled local store, with one-time migration from the legacy JSON file and
  compact event retention for older runs.
- **Retrieval health diagnostics.** The local health API and `dql doctor` report
  value-grounding mode, embedding capability, metadata catalog/context-pack
  state, run-store size, and immutable snapshot growth without exposing secrets.
- **Complete governed discovery tools.** MCP and Claude Code expose metadata
  search, table-schema inspection, and SQL validation through the same agentic
  registry used by the runtime.

### Fixed

- **Tool recommendations only name callable tools.** Ask responses no longer
  advertise a phantom clarification tool, and deprecated block generation is
  explicitly represented as an alias.
- **Retrieval degradations remain advisory.** Lexical embedding fallback,
  disabled value grounding, or a cold catalog are visible in `dql doctor`
  without incorrectly failing an otherwise healthy installation.

## v1.8.2 - 2026-07-20

### Grounded follow-ups and semantic notebook execution

This patch strengthens governed AI follow-ups so entity values remain bound to
the user request, improves multi-concept ranking safety, and makes imported dbt
semantic metrics easier to compose and execute from the notebook.

### Added

- **Typed member bindings across the answer loop.** Named customers, products,
  regions, and other result values are preserved as immutable request evidence
  through planning, block selection, SQL generation, repair, and validation.
- **Notebook semantic composer.** Users can search imported metrics and
  dimensions, inspect execution readiness, and insert a valid semantic query
  source without manually composing internal syntax.
- **Bounded repair accounting.** Regrounding, validation, and execution retries
  now have separate budgets and visible progress instead of sharing one opaque
  retry counter.

### Fixed

- **Generated SQL cannot silently drop or move member filters.** Validation
  rejects missing bindings and filters attached to the wrong dimension, while
  deterministic injection safely restores unique predicates on an existing
  governed query path.
- **Ranked questions preserve every requested grouping.** Product-by-region and
  similar questions must return both concepts, including governed semantic
  aliases such as a location dimension used for a requested region.
- **Certified blocks are selected by actual fit.** Broad customer or product
  blocks no longer win solely because their names overlap a follow-up question;
  grain, outputs, filters, and typed member coverage participate in routing.
- **dbt semantic execution status stays honest.** Imported MetricFlow and native
  semantic definitions expose whether they can run locally and retain their
  source metadata across refreshes.

## v1.8.1 - 2026-07-19

### Reliable dbt semantic discovery and upgrade preparation

This patch repairs projects where database objects were visible but dbt semantic
metrics were missing, and keeps the governed agent snapshot current after CLI
upgrades without adding work to normal warm restarts.

### Fixed

- **dbt semantic metrics load across enterprise project layouts.** MetricFlow
  artifacts may use array or object collections, dbt projects may use absolute
  roots, custom manifests, `target-path`, and `model-paths`, and source semantic
  YAML remains discoverable when compiled artifacts contain only technical models.
- **Setup and Settings see semantic changes immediately.** dbt Apply, Refresh,
  artifact changes, and manual reload now share one live semantic configuration;
  a failed reload preserves the last valid semantic layer.
- **CLI upgrades silently refresh governed search state.** A project-local runtime
  marker invalidates stale snapshots and indexes once per installed CLI version,
  rebuilds them in the background, and keeps ordinary restarts on the warm cache.

## v1.8.0 - 2026-07-19

### Enterprise domain context and faster governed AI orchestration

This release connects DQL manifests, dbt metadata, domain knowledge, governed
skills, and cross-domain lineage into one bounded retrieval path for accurate,
lower-latency answers at enterprise catalog scale.

### Added

- **Compiled knowledge graph and domain-skill references.** Manifests now carry
  compact, stable references across domains, products, models, metrics, blocks,
  relationships, and skills without embedding full skill documents.
- **Cross-domain technical and business lineage.** Domain views and lineage APIs
  expose connected dbt models, semantic metrics, governed blocks, and downstream
  products as one end-to-end graph.
- **Enterprise-scale modeling search.** The dbt-first modeler adds indexed model,
  relationship, and column search designed for thousands of models instead of
  relying on long select lists.
- **Bounded knowledge-context retrieval.** The agent loads only the ranked domain
  context and governed skill excerpts relevant to a question, with deterministic
  budgets and scale coverage for large manifests.

### Fixed

- **Follow-up questions use conversational data context.** Entity names, pronouns,
  result references, and phrases such as “this amount” are resolved before object
  retrieval instead of being mistaken for schema objects.
- **Governed evidence stays ahead of generated SQL.** Certified blocks and semantic
  metrics are selected when they satisfy the requested grain; generated SQL is the
  fallback, not the default route.
- **Failed governed SQL can recover safely.** Binder failures and ambiguous-column
  errors fall through to a grounded repair path instead of trapping the answer loop.
- **Less planning and retrieval noise.** Duplicate meaning calls, stale clarification
  state, prior result-value pollution, and unnecessary time/filter assumptions are
  removed from the orchestration path.
- **Business-readable results.** Ranking direction, compound labels, numeric and
  currency formatting, and answer synthesis now stay aligned with executed rows.

---

## v1.7.0 - 2026-07-16

### Governed agentic analytics: AI-drafts/human-certify onboarding, enforced trust, and data freshness

This release makes DQL a governed agentic-analytics layer end to end: AI proposes
draft analytics from your dbt evidence, humans certify, and the agent answers
certified-first with honest trust labels — never presenting generated or stale
results as certified. Everything here is OSS and local-first.

### Added

- **`dql propose` — AI drafts, humans certify.** Scans your dbt evidence
  (`manifest.json`, `catalog.json`, semantic metrics) and generates a value-ranked
  queue of **draft** blocks with inferred grain, pattern, outputs, and `llmContext`.
  Every proposal is run through the certifier and stored as `draft` — nothing is
  ever auto-certified.
- **Get Started onboarding flow** in the notebook — a readiness scan that surfaces
  the ranked draft proposals with trust badges and a per-draft "what's missing to
  certify" summary, routing each into the existing Review & Certify queue.
- **`dql eval` — routing-accuracy harness.** Replays each block's `examples` (plus
  optional `eval/*.yaml`) through the agent router and scores route, block
  selection, and grain match across the certified / generated / insufficient-context
  / conflict / wrong-grain cases. CI-gateable.
- **Canonical trust-label vocabulary** — `Certified`, `Reviewed`, `AI-Generated`,
  `Insufficient-Context`, and `Conflict`, modeled as a base label plus optional
  qualifier and consumed consistently across the MCP server, agent, and UI.
- **Definition-conflict detection** — two certified terms or blocks that claim the
  same concept/grain but disagree are flagged at compile time and routed as a
  `conflict` (the agent surfaces both definitions and asks, instead of guessing).
- **Runtime invariant enforcement** — a block's declared `invariants` now execute
  against results at run and certification time. A violation blocks certification
  and downgrades the label to "Certified · invariant violated".
- **Grain / contract gate** — the agent refuses to serve a near-miss certified block
  whose grain doesn't match the question, demoting to a labeled generated query
  instead of a confidently-wrong governed answer.
- **Show-your-work** — a consumer-facing derivation walk (value → block →
  metric/term → dbt model → owner / review cadence / freshness), with depth hidden
  by default.
- **Freshness-aware trust** — folds dbt `run_results.json` and source freshness into
  a block's effective trust: a certified block over a failed or stale upstream shows
  "Certified · upstream failed" / "Certified · stale data".
- **Output-contract drift detection** — a new additive `outputContract` field;
  `dql compile`/`dql doctor` **warn** (never block) when a block `ref()`s a child
  column that no longer exists, keeping freeform composition safe.
- **Impact & re-cert gate** — `dql diff --impact` reports a changed block's full
  transitive downstream, the affected cross-domain edges, the `domainTrust` delta,
  and the certified artifacts that need re-certification; exits non-zero in CI when
  certified downstream is invalidated.
- **Scoped correction memory** — Git-versioned, approved-only hints (scoped to a
  metric / model / domain / dialect) compiled into the agent knowledge graph, so
  reviewed corrections improve future drafts without weakening certification. Plus a
  pluggable `EmbeddingProvider` (offline default) for hybrid retrieval.

### Fixed

- **The redesigned application is wired end to end.** Ask AI, notebooks, Block
  Studio, Apps, domains, source control, Setup, and Settings now use the same
  project metadata, database connection, AI-provider state, and governed answer
  flow. Setup recognizes an existing workspace without overwriting its saved
  database or provider, and the Notebook catalog matches Block Studio.
- **Ask AI now returns business-readable, result-grounded explanations.** The
  response layer summarizes actual query results, keeps tables and charts in the
  conversation, moves technical evidence into the detail surface, and shares the
  same DQL-generation and follow-up behavior with Notebook and Block Studio AI.
- **AI-generated SQL is grounded in the real warehouse.** Generated SQL used bare
  table names (`FROM order_items`) that don't exist (`Catalog Error … did you mean
  "dev.order_items"?`). Both SQL paths now share one grounding layer: tables are
  presented as their qualified relation (`db.schema.table`) and `{{ ref() }}` form
  with real columns + join keys, only the relevant tables are retrieved, a
  deterministic resolver rewrites any bare name to its real relation, and the result
  is validated + repaired (re-prompted on a miss) before it runs — so the build path
  gets the validation the governed answer-loop already had.
- **Skills — teach the AI your business context.** A new **Skills** page lets you add,
  edit, and delete project-wide and personal "skills" (definitions, rules, vocabulary,
  preferred metrics/blocks) saved as Git-versioned `.dql/skills/*.skill.md`. `dql init`
  seeds three editable starters (a metrics glossary from your semantic layer, SQL
  conventions, and a domain-rules template). The agent applies the relevant skills per
  question and shows "guided by <skills>" on its answers.
- **Proposals show their work before you approve.** Each Get Started proposal now
  expands to the **SQL it will run**, its output columns, example questions, and a
  plain "what's missing to certify" — fetched on demand. You approve what you can
  see, not a checkbox.
- **One AI "Build", two destinations — and no more confusing AI dump.** "Ask AI to
  build a block" no longer routes through the governed Q&A answer-loop (which leaked
  its internal self-correction, evidence tiers, review-status churn, and named blocks
  after the literal question). Build is now its own surface: describe what you want →
  a clean result card with a **Cell ⇄ Block** toggle. Cell inserts SQL into the
  notebook; Block writes a complete, **semantically-named** draft
  (`orders_by_location_daily`, not `can_you_build_the_total_orders…`) with grain,
  outputs, examples, and "what's missing", then opens in Block Studio. The Notebook AI
  panel keeps **Ask** (governed Q&A) and **Build** as distinct modes.
- **A local owner identity, so nothing is born "missing owner".** A default owner is
  resolved once (git `user.email` → OS user → `guest@local`) and stamped on every
  draft (`propose`, generate, AI build); the UI shows "drafting as <owner>".
- **`dql propose` is now business-first and selective (was a `SELECT *`-per-model
  dump).** A convention-agnostic classifier (dbt `meta` → exposures → semantic
  manifest → folder/path → tags → name, configurable via a `propose` block in
  `dql.config.json`) splits the warehouse into a business layer and excluded
  plumbing, ranks cheaply across all models but runs inference + the Certifier only
  on a bounded per-domain selection (scales to thousands of models), and generates
  **real aggregation SQL** for semantic-metric models / narrowed projections for
  entity marts — never a passthrough per model. Get Started now shows a deterministic
  **plan** (domains, "will generate N / skip M", per-candidate evidence) that writes
  nothing until you **Approve & Generate** the scope you pick. On jaffle: 13 scanned →
  7 business, 6 staging excluded, 19 metrics detected.
- **Optional AI enrichment for proposed drafts (content only).** When "Approve &
  Generate" runs with an AI provider configured (`propose.aiEnrichment`), each
  drafted block's `llmContext` and example questions are written by the model, and a
  `description` is generated for models dbt left undescribed — a real human-authored
  dbt `description` always wins. Structure (classification, grain, outputs, SQL,
  invariants) stays fully deterministic; enrichment is best-effort with a timeout and
  falls back to dbt-derived content offline, so nothing requires a provider.
- **`dql propose --enrich`** brings the same AI enrichment to the CLI (off by default
  so CLI runs stay deterministic/CI-reproducible).
- **`dql init` auto-wires the DuckDB connection from the dbt project dir.** When the
  `.duckdb` lives next to `dbt_project.yml` a level up from the DQL workspace (the
  common layout), init now finds it and writes a workspace-relative connection
  (e.g. `../warehouse.duckdb`) instead of reporting "DuckDB file: none".
- **Clearer error when a query hits a missing table.** A DuckDB "table does not
  exist" / catalog error now appends a hint that the database may be empty or the
  connection may point at the wrong `.duckdb` file (run `dbt build` to populate it).
- **The Review & Certify queue lists draft blocks (was always empty).** It read only
  `apps/*.dql-app` apps, so the standalone draft blocks `dql propose` writes never
  appeared ("No Apps or drafts are waiting for review"). It now lists every draft /
  in-review governance block with its status, and each row opens that block in Block
  Studio to preview, edit, run tests, and certify. Nothing certifies automatically.
- **`dql agent ask` starts its own runtime.** It no longer assumes a notebook server
  on a hardcoded `127.0.0.1:3474` (which collides with unrelated services — e.g.
  Docker, whose health check returns `{"status":"ok"}` — producing a misleading "no
  database connection" error). With no `--runtime-url`/`DQL_RUNTIME_URL` it now starts
  an ephemeral runtime bound to the project on a free port and closes it on exit; an
  explicit runtime URL is validated as a real DQL runtime before use.
- **Lineage no longer self-references a block that wraps its own dbt model.** A block
  named after the dbt model it `ref()`s (e.g. `block "customers"` →
  `ref('customers')`) used to appear as its own upstream and downstream, distorting
  `dql lineage --impact` and risking false cycles. The dependency now resolves to the
  dbt-model node (`dbt_model:customers → block:customers`).
- **`dql propose` drafts are sharper.** Generated `examples` are now concrete business
  questions ("How many customers are there?", "What is the total <measure> per
  <entity>?") instead of a generic "What does X contain?", and the uncheckable
  `row_count >= 0` invariant is no longer emitted (row-count coverage lives in the
  block's tests; the runtime invariant evaluator only sees result columns).
- **Notebook no longer crashes (OOM) on every query.** The DQL parser could
  infinite-loop on input it didn't recognize — including the raw SQL the cell
  executor feeds it (e.g. `SELECT COUNT(*) …`) — exhausting the heap and killing the
  notebook runtime. The parser now guarantees forward progress and terminates on any
  input; a regression test exercises raw SQL and non-DQL text.
- **Local DuckDB connector works on the latest `duckdb` (1.4.x).** `COUNT(*)`/`SUM`/id
  results come back as `BIGINT`; the driver coerces them to numbers before marshaling
  and `serializeJSON` carries a BigInt replacer, so the full local path is BigInt-safe
  (verified on real data across UUID/BIGINT/decimal/datetime columns). The install spec
  is unpinned (`duckdb@^1.1.0`, latest 1.x) — no version pin needed.
- **dbt-profile DuckDB path now resolves against the dbt project, not the DQL
  workspace.** A relative `path:` in `profiles.yml` (e.g. `jaffle_shop.duckdb`) was
  resolved against the DQL workspace dir, so DuckDB silently opened/created an empty
  database and every query failed "table does not exist". The imported connection now
  resolves to an absolute path under the dbt project dir and warns when the file
  doesn't exist yet.
- **dbt import + freshness on the standard staging + mart layout.** The selective
  dbt import anchored **0 models** when a staging model's role-prefix-stripped alias
  (`stg_customers` → `customers`) collided with a same-named mart, which also
  prevented freshness-aware trust from surfacing. Anchor resolution now prefers exact
  model names; freshness resolution matches schema-qualified block refs
  (`dev.customers`) and treats upstream nodes with no run record (e.g. raw sources)
  as neutral rather than `unknown`.

### Notes

- Certification remains a **local** trust label. Organization-wide approval
  workflows, audit logs, and permission-aware retrieval are part of the commercial
  cloud product, not OSS.

---

## v1.6.17 - 2026-06-18

### Notebook startup patch

### Fixed

- Notebook startup no longer invents a hidden DuckDB-backed `file/:memory:`
  connection when a project has no default connection.
- Fresh projects can open the notebook UI before DuckDB or Snowflake optional
  connector packages are installed.
- Schema/catalog startup endpoints now degrade to project/file metadata when no
  runtime connection is active, while SQL execution returns a clear connection
  setup message.

---

## v1.6.16 - 2026-06-18

### MCP agent readiness for Claude Code and Codex

### Added

- `dql connect` configures Claude Code, Codex, Claude Desktop, Cursor, or all
  supported MCP clients from a DQL project.
- `dql mcp test` verifies manifest loading, metadata catalog freshness, the
  agent index, and the MCP tool surface before users ask an external agent.
- The DQL MCP server now exposes front-door workflow tools:
  `inspect_dql_project`, `ask_dql`, `build_dql_block`, and `build_dql_app`.

### Changed

- Generated Claude Code and Codex setup is project-local and includes
  `CLAUDE.md` / `AGENTS.md` guidance so agents route questions through DQL
  trust rules before writing SQL.
- Starter projects ignore generated local agent config files such as
  `.mcp.json`, `.codex/`, and `.cursor/`.
- MCP documentation and the starter README now show the full Claude/Codex
  testing path.

---

## v1.6.1 - 2026-06-10

### OSS release: clean foundation, external example, UI polish

### Changed

- **Repo restructured dbt-core style — no bundled example projects.**
  Removed `examples/` and the `acme-bank` / `jaffle-shop` templates;
  `create-dql-app` now ships a single `starter` template (the default) that
  auto-wires a detected dbt project. The example dbt project lives in its own
  repo: [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).
- Quickstart and README rewritten around two entry points with identical
  steps: your own dbt repo, or the cloned example repo
  (`create-dql-app` → `dql sync dbt` → `dql notebook`).
- Tutorials condensed from 11 to 5 (getting started, authoring blocks,
  dashboards & Apps, agentic analytics, CI & verify) and re-based on the
  example repo; troubleshooting moved to `docs/guides/troubleshooting.md`.
- Docker starter now scaffolds the minimal starter project instead of the
  removed Acme Bank template.

### Fixed

- `create-dql-app` no longer runs `git init` inside an existing git repo
  (previously nested a repo when scaffolding `./dql` inside a dbt project).
- Results table renders DATE values as `YYYY-MM-DD` instead of raw ISO
  timestamps; timestamps render as `YYYY-MM-DD HH:MM:SS` (exports keep raw
  values).
- Chart x-axis date labels are formatted in UTC — month boundaries no longer
  shift a day backwards in western timezones; line/area charts gained axis
  titles and date-aware tooltips.
- Notebook cell editor no longer paints a tinted slab behind the code: the
  always-on active-line highlight is now focus-scoped and the editor inherits
  the cell surface.
- Header is view-aware: static titles for Apps/Review/Settings/Source control
  and editor-only actions (Run all, Save, Share) hidden outside editor views.
- Sidebar panel headers wrap instead of overlapping their action buttons;
  Block Studio start cards and dbt-status panels reflow at narrow widths.
- Lineage side panel groups dashboards under "Dashboards" (was "Notebooks");
  row/duration counters use correct pluralization and rounded timings.
- Tutorial sample code used an inline `visualization { ...; ... }` form the
  parser rejects; corrected to the canonical multi-line form.
- `SECURITY.md` supported-versions table updated to 1.6.x/1.5.x.

### Added

- Privacy & telemetry disclosure in the README (off by default, no PII,
  `DO_NOT_TRACK` honored).
- Lineage fixture (`apps/cli/test/fixtures/lineage-app`) preserving
  source → block → dashboard → App compile coverage after the template
  removal.

## v1.6.0 - 2026-05-01

### Graduated trust + contracts

### Added

- **Graduated trust + Tier-2 promotion loop**: agent answers route through
  certified blocks first (Tier 1); LLM proposals are flagged *Uncertified*,
  saved as drafts under `blocks/_drafts/`, and promoted via
  `dql certify --from-draft` (optionally `--open-pr`).
- DataLex contracts end-to-end: certified blocks can cite a contract id;
  `--contract <id@version>` binding on certification.
- Column-level lineage extraction with honest `unresolved` marking.
- MCP server test coverage and tool hardening.
- `datalex-lsp`: schema-aware language server for `.model.yaml` semantic
  definitions.
- OpenLineage event emission for project snapshots.
- mkdocs-material public docs site.
- Community files: issue templates, PR template, support/triage policy.

## v1.5.3 - 2026-04-30

### OSS release candidate polish

### Added

- dbt-first Block Studio guide covering SQL blocks, semantic blocks, SQL import,
  certification, and lineage.
- OSS readiness checklist sections for Block Studio and Apps UX release gates.

### Changed

- Updated README and docs to position DQL as a local-first dbt companion where
  dbt owns models/semantics and DQL owns certified blocks, Apps, notebooks,
  AI pins, and answer-level lineage.
- Updated project layout docs to describe Apps as View/Build surfaces with
  dashboard pages, attached notebooks, AI conversations, pins, and drafts.
- Clarified that Import SQL is a Block Studio wizard, not a separate primary
  navigation area.

### Fixed

- Fixed standalone preview for `single_value` block visualizations by lowering
  them to KPI output.
- Fixed semantic analyzer validation so `@rls` decorators on block declarations
  pass the same way they do in notebook/App execution.

---

## v1.5.1 - 2026-04-29

### OSS app workspace structure and dbt repo onboarding

This patch publishes the OSS single-user App workspace flow on top of the
1.5.0 agentic Apps release.

### Changed

- Clarified OSS product language around local Apps, policies, personas, and
  commercial boundaries.
- Updated docs for the recommended isolated `./dql` folder inside existing dbt
  repositories.
- Added clean dbt-style init/compile/sync readiness coverage and release
  checklist updates.
- Bumped starter templates to use `@duckcodeailabs/dql-cli@^1.5.1`.

---

## v1.5.0 - 2026-04-27

### Agentic analytics evidence, app builder, and local-first AI setup

This release turns the first DQL agent surface into a governed analytics
workflow: certified assets first, semantic/dbt fallback second, and generated
answers clearly labeled for analyst review. It also makes Apps a stronger
stakeholder surface with editable layouts, local AI pins, scoped lineage, and
provider setup in Settings.

### Added

- Governed answer envelopes with source tier, certification state, SQL/result
  metadata, citations, confidence, review state, and evidence tabs.
- Evidence view for agent answers: Answer, Chart, Data, Lineage, Business
  Context, SQL / Block, and Review.
- Certified-first agent routing across certified blocks/dashboards/apps,
  semantic/dbt metadata, and manifest-backed SQL fallback.
- Local agent memory storage and Settings UI for scoped project/user/artifact
  memory.
- Provider setup cards for OpenAI, Gemini, Ollama, and custom OpenAI-compatible
  endpoints, with local Settings-backed provider selection.
- App Builder edit mode with Add tab, Add tile, text/summary tiles, section
  headings, domain-scoped certified block catalog, drag handles, size presets,
  and auto-packed layout movement.
- Local AI pins for Apps with refresh cadence, citations, review status, and
  promote-to-draft-block path.
- Add-to-App choices for AI answers: Chart + data, Chart only, or Data table.
- Scoped App lineage from Domain -> App -> Dashboard -> Tile -> Block ->
  semantic/dbt/source nodes.
- dbt semantic manifest and semantic YAML ingestion improvements.

### Changed

- Dashboard/App chat now uses the provider configured in Settings instead of
  asking users to pick a provider in every chat surface.
- App chat is a sticky, viewport-bounded side drawer with expand/collapse and
  close controls so the input remains visible.
- Chat answer cards are compact by default in App/Dashboard mode and keep route
  details out of the primary answer tab.
- Certified block answers can execute and return result data when the runtime
  host provides governed execution.

### Fixed

- Ollama/provider configuration persistence and default provider resolution.
- `@block("...")` execution path for block-backed notebook usage.
- Duplicate Add menus in empty App tabs.
- App dashboard AI pins previously added only chart views even when result rows
  were available.
- Lineage labels and notebook/dashboard node typing in scoped lineage views.

---

## v1.4.0 — 2026-04-25

### Apps, Agentic Analytics, programmable end-to-end DQL

A major scope expansion landing the consumption layer (Apps + first-class
dashboards), an OSS block-first agent (knowledge graph + Skills + multi-provider),
a Slack front-end, and CI-grade reproducibility. Identity stays single-user
in OSS; RBAC declarations are programmable and enforced via persona switching.

See `docs/tutorials/` for hands-on walkthroughs (Acme Bank scenario).

### Added

- **Apps** — first-class consumption-layer artifact at `apps/<id>/dql.app.json`.
  Members + roles + access policies + RLS bindings + schedules + homepage,
  validated by [`packages/dql-core/src/apps/app-document.ts`](packages/dql-core/src/apps/app-document.ts).
- **Dashboards (`.dqld`)** — first-class grid-layout artifact distinct from
  notebook-as-dashboard, validated by [`packages/dql-core/src/apps/dashboard-document.ts`](packages/dql-core/src/apps/dashboard-document.ts).
  Block refs by id or path; viz config per tile; params + filters.
- **Persona registry** — runtime active-user state in
  [`packages/dql-project/src/persona.ts`](packages/dql-project/src/persona.ts).
  Drives the existing PolicyEngine + a new
  [`personaVariables()`](packages/dql-project/src/persona-variables.ts) helper
  that supplies template values to `executor.executeQuery`'s `variables` map,
  so `@rls("col", "{user.var}")` decorators resolve at execution time.
- **Manifest extensions** — `apps[]`, `dashboards[]`, `ManifestApp`,
  `ManifestDashboard` in [`packages/dql-core/src/manifest/types.ts`](packages/dql-core/src/manifest/types.ts).
  Builder cross-checks homepage + schedule references and surfaces unresolved
  block refs as diagnostics.
- **Lineage** — populates the previously-reserved `app` node type and
  `dashboard → app` `contains` edges, completing the chain
  `Domain → App → Dashboard → Block → metric/dimension → dbt_model → source`.
- **SQLite registries** — `app_registry` + `dashboard_registry` tables in
  [`packages/dql-project/src/sqlite-storage.ts`](packages/dql-project/src/sqlite-storage.ts)
  for fast queries from the API layer (file format remains source of truth).
- **CLI: `dql app new|ls|show|build|reindex`** — see
  [`apps/cli/src/commands/app.ts`](apps/cli/src/commands/app.ts).
- **API endpoints** — `GET/POST /api/apps`, `/api/apps/:id`,
  `/api/apps/:id/dashboards/:did`, `/api/persona` in
  [`apps/cli/src/apps-api.ts`](apps/cli/src/apps-api.ts).
- **Desktop UI** — new `mainView: 'apps'` with
  [`AppsView`](apps/dql-notebook/src/components/apps/AppsView.tsx),
  [`PersonaSwitcher`](apps/dql-notebook/src/components/apps/PersonaSwitcher.tsx),
  and [`DashboardRenderer`](apps/dql-notebook/src/components/apps/DashboardRenderer.tsx)
  wired into `AppShell` + the activity bar.
- **`@duckcodeailabs/dql-agent`** — new package with:
  - SQLite + FTS5 knowledge graph at `.dql/cache/agent-kg.sqlite`,
    built from manifest + Skills.
  - Skills loader for `.dql/skills/*.skill.md` (YAML frontmatter +
    markdown body).
  - Block-first answer loop: certified blocks first, otherwise LLM-proposed
    SQL marked Uncertified and routed through analyst review.
  - Provider abstractions for Claude, OpenAI / OpenAI-compatible, Gemini,
    and local Ollama, with automatic `pickProvider()` fallback.
  - `getPromotionCandidates()` — surface uncertified answers ready for
    certification.
- **MCP tools** — `kg_search` and `feedback_record` join the existing 8
  tools (`search_blocks`, `get_block`, `query_via_block`, `list_metrics`,
  `list_dimensions`, `lineage_impact`, `certify`, `suggest_block`) in
  [`packages/dql-mcp/src/tools/kg.ts`](packages/dql-mcp/src/tools/kg.ts).
- **CLI: `dql agent ask|reindex|feedback`** — block-first answer loop on the
  command line, see [`apps/cli/src/commands/agent.ts`](apps/cli/src/commands/agent.ts).
- **`@duckcodeailabs/dql-slack`** — new package with a slash-command bot,
  Slack signature verification, Block-Kit reply formatting, and feedback
  buttons.
- **CLI: `dql slack serve`** — boots the bot.
- **CLI: `dql verify`** — proves `dql-manifest.json` is reproducible from
  source. Non-zero on drift; structured diagnostic; CI-ready.
- **Tutorials** — full Acme Bank walkthrough at `docs/tutorials/` covering
  setup, authoring, Apps + RBAC + personas, dashboards, schedules + Slack,
  agentic analytics, end-to-end fraud spike, promoting AI to certified,
  CI + verify, troubleshooting.
- **Tests** — 31 new tests across the new code (12 app-document, 6 dashboard-
  document, 6 persona, 3 manifest scan, 21 dql-agent, 8 dql-slack). All 489
  workspace tests green.

### Changed

- `dql app new` now scaffolds the new programmable schema (`dql.app.json`
  with members/roles/policies/RLS bindings/schedules) instead of the
  earlier `app.yml`-based prototype.
- `dql-mcp` now depends on `dql-agent` for the KG-backed tools.
- `ROADMAP.md` updated — multi-user identity / hosted SSO remains closed
  product; agent + apps + RBAC declarations are now OSS.

### Out of scope (still closed product)

- Real authentication (login screens, OIDC, password storage)
- Hosted cloud / multi-tenant deployment
- Approval workflows or run history as a managed service

---

## v1.0.3 — 2026-04-21

### v0.11 — Block-First Notebook (Tracks 1–6)

Collapses three authoring paths (notebook SQL, notebook DQL, Block Studio) into one mental model: **every notebook cell is a draft block; blocks are live-referenced with `bound` / `forked` state; promotion is certification-gated**.

### Added
- **Unified `@metric()` / `@dim()` resolver** — notebook SQL cells now resolve semantic refs the same way Block Studio does. `SELECT @metric(revenue) FROM @dim(date)` runs against the warehouse instead of throwing.
- **Block Picker as primary palette tile** — `Block` is the left-most tile in the Add-Cell palette; picking a block drops a **bound cell** (live reference, not `@include` SQL).
- **Semantic-aware cell pickers** — Chart / Pivot / SingleValue / Filter pickers read `QueryResult.semanticRefs` and show typed icons (`# metric`, `∴ dimension`, `abc column`); falls back to inference with a "no semantic binding" nag strip.
- **Save-as-Block governance gate** — `SaveAsBlockModal` runs `BUILTIN_RULES` inline; missing owner / domain / description blocks the save. Git metadata (commit SHA, repo, branch) auto-captured and written to the companion YAML.
- **Bound-cell state model** — `BlockBinding { path, commitSha?, version?, state, originalContent? }` on each cell. Green chrome for `bound`, yellow for `forked` after a local edit. Inline chip with path · 🔒 · Revert (forked only) · Unbind.
- **Bound cells in lineage** — bound cells flow into the lineage graph as `block:<name> → dashboard:<notebook>` edges. Draft SQL cells stay excluded (design preserved).

### Changed
- Palette surface: dropped `Python` / `Map` / `Writeback` "coming soon" tiles and the legacy `DQL block` entry; single row, block-first ordering.
- `SingleValueCell` / `ChartCell` / `PivotCell` / `FilterCell` empty states rewritten to guide the user toward the upstream cell.
- Git metadata moved from `.dql` block body into companion YAML (DQL parser drops unknown tokens; body now only carries parser-known keys).

### Fixed
- Notebook SQL cells containing `@metric()` / `@dim()` previously failed with a raw warehouse error. Resolver is now shared between the notebook path and the Block Studio path.
- `workspace:*` dependency resolution (retained from v0.8.2): release script rewrites to real `^x.y.z` before publish.

---

## v0.8.7 — 2026-04-14

### Added
- **14-driver schema introspection** — all database connectors now implement `listTables()` and `listColumns()` with a 3-tier fallback strategy (information_schema → connector methods → lazy loading)
- **Connection hot-swap** — changing the database connection via the notebook Connection Panel or `PUT /api/connections` re-initializes the executor at runtime without restarting the server
- **Block Studio improvements** — save guard opens NewBlockModal when metadata is missing, save/catalog errors shown as inline banners with retry, sidebar no longer forced closed
- **`dql doctor` notebook asset check** — verifies the notebook SPA assets (`index.html`) are bundled correctly
- **`dql --version` / `-V` flag** — prints the CLI version
- **Driver-aware welcome notebook** — `createWelcomeNotebook()` generates database-specific SQL (`SHOW TABLES` for DuckDB, `information_schema` for Postgres/Snowflake/etc.)
- **Semantic import uses project config** — re-resolve after import uses `dql.config.json` provider, not hardcoded `'dql'`
- **`/api/describe-table` endpoint** — lazy column loading for the schema sidebar and Block Studio
- **Type-colored column badges** — shared color utility for schema browser (blue=string, green=number, pink=boolean, gold=date, purple=json)

### Documentation
- **README rewrite** — three clear install paths (DQL-only, Jaffle Shop, Enterprise), Block Studio section, version 0.8.7
- **Quickstart rewrite** — two-track guide (Path A: DQL-only 2min, Path B: dbt+Jaffle Shop 5min) with Block Studio walkthrough
- **Getting Started rewrite** — fixed stale table references, added Block Studio step-by-step (Step 7), clarified auto-import behavior
- **NEW: Enterprise Getting Started** — 11-step guide for teams with existing dbt repos and production databases (Snowflake, Postgres, BigQuery, etc.)
- **Examples rewrite** — three-path table, Block Studio in learning path, parameterized block examples
- **Semantic Layer Guide** — added Snowflake provider section (Option D) with config and notebook UI import steps
- **Data Sources** — documented Connection Panel hot-swap workflow

---

## v0.8.2 — 2026-03-25

### Fixed
- **`workspace:*` dependency resolution** — published packages on npm previously contained raw `workspace:*` dependency versions, causing `EUNSUPPORTEDPROTOCOL` errors during `npm install -g`. The release script now explicitly resolves workspace dependencies to real `^x.y.z` versions before publishing.

---

## v0.8.1 — 2026-03-25

### Fixed
- **`dql init` detection improvements** — added more DuckDB filename candidates (`database.duckdb`, `analytics.duckdb`, `target/jaffle_shop.duckdb`), improved detection output with clear status for dbt project and DuckDB file discovery
- **`dql init` works on non-empty directories** — removed the "Target directory is not empty" guard so `dql init .` works inside existing dbt projects (e.g., Jaffle Shop)

### Changed
- Init output now shows detection results: dbt project (yes/no), DuckDB file path, and semantic layer provider

---

## v0.8.0 — 2026-03-25

### Added
- **Interactive lineage DAG visualization** — full React Flow + dagre-powered graph in the notebook, with node type filtering, click-to-focus highlighting, minimap, legend, and detail panel (`LineageDAG.tsx`)
- **Lineage fullscreen toggle** — "Open Graph View" button in lineage sidebar panel switches main content area to the DAG canvas
- **Jaffle Shop getting-started flow** — `dql init` auto-detects `dbt_project.yml` and `.duckdb` files, scaffolds config with dbt provider, creates welcome notebook

### Removed
- **Project templates** — removed `templates/` directory, `--template` CLI flag, and all template-based scaffolding. `dql init` now always creates a minimal project structure.
- **Example projects** — removed `examples/` and `my-dql-project/` directories

### Changed
- All documentation updated to use Jaffle Shop dbt project as the canonical getting-started path
- README, quickstart, CLI reference, FAQ, and use cases rewritten to remove template references
- Package versions bumped to 0.8.0 across all 10 packages

---

## v0.7.1 — 2026-03-24

### Added
- **Inline cell lineage** — SQL cells in the notebook now show upstream table dependencies and `@metric()` / `@dim()` tracking inline
- **Client-side ColumnMeta normalization** — backward-compatible normalization of `ColumnMeta[]` to `string[]` at the API boundary

### Fixed
- React crash from inconsistent ColumnMeta format at API boundary
- Added `@codemirror/autocomplete` and `@codemirror/search` dependencies, updated `sql-formatter`

---

## v0.7.0 — 2026-03-24

### Added
- **`dql compile` command** — generates `dql-manifest.json`, a complete project artifact containing all blocks, notebooks, metrics, sources, dependencies, and pre-computed lineage (similar to dbt's `manifest.json`)
- **Manifest system** (`packages/dql-core/src/manifest/`) — `DQLManifest` type with `ManifestBlock`, `ManifestNotebook`, `ManifestMetric`, `ManifestSource`, `ManifestLineage`
- **Recursive directory scanning** — blocks and notebooks in nested subdirectories are now discovered (no longer flat-only)
- **Config-driven semantic layer path** — reads `semanticLayer.path` from `dql.config.json` instead of hardcoding `semantic-layer/`
- **Notebook lineage** — `.dqlnb` notebook SQL/DQL cells are scanned for table and ref() dependencies; DQL cells declaring blocks are added to the lineage graph
- **dbt manifest import** — `dql compile --dbt-manifest path/to/manifest.json` imports dbt models and sources with column-level metadata as upstream nodes
- **Smart node lookup** — `dql lineage <name>` auto-resolves to block, table, metric, or dimension (no type prefix needed)
- **`dql lineage --table <name>`** — show lineage for a specific source table
- **`dql lineage --metric <name>`** — show lineage for a specific metric
- **`dql lineage --impact <name>`** — impact analysis now works on any node type (tables, metrics), not just blocks
- **`dql lineage --no-manifest`** — force live scan, skip reading `dql-manifest.json`
- **DuckDB reader function extraction** — `read_csv_auto()`, `read_parquet()`, `read_json()` calls in SQL are now extracted as source table dependencies
- **Rich lineage summary** — `dql lineage` now shows actual block/table/metric names, ownership, data flow relationships, and a DAG tree visualization

### Changed
- `dql lineage` reads from `dql-manifest.json` when available for faster lookups; falls back to live scanning
- Lineage output shows direct vs transitive upstream/downstream, with `*` marking direct connections
- `dql lineage` data flow tree renders from root source tables through all downstream nodes

---

## v0.6.0 — 2026-03-24

### Added
- **Answer-layer lineage engine** — tracks data flow from source tables through blocks, semantic metrics, business domains, and charts
- **`ref("block_name")` system** — declare explicit block-to-block dependencies in SQL queries, similar to dbt's `ref()`
- **`dql lineage` CLI command** — full lineage analysis with subcommands:
  - `dql lineage` — project summary with node counts, cross-domain flows, domain trust scores
  - `dql lineage <block>` — upstream/downstream for a specific block
  - `dql lineage --domain <name>` — domain-scoped view with data flows in/out
  - `dql lineage --impact <block>` — impact analysis showing affected downstream nodes by domain
  - `dql lineage --trust-chain <from> <to>` — certification status at every hop between two blocks
  - `dql lineage --format json` — export full lineage graph as JSON
- **Cross-domain flow detection** — automatic detection when data crosses business domain boundaries (e.g., data → finance → executive)
- **Trust chain scoring** — certified blocks are trust checkpoints; trust score = certified/total ratio
- **Lineage API endpoints** — `GET /api/lineage`, `/api/lineage/block/:name`, `/api/lineage/domain/:name`, `/api/lineage/impact/:block`, `/api/lineage/trust-chain`
- **Notebook Lineage Panel** — sidebar panel showing blocks, metrics, source tables, domains, and cross-domain flows
- **SQL table extractor** — lightweight regex-based parser for FROM/JOIN/INTO/CTE table extraction
- **Dependency resolver** — topological sort with circular dependency detection
- **DuckDB reader normalization** — `read_csv_auto('./data/revenue.csv')` normalizes to `revenue` in lineage nodes
- **Edge deduplication** — prevents duplicate edges in the lineage graph
- **Comprehensive lineage documentation** — new `docs/lineage.md` with tutorials, CLI reference, and dbt complement strategy
- **Unified package versioning** — all 10 packages now share a single version number (0.6.0)

### Changed
- Updated all documentation to cover lineage, ref(), and cross-domain flows
- README now includes Lineage & Trust Chains section
- ROADMAP updated with lineage as shipped feature

---

## v0.5.2 — 2026-03-23

### Added
- **Snowflake semantic layer provider** — `provider: "snowflake"` in `dql.config.json` now wires a live Snowflake connection into the semantic layer; no manual YAML duplication required
- **Time dimension picker in Compose Query UI** — select a date dimension and granularity (`day` / `week` / `month` / `quarter` / `year`); generates dialect-correct `DATE_TRUNC()` SQL
- **Live test execution in `dql certify`** — `assert` statements in `.dql` blocks now run against real data before governance checks; use `--skip-tests` to bypass for metadata-only validation
- **`defaultConnection` auto-detection** — `dql certify` and `dql test` now read `defaultConnection` from `dql.config.json` without requiring `--connection`
- **Auto-refresh semantic layer via SSE** — editing a YAML file in `semantic-layer/` while the notebook is open now triggers an automatic panel reload (no manual Retry click)
- **New Metric form in notebook sidebar** — create a new metric YAML file from inside the Semantic Panel without leaving the notebook
- **Block Governance Bar** — DQL cells with a `block { ... }` declaration show an inline form for editing `domain`, `owner`, `tags`, and `description` without touching the raw syntax
- **DQL / SQL cell type tooltips** — hover over the cell type badge to see what each cell type does
- **`dql test` deprecation notice** — `dql test` now prints a deprecation warning; use `dql certify --connection` instead (removal planned for v0.6.0)

### Fixed
- Removed non-existent `@import` syntax from authoring-blocks.md and notebook reference panel; replaced with the real `@metric()` / `@dim()` patterns and Compose Query workflow
- Removed dead `BlockImportView` component and all `@import` dead code from the notebook frontend
- `dql certify` no longer reports "✓ certified" when `tests-pass` governance rule would have failed on live data

### Changed
- Semantic layer section in Reference Panel now leads with Compose Query (canonical path) and marks `@metric()` / `@dim()` as advanced
- `dql test` marked `[deprecated]` in help text

---

## v0.5.1 — 2026-03-20

### Fixed
- Resolved `workspace:*` dependency resolution issue for npm publish
- Version bumps across all packages for v0.5.0 release alignment

---

## v0.5.0 — 2026-03-18

### Added
- **Semantic Compose Query** — Semantic Panel now has a Compose Query section: select metrics, dimensions, compose SQL, and insert as a cell with one click
- **"Insert as Cell" button** — composed SQL can be inserted directly as a new SQL cell
- **Notebook semantic panel** — browse metrics, dimensions, and hierarchies from the sidebar; click to insert refs into SQL cells
- **`type = "semantic"` block** — reference a metric by name from a DQL block (`metric = "total_revenue"`)
- **`@metric()` / `@dim()` inline refs** — use semantic metrics and dimensions directly inside SQL cells
- Comprehensive documentation overhaul: authoring-blocks guide, own-repo tutorial, progressive doc index
- Tutorial rewrite for getting-started, data-sources connector reference, notebook semantic panel guide

---

## v0.4.0

### Added
- Semantic layer core: DQL native YAML provider, dbt provider, Cube.js provider
- 14-database SQL dialect abstraction in `composeQuery()`
- `dql certify` command with governance rule evaluation
- `dql fmt` format-on-save for `.dql` files
- DQL Language Support VS Code extension packaging

---

## v0.3.0

### Added
- Multi-cell notebook with param cells, markdown cells, and auto-charting
- DQL block AST: `block { domain, owner, tags, params, query, visualization, tests }`
- `dql parse` semantic analysis
- `dql preview` and `dql build` for static HTML bundles
- `dql serve` for local preview serving

---

## v0.1.0

Initial public DQL release.

- Open-sourced the DQL language core, compiler, runtime, connectors, governance, LSP, and Git-backed project package
- Published the `dql` CLI and the `DQL Language Support` VS Code extension packaging path
- Added starter docs, examples, templates, and GitHub release automation for the OSS repo
