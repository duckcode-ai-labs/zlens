# Import SQL

Turn SQL you already have into draft saved queries (`.dql` block files): `.sql`
files and pasted SQL, the Custom SQL in Tableau workbooks, and the native SQL
in Power BI templates and projects. ZLens drafts a saved query for each query
and runs a preview. You review the drafts and certify the ones that are right,
one at a time or all that ran at once.

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
- **Upload files**: pick `.sql` files, Tableau workbooks or Power BI files.
- **Local path**: a file or folder inside your project.

ZLens reads `.sql` files, Tableau workbooks and Power BI files (see
[Tableau and Power BI](#tableau-and-power-bi) below). A `.sql` file can hold
many queries: ZLens splits at `;`, at `GO` lines, and where a new statement
starts on its own line, so a pasted page of reports with only a blank line
between them works too. A comment
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

### Tableau and Power BI

| File | What becomes a draft |
|---|---|
| Tableau workbook (`.twb`, or a packaged `.twbx`) | Each Custom SQL query, named after it (`Usage Stats (Custom SQL)` → `Usage Stats`) |
| Power BI template (`.pbit`) | Each table whose Power Query runs SQL: `Value.NativeQuery(…)`, a connector's `Query` option (`Sql.Database(…, [Query="…"])`), or `Odbc.Query` |
| Power BI project (PBIP): the `.pbip` file, its `<name>.SemanticModel` folder, `model.bim` or the `.tmdl` files | The same, read from the model's tables |

A draft's warnings name the workbook or model, the data source or table, the
database it ran on, and for Tableau the worksheets that use it. Tableau
parameters (`<Parameters.Start Date>`) and Power BI parameters become saved
query parameters, with the value they have in the file as default. SQL that
Power Query builds with `&` is put back together; a piece ZLens cannot read
becomes a parameter, and the warning says to check it.

Some of a BI file has no SQL. **Left out** lists it, so you can see what is
not covered:

- **Data sources and tables that load a table directly**, without SQL: most
  Power BI tables and many Tableau data sources. ZLens reads those tables from
  the database itself.
- **Calculated fields and DAX measures:** they have no SQL. The simple,
  filtered and ratio ones become metric drafts (below); the rest are listed
  there with why.
- **A `.pbix`**, which stores its model compressed. In Power BI Desktop choose
  **File → Export → Power BI template** and import the `.pbit`, or save the
  report as a Power BI project.

Upload is fine for workbooks without extracts. For a large `.twbx`, point the
**Local path** at it instead.

### Generate the drafts

Optionally set **Domain** and **Owner**. Then click **Generate DQL drafts**.

ZLens works through **Reading SQL**, **Running previews** and, for a Tableau
or Power BI file, **Making metric drafts**, then **Import complete**. Nothing is written to your project yet: a draft becomes a saved query
file only when you click **Save draft** on it, or when it is certified.

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

### When a draft needs a fix

A draft whose preview did not run is marked **needs attention**, with the
reason. The usual ones:

| The draft says | What to do |
|---|---|
| `Provide required parameter: start_date` (in the terminal: **Needs a default value**) | The SQL had a report parameter without a value. In **Edit full DQL**, give it one: `params { start_date = "2024-01-01" }`. |
| A table does not exist (in the terminal: **Reads a table this connection does not have**) | The report ran on another database or schema. Point the table names at this connection's, or connect ZLens to that database. |
| A syntax error (in the terminal: **Does not parse on this connection**) | The SQL is in another database's dialect, such as SQL Server's `TOP` or `[brackets]` on DuckDB. Rewrite those parts for this connection. |
| A column error (in the terminal: **Column problem**) | The query itself has a mistake, such as an ambiguous column. It would fail in the old tool too. |
| A warning that a temp table is changed after it is created | The script builds the table in several steps (`UPDATE`, `DELETE`). Rewrite it as one `SELECT`. |

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
whose preview ran, one after another; you do not have to save each one first.
Each draft is still checked on its own and gets its own receipt; the ones
that fail stay drafts, and a line under the button names them with the
reason. Drafts that are certified already, rejected, or marked **reuse
recommended** are not included. Nothing is certified until you click it.

### Metric drafts

For a Tableau workbook or a Power BI model, **Metric drafts (N)** under the
drafts lists each simple, filtered or ratio calculation that became a metric
draft, with:

- the definition in words: `sum(sales) where region = 'East', on
  analytics.orders`;
- its value over all rows, from one query per table, to compare with the old
  report's grand total;
- the formula it came from, and notes where the numbers can differ (a joined
  Tableau data source, an extract, a DAX filter that replaces the report's own
  filter, another database);
- for a ratio, the parts that are approved with it.

The text, date and true/false columns of those tables come with them as
dimension drafts, so an approved metric can answer "by region" or "by month".

**Approve** makes it answer: its file moves from
`semantic-layer/metrics/_drafts/<domain>/` to `semantic-layer/metrics/<domain>/`
with `status: certified`, who approved it and when, its table's dimensions
come with it, and Ask labels its answers **From Metrics**. **Discard** deletes the draft. **Approve all that ran (N)**
approves every draft whose check ran. Below them: calculations that are
already a metric, ones whose check failed on the database, and ones left out,
each with why. See [Migrate from other tools](../guides/migrate.md#bring-the-calculations-over-as-metrics).

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

The path can be a `.sql` file, a Tableau workbook, a Power BI template or
project, or a folder holding any of them:

```bash
zlens import sql ./reports/Sales.pbit --domain finance --owner you@example.com
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
