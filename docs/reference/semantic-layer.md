# Semantic layer

The semantic layer is ZLens's shared business vocabulary. It's a **superset**
of dbt's MetricFlow — ZLens imports dbt's semantic models as-is and lets you
extend them with DQL-local definitions.

## Object types

| Object | Purpose | Example |
| --- | --- | --- |
| **Metric** | A measure with aggregation | `sum(orders.amount)` |
| **Dimension** | An attribute to slice by | `customers.segment` |
| **Hierarchy** | An ordered drill path | `year → quarter → month → day` |
| **Cube** | A pre-joined fact+dim set | `orders_by_customer_region` |
| **Segment** | A named boolean filter | `active_customers` |

## YAML shape (DQL-local)

```yaml
# semantic/finance.yaml
metrics:
  - name: revenue
    label: Revenue
    description: Gross revenue
    type: sum
    sql: amount
    table: orders
    domain: finance

dimensions:
  - name: segment
    label: Customer segment
    type: string
    sql: segment
    table: customers

hierarchies:
  - name: time
    levels:
      - { name: year, label: Year }
      - { name: quarter, label: Quarter }
      - { name: month, label: Month }
      - { name: day, label: Day }
```

## dbt import

ZLens reads `target/manifest.json` directly — see
[Import a dbt project](../get-started/your-dbt-project.md). Imported metrics and
dimensions appear in the **Semantic** panel alongside DQL-local ones.

## Which engine runs a metric

| Project | Engine | Runs |
| --- | --- | --- |
| dbt project with MetricFlow installed, or dbt Cloud configured | MetricFlow / dbt Cloud | every dbt metric type |
| Everything else, including warehouse-first projects with no dbt | DQL native compiler | simple metrics, ratios of two simple metrics, and derived metrics that do arithmetic over simple metrics with no offset window |

An `mf` executable on the PATH does not make a project a MetricFlow project:
without a `dbt_project.yml` (or a dbt setting in `dql.config.json`) the native
compiler serves it. When the native compiler cannot run a metric it says why
(for example "revenue_growth_mom is a derived metric; the DQL native semantic
engine runs a derived metric only when its expression is arithmetic over simple
metrics with no offset window") instead of asking for `dbt parse`.

### Derived metrics

A derived metric such as `average_order_value`
(`lifetime_spend_pretax / count_lifetime_orders`) runs natively when every
input is a simple metric and none has an `offset_window` or `offset_to_grain`.
Each input is summed at the requested grain first, and the expression is then
evaluated once per output row, as MetricFlow does. The expression may use
`+ - * /`, parentheses, numbers, and `NULLIF`, `COALESCE`, `ROUND` and `ABS`.
Anything else, such as a prior-period comparison, needs MetricFlow or dbt Cloud.

### Ratio metrics

A ratio divides two simple metrics, as MetricFlow does: both sides are
aggregated at the requested dimensions and time grain, then divided once per
row. `loss_ratio = incurred_losses / written_premium` is SUM(losses) / SUM(premium)
for each line of business, never an average of per-row ratios. Sides on
different fact tables are aggregated separately and joined on the grain, so
neither fact multiplies the other. A zero denominator gives NULL. A filter on
the numerator or denominator (`numerator: {name: incurred_losses, filter: ...}`)
applies to that side only. A side that is itself a ratio, derived, or
cumulative metric needs MetricFlow.

## Joins

The native compiler joins along dbt entities the way MetricFlow does:

- **Foreign → primary** (many-to-one): a claim amount's `claim` joins the claims
  model. A metric's own `filter` may read a column of any model reached this
  way; the model is joined for it.
- **Primary/unique ↔ primary/unique** (one-to-one): two models keyed by the
  same entity join on that key. A subtype table such as `loss_payment`, one row
  per claim amount that is a loss payment, filters or groups claim amounts
  without `claim_amount_id in (from loss_payment)` in the measure. A dimension
  that reads no column (`has_loss_payment: 1`) is the value when the subtype
  row exists and NULL when it does not.
- **Composite keys**: an entity `expr` may be an expression
  (`policy_id || '-' || coverage_code`) or a column list
  (`policy_id, coverage_code`). Each column is qualified on its own side.
- **Model-level `primary_entity:`** names a keyless model (a bridge or a fact
  with no single-column grain). Its dimensions are addressed
  `<primary_entity>__<dimension>`, exactly as MetricFlow addresses them, and
  `zlens semantic import dbt` writes that name into the imported YAML
  (`qualified_name`), so semantic models need not be named after their entity.

### Bridges: why claim money cannot reach the agent

The compiler never walks an entity join backwards. Claim amounts reach the
policy (claim amount → claim → policy), but `policy_party_role` holds several
rows per policy (the holder and the agent), so going on to a party role would
repeat every claim amount once per role. MetricFlow refuses the same path, and
also stops at two hops. The compiler refuses the block and names the step:

> party_role lives on policy_party_role, which incurred_losses reaches only
> through insurance_policies → policy_party_role: one insurance_policies row has
> many policy_party_role rows, ...

Model the rows you need as one row per policy — for example a `policy_agent`
dbt model (`where Party_Role_Code = 'AG'`) whose entity `policy` is declared
`type: unique`, with `primary_entity: policy_agent` at model level. Keeping
`insurance_policies` the only `primary` model for `policy` keeps it the target
of every foreign `policy`; `policy_agent` then joins it one-to-one, and a claim
metric groups by the agent in both engines (`claim__policy__agent_party_id` is
two hops for MetricFlow).

## CLI

```bash
zlens semantic list                 # list everything
zlens semantic validate             # check all refs resolve
zlens semantic query 'revenue by segment in 2024'   # NL → SQL preview
zlens semantic pull                 # re-sync from dbt
```

## Referencing from cells

```dql
// In a DQL cell
@metric("revenue") by @dim("customer.segment") for 2024
```

The compiler resolves refs, joins the needed tables, and emits SQL for the
target warehouse dialect.
