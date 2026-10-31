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

## Prove the numbers match

A metric draft shows its value over all rows, but a report is a whole table.
`zlens migrate compare` takes an export of the old report, builds the same
table in ZLens, and compares every value. It works on drafts, so you can check
before you approve.

1. Export the report as CSV or `.xlsx`: in Tableau, **Download → Crosstab**; in
   Power BI, a visual's **Export data**.
2. Compare it:

    ```bash
    zlens migrate compare "Sales by Region.csv" --worksheet "Sales by Region"
    ```

    ```text
    Sales by Region.csv: 4 rows, 1 total row set aside

      Region        the dimension region
      Total Sales   the metric total_sales, at 2 decimals
      Profit Ratio  the metric profit_ratio, at 0.1%

    Differs: 4 of 4 rows, 2 of 8 values.
      Central  Total Sales  old report $501,239.89  ZLens 612004.13
      …

    Possible reasons:
      The report filters Order Date, and no filter was stated. Filters are not
      in an export, so this run read every row.
    ```

3. State the report's filters and compare again:

    ```bash
    zlens migrate compare "Sales by Region.csv" --worksheet "Sales by Region" \
      --filter "order_date >= 2024-01-01"
    ```

**What counts as equal.** A value is equal when ZLens's lies within half a
printed unit of the file's, using the most decimals in that column: `14.93%`
equals a printed `14.9%`, and `14.96%` does not. `--tolerance 0.5%` loosens it for
a report known to lag, up to 10%, and is recorded. An empty value is equal only to
an empty value. A percent is also tried at 100 times when the metric's definition
multiplies by 100, so `14.9%` matches a metric that holds 14.9.

An `.xlsx` number has nothing printed to round to, so it is compared at the full
value the file holds. If the file holds rounded numbers, every one will differ a
little: use the CSV download, or `--tolerance`.

**Three verdicts.** Each metric gets its own, and the file gets the worst:

| Verdict | Means |
|---|---|
| **Matches** | Every row is in both, every value is equal, every number column was compared, and each filter ZLens can see was answered. |
| **Differs** | A value differs, or a row is in only one side. |
| **Not proven** | Nothing disagrees, but something is missing: a column not compared, an export cut short, or a filter nobody answered. |

The command exits 0, 1 or 2 for those, so a script can read it.

**Filters decide most comparisons.** An export does not show a filter on a field
the report does not display, and ZLens applies no filter by itself. With
`--worksheet`, it reads the filters saved on that worksheet in your imported
workbook, along with filters on its data source. Each one must be stated or
waived, or the best result is Not proven:

```bash
--filter "region in (East, West)"          # = != > >= < <= in between
--waive "Order Date: covers every row"     # with your reason, kept in the record
```

A Power BI `Applied filters:` line can name several filters, so stating one does
not answer it. State them, then waive the line: `--waive "Applied filters: all stated"`.
In an `.xlsx`, the text of an `ExportHeaders` sheet counts as that line, and so does
any hidden sheet, because ZLens does not read those and they could hold filters.

A filter that can't be written this way (top N, sets, `OR`) can be waived, and
`--file-rows` compares only the rows in the file. That proves the values on those
rows, not that the rows are the right ones, and the result says so.

**Which columns are compared.** Columns are matched by name to metrics and
dimensions: `Total Sales`, `SUM(Sales)` and `Sum of Sales` all find their metric.
The mapping is printed. Change it with `--map "Sales=total_sales"`, `--key
Column` or `--ignore Column`. To compare a saved query instead, use `--query
<name>`, with `--param name=value` for its parameters. For one number:

```bash
zlens migrate compare --metric total_sales --value 2297200.86
```

**A folder of exports.** `zlens migrate compare ./exports` runs each file and
writes `zlens-migration-match.md` (`--out` to choose), the page to hand to whoever
signs off the migration. An `exports.yaml` in the folder gives each file its own
options, under the file's name: `worksheet`, `report`, `query`, `filters`,
`waive`, `map`, `keys`, `ignore`, `fileRows`, `tolerance`.

**On the Import screen.** **Compare with the old report**, in the *Metric drafts*
section and on a saved query draft, does the same thing: drop the file, state the
filters, read the differences. Each draft then shows its verdict, and **Approve
all that ran** leaves out what differs.

**What is kept.** Each metric or saved query gets a record in
`semantic-layer/report-matches/`: who compared which file (by its fingerprint),
which fields were filtered and how, the mapping, and the counts. Records hold no
values, not even a filter's or a parameter's, so no data enters git; the differences
stay in `.dql/`, which git ignores. A waiver's reason is kept as you wrote it. A record says
a named person compared a named file. It can't prove the file came from Tableau,
and it never certifies anything. `--no-record` compares without keeping one.

A record holds a hash of the compiled query, so a draft shows **Changed since
compared** when its definition, or a part of it, moves on. The newest comparison
with each report counts, but a narrower look at the same query, such as fewer rows
or `--file-rows`, does not clear a difference. With several reports, the worst
stands. Certifying a saved query adds that comparison to the receipt: as a passed
check when it matches every row and the query is unchanged, otherwise as a warning.
A match is not required to certify.

**On a server.** Comparing runs as you, with your row rules, and the differences
stay yours. Recording is a second step that takes the right to author datasets. It
is refused when another person could see different figures, because a result your
rules narrowed can't stand for everyone.

## What `zlens migrate <tool>` does today

`zlens migrate assess <folder>` reports what moves; see
[See what moves first](#see-what-moves-first). `zlens migrate compare` checks the
numbers; see [Prove the numbers match](#prove-the-numbers-match).

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
