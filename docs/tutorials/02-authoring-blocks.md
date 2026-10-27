# 02 — Authoring blocks

!!! warning "Archived page"
    This page was written for an earlier version of ZLens and may not match the
    current product. See [About the archive](../archive.md) for the current page.

**Who this is for:** analysts who'll author and certify reusable analytics
blocks on top of dbt models.

**What you'll do:** write a real block with governance metadata, agent
context, and tests, then walk it through the certification gate.

**Time:** 20 minutes.

> Setup: this tutorial continues from
> [01 — Getting started](./01-getting-started.md) — a `dql/` workspace inside
> a dbt repo, with the default connection pointed at the dbt warehouse. SQL
> below uses the example repo's `dev` schema; substitute your own models.

---

## The idea

dbt gives you clean, tested, modeled tables. The questions stakeholders
actually ask on top of them — "what's monthly revenue?", "what's our average
order value?" — usually live in ad-hoc queries, BI tiles, and pasted SQL. A
**block** captures one of those answers as code: the SQL, who owns it, what it
means, how it's tested, and how an AI agent should use it. Certified blocks
become the only thing dashboards and agents are allowed to trust.

---

## Step 1 — Open Block Studio

In the notebook UI:

1. Click **Blocks** in the activity bar.
2. Click **+ New** → **SQL Block** (you can also start from a dbt model —
   Block Studio lists them when dbt is synced).
3. Name it `revenue_by_month`. Domain: `revenue`. Hit **Create**.

> **You should see** a CodeMirror editor with a starter `.dql` template and
> tabs along the top: **Validate · Results · Save**.

The file lives at `blocks/revenue_by_month.dql`.

---

## Step 2 — Write the SQL + metadata

Replace the template with this block. We'll walk through each section
afterwards.

```dql
// blocks/revenue_by_month.dql
// dql-format: 1

block "revenue_by_month" {
  domain      = "revenue"
  type        = "custom"
  owner       = "you@your-company.com"
  description = "Gross revenue by calendar month, from the orders mart."
  tags        = ["revenue", "kpi", "monthly"]

  // ── Agent-facing metadata ────────────────────────────────────────────
  // llmContext is a single-line string — a block uses one triple-quoted
  // ("""…""") string and we reserve it for `query` below.
  llmContext = "Use this block for questions about revenue over time, monthly revenue, or revenue trend. Revenue is the sum of order_total from the dbt orders mart (gross, before costs). One row per calendar month."
  // The questions this block answers. A question that equals one of them
  // (ignoring case, spacing and trailing punctuation) is answered by this
  // block once it is certified, before any model reads it. A draft made from
  // an Ask answer or a request records that question here; Block Studio
  // edits the list as "Questions it answers".
  examples = [
    { question = "What is monthly revenue?" },
    { question = "How has revenue trended this year?" }
  ]
  invariants = ["revenue >= 0"]

  // ── Query ────────────────────────────────────────────────────────────
  query = """
    SELECT
      date_trunc('month', ordered_at) AS month,
      SUM(order_total)                AS revenue
    FROM dev.orders
    GROUP BY 1
    ORDER BY 1
  """

  visualization {
    chart = "line"
    x     = "month"
    y     = "revenue"
  }

  tests {
    assert row_count >= 1
  }
}
```

Hit **Cmd-S**. Block Studio auto-validates.

> **You should see** the **Validate** tab go green and the **Results** tab
> show one row per month.

### What each section is for

| Section | Purpose |
|---|---|
| `domain`, `owner`, `tags` | Routed into `dql-manifest.json` and the lineage graph. Required by the certifier. |
| `description` | Human-readable; shown in the Block Library and on dashboard tiles. |
| `llmContext` | One paragraph the agent uses to ground retrieval and SQL generation. **Required for good agent recall** — without it, the knowledge graph only has the description to work with. |
| `examples` | Few-shot questions the chat cell and Slack bot use to disambiguate. |
| `invariants` | Free-form post-conditions used as prompt grounding for the agent. |
| `query` | Your SQL. Triple-quoted so multi-line is comfortable. |
| `visualization` | Default chart for tiles that don't override it. |
| `tests` | Assertions run by `zlens certify` against the real connection. |

---

## Step 3 — Run the certification gate

```bash
zlens certify blocks/revenue_by_month.dql
```

(The default connection from `dql.config.json` is used automatically.)

> **You should see** the rule table — `has-description`, `has-owner`,
> `has-domain`, `tests-pass`, … — go green, ending with:
> ```text
> Status: certified
> ```

The block's `status` flips from `draft` → `certified`. Certification in OSS
is a **local trust label**: required metadata present, query executes,
test assertions pass.

---

## Step 4 — Confirm it landed in the manifest

```bash
zlens compile
```

This rebuilds `dql-manifest.json` — the dbt-like artifact for the ZLens
workspace. Your block appears under `blocks` with its status, domain, chart
type, and table dependencies (`dev.orders`).

---

## Step 5 — See it in the lineage graph

```bash
zlens lineage --block revenue_by_month
```

> **You should see** the block reading from the orders model, which in turn
> traces back through the dbt DAG to its sources:
> ```text
> block:revenue_by_month (certified · revenue)
>   ↑ reads_from
> dbt model: orders → stg_orders → seed
> ```

Or click **Lineage** in the activity bar for the interactive graph.

---

## Step 6 — Add two more blocks for the next tutorial

Create and certify these the same way (Block Studio, or paste the files):

```dql
// blocks/avg_order_value.dql
// dql-format: 1

block "avg_order_value" {
  domain = "revenue"
  type = "custom"
  owner = "you@your-company.com"
  description = "Average order value across all orders, in dollars."
  tags = ["revenue", "kpi"]
  llmContext = "Single-value KPI: average order_total across all orders."
  query = """
    SELECT ROUND(AVG(order_total), 2) AS avg_order_value
    FROM dev.orders
  """
  visualization { chart = "single_value" }
  tests { assert row_count == 1 }
}
```

```dql
// blocks/daily_orders.dql
// dql-format: 1

block "daily_orders" {
  domain = "revenue"
  type = "custom"
  owner = "you@your-company.com"
  description = "Order count per day."
  tags = ["revenue", "volume"]
  llmContext = "Use for order volume over time: orders per day."
  query = """
    SELECT date_trunc('day', ordered_at) AS day,
           COUNT(*)                      AS orders
    FROM dev.orders
    GROUP BY 1 ORDER BY 1
  """
  visualization {
    chart = "bar"
    x = "day"
    y = "orders"
  }
  tests { assert row_count >= 1 }
}
```

```bash
zlens certify blocks/avg_order_value.dql
zlens certify blocks/daily_orders.dql
```

> **You should see** both flip to `certified` — three certified blocks,
> enough to compose a dashboard.

---

## What you now have

✓ A certified block with governance metadata, agent context, and tests
✓ A working understanding of every block-section field
✓ Three certified blocks ready to compose into a dashboard
✓ `dql-manifest.json` connecting your blocks to the dbt DAG

[Continue to tutorial 03 — Dashboards & Apps →](./03-dashboards-and-apps.md)
