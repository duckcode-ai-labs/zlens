# Feature clips

Short, muted, looping clips of ZLens features for the docs pages and the
README. Each clip `<id>` has `<id>.mp4` (H.264), `<id>.webm` (VP9) and a
`<id>.png` poster; `overview` also has `overview.gif` for the README.
[`clips.yml`](clips.yml) gives each clip a title, a caption and the steps it
shows, for the figcaption.

## Re-record

```bash
pnpm install
pnpm docs:clips                 # every clip
pnpm docs:clips lineage ask-review   # only these
```

Each clip is a scripted Playwright journey in
`apps/dql-notebook/browser/clips/<id>.clip.ts`. The command builds the CLI,
prepares the Jaffle Shop sample (the project the README and quickstart point
to: `github.com/duckcode-ai/jaffle-shop-duckdb`, pinned to one commit), serves
it with the built `zlens notebook`, records each journey at 1440×900 in the
Paper theme, and encodes the result into this folder. Waits on the server are
shortened in the clip; a pointer shows what is clicked. The `quickstart` and
`mcp-connect` terminals show commands the harness really runs, with their real
output; the scratch folder they run in is shown as `~`.

Flags: `--skip-build` (reuse `apps/cli/dist`), `--encode-only` (re-encode the
last recordings), `--record-ask` (see below). The sample, the dbt build and
raw recordings are cached in `node_modules/.cache/zlens-clips`
(`ZLENS_CLIPS_WORK_DIR` to move it).

## Ask clips and the model

Ask answers come from a model. The clips replay real model responses recorded
once and committed under `apps/dql-notebook/browser/clips/cassettes/<id>/`, so
a re-record needs no model and shows the same answers. Everything else in the
answer (retrieval, SQL, the query against DuckDB, the trust label) runs live.
A replay miss is an error, never a live call: if the product's prompts change,
re-record the responses with

```bash
pnpm docs:clips ask-certified --record-ask
```

which uses the locally configured subscription provider
(`ZLENS_CLIPS_PROVIDER`, default `claude-code`: the `claude` CLI's own login).
No API key is used or stored.

## Requirements

- Node 20–22, pnpm, and the Playwright Chromium
  (`pnpm -F @zlens/notebook-app exec playwright install chromium`)
- Python 3.9–3.14 (dbt-duckdb builds the sample's DuckDB file)
- ffmpeg with libx264 and libvpx-vp9 (`FFMPEG=/path/to/ffmpeg` to choose one)
- Network on the first run (sample clone, dbt packages, DuckDB driver)

## Size budget

| File | Budget |
| --- | --- |
| `<id>.mp4`, `<id>.webm` | 2 MB each (`overview`: 3 MB) |
| `<id>.png` poster | 0.5 MB |
| `overview.gif` | 5 MB |

The encoder lowers quality until each file fits; `pnpm test` checks the budget
and that every clip in `clips.yml` has its files
(`scripts/docs-clips.test.mjs`).
