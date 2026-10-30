# create-zlens

Create a ZLens project and open the workbench, in one command:

```bash
npm create zlens@latest
```

- **In a folder with data** (a dbt project, a DuckDB or SQLite file, or CSV,
  Parquet or JSON files), it offers to make the project right there.
- **Anywhere else**, it asks for a new folder's name (`my-analytics` by
  default).

Either way the workbench opens at <http://127.0.0.1:3474> and Guided Setup
takes it from there.

```bash
npm create zlens@latest ./shop                    # a folder with shop.duckdb or CSV files
npm create zlens@latest my-analytics -- --port 4000
```

It runs `zlens notebook <folder> --yes` from [`@zlens/cli`](https://www.npmjs.com/package/@zlens/cli).
Later, open the project again with `npx zlens notebook <folder>`.

`create-zlens-app` is the other starter: it writes a project with its own
`package.json` and npm scripts, for a team that keeps ZLens pinned in the repo.

Docs: <https://docs.zlens.app/>
