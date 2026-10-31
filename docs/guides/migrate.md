# Migrate from other tools

Moving to ZLens from Looker, Metabase, Tableau, Power BI, Hex or a folder of
SQL scripts starts with the SQL behind your reports.

## See what moves first

Before you import anything, point ZLens at the folder of reports:

```bash
npx zlens migrate assess ./reports
```

Point it at a folder, or at one file: a Tableau workbook (`.twb`, `.twbx`), a
Power BI template (`.pbit`), a Power BI project (its `.pbip` file, its
`model.bim` or TMDL folder, or its `.Report` folder) or a `.sql` file. It
reports:

- **Queries**: how many draft saved queries `zlens import sql` would make
  (the import's own count: a copy of a query counts once, statements that
  change data are left out), and how many take report parameters.
- **Tables loaded by name from a database**, with no SQL to import: ZLens
  reads those tables from the database directly. Files and web sources a
  report loads are listed under the databases instead.
- **Calculations**, each Tableau calculated field and DAX measure, calculated
  column and calculated table, sorted by how it moves:

    | Kind | For example | In ZLens |
    |---|---|---|
    | Simple | `SUM([Sales])`, `DISTINCTCOUNT(Orders[customer_id])` | a metric draft |
    | Filtered | `SUM(IF [Region] = "East" THEN [Sales] END)`, `CALCULATE(SUM(Orders[total]), Orders[status] = "paid")` | a metric draft with a filter |
    | Ratio | `SUM([Profit]) / SUM([Sales])`, `DIVIDE([Total Sales], [Orders])` | a metric draft built from others |
    | Row-level | `[Price] * [Quantity]`, a DAX calculated column | a column or dimension |
    | Advanced | `{FIXED …}`, `RUNNING_SUM`, `TOTALYTD`, `SUMX`, `ALL`, `USERNAME()` | rewritten by hand or with a coding agent; the report says why |

- **The report**: worksheets, dashboards, report pages and their chart types.
- **Databases** the reports read, and whether ZLens connects to each.

It prints a summary and writes the full report to
`zlens-migration-assessment.md` where you run it (`--out <file.md>` to choose;
`--format json` prints the assessment instead and writes nothing). It reads
files only: nothing runs against a database, no AI is asked, and nothing
leaves your computer. You do not need a ZLens project to run it.

For simple, filtered and ratio calculations the report also says what the
import makes: the metric in words (`sum(sales) where region = 'East', on
analytics.orders`), or why it cannot yet (it reads Custom SQL, it filters on
another table, it uses a parameter).

The calculation kinds come from reading each formula, not running it.
Comments and text in quotes are not read as code, and neither are field and
table names (`[Total (copy)]` is a field, not a table calculation). A
formula that builds on an advanced calculation is advanced; a ratio of
row-level calculations is still a ratio. If a file cannot be read, the
report says so under **Not read** rather than counting it as empty.

## Bring the SQL over

1. Put the reports you want to keep in one folder:
    - Tableau workbooks (`.twb`, `.twbx`), as they are.
    - Power BI templates (`.pbit`), or Power BI projects (PBIP). For a
      `.pbix`, export a template first: **File → Export → Power BI
      template**.
    - Other SQL, copied into `.sql` files, one or several queries per file.
2. Import them:

    ```bash
    zlens import sql ./reports --domain finance --owner you@example.com
    ```

    `zlens migrate raw-sql --input ./reports` does the same thing, and so do
    `zlens migrate tableau --input` and `zlens migrate powerbi --input`.

    It runs each draft once and lists the ones that need a fix, by kind.

3. Check the drafts, then certify the ones that pass:

    ```bash
    zlens certify --from-import
    zlens certify --from-import --apply
    ```

    Fix the rest (often a parameter that needs a default value) and run it
    again. You can also do all of this in the workbench, where **Certify all
    that ran** does the same. See [Import SQL](../blocks/import-sql.md).

## Bring the calculations over as metrics

From a Tableau workbook or a Power BI model, the same import also turns each
simple, filtered and ratio calculation into a **metric draft** in
`semantic-layer/metrics/_drafts/<domain>/`:

```text
4 calculations became metric drafts (semantic-layer/metrics/_drafts/sales/):
  Total Sales    sum(sales), on analytics.orders                      all rows: 2,297,200.86
  East Sales     sum(sales) where region = 'East', on analytics.orders all rows: 678,781.24
  Profit Ratio   sum(profit) / sum(sales), on analytics.orders         all rows: 0.1247
1 calculation is left out:
  Sales LY       {FIXED [Year] : SUM([Sales])}   A level of detail expression …
```

- **On the real table and column.** Each field's database column and table
  come from the file (Tableau's field metadata, Power BI's source column
  through Power Query renames), matched against the connected database's
  tables: schema and table, else the table name alone when only one table has
  it.
- **Run once.** One query per table computes every draft on it over all rows,
  so you can compare each value with the old report's grand total.
  `--no-check` skips the query; a draft whose query fails is listed with the
  database's error and not written.
- **Translated as the tool computes.** DAX filters follow DAX: an empty value
  counts as 0 or `""` (`coalesce(qty, 0) < 5`), and text on an imported table
  compares ignoring case (`lower(region) = 'east'`). Every division gives an
  empty value for 0 and keeps its decimals.
- **Named after the caption** (`East Sales` → `east_sales`), kept as label and
  synonym. A draft never takes or replaces a metric's name; a calculation that
  is already a metric or a draft is reused. A ratio's parts become drafts of
  their own.
- **With the columns to group by.** A metric groups only by dimensions, so the
  text, date and true/false columns of the tables the drafts read come with
  them as dimension drafts in `semantic-layer/dimensions/_drafts/<domain>/`.
  Date columns are time dimensions, so "by month" works.
- **Notes say where the numbers can differ:** a Tableau data source that joins
  tables (the metric counts each row of its own table once), a workbook that
  reads an extract, a DAX filter that replaces the report's own filter on that
  column, or a file that reads another database than ZLens's connection.

What is left out, with why: calculations on Custom SQL or a Power BI native
query, filters on another table (`CALCULATE([Total], part[container] =
"BAG")` on `orders`), parameters, `DIVIDE` with an alternate result, MEDIAN,
and everything advanced. `--no-metrics` makes no metric drafts.

**A draft answers nothing until a person approves it.** Review them on the
Import screen (**Approve**, **Discard**, **Approve all that ran**) or in the
terminal:

```bash
zlens semantic drafts
zlens semantic approve east_sales
zlens semantic approve --all-from latest
```

Approving moves the file out of `_drafts/` unchanged apart from `status:
certified`, who approved it and when; a ratio brings its parts, and a metric
brings the dimensions of its table. From then on Ask answers "East Sales by
month" **From Metrics**. Grouping by a column of another table needs a certified
relationship, as any join does. Agents can list drafts (MCP `list_proposals`)
but not approve them.

A project whose metrics live in dbt (dbt semantic models, or dbt-first) gets
no files: the import lists each definition in words to add in dbt.

Each query becomes a draft block with a name, description, grain and outputs,
a preview of its rows, and a default test. Scripts become one query each:
temp tables turn into `WITH` clauses and report parameters (`:start_date`,
`@Region`, Tableau `<Parameters.Store>`) into saved query parameters.
Statements that change data get no draft. Nothing is certified until a person
runs Certify.

## What `zlens migrate <tool>` does today

`zlens migrate assess <folder>` reports what moves; see
[See what moves first](#see-what-moves-first).

`zlens migrate tableau --input <path>` and `zlens migrate powerbi --input
<path>` run the import above. Without `--input` they print the command to
use.

`zlens migrate looker`, `metabase` and `dbt` do not read anything yet: they
print what a migration would involve and an example saved query. For Looker
and Metabase, export the SQL behind your reports into `.sql` files and import
those; for dbt, see `zlens propose` in the [CLI reference](../reference/cli.md).

## Check the result

```bash
zlens validate .
```

`zlens validate` reports unresolved references in the imported blocks.

## Upgrade older ZLens or DQL files

These `migrate` commands work on your own project files:

| Command | Does |
|---|---|
| `zlens migrate format --check` | Lists `.dql` and `.dqlnb` files that are not in the canonical format. Run without `--check` to rewrite them. |
| `zlens migrate layout --to domain-first --dry-run` | Previews moving older folders into the `domains/` layout. |
| `zlens migrate parameters --check` | Audits older block parameters. |
| `zlens migrate modeling --to dbt-first --dry-run` | Previews adopting dbt-first modeling. Use `--apply` to write. |
| `zlens migrate datalex --input <manifest.json> --dry-run` | Converts DataLex business semantics into dbt-first overlays. |
