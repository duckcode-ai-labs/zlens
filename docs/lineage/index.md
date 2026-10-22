# Lineage

Lineage shows where a number comes from and what uses it: from your warehouse
tables (and, if you use dbt, the sources and models behind them), through
saved queries, to the dashboards and Apps that show them. ZLens builds it from your
synced warehouse catalog or dbt manifest plus your ZLens files, so it is always
up to date after `npm run sync` (or `zlens compile`).

{{ clip("lineage") }}

## Trace one item

1. In the left rail, click **Lineage**.
2. **Trace lineage** asks you to pick something. Use the tabs (**Saved queries**,
   **Apps**, **Notebooks**, **Dashboards**) or **Search saved queries…**.
3. Click an item, such as the saved query `Top customers by lifetime spend`.

The graph shows everything upstream and downstream of it. In the sample
project that is: the raw dbt sources, the staging and mart models
(`stg_customers`, `orders`, `customers` and so on), the saved query, the dashboard
page, and the App.

Each card names the item and its type, such as **dbt Model**, **Saved query**,
**Dashboard** or **App**. Certified saved queries have a green shield.

The status bar reads, for example, `End-to-end lineage of Top customers by
lifetime spend · 18 nodes · 18 edges` and **Compiled from the dbt manifest**.
The status bar names what the lineage was built from: on a project without
dbt (warehouse-first) it reads **Compiled from the synced warehouse catalog**,
and on a hybrid project it names both.

## Focus on one path

Click a card. Everything that is not upstream or downstream of it fades. A
card in the corner shows how many items are upstream and downstream, and
offers:

- **Trace from here**: make this item the one you trace.
- **Ask about this**: ask AI to explain where it comes from and what uses it.

Click the empty canvas, or **Show all**, to clear the focus.

## Change the view

| Control | Options |
|---|---|
| View | **Technical** (sources and dbt), **Domain** (terms, domains, metrics, certified saved queries), **End-to-end** (everything) |
| Layout | **Flow** or **Layered** |
| Direction | **LR** (left to right) or **TB** (top to bottom) |

To trace something else, click **Tracing** at the top left, or type in
**Search another saved query, app, or notebook…**.

## From other places

- **A notebook cell**: open **Cell SQL lineage** or **Project saved query lineage**
  under the cell, then **View in DAG**.
- **A saved query**: the **Lineage** tab at the bottom of the saved query editor.
- **An App**: **Lineage** in the dashboard toolbar opens the page's lineage.

## From the terminal

```bash
zlens lineage                                     # summary of the whole project
zlens lineage "Top customers by lifetime spend"   # one block, App, model, metric…
zlens lineage --domain finance                    # one domain
zlens lineage cross-domain                        # flows between domains
zlens lineage --format json                       # the whole graph as JSON
```

For one item, it prints its direct and full upstream and downstream, for
example:

```text
  Block Lineage: Top customers by lifetime spend
  ==================================================
  Type: block
  Status: certified

  Direct Upstream (1):
    dbt_model:customers

  Direct Downstream (2):
    chart:Top customers by lifetime spend (table) (uncategorized)
    dashboard:customer-overview/overview
```

Lineage reads `dql-manifest.json`. If it says **No lineage data found**, run
`zlens compile` first.

## What lineage tracks

Node types: source tables, dbt sources and models, semantic metrics and
dimensions, business terms and views, domains, saved queries, charts, notebooks,
dashboard pages and Apps. For the full model, see
[Lineage model](../architecture/lineage-model.md).
