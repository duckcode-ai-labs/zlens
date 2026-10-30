# Migrate from other tools

Moving to ZLens from Looker, Metabase, Tableau, Power BI, Hex or a folder of
SQL scripts starts with the SQL behind your reports.

## See what moves first

Before you import anything, point ZLens at the folder of reports:

```bash
npx zlens migrate assess ./reports
```

It reads Tableau workbooks (`.twb`, `.twbx`), Power BI templates (`.pbit`)
and projects (PBIP), and `.sql` files, and reports:

- **Queries**: how many draft saved queries `zlens import sql` would make
  (the import's own count: a copy of a query counts once, statements that
  change data are left out), and how many take report parameters.
- **Tables read without SQL**: ZLens reads those from the database directly.
- **Calculations**, each Tableau calculated field and DAX measure, calculated
  column and calculated table, sorted by how it moves:

    | Kind | For example | In ZLens |
    |---|---|---|
    | Simple | `SUM([Sales])`, `DISTINCTCOUNT(Orders[customer_id])` | one metric |
    | Filtered | `SUM(IF [Region] = "East" THEN [Sales] END)`, `CALCULATE(SUM(Orders[total]), Orders[status] = "paid")` | one metric with a filter |
    | Ratio | `SUM([Profit]) / SUM([Sales])`, `DIVIDE([Total Sales], [Orders])` | one metric built from others |
    | Row-level | `[Price] * [Quantity]`, a DAX calculated column | a column or dimension |
    | Advanced | `{FIXED …}`, `RUNNING_SUM`, `TOTALYTD`, `SUMX`, `ALL`, `USERNAME()` | rewritten by hand or with a coding agent; the report says why |

- **The report**: worksheets, dashboards, report pages and their chart types.
- **Databases** the reports read, and whether ZLens connects to each.

It prints a summary and writes the full report to
`zlens-migration-assessment.md` where you run it (`--out <file.md>` to choose;
`--format json` prints the assessment instead and writes nothing). It reads
files only: nothing runs against a database, no AI is asked, and nothing
leaves your computer. You do not need a ZLens project to run it.

The calculation kinds come from reading each formula, not running it, and a
formula that builds on another calculation counts as the harder of the two.

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
