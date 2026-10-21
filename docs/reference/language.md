# DQL language

This page is the canonical OSS language reference for the stable local-first
surface. The formatter emits this style and the parser accepts these examples.

## Domain

A `domain` declares a business boundary. Domain declarations are optional for
legacy projects, but recommended for enterprise-scale repos because they become
manifest nodes and lineage roots.

```dql
domain "Customer" {
  owner = "customer-analytics"
  businessOwner = "Customer Success"
  boundedContext = "Customer identity, lifecycle, activity, value, and retention."
  sourceSystems = ["crm", "orders", "support"]
  primaryTerms = ["Customer", "Customer Health", "Lifetime Value"]
  reviewCadence = "monthly"
  tags = ["customer", "retention"]
}
```

## Block

A block is the reusable analytics unit. Blocks live in `blocks/**/*.dql` and
compile into `dql-manifest.json`.

```dql
// dql-format: 1

block "Revenue by segment" {
  domain = "finance"
  type = "custom"
  status = "draft"
  description = "Gross revenue grouped by customer segment."
  owner = "analytics@company.com"
  tags = ["revenue", "sample"]
  llmContext = "Use this block when people ask for revenue by customer segment."
  pattern = "ranking"
  grain = "segment"
  entities = ["Customer Segment"]
  terms = ["Revenue", "Customer Segment"]
  outputs = ["segment", "revenue"]
  dimensions = ["segment"]
  allowedFilters = ["order_date", "segment"]
  parameterPolicy {
    start_date = "dynamic"
    segment = "dynamic"
    team_set = "dynamic"
    approved_status = "static"
  }
  filterBindings {
    date_range = "order_date"
    segment = "customer_segment"
    team_set = "team_abbreviation"
  }
  sourceSystems = ["orders"]
  replacementFor = []
  reviewCadence = "monthly"

  query = """
    SELECT
      c.customer_segment AS segment,
      SUM(o.amount) AS revenue
    FROM orders o
    JOIN customers c ON c.customer_id = o.customer_id
    GROUP BY 1
  """

  visualization {
    chart = "bar"
    x = segment
    y = revenue
  }

  tests {
    assert row_count > 0
  }
}
```

Canonical block fields:

| Field | Purpose |
| --- | --- |
| `domain` | Business domain used for cataloging and lineage |
| `type` | `"custom"` for SQL blocks, `"semantic"` for metric-backed blocks |
| `status` | Local trust state: `draft`, `review`, `certified`, `deprecated`, `pending_recertification` |
| `description` | Human-facing summary |
| `owner` | Person or team responsible for the block |
| `tags` | Discovery and filtering labels |
| `llmContext` | Agent-facing natural-language context |
| `pattern` | Official reusable-widget pattern: `metric_wrapper`, `entity_profile`, `entity_rollup`, `ranking`, `trend`, `bridge`, `drilldown`, `replacement`, or `custom` |
| `businessOutcome` | Outcome this block supports |
| `businessOwner` | Business stakeholder for the metric or decision |
| `decisionUse` | How the block should be used in decisions |
| `reviewCadence` | Expected review interval |
| `grain` | Row or business grain, such as `customer_id`, `order_month`, or `segment` |
| `entities` | Business entities represented by the block |
| `terms` | Business term references implemented or used by the block |
| `primaryTerms` | Business words for what the block measures, in free text (unlike `terms`, they need not name a declared term). Ask matches on them |
| `synonyms` | Question aliases: other words people use when they ask for this block. Ask matches on them |
| `businessRules` | Business rules the block encodes |
| `caveats` | Known limitations or interpretation rules, as a list (a single string is read as a one-item list) |
| `outputs` | Declared output columns reviewers expect from the block |
| `dimensions` | Declared grouping dimensions. In `type = "semantic"` blocks these are MetricFlow dimensions; in `type = "custom"` blocks they are reusable business-contract dimensions, not semantic dependencies |
| `allowedFilters` | Filters considered safe and meaningful for reuse |
| `parameterPolicy` | Review intent for parameters: `dynamic`, `static`, `business`, `derived`, `optional`, or `ambiguous_review_required` |
| `filterBindings` | Mapping from app/business filters to physical columns or expressions used by the block |
| `metricMappings` | Which semantic metric an output column answers, and the rows it is read over: `open_claims { metric = "claim_count"  filter = "status = 'open'" }`. Ask reads a simple block's SQL and serves it as the certified answer when it computes the same thing as the question's metric; declare a mapping when the SQL is too complex to compare. `zlens compile` fails when the metric is not in the semantic layer, the column is not an output, or the filter is not plain `column = value` conditions |
| `sourceSystems` | Business source-system hints used in lineage and AI context |
| `replacementFor` | Prior blocks or business questions this block replaces |
| `replacedBy` | Deprecated blocks only: the block that replaces this one, by name or project-relative `.dql` path |
| `deprecatedOn` | Deprecated blocks only: the date the block was retired, `YYYY-MM-DD` |
| `query` | SQL for `type = "custom"` blocks |
| `metric` / `metrics` | Metric refs for `type = "semantic"` blocks |
| `visualization` | Compatibility display hint, not fixed presentation |
| `tests` | Local certification assertions |

`visualization { ... }` remains valid for existing blocks, but DQL treats it as
a block-level display hint. Apps and notebooks own the actual presentation for
their audience: the same certified block can render as a table in a notebook, a
KPI in an executive App, a ranking panel in an NBA analysis App, or a trend in a
monitoring dashboard. Enterprise certification prioritizes the business/data
contract: domain, owner, grain, outputs, filters, lineage, tests, and review
metadata. Blocks may be query-only when that contract is complete.

`zlens certify --enterprise` treats the reusable contract as certification
criteria. Runtime parameters may be scalar values, date/year ranges represented
by paired parameters, or selected sets represented by array params such as
`team_set = ["LAL", "BOS"]`. Execution expands selected-set arrays into safe
warehouse bind placeholders at runtime. It validates official pattern
requirements, for example:
`metric_wrapper` must bind exactly one semantic metric, `entity_profile` and
`entity_rollup` must declare a stable entity grain, `ranking` must expose a
ranked dimension/entity plus metric output, `trend` must declare time context,
`bridge` must declare the two source systems or entities it connects plus a
bridge/id/key output and review cadence, and `drilldown` must declare reusable
filters or parameter bindings.

## Certified Block

Certification is a local OSS trust label. A certifiable block has enough
metadata, runs successfully, and passes local test assertions.

```dql
block "Card approval rate" {
  domain = "cards"
  type = "custom"
  status = "certified"
  description = "Card approval rate across the transaction stream."
  owner = "cards-analytics@company.com"
  tags = ["cards", "kpi"]
  llmContext = "Use this KPI when stakeholders ask about card approval rate."

  query = """
    SELECT
      ROUND(100.0 * SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) / COUNT(*), 2) AS approval_rate_pct
    FROM read_csv_auto('./data/transactions.csv')
  """

  visualization {
    chart = "single_value"
  }

  tests {
    assert row_count == 1
  }
}
```

## Retired Block

When a certified block is replaced, keep the old file and mark it retired so
everything that still uses it can say what to use instead:

```dql
block "Claims Summary" {
  domain = "claims"
  type = "custom"
  status = "deprecated"
  replacedBy = "Claims Dataset"
  deprecatedOn = "2026-09-30"
  query = """SELECT ..."""
}
```

- `replacedBy` and `deprecatedOn` only apply when `status = "deprecated"`;
  `zlens validate` warns when they are set on any other status.
- The replacement must be a block in the project (an error otherwise). If it
  is itself deprecated, DQL warns and follows the chain to the first active
  block; a chain that loops is an error.
- Block Studio and the block library show **Replaced by `<name>`** next to the
  Deprecated badge, with a link to open the replacement.
- Ask never answers from a deprecated block. A question that names it is
  answered from the replacement when the replacement fits the question, under
  the replacement's own trust, and **How it answered** says
  "`<old>` was retired on `<date>`; answered from `<new>`".
- App tiles still bound to a retired block show authors
  "Retired — replaced by `<new>`". A retired block is not certified, so a new
  publish refuses the tile until it is rebound.
- Lineage draws a dashed **replaced by** edge from the old block to the new
  one. It is not a data-flow edge: impact analysis does not follow it.
- `zlens validate` warns about blocks (`ref("...")`) and App pages that still
  use a deprecated block.

`replacementFor` is the other direction — the new block naming what it
replaces. Either is enough for lineage to link the two.

## Semantic Block

Semantic blocks use metric metadata instead of hand-written SQL.

```dql
block "Approval rate by region" {
  domain = "cards"
  type = "semantic"
  status = "draft"
  description = "Approval rate by region from the semantic layer."
  owner = "analytics"
  tags = ["cards", "approval"]

  metric = "approval_rate"
  dimensions = ["region"]

  visualization {
    chart = "bar"
    x = region
    y = approval_rate
  }
}
```

Use `metric = "name"` for one metric, or `metrics = ["metric_a", "metric_b"]`
for a multi-metric semantic block. `dimensions = [...]` groups the semantic
query by one or more semantic dimensions.

Imported dbt dimensions keep their model-scoped authoring identity, for example
`sm_consumption_daily_metrics_detail.report_as_of_dt`. If MetricFlow reports
that the same member is reachable through multiple governed entity paths, the
Semantic composer requires a preview and asks the analyst to select one. ZLens
persists that choice without replacing the authoring identity:

```dql
dimensions = [
  "sm_consumption_daily_metrics_detail.report_as_of_dt@via(bcm_ccu_pc)"
]
```

`@via(...)` is a compiler-owned relationship-path binding. The selected adapter
turns the example into the exact runtime member
`bcm_ccu_pc__bcm_dtl__report_as_of_dt`. Hand-written SQL must not infer or
substitute this path. Trust & Steps shows both identities and whether member
resolution, path binding, compilation, and execution completed.

## Business Term

A `term` defines business vocabulary in DQL core. It does not require SQL.
Blocks and business views reference terms with `terms = [...]` so lineage can
connect business meaning to implementation and consumption.

```dql
term "Customer" {
  domain = "Customer"
  type = "entity"
  status = "draft"
  description = "A person or account that can place orders or receive service."
  owner = "customer-analytics"
  tags = ["customer", "glossary"]
  identifiers = ["customer_id"]
  synonyms = ["Account"]
  businessOwner = "Customer Success"
  businessRules = ["One row per customer_id"]
  caveats = ["Merged accounts may appear under a surviving customer_id."]
}
```

Attach terms to a block:

```dql
block "Customer Orders Rollup" {
  domain = "Customer"
  type = "custom"
  terms = ["Customer", "Lifetime Revenue", "Total Orders"]

  query = """
    SELECT customer_id, COUNT(*) AS total_orders, SUM(amount) AS lifetime_revenue
    FROM fct_orders
    GROUP BY 1
  """
}
```

## Business View

A `business_view` composes trusted blocks and other business views into a
git-versioned business lineage artifact. It does not run SQL itself. Use it to
model business capabilities such as Customer 360, Customer Health Review, or
Revenue Operations Review.

```dql
business_view "Customer 360" {
  domain = "Customer"
  status = "draft"
  description = "Complete customer view for retention and account review."
  owner = "customer-analytics"
  tags = ["customer", "360", "retention"]
  terms = ["Customer", "Customer Health"]
  businessOutcome = "Understand customer value, activity, and service risk."
  decisionUse = "Account planning, churn review, and expansion targeting."
  reviewCadence = "weekly"

  includes {
    block "Customer Identity"
    block "Customer Orders Rollup"
    business_view "Customer Service Summary"
  }
}
```

Canonical business-view fields:

| Field | Purpose |
| --- | --- |
| `domain` | Business domain used for cataloging and lineage |
| `status` | Local trust state: `draft`, `review`, `certified`, `deprecated`, `pending_recertification` |
| `description` | Human-facing summary |
| `owner` | Person or team responsible for the business view |
| `tags` | Discovery and filtering labels |
| `terms` | Business term references represented by this view |
| `businessOutcome` | Outcome this view supports |
| `businessOwner` | Business stakeholder for the decision |
| `decisionUse` | How the view should be used in decisions |
| `reviewCadence` | Expected review interval |
| `businessRules` | Business rules the view encodes |
| `caveats` | Known limitations or interpretation notes |
| `includes` | `block` and `business_view` references composed into this view |

Compile validates term refs and included refs. It reports unresolved terms,
unresolved blocks, unresolved business views, and business-view cycles as
manifest diagnostics.

## References

Inside `query` strings, DQL recognizes these analytics references:

| Syntax | Resolves to |
| --- | --- |
| `@table("name")` | A semantic table, dbt model, or DQL-local table |
| `@metric("name")` | A semantic metric |
| `@dim("cube.name")` | A semantic dimension |
| `@block("name")` | A certified or draft DQL block |
| `@param("name")` | A notebook parameter value |

## Apps and Manifest

Apps and dashboard pages are JSON artifacts, not `.dql` block fields. Business
views are `.dql` composition artifacts that sit between blocks and consumption
surfaces. App `lifecycle` belongs in `apps/<app-id>/dql.app.json`; block and
business-view trust belongs in `status`.

Run:

```bash
zlens compile
```

to generate `dql-manifest.json`, the dbt-like compiled artifact that records
blocks, business views, notebooks, Apps, dashboard pages, metrics, dimensions,
sources, dbt imports, and lineage edges.
