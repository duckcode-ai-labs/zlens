# zlens

Run ZLens with nothing installed first:

```bash
npx zlens notebook ./my-data
```

`./my-data` can be a dbt project, a folder with a DuckDB or SQLite file, or a
folder of CSV, Parquet or JSON files. ZLens asks before it creates a project
there, then opens the workbench at <http://127.0.0.1:3474>.

This package is the `zlens` command of [`@zlens/cli`](https://www.npmjs.com/package/@zlens/cli)
under a name `npx` can run: `npx @zlens/cli` stops because that package has two
commands (`zlens` and its old name `dql`). Both run the same CLI.

To keep a `zlens` command on your machine, install the CLI itself:

```bash
npm i -g @zlens/cli --allow-scripts=better-sqlite3   # npm 12 needs the flag
```

To start a new project in one step, use `npm create zlens@latest`.

Docs: <https://docs.zlens.app/>
