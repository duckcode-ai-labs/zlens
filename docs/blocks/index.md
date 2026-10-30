# Saved queries

A **saved query** is a named, reusable query that a person can review and
certify. On disk it is a saved query (a `.dql` block file). It carries the
SQL (or a metrics query) plus an owner, a domain, a description, tests and a
chart. Ask answers from certified saved queries first, and App tiles are built
from saved queries.

{{ video("bk1-why-blocks") }}

## Where saved queries come from

| Start from | How |
|---|---|
| Existing SQL: `.sql` files, pasted SQL, Tableau workbooks or Power BI files | [Import SQL](import-sql.md) |
| A notebook cell | **Save as saved query** on the cell. See [Notebooks](../notebooks/index.md#save-a-cell-as-a-saved-query). |
| An Ask answer you want to keep | **Save as saved query** on the answer, or the review draft Ask saves for you. See [Answers that need review](../ask/needs-review.md). |
| Nothing yet | **New saved query** in [Saved queries](block-studio.md) |
| A dbt project | `zlens propose` in a terminal: it ranks your dbt models and writes one draft saved query per high-value model. See the [CLI reference](../reference/cli.md). |
| A terminal | `zlens new block "<name>"` or `zlens import sql <path>` |

Whichever way you start, the result is a **draft**. A person certifies it
later. See [Save and certify](certify.md).

## Find your saved queries

1. In the left rail, click **Saved queries**.
2. The sidebar lists saved queries in folders by domain. Drafts that Ask or
   Import SQL saved for review are in a **Drafts** folder.
3. Narrow the list with the search box or the domain menu (**All domains**).

The line under the search box counts them, for example `3 saved queries · 1
draft · all domains`.

Each row shows the saved query's name, domain and status. A **Private** badge
means the saved query is kept only on your machine, outside git, until you
publish it.

## Status

The **Saved queries** page shows a saved query's status as a badge in capital
letters:

| Badge | Means |
|---|---|
| **DRAFT** | Saved, not reviewed. Ask does not use it as a trusted answer. |
| **CERTIFIED** | A person certified it. Ask and Apps treat it as trusted. |
| **IN REVIEW** | The source says `status = "review"`. ZLens never sets this status; it appears only when someone writes it into the `.dql` file. |
| **RECERTIFY** | The saved query was certified, but its source was edited after that (it no longer matches its certification receipt), or something it depends on changed. Ask does not treat it as certified until someone certifies it again. See [Save and certify](certify.md#edited-after-certification). |
| **DEPRECATED** | Retired. If it names a replacement, ZLens shows **Replaced by** and links to it. |

## What the file looks like

The file format and the CLI keep the word `block`:

```dql
// dql-format: 1

block "Top customers by lifetime spend" {
  status = "certified"
  domain = "uncategorized"
  type = "custom"
  description = "The ten customers with the highest lifetime spend, with their order counts."
  owner = "analytics@example.com"
  query = """
    select customer_name, count_lifetime_orders, lifetime_spend
    from dev.customers
    order by lifetime_spend desc
    limit 10
  """
  visualization {
    chart = "table"
  }
}
```

- Saved queries are kept under `blocks/<domain>/`, or `domains/<domain>/blocks/`
  when your project uses domain folders.
- Drafts that Ask or Import SQL created go in a `_drafts/` folder until they
  are certified.
- Once you save it, a saved query has a companion file under
  `semantic-layer/blocks/` that records its review status and, once certified,
  the certification receipt. One that has never been saved has no companion
  file yet.

The full syntax is in the [DQL language reference](../reference/language.md).
