# Blocks

A **block** is a named, reusable query saved as a `.dql` file. It carries the
SQL (or a semantic metric query) plus an owner, a domain, a description,
tests and a chart. Ask answers from certified blocks first, and App tiles are
built from blocks.

## Where blocks come from

| Start from | How |
|---|---|
| Existing SQL files or pasted SQL | [Import SQL](import-sql.md) |
| A notebook cell | **Save Block** on the cell. See [Notebooks](../notebooks/index.md#save-a-cell-as-a-block). |
| An Ask answer you want to keep | **Save as block** on the answer, or the review draft Ask saves for you. See [Answers that need review](../ask/needs-review.md). |
| Nothing yet | **New block** in [Block Studio](block-studio.md) |
| A dbt project | `zlens propose` in a terminal: it ranks your dbt models and writes one draft block per high-value model. See the [CLI reference](../reference/cli.md). |
| A terminal | `zlens new block "<name>"` or `zlens import sql <path>` |

Whichever way you start, the result is a **draft**. A person certifies it
later. See [Save and certify](certify.md).

## Find your blocks

1. In the left rail, click **Blocks**.
2. The sidebar lists blocks in folders by domain. Draft blocks that Ask or
   Import SQL saved for review are in a **Drafts** folder.
3. Narrow the list with **Search blocks…** or the domain menu (**All domains**).

The line under the search box counts them, for example `3 blocks · 1 draft ·
all domains`.

Each row shows the block's name, domain and status. A **Private** badge means
the block is saved only on your machine, outside git, until you publish it.

## Block status

Block Studio shows a block's status as a badge in capital letters:

| Badge | Means |
|---|---|
| **DRAFT** | Saved, not reviewed. Ask does not use it as a trusted answer. |
| **CERTIFIED** | A person certified it. Ask and Apps treat it as trusted. |
| **IN REVIEW** | The source says `status = "review"`. Block Studio never sets this status; it appears only when someone writes it into the `.dql` file. |
| **RECERTIFY** | The block was certified, but its source was edited after that (it no longer matches its certification receipt), or something it depends on changed. Ask does not treat it as certified until someone certifies it again. See [Save and certify](certify.md#edited-after-certification). |
| **DEPRECATED** | Retired. If it names a replacement, Block Studio shows **Replaced by** and links to it. |

## What a block file looks like

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

- Blocks are saved under `blocks/<domain>/`, or `domains/<domain>/blocks/` when
  your project uses domain folders.
- Drafts that Ask or Import SQL created go in a `_drafts/` folder until they
  are certified.
- Once a block is saved, it has a companion file under `semantic-layer/blocks/`
  that records its review status and, once certified, the certification
  receipt. A block that has never been saved has no companion file yet.

The full syntax is in the [DQL language reference](../reference/language.md).
