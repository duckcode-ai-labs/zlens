# Import SQL

Turn SQL you already have into draft saved queries (`.dql` block files). ZLens
reads the SQL, drafts a
saved query for each query and runs a preview. You review each draft, save the ones
you want to keep, and certify the ones that are right.

{{ clip("import-certify") }}

{{ video("bk2-import-sql") }}

## 1. Open Import SQL

1. In the left rail, click **Saved queries**.
2. With no saved query open, the saved query editor shows **Create saved queries**. On the
   **Import SQL** card, click **Start import**.

The page is titled **Import SQL to DQL** and shows three steps: **Source**,
**Draft** and **Review**.

## 2. Give it your SQL

Pick one:

- **Paste SQL**: paste one or more queries.
- **Upload files**: pick `.sql` files.
- **Local path**: a file or folder inside your project.

Only `.sql` files are read. A file can hold many queries: ZLens splits at `;`,
at `GO` lines, and where a new statement starts on its own line, so a pasted
page of reports with only a blank line between them works too. A comment
right above a query names its draft (`-- Revenue by store`), and so does a
`-- name:` line.

Scripts become the queries they end in:

| In your SQL | In the draft |
|---|---|
| A temp table the script builds, then reads (`CREATE TEMP TABLE`, `SELECT … INTO #t`, `CREATE TABLE #t` + `INSERT … SELECT`) | A `WITH` clause in the query |
| `DECLARE @since date = '2024-01-01'`, or Snowflake `SET since = …` | The parameter `since`, with that value as its default |
| A variable set to an expression (`SET @cutoff = GETDATE()`) | The expression, written into the query |
| A report parameter with no value: `:start_date`, `@Region`, Tableau's `<Parameters.Store>`, `{{ region }}` | A parameter without a default. Give it one in **Edit full DQL** so the preview and Certify can run the query |
| A stored procedure | The queries in its body, named after the procedure |
| A view nothing else in the file reads | The query it selects, named after the view |

Each draft's warnings say what was changed.

No draft is made for a statement that changes data (`DROP`, `DELETE`,
`INSERT`, `CREATE TABLE … AS` of a table nothing reads), for `EXEC`/`CALL`, or
for a query that repeats one earlier in the same import. **Left out** under
the drafts lists each one with the reason, and none of them is run. Session
settings (`SET NOCOUNT ON`, `USE`) and temp-table cleanup are dropped without
a note. The preview and Certify only ever run one read-only `SELECT` or
`WITH` query.

Optionally set **Domain** and **Owner**. Then click **Generate DQL drafts**.

ZLens works through **Reading SQL** and **Running previews**, then **Import
complete**. Nothing is written to your project yet: a draft becomes a saved query
file only when you click **Save draft** on it.

## 3. Review each draft

The **Drafts** list shows one row per query. Click a draft to see:

- **Review details**: name, domain, owner, description, grain, outputs and
  other fields you can edit.
- **Preview Results**: the rows the query returned.
- **Original SQL** and **Draft saved query**: before and after.

Click **Show context (N)** to see the **Grounding**: the tables and columns
ZLens matched, with any warnings. **Hide context** closes it again.

A draft says **Preview ran successfully. Nothing is written until you save.**
After you edit **Review details**, click **Apply edits**. When a draft repeats
a saved query you already have, it is marked **reuse recommended**, and
**Show context** names the one to use.

The draft runs your SQL, and so does its preview. Only a query that is
exactly a metric query becomes a saved query built from metrics: one table, no joins,
filters, `ORDER BY` or `LIMIT`, each aggregate the same as a metric's
definition and named like it, and every other column a dimension it groups
by. For example, `select region, sum(revenue) as total_revenue from orders
group by 1` becomes the `total_revenue` metric by `region`.

A matching name alone is not enough. If an output only shares a metric's
name (say `count(*) as order_count` over a join, and a metric named
`order_count`), the draft runs your query, and **Generation audit** in the
context panel notes the shared name, so you can check that the two agree or
use the metric instead.

Edit the review details if something is wrong. **Edit full DQL** opens the
whole saved query. If ZLens finds a similar certified saved query, the save button reads
**Reuse existing** and is disabled, and there is no **Certify**: use the
existing saved query instead of saving a copy.

## 4. Save the draft

Click **Save draft**. This is when the `.dql` block file and its companion YAML are
written. The message reads **Draft saved · needs review. Certify it when it is
ready.**

- A draft needs an **Owner**.
- If you changed the review details, ZLens saves the values you see.
- If the name is taken, rename the draft and save again.

## 5. Certify it

Click **Certify**. It is available once the draft is saved.

ZLens runs the saved query and its tests, if it has any (tests are optional). When
the checks pass, the saved query moves out of `_drafts/` to its normal place and is
**Certified**, with a receipt that says `via: sql-import`. When they do not,
you see **Not certified; the draft is unchanged.** and the reasons. See
[Save and certify](certify.md) for the rules.

### Certify all that ran

Under the drafts, **Certify all that ran (N)** runs Certify on every draft
whose preview ran, one after another. Each draft is still checked on its own
and gets its own receipt; the ones that fail stay drafts, and a line under
the button names them with the reason. Drafts that are certified already,
rejected, or marked **reuse recommended** are not included. Nothing is
certified until you click it.

## Where the drafts go

Saved drafts go in:

- `domains/<domain>/blocks/_drafts/` when your project has domain folders,
  otherwise `blocks/_drafts/<domain>/`.
- The import session is cached in `.dql/imports/<session>/`. **Import
  history** lists past sessions.

## From the terminal

Unlike the Import SQL page, the terminal command saves every draft as it goes.

```bash
zlens import sql ./legacy-sql --domain finance --owner you@example.com
```

It prints one line per query with the draft's path and whether it ran (`ran:
12 rows`, or `needs a fix:` and why), then the statements it left out. It
ends with a count by kind of fix:

```text
Ran: 9 of 13 drafts. Need a fix: 4.
  2 × Needs a default value
  1 × Does not parse on this connection
  1 × Column problem
Certify the ones that pass the checks: zlens certify --from-import imp_5f4b1b7a93 --apply
```

It uses the running `zlens notebook` when there is one. `--no-preview` makes
the drafts without running them.

Check every draft of the import, then certify the ones that pass:

```bash
zlens certify --from-import
zlens certify --from-import --apply
```

Without an id it uses the latest import. `--apply` runs the page's Certify on
each draft, so each one is checked on its own and gets its own receipt
(`via: sql-import`). The ones that fail stay drafts and are listed with the
reason. Fix a draft on the Import SQL page or in its file under `_drafts/`,
then run it again: drafts already certified are skipped.

One draft at a time: `zlens certify --from-draft <path> --owner
you@example.com`. The certified file drops the draft's hash from its name
(`monthly-revenue.dql`) unless that name is taken.
