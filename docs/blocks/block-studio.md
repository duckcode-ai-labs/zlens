# Block Studio

Block Studio is where you write, run, review and certify blocks.

## Open it

In the left rail, click **Blocks**.

- With a block selected in the sidebar, Block Studio opens that block.
- With nothing selected, it shows **Create DQL blocks** with three ways to
  start:

| Card | Button | Use it to |
|---|---|---|
| **Ask AI** | **Describe block** | Describe what you need; AI drafts it from your blocks, models and metrics. |
| **Import SQL** | **Start import** | Turn existing SQL into drafts. See [Import SQL](import-sql.md). |
| **Build manually** | **Open builder** | Build a semantic block from metrics, dimensions, time grain and filters. |

Under **Manual options** you also find **Blank SQL block** (**Create**) and
**Semantic block** (**Build**).

**New block** in the Block Studio toolbar brings you back to this start page.

The **New Block** dialog opens from **Semantic block** → **Build**, from **New
Block** on the Notebooks start screen, and from the command palette. It asks
for the type (**SQL Block** or **Semantic Block**), who it is for (**Shared
with the team** or **Private to me**), a **Block Name**, a **Domain** and an
optional **Folder**. Click **Create Block**.

## SQL block or semantic block

- A **SQL block** runs SQL you write against dbt models or warehouse tables.
- A **semantic block** asks for metrics and dimensions from the semantic
  layer, so you do not write joins. Use it when the metric is already defined
  in dbt.

## The block page

When you open a block, you see its overview:

- the name, a status badge such as **DRAFT** or **CERTIFIED**, the domain and
  the owner;
- for a certified block, the certification receipt under the name. This
  overview is the only place Block Studio shows the receipt. If the block was
  edited after it was certified, the badge reads **RECERTIFY** and a warning
  says the source no longer matches its certification receipt;
- **Last run**, **Rows**, **Used in** and **Tests**;
- **Outputs**, **Parameters**, the **DQL source**, tests and lineage.

Buttons on the overview: **Open in builder**, **Run**, and **Delete** (trash
icon) for a block you may edit.

The toolbar at the top has:

| Button | Does |
|---|---|
| **New block** | Goes back to the **Create DQL blocks** start page. |
| **Ask AI** / **Modify with AI** | Has AI draft a new block, or change the saved block. |
| **Run** | Runs the block and shows the rows in **Results**. Shown while you edit; the overview has its own **Run**. |
| **Save draft** | Saves your changes as a draft. Never certifies. |
| **Certify** / **Re-certify** | Runs the certification checks. See [Save and certify](certify.md). |
| **Delete** | Deletes a saved block. Shown while you edit; the overview has its own delete button. |

Switch between **Visual Builder** and **DQL Source** to edit the block in a
form or as text. Above the visual builder, the **Query** toggle switches
between **Semantic picker** (metrics and dimensions) and **Raw SQL**.
**Context** opens a panel with the block's context; the block's `llmContext`
is the **Agent guidance** field there.

The tabs at the bottom are **Results**, **Run inputs**, **Lineage**,
**History** and **Metadata**. The certification panel is in **Metadata**.

## Edit and save

1. Click **Open in builder** (or switch to **DQL Source**).
2. Change the query, the chart or the details. In the visual builder, the
   **Details** box holds **Block name**, **Domain**, **Owner**, **Tags**,
   **Folder (optional)** and **Description**.
3. Click **Run** to check the rows.
4. Click **Save draft**.

Saving a certified block does not change the certified version: your edit is
saved as a separate draft beside it until you certify it.

## Add tests

Tests are optional. In the visual builder, use the **Tests** box ("Optional.
Certify runs them: a declared test must pass, and a column test must hold on
every row."). In DQL source:

```dql
tests {
  assert row_count > 0
  assert revenue >= 0
  assert region IN ["east", "west"]
}
```

Certify runs the tests; **Run** does not. See [Add tests](certify.md#add-tests).

## Fill in the details that help Ask

Ask and your AI agents find blocks by what they say about themselves. In the
**Metadata** tab or the DQL source, set:

- a plain **description** of what the block answers,
- `grain`: what one row is, such as `customer` or `day`,
- `outputs`: the columns it returns,
- `llmContext`: a short note for AI about when to use the block (the
  **Agent guidance** field in the **Context** panel).

Certification records these as warnings when they are missing.

## From the terminal

```bash
zlens new block "Revenue by segment" --domain finance --owner you@example.com
```

This writes a draft block under `blocks/` (or `domains/finance/blocks/` if
your project has domain folders) and prints its path. Open it in Block Studio
to run and certify it.
