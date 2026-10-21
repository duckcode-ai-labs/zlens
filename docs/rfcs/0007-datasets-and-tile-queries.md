# RFC 0007: Datasets and tile queries (App Builder v2)

| Field              | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| **Author(s)**      | @KKranthi6881                                                          |
| **Status**         | Accepted; implemented and on by default (`apps.datasets: false` turns it off) |
| **Created**        | 2026-09-10 (revised 2026-09-17)                                        |
| **Targets**        | DQL after `1.17.3`; on by default after ZLens 0.2.2                    |
| **Implementation** | landed on `main`, `b5a34727`..`8e0d3f4c`                               |
| **Amends**         | `PRD-004`, `PRD-007`, `AGT-026` (adds a field-query tile kind)         |

## Summary

An App tile can be a declarative query over one **Dataset**: a governed
source that declares its complete field list, its grain, and the measures
and operations it permits. The author picks dimensions, measures, filters,
and a chart, and never writes SQL. The persisted artifact is a `TileQuery`
inside a version-3 `.dqld` page. SQL is compiled from it on every run against
the live warehouse; nothing is extracted. Turning a tile into a reusable
`.dql` block is a separate, explicit action that creates a review draft.

Datasets are either block-backed (a `.dql` block with `grain`, `fields`, and
`measures` sections) or semantic-backed (a projection of one semantic model's
metric capabilities). Both are available from the first milestone.

## Motivation

Today a tile binds a whole pre-built block, semantic query, draft SQL, AI pin,
or text to one chart. That produces three problems:

1. **Tiles are islands.** A page filter reaches a tile only if the block
   author pre-declared a binding for it. There is no cross-filter and no
   drill, so a page reads as a set of unrelated charts.
2. **An answer is not a source.** A block that answers "monthly revenue"
   cannot also give a customer count, a regional breakdown, or the
   transactions behind a bar. A reusable answer and a reusable analytical
   source are different objects, and the App builder only has the first.
3. **Every new view needs new SQL.** Each variation of a chart means another
   block, another review, and another copy of the same business logic.

A Dataset separates the source (reviewed once, in the Domain) from the view
(authored per tile, in the App). Validation of the requested operation
against the source's declared contract replaces per-tile SQL review.

## Decisions

These four decisions were locked by the owner on 2026-09-10.

- **D1. The tile artifact is a declarative `TileQuery` in `.dqld`.** SQL is
  compiled on every run. Promotion to a block is on demand. (`APP-031`)
- **D2. One Dataset per tile.** A Dataset may itself contain approved
  relationships, but the tile engine never joins two Datasets.
  Cross-dataset consistency comes from field-bound page filters, typed
  parameters, and declared cross-filter mappings. (`APP-041`)
- **D3. The first builder UI is an explore panel**: measures, group-by,
  filters, chart, and a live preview. Tableau-style shelves come later.
- **D4. Datasets are block-backed and semantic-backed from the first
  milestone.** (`APP-031`)

Review of the first draft added these rules, which the rest of this document
applies:

- Validation of permitted operations replaces "certified by construction"
  (the C8 table below, `APP-068`).
- Inferred fields and measures are suggestions. They are committed only
  through an immutable source proposal (`API-012`, `APP-055`), never written
  on first run.
- Physical fields and calculated measures validate separately.
- An aggregated block may be a Dataset, with restricted operations.
- Execution goes through the existing contracts: spec 10's
  `MetricCapabilityContract`, the analytical compatibility solver, and the
  semantic execution gateway.
- Promotion creates a review draft and keeps the tile.
- Caching is a later, opt-in capability with an isolation contract.
- Running never certifies anything (`REL-005`).

## Detailed design

### Dataset contract

`DatasetDescriptor` (`packages/dql-core/src/datasets/descriptor.ts`) is the
small, UI-facing projection that App Studio, the CLI, the agent catalog, and
MCP exchange. It is not the capability contract. `contractRef` points to the
full contract, and the compiler resolves it before compiling a query.

| Field | Meaning |
| ----- | ------- |
| `version` | `1` |
| `id`, `label`, `domain` | Source id (the App catalog source id), display label, owning domain |
| `kind` | `block` or `semantic` |
| `sourceRevision`, `snapshotId` | Source content revision and the runtime snapshot the descriptor was resolved in (`target-required` in a catalog with no target) |
| `contractRef` | `{ kind, id, fingerprint }`. `kind` is `block_source` for blocks and `semantic_model` for semantic Datasets. `metric_capability` is a declared kind that no current producer emits. |
| `binding` | Target-bound proof state: `sourceQualifiedId`, `sourceRevision`, `contractFingerprint`, `state` (`target_required`, `valid`, `missing`, `invalid`, `stale`), and the active snapshot, target, and proof ids once checked |
| `lifecycle` | `certified`, `review`, `draft`, `pending_recertification`, `deprecated`, `unknown` (the declaration) |
| `trust` | `certified` or `review_required` |
| `grain` | `entityIds`, `keyFields`, `keyEvidence`, `timeGrain`, `timeBucketBy`, `aggregate`, `description` |
| `fields` | Physical fields and measures (below) |
| `operations` | Subset of `filter`, `group`, `trend`, `compare`, `rank`, `detail`, `having` |
| `execution` | `{ route: certified \| semantic \| governed_sql, adapterId? }` |

`binding` keeps the declaration apart from the proof. A catalog can show a
certified source before any connection exists: it stays `certified` with
`binding.state = target_required`. The runtime turns that into `valid` only
after the grain proof matches the current source, query, keys, parameters,
snapshot, and warehouse target. A descriptor that fails the proof has
`trust = review_required` and `execution.route = governed_sql`. Because no
code path writes lifecycle from a result, "running never certifies" is
enforced by the types, not by convention.

**Physical field** (`kind: "physical"`): `name`, `qualifiedId`
(`<sourceId>::field::<name>`), `type` (`string`, `number`, `boolean`, `date`,
`timestamp`), `role` (`dimension`, `key`, `time`, `attribute`), `status`
(`approved`, `suggested`), optional `time { grains, baseGrain, primary }`,
optional `hierarchy { id, level }`, and, on semantic Datasets only,
`semanticReference` (the provider member the adapter compiles).

**Measure** (`kind: "measure"`): `name`, `qualifiedId`, `aggregation` (`sum`,
`count`, `count_distinct`, `ratio`, `avg`, `min`, `max`); inputs `from`, or
`numerator` and `denominator` for a ratio of sums, or a parsed `expression`
AST with its `expressionFingerprint` for a calculated measure; `timeBucketBy`;
`dependsOn`; `additivity { entities, time, nonAdditiveDimensionIds? }`, each
`additive`, `semi_additive`, or `non_additive`; `allowedAggs`; `format { kind:
number | currency | percent, currency?, decimals? }`; `metricId`; `status`.

Ratios are stored as ratios (`0.25`). `percent` is a display format only.

**Operations are derived, not authored.** For a block Dataset,
`blockDatasetOperations` computes them from the typed declaration:

- `filter` when any approved physical field exists.
- `group` and `rank` when approved group fields and approved measures exist
  and, for an aggregate source, the rollup contract is complete.
- `having` when any approved measure exists.
- `trend` and `compare` when an approved time field declares grains.
- `detail` only for a non-aggregate source whose declared keys are all
  approved `key` fields and whose grain names `keyEvidence`.

A semantic Dataset takes the operations every selected metric capability
shares. It has no physical keys, so it never offers `detail`.

### TileQuery

`TileQuery` (`packages/dql-core/src/apps/tile-query-types.ts`) is the
persisted tile intent. It participates in the query fingerprint, so any edit
invalidates earlier preview and publication evidence.

| Field | Meaning |
| ----- | ------- |
| `dimensions[]` | `{ field, timeGrain?, alias? }`. Default alias is `field`, or `<field>_<timeGrain>` |
| `measures[]` | `{ measure, alias? }` |
| `filters[]` | `{ field, op, values }` on physical fields, applied before aggregation (`WHERE`). `op` is `eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `between`, or `contains` |
| `having[]` | The same shape on a selected measure's logical identity, applied after aggregation (`HAVING`) |
| `comparison` | Explicit period contract (below) |
| `orderBy[]` | `{ alias, direction }` over selected output aliases only |
| `limit` | A positive integer up to 10,000, or `{ param }` |
| `detail`, `detailColumns[]` | Bounded dataset-grain rows. Requires the `detail` operation and a limit. Cannot be combined with measures, dimensions, or a comparison |
| `respectsGlobalFilters` | `false` opts the tile out of page filters and cross-filters |

`comparison` (version 1) holds `timeField`, `timeRole`, `calendarId`,
`timezone`, `grain`, `completenessPolicy` (`partial_current`,
`latest_complete`, `closed_period`), `periods[]` (`absolute`, `current`,
`previous_period`, `previous_year`, with start-inclusive and end-exclusive
bounds), `basePeriodId`, `comparisonPeriodIds`, `alignment`, `outputs`
(`value`, `absolute_delta`, `percent_delta`), and `zeroDenominatorPolicy`.
Deltas are base minus comparison. A comparison currently needs exactly one
measure, no detail, no ordering, no limit, and no grouping by its own time
field (`APP-060`).

### Block grammar

A block becomes a Dataset when it declares an object `grain`, a `fields`
section, and a `measures` section. The legacy string `grain = "..."` still
parses and keeps its old meaning.

```dql
grain = {
  entities = ["order_line"]          // required, non-empty
  keys = ["order_line_id"]           // required, non-empty
  keyEvidence = "proof.order-lines"  // proof id; needed for detail and aggregate rollups
  timeGrain = "day"                  // optional; closed vocabulary
  timeBucketBy = "order_date"        // aggregate sources: the native time bucket
  aggregate = true                   // only for an already-aggregated source
  description = "..."
}

fields {
  <name> { role = "dimension|key|time|attribute", type = "string|number|boolean|date|timestamp",
           grains = [...], primary = true, hierarchy = "<id>", level = 0, status = "approved|suggested" }
}

measures {
  <name> { agg = "sum|count|count_distinct|ratio|avg|min|max",
           from = "<field>" | numerator = "<field>", denominator = "<field>" | expression = "<aggregate formula>",
           additive = "additive|semi_additive|non_additive",   // required; time additivity
           entityAdditive = "...",                              // optional; defaults to `additive`
           timeBucketBy = "<time field>", allowedAggs = [...],
           format = "number|currency|percent", currency = "USD", status = "approved|suggested" }
}
```

The parser rejects unknown properties, and it rejects `expression` combined
with `from`, `numerator`, or `denominator`. A ratio without both inputs is
rejected, and so is any other measure without `from`. Status defaults to
`approved`. A measure is usable only when `allowedAggs` includes its own
`agg`.

From the pilot fixture
(`apps/cli/test/fixtures/app-datasets-pilot/domains/commerce/blocks/order-lines-dataset.dql`):

```dql
block "Order lines Dataset" {
  domain = "commerce"
  type = "custom"
  status = "certified"

  grain = {
    entities = ["order_line"]
    keys = ["order_line_id"]
    keyEvidence = "proof.order-lines"
    timeGrain = "day"
  }

  fields {
    order_line_id { role = "key", type = "string" }
    customer_id { role = "dimension", type = "string", hierarchy = "commerce_customer_orders", level = 0 }
    order_id { role = "dimension", type = "string", hierarchy = "commerce_customer_orders", level = 1 }
    region { role = "dimension", type = "string" }
    order_date { role = "time", type = "timestamp", grains = ["day", "month"], primary = true }
    net_amount { role = "attribute", type = "number" }
    margin_amount { role = "attribute", type = "number" }
  }

  measures {
    revenue { agg = "sum", from = "net_amount", additive = "additive", allowedAggs = ["sum"], format = "currency", currency = "USD" }
    customer_count { agg = "count_distinct", from = "customer_id", additive = "non_additive", allowedAggs = ["count_distinct"] }
    margin_rate { agg = "ratio", numerator = "margin_amount", denominator = "net_amount", additive = "non_additive", allowedAggs = ["ratio"], format = "percent" }
  }

  query = """
SELECT order_line_id, order_id, customer_id, region, order_date, net_amount, margin_amount
FROM order_lines
"""
}
```

The sibling `customer-daily-dataset.dql` is the aggregate case. It declares
`aggregate = true`, `timeGrain = "day"`, `timeBucketBy = "order_date"`, and
keys `["customer_day_id", "order_date"]`, so it can be rolled up to month,
but only through the adaptation path below.

### `.dqld` version 3

`packages/dql-core/src/apps/dashboard-document.ts` accepts `version` 1, 2, or
3. Version 3 adds:

- `datasets[]`: `{ id, sourceId, sourceRevision, snapshotId,
  contractFingerprint }`. The source identity is fixed; the field selection
  stays editable.
- A tile (`layout.items[]`) with `sourceId`, `sourceRevision`, and `query`
  (a `TileQuery`). Each must resolve to exactly one declared Dataset at the
  same revision, and the query must be compatible with the tile's
  visualization (scalar charts take one measure and no grouping, detail
  requires a table).
- Page filters with `datasetBindings: { <datasetId>: { field, tileIds? } }`.
  An absent `tileIds` binds every tile of that Dataset. A present list
  (including an empty one) binds only the listed tiles.
- `filters[].scope.app` for App-scoped filters, and `filters[].timezone`
  (IANA; required before a date control can bound a timestamp field).
- `interactions`: `crossFilter { enabled?, mappings[{ fromTileId, fromField,
  toDataset, toField }] }`, `detail { dataset, columns }`, and `navigate[{
  fromTile, toPage, carryFilters }]`.
- `semanticTileConversionProvenance` on a tile produced by an explicit
  conversion.

The parser validates every reference: a mapping's `fromField` must be a
selected output of an exact Dataset tile, `toDataset` must be declared, and
`tileIds` must name tiles bound to that Dataset. A Dataset field filter may
not share an id with a page parameter; source inputs go through a separately
named tile parameter binding.

```json
{
  "version": 3,
  "id": "overview",
  "datasets": [{ "id": "orders", "sourceId": "app:block:commerce:…", "sourceRevision": "sha256:…",
                 "snapshotId": "…", "contractFingerprint": "sha256:…" }],
  "filters": [{ "id": "region", "type": "select", "label": "Region",
                "datasetBindings": { "orders": { "field": "region" } } }],
  "interactions": { "crossFilter": { "mappings": [
    { "fromTileId": "revenue-by-region", "fromField": "region", "toDataset": "orders", "toField": "region" } ] } },
  "layout": { "kind": "grid", "cols": 12, "rowHeight": 40, "items": [
    { "i": "revenue-by-region", "x": 0, "y": 0, "w": 6, "h": 4,
      "sourceId": "app:block:commerce:…", "sourceRevision": "sha256:…",
      "query": { "dimensions": [{ "field": "region" }], "measures": [{ "measure": "revenue" }] },
      "viz": { "type": "bar" } } ] }
}
```

**Backward compatibility.** Version 1 and 2 pages load and run unchanged, and
nothing is rewritten when they are opened. A v1 or v2 document that carries
`datasets`, `filters[].datasetBindings`, a tile `query`,
`interactions.crossFilter`, or `interactions.detail` is rejected ("requires
dashboard version 3"), whether it comes from a `.dqld` file or a restored
local draft. `interactions.navigate` is not v3-only; older pages keep their
page navigation.

### Compile path

```text
TileQuery + page filters + cross-filters
  → resolveDashboardDatasetFilters        (field-bound filters only; no name fallback)
  → validateTileQuery(descriptor)         (C8 outcome: covered | adapted | needs_review | rejected)
  → compatibility
      block:    the descriptor contract itself (+ live grain proof; aggregate component proof for rollups)
      semantic: solveAnalyticalCompatibility over each selected metric's MetricCapabilityContract
  → adapter
      block:    WITH ds AS (<block SQL>) SELECT … FROM ds WHERE … GROUP BY … HAVING … ORDER BY … LIMIT
      semantic: semantic execution gateway → SemanticLayer.composeQuery (fan-out probe when joins exist)
  → result + receipt
```

The block adapter is `compileDatasetTileQuery`
(`apps/cli/src/datasets/tile-query-compiler.ts`). Page filters and
cross-filters are merged into the query before validation, so they pass the
same status, type, cardinality, and operation checks as authored filters.
Every value is bound as a positional parameter appended after the source
block's own parameters. No filter value is ever interpolated. The outer query
is the only place that groups, filters, ranks, or limits. It never
re-aggregates preview rows. A bounded Top-N query (measure-first order and a
limit) adds the selected dimensions as ascending tie-breakers. Detail rows
are ordered by the declared keys.

The semantic adapter is `planSemanticDatasetTileQuery`
(`apps/cli/src/datasets/semantic-tile-query.ts`). It keeps the governed
identities (metric id, measure id, field id) apart from the provider member
references the adapter compiles, and records both on the receipt. A `having`
predicate is accepted only by adapters that advertise it: `native` today,
not `metricflow-cli` or `dbt-cloud` (`APP-062`).

A comparison goes through `buildDatasetComparisonPlan`, which resolves the
periods and builds the analytical execution graph (`AGT-019`) on either
route.

Compile-time drift (`APP-034`): `dql compile` reads the current block source
for every v3 tile and reports `APP_DATASET_SOURCE_DRIFT` (a changed source
revision) or `APP_DATASET_FIELD_DRIFT` (a selected field or measure is no
longer declared) before the runtime would refuse the page. The runtime makes
the same checks against the live source (`DATASET_FIELD_DRIFT`,
`DATASET_MEASURE_DRIFT`, `DATASET_DETAIL_*_DRIFT`).

**Closed time-grain vocabulary** (`APP-069`). Time grains are `second`,
`minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`. Anything else,
in a TileQuery or in a Dataset's declared `grain.timeGrain`, is rejected as
`INVALID_TIME_GRAIN`. A grain is never interpolated into SQL, and an unknown
grain cannot disable the finer-than-source or rollup checks by having no
position in the order. Weeks start on Monday on every supported dialect.
BigQuery is pinned to `WEEK(MONDAY)` and uses `TIMESTAMP_TRUNC` for
timestamps.

**Supported tile dialects** (`APP-070`). `duckdb`, `file`, `postgresql`,
`redshift`, `snowflake`, `bigquery` (`DATASET_TILE_DIALECTS`). Any other
driver fails with `DATASET_DIALECT_UNSUPPORTED` before any SQL is rendered.
Golden SQL tests in `apps/cli/src/datasets/tile-query-compiler.test.ts` pin
each dialect's output, and the list may grow only together with a new golden.
`contains` escapes the literal and binds it. BigQuery has no `ESCAPE`
clause, so it escapes with a backslash; every other dialect uses `ESCAPE
'!'`. On Snowflake, plain source-column references stay unquoted so they
resolve the way the block's own SQL did, while output aliases stay quoted.

### Shared semantics

These rules are specified once and apply to every surface: Studio preview,
published run, App Autopilot, Ask about this chart, and MCP.

1. **Placement.** Dimension and time filters apply before aggregation
   (`WHERE`). Measure filters apply after aggregation (`HAVING`) and resolve
   the measure's logical identity, never a presentation alias. Page filters
   bind physical fields only, so they are always `WHERE`.
2. **Filter scope.** A filter with `scope.app` keeps its value across pages
   only between pages that both declare that id with `scope.app`. A
   page-scoped filter does not travel. Navigation carries only the filter
   ids named in `carryFilters`. A carried filter with no page value takes
   the values of a mark the reader clicked on the navigating tile, but only
   when that filter is bound, on the tile's Dataset, to the field the mark
   came from (`APP-078`); an App-scoped carried value becomes the App value.
   Filter options for a Dataset-bound filter are the bound field's distinct
   values, read through the governed Dataset runtime
   (`POST /api/app-datasets/field-values`).
3. **Unbound and incompatible filters.** A page filter with no
   `datasetBindings` entry for a tile's Dataset leaves that tile running and
   reports `FILTER_MAPPING_MISSING` ("<filter> is not mapped to <Dataset>").
   A binding whose `tileIds` omits the tile reports `DATASET_TILE_EXCLUDED`.
   Both are shown on the tile and carried into the story caveat. A binding
   to a field that no longer exists (`FILTER_FIELD_UNAVAILABLE`) or a value
   that does not fit the field type (`FILTER_VALUE_INVALID`) is an error for
   that tile, never a silent skip. A required filter with no value is
   `FILTER_REQUIRED_VALUE_MISSING`.
4. **Cross-filter.** Only through a declared mapping from an exact
   source-qualified tile output (`fromTileId`, source id, and source
   revision must all match) to a declared Dataset field. There is no name
   matching. A mark on an unmapped target reports `CROSS_FILTER_UNSUPPORTED`.
   Selecting a new mark replaces only the mark from the same source-qualified
   tile. Malformed cross-filter input is rejected as a whole, never pruned.
5. **Relative dates** (`APP-071`). A `relative_date` filter takes one preset:
   `last_N_days` (N is 1–3660), `today`, `yesterday`, `month_to_date`,
   `quarter_to_date`, or `year_to_date`. It resolves to an inclusive calendar
   range ending today in the filter's timezone; `last_7_days` is today and
   the six days before it. "Today" uses UTC when no timezone is declared.
   From there the filter is exactly a `daterange`: `>= start` and `< day
   after end`. Both boundaries are compared as calendar dates on every field
   type, timestamps included, so the filter uses the same calendar as the
   time buckets that group the field (`DATE_TRUNC` on the column). An earlier
   revision converted timestamp boundaries to instants in the filter's
   timezone; that put 1 July rows into a range ending 30 June when the
   buckets used the column's own clock (new-user fix B5). A `daterange` with
   only a start means "from", with only an end "until" (D8).
6. **Period comparison.** Periods come from the explicit `comparison`
   contract and the governed calendar. The completeness policy decides
   whether the current partial period is used, and a partial current period
   is disclosed with the result. DATE fields keep their calendar dates in the
   declared zone (`APP-060`).
7. **Detail.** Only when the Dataset declares the `detail` operation. It
   needs an explicit row limit, is ordered by the declared key, and reads
   only approved physical columns.
8. **Hierarchy drill.** It follows a declared `hierarchy` one level at a
   time. The drilled query is run-local view state; the saved TileQuery is
   never mutated, and returning restores the parent scope (`APP-061`).
9. **Invalidation.** Every compiled result carries a `filterFingerprint`.
   Any change to filters, parameters, or interaction state marks
   non-matching results and story claims stale until they are re-run
   (`AGT-008`). An affected-tile refresh shows unaffected tiles only when the
   declared mappings say their inputs cannot change, and the page story is
   withheld until a full run settles.

### C8 validation outcome table

`validateTileQuery` returns one of four outcomes (`APP-068`). This table is
normative.

| Outcome | Executes? | Displayed trust | Receipt records | Project publication |
|---|---|---|---|---|
| covered — within approved contract of a certified dataset | yes, no per-tile review | certified (derived from dataset, labelled "derived") | dataset id + revision, contract fingerprint, TileQuery hash, validation = covered | eligible |
| covered on a review/draft dataset | yes (local preview) | review_required | as above + dataset lifecycle | blocked until dataset certified |
| adapted — permitted adaptation. Implemented kinds: `aggregate_time_rollup` (an aggregate Dataset rolled above its declared timeGrain), `aggregate_entity_rollup` (grouped above its declared keys); both only after every additivity / component-proof check passed | yes | same as dataset, adaptation disclosed | + adaptation kinds | eligible |
| needs_review — suggested (unapproved) field/measure | only via explicit review lane | review_required | + reason code | blocked until reviewed |
| rejected — unknown field, non-additive re-aggregation, grain below base, unknown grain, detail unsupported, incompatible binding | no | n/a (typed error) | error code only | n/a |

Successful execution never changes these outcomes. Certifying a Dataset is a
separate explicit action (`REL-005`). A derived tile is never certified
itself; it inherits and displays its Dataset's trust.

Implementation notes:

- `covered` and `adapted` are the only outcomes that run
  (`tileQueryValidationRuns`). The compiler refuses `needs_review` with
  `DATASET_QUERY_REVIEW_REQUIRED` and `rejected` with
  `DATASET_QUERY_REJECTED`. No review lane executes a `needs_review` tile
  yet.
- The rejected diagnostics are `UNKNOWN_FIELD`, `UNKNOWN_MEASURE`,
  `INVALID_DIMENSION_ROLE`, `INVALID_FILTER_FIELD`, `UNSUPPORTED_OPERATION`,
  `DETAIL_UNSUPPORTED`, `DETAIL_LIMIT_REQUIRED`, `INVALID_DETAIL_FIELD`,
  `AGGREGATE_GRAIN_EVIDENCE_REQUIRED`, `AGGREGATE_TIME_BUCKET_REQUIRED`,
  `NON_ADDITIVE_AGGREGATE_ROLLUP`, `NON_ADDITIVE_TIME_ROLLUP`,
  `TIME_GRAIN_BELOW_SOURCE_GRAIN`, `INVALID_TIME_GRAIN`,
  `INVALID_COMPARISON`, `HIERARCHY_DRILL_UNSUPPORTED`, `INVALID_LIMIT`, and
  `INVALID_QUERY`.
- An aggregate rollup that passes validation still needs run-owned,
  target-bound component evidence before it compiles: a source-expression
  proof, plus a membership proof for each raw distinct-count component,
  computed in the same read scope as the tile query (`APP-057`).
- Review-lifecycle Datasets run only under the App's explicit
  `include_review_required` source policy. Governed-only preview and Project
  publication refuse them (`APP-058`).
- The runtime returns `{ outcome, adaptations }` on every Dataset tile
  (`tile.dataset.validation`). Studio and the published viewer disclose each
  adaptation next to the result through the shared `datasetTileNotices()`,
  and the builder's live preview shows it before the tile is added. A
  separate "derived" trust label is not shown yet.

### Ownership

| Artifact | Owner | Where |
| -------- | ----- | ----- |
| Dataset blocks, fields, measures, relationships, metrics | Domain | `domains/<domain>/blocks/*.dql`, semantic layer |
| Pages, tiles (`TileQuery`), filters, interactions, narrative | App | `apps/<app>/dashboards/*.dqld` |
| Compiled SQL, previews, receipts, result cache, grain proofs | Local runtime | `.dql/local/…` (never committed) |
| A tile promoted for reuse | Domain | `blocks/_drafts/…` via an explicit review draft |

Git holds intent. Generated SQL is derived and is never a second editable
copy. Local proofs are written to `.dql/local/datasets/proofs.json`. The
runtime also reads an optional portable `datasets/proofs.json`, which is
still revalidated against the current source, keys, parameters, snapshot,
and target. The local file wins when both have the same proof id.

### Runtime scheduler

A dashboard run is scheduled on the server (`POST …/dashboards/:id/run`):

- It runs only the requested `visibleTileIds`, the declared
  `affectedTileIds` of an interaction, or one `tileId`. An explicit empty
  set does nothing; it never widens into a full run.
- A newer interaction in the same viewer `runScope` aborts the older run. A
  result that settles after being superseded, or after the project snapshot
  or draft intent changed, is returned as `stale` without rows, and is never
  persisted or narrated. The browser also drops late responses by request
  sequence.
- Identical executions within one run share work: tile queries with the same
  source, revision, target, query, filter, and parameter fingerprints; the
  full-source grain check per binding; and each distinct-count membership
  probe.
- Concurrency is bounded at four workers.
- A partial run (bounded scope, interaction, or hierarchy drill) never
  produces a page story or publication evidence. A full run with any failed
  tile is `incomplete` and is not a publication receipt either.

### Result cache and isolation

The result cache is opt-in and off by default (`M4-CACHE-01`):

```json
{ "apps": { "datasets": true, "datasetResultCache": { "enabled": true, "ttlSeconds": 300, "maxEntries": 256, "maxBytes": 67108864 } } }
```

It is a local SQLite file, `.dql/local/dataset-results.sqlite`. Invalid
limits fall back to the defaults shown. A corrupt or unavailable cache is
treated as a miss. It stores only complete results of ordinary physical
Dataset queries. Aggregate-component proofs, period comparisons, and partial
runs always execute live.

The cache key is a hash of the complete identity (`DatasetResultCacheIdentity`):

- dataset id, source revision, contract fingerprint;
- snapshot fingerprint and warehouse target fingerprint;
- the normalized query, with its compiled query and filter fingerprints;
- filter, parameter, and interaction fingerprints (cross-filters and
  hierarchy steps);
- dialect, adapter fingerprint, compiler fingerprint, row bound;
- **the active persona policy fingerprint**: a hash of the App id, user id,
  sorted roles, RLS context, and attributes. The App id alone is not enough
  (`APP-072`).

The same persona fingerprint is part of every promotion and equivalence
identity. A save, replace, conversion, or chart answer is refused when the
active persona has changed since the run it relies on.

A cached delivery is labelled with a `dataset_cache_delivery` receipt. It
carries no executed SQL and no execution provenance. It cannot bind a
preview or publication receipt, be saved as a block, replace a tile, or
prove equivalence (`M4-CACHE-02`). **Refresh** skips the read, executes
live, and replaces the entry.

### Promotion, replacement, and conversion

**Save as block** (`M4-PROM-01`, `APP-073`). This takes a settled, complete,
live (not cached) result of a physical Dataset tile. It writes a new block
under `blocks/_drafts/` with `status = "draft"` and a
`dataset_tile_provenance` property (`DatasetTileProvenanceV1`). The
provenance records the App, page, tile, Dataset, source revision, contract,
the TileQuery and its query, filter, parameter, interaction, snapshot,
target, and persona fingerprints, the receipt id, and the SQL, schema, and
result fingerprints. Each positional parameter in the executed statement
(`$1`, `$2`, …) becomes a named `${…}` reference with a typed `params { }`
default (`string`, `number`, or `boolean`) that holds the value the settled
result ran with. The saved block therefore runs on its own and returns the
same result. The save is refused for a comparison (several executions plus
graph arithmetic), a `?` placeholder, a missing bound value, a non-scalar
value, or more than one statement. The tile itself is unchanged.

**Replace tile with block** (`M4-REPL-01`) is a separate, explicit action.
It reloads current authority: the App revision and proposal hash, the tile
and page intent, the current source, the target, the persona, and the draft
path. It then re-runs the current Dataset statement and the saved block in
one read transaction and compares their schema and rows
(`EquivalenceProofV1`). Only DuckDB supplies that same-read scope today.
Other targets refuse with `equivalence_read_scope_unavailable`. The
replacement requires the explicit review-required action. After it, the tile
is a `review_required` block tile with an open review task. A tile whose
filters, parameters, or interactions a fixed-value block cannot represent is
refused (`dataset_tile_dynamic_binding_not_representable`).

**Legacy semantic → Dataset conversion** (`M4-CONV-01`) is an explicit,
server-owned proposal and never happens on open. Preview and accept both
execute the persisted legacy semantic intent and its exact Dataset
projection in one private DuckDB read scope. Accept never reuses the
preview's result or proof, and a stale proposal is refused. The converted
tile keeps its identity and records `SemanticTileConversionProvenanceV1`:
legacy identity and tile fingerprints, the legacy payload, the Dataset id,
source revision, contract, query fingerprint, and equivalence proof.

### Agent and API surfaces

- Initial Build with AI plans source-bound Dataset components, pages,
  filters, cross-filters, navigation, and detail drills from supplied ids
  only (`AGT-026`).
- An uncovered requirement stays a visible gap. The explicit gap action
  produces an immutable, review-required Dataset draft proposal, never a SQL
  tile (`APP-064`).
- App Autopilot prepares typed Dataset edits from one fresh server-held
  preview and applies them atomically under revision and hash guards
  (`APP-065`).
- Ask about this chart runs only for a settled, current Dataset run, using
  server-issued context (`APP-066`).
- MCP `list_datasets`, `describe_dataset`, `preview_tile_query`, and
  `query_dataset` (HTTP `/api/app-datasets*`) accept only `sourceId`,
  `query`, and `parameters`, and return `ephemeral_mcp_runtime` results that
  are never App evidence (`APP-067`).
- App-only Dataset sources stay out of Ask retrieval.

## Compatibility versus conversion

- **Compatibility is automatic and non-destructive.** v1 and v2 pages, and v3
  pages without Dataset tiles, load and run unchanged. Opening, saving, or
  publishing never rewrites a block, semantic, draft, AI-pin, or text tile
  into a TileQuery. A page does not need to be version 3 unless it uses a
  v3 feature.
- **Conversion is explicit only.** Semantic → query conversion and
  query → block replacement each need a named user action, current guards,
  and an equivalence proof. They preserve identity, source revision, and
  provenance. Neither runs as a side effect of loading, migrating, or
  upgrading DQL.

## OSS and Cloud boundary

OSS includes the builder, the compilers, the scheduler, the result cache, the
promotion, replacement, and conversion flows, MCP tools, and the App agents.
Persona RLS in OSS is the existing App persona and `rlsBindings`
substitution, and the persona fingerprint isolates cache and proof identity
per persona.

Cloud adds enforced multi-tenant RLS, hosted sharing, RBAC, credential
management, shared (cross-user) caches, embedded analytics, and
organization approvals.

## Milestones

The plan was journey-first. The implementation landed M1–M4 together.
Everything is gated by `apps.datasets`. It was off by default during the
pilot; field-based tiles are now on by default, and `apps.datasets: false` in
`dql.config.json` turns them off for a project. The result cache has a separate
opt-in.

| Milestone | Scope |
| --------- | ----- |
| M0 | This RFC, decision IDs, the `apps.datasets` flag |
| M1 | Complete vertical slice: two prepared sources (one block, one semantic), 4–6 tiles, one shared filter bound to both, one cross-filter mapping, detail navigation that carries named filters, View DQL, publication |
| M2 | Widen: inference as proposal, calculated measures, aggregated-block Datasets, hierarchy drill, period comparison, App-scoped filters, manifest tile nodes (`datasetTiles`) |
| M3 | Agentic: planner emits TileQuery, Dataset-from-prompt gap action, App Autopilot typed deltas, Ask about this chart, MCP `query_dataset` |
| M4 | Promotion, cache, conversion, docs |

### Pilot acceptance (end of M1)

1. 6–8 useful tiles from prepared sources in about 15 minutes without SQL.
2. Shared filters, cross-filter, navigation, and detail work together.
3. Distinct counts, ratios, totals, and multi-source cases match independent
   SQL. The fixture's expected values: revenue 130, 6 distinct orders,
   3 distinct customers, margin rate 67/130, and monthly customer counts
   `[1, 2, 2]`, which deliberately do not sum to the whole-source count.
4. The same metric agrees across Ask, Notebook, and App.
5. A clean git checkout reconstructs the App, and the first run re-creates
   its grain proof from a live probe.
6. A source change surfaces the affected tiles (`APP-034`, `APP-056`).
7. A filter change invalidates stale results and claims.
8. Live performance is measured on representative warehouse data.
9. Existing published Apps remain usable.

## Acceptance IDs

Existing IDs cited by code and tests: `APP-007`, `APP-018`, `APP-030`,
`APP-031`, `APP-034`, `APP-041`, `APP-047`, `APP-055`, `APP-056`, `APP-057`,
`APP-058`, `APP-060`, `APP-061`, `APP-062`, `APP-064`, `APP-065`, `APP-066`,
`APP-067`, `M4-CACHE-01`, `M4-CACHE-02`, `M4-CONV-01`, `M4-PROM-01`, and
`M4-REPL-01`.

New IDs for decisions this RFC locks:

| ID | Decision |
| -- | -------- |
| `APP-068` | C8 validation outcome table |
| `APP-069` | Closed time-grain vocabulary |
| `APP-070` | Supported tile dialects |
| `APP-071` | Relative-date semantics |
| `APP-072` | Persona fingerprint in cache and proof isolation |
| `APP-073` | Promotion params |
| `APP-074` | Run scheduler: bounded concurrency and per-run dedupe |
| `APP-075` | Parity with independent SQL and across block and semantic routes |
| `APP-076` | Committed M1 pilot App compiles without drift and runs from a clean checkout |
| `APP-077` | Apps published before Datasets run and republish unchanged |
| `APP-078` | Detail navigation carries a clicked mark into a carried filter bound to the same field; Dataset filters list their bound field's values |
| `APP-079` | Field tiles can be turned back on from the viewer in one action (`POST /api/app-datasets/enable`); the `APP-007` gate is unchanged |

All are recorded in
[`00-decisions.md`](../specs/dql-2-domain-context/00-decisions.md) and
[`acceptance-matrix.md`](../specs/dql-2-domain-context/acceptance-matrix.md).
Implementers may report them `implemented`. Independent verification owns
`verified`.

## Alternatives considered

- **Tile = SQL generated once and stored.** Rejected. A stored statement is a
  second editable copy of business logic. It goes stale when the source
  changes, and it cannot be revalidated against the contract.
- **Certified by construction.** Rejected. Declaring a Dataset certified
  does not make every combination of its fields safe (non-additive rollups,
  grains below base, suggested fields). Per-query validation against the
  declared contract gives the same speed without that claim.
- **Cross-dataset joins in the tile engine.** Rejected (D2). Join safety
  belongs to relationships and semantic models, where fan-out is proven.
  Filters and mappings give page-level consistency without it.
- **Extracts.** Rejected. Live compilation keeps RLS, freshness, and receipts
  intact. The cache is a delivery optimization with no authority.

## Unresolved questions

- The review lane that lets a `needs_review` tile execute is not built. Today
  such tiles never run.
- App Studio does not yet render the adaptation disclosure or the "derived"
  trust label, although the runtime returns both.
- Equivalence proofs (replacement, conversion) are DuckDB-only until other
  connectors expose a same-connection read scope.
- Shelves (D3) and cross-Dataset blending are out of scope.

## Adoption signal

- The pilot acceptance list passes on the fixture and on one representative
  warehouse.
- The share of new App tiles authored as TileQueries versus bespoke blocks.
- Zero C8 violations in receipts: no `needs_review` or `rejected` query
  executes, and no derived tile is persisted as certified.
- Dashboard p50 and p95 per tile on warehouse data, and the cache hit rate
  once the cache is enabled.
