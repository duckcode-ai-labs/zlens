# Launch gate

`node scripts/launch-gate.mjs` checks a release the way a new user meets it.
On a clean folder it installs the packed release, follows the README and
docs quickstart exactly for both samples, and prints a pass/fail table. Push
a release tag only after a run on the tagged commit has zero failures.

```bash
pnpm install --frozen-lockfile
node scripts/launch-gate.mjs --out ../gate-runs/gate-$(date +%Y%m%d-%H%M%S) --node <folder with Node 24>
```

It runs everything below twice, once per **npm lane**: the npm on your PATH
(`system`) and **npm 12**. npm 12 blocks dependency install scripts unless
`package.json` allows them, which is how 0.2.0 shipped a `better-sqlite3`
without its native binary to npm 12 users while a gate on npm 10 passed.
`--npm system,12` is the default; `--npm system` runs one lane.

npm 12 needs Node `^22.22.2 || ^24.15.0 || >=26`. The gate installs
`npm@12` into `<out>/lanes/` and puts it first on the lane's PATH, with the
Node from `--node <folder>` (or the gate's own Node when it is new enough).
Without a suitable Node, the lane's setup row fails and tells you so. To get
one without touching your system Node:

```bash
V=v24.22.0; mkdir -p ../node24 && cd ../node24
curl -fsSLO https://nodejs.org/dist/$V/node-$V-darwin-arm64.tar.gz
curl -fsSL https://nodejs.org/dist/$V/SHASUMS256.txt | grep "node-$V-darwin-arm64.tar.gz" | shasum -a 256 -c -
tar xzf node-$V-darwin-arm64.tar.gz && cd -
node scripts/launch-gate.mjs --node ../node24/node-$V-darwin-arm64/bin
```

**Node 26 LTS.** Add a lane that runs Node 26 with the npm it ships with:
`--npm system,12,bundled:<folder with Node 26>`. ZLens's DuckDB driver
(`@duckdb/node-api`, RFC 0011) loads on every Node from 20 up, so the release
gate runs this lane too. Get Node 26 the same way as Node 24 above
(`V=v26.13.0`).

It takes 40 to 80 minutes: per lane, the dbt build, the `npm install`s, and
Ask answered by a live model.

## What it does

1. **Packs the release.** `scripts/release-packages.mjs --dry-run` builds the
   workspace and packs the 18 release packages at the version in
   `apps/cli/package.json`. These are the tarballs `npm publish` would upload.
   Pass `--tarballs <dir>` to reuse tarballs packed earlier.
2. **Serves them from a local registry** on `127.0.0.1` (first free port from
   `--port`, default 3620). The release packages resolve to the packed
   tarballs, at their version, under `latest`. Every other package passes
   through to registry.npmjs.org. Nothing is published.
3. **Uses a clean shell:**
   - npm points at that registry, with a fresh npm cache and an empty user
     config;
   - no npm/pnpm/`ZLENS_*` variables from the harness;
   - no `dbt`, `mf`, `zlens` or `dql` from your `PATH` (other commands in
     those folders stay); the quickstart uses the sample's own
     `.venv/bin/dbt`;
   - `ZLENS_EMBEDDINGS_AUTODETECT=off`, so a local Ollama does not change
     Ask.

   `open`/`xdg-open` are stubbed, so `npm run notebook` does not open your
   browser. Playwright is the browser.
4. **dbt sample** (`duckcode-ai/jaffle-shop-duckdb`), as the README says:
   - `git clone`; the Python venv; `pip install`; `dbt deps`, `dbt seed` and
     `dbt build`;
   - `npm install` (no install script may be blocked: the sample's
     `package.json` allows `better-sqlite3`), then `better-sqlite3` must open
     a database;
   - `npm run sync`, `npm run validate` (no driver step: the README has none);
   - `npm run notebook`, which installs the DuckDB driver
     (`@duckdb/node-api`) into `.dql/connectors` on start; it must then load
     and report DuckDB 1.5, with nothing compiled;
   - then, in the browser (`apps/dql-notebook/browser/gate/dbt-sample.gate.ts`):
     - Guided Setup opening the sample as an existing ZLens project (DuckDB
       configured and tested, Refresh dbt data, Finish setup);
     - the quickstart's notebook query;
     - the **Jaffle Growth Review** App and its trust labels;
     - lineage of `monthly_revenue` (dbt source → dbt model → block → App);
     - the `claude-code` AI provider (Settings → AI provider → Anthropic
       Claude → Subscription → Test, save & activate);
     - Ask: a certified answer;
     - two App Ask questions, each of which must carry exactly one kind of
       trust label;
   - then `zlens connect claude-code`, `zlens mcp test` with the workbench up
     (must pass), `zlens doctor` while it runs (no DuckDB lock error, and
     its SQLite native module and DuckDB driver checks pass), and
     `zlens mcp test` with it stopped (must fail and say Not ready).
5. **Warehouse sample** (`duckcode-ai/jaffle-shop-warehouse`, no dbt): the same
   steps without dbt; here `npm run sync` (a warehouse sync) installs the
   DuckDB driver, and its row fails if it did not. In the browser
   (`warehouse-sample.gate.ts`):
   - Guided Setup with Database only;
   - the starter notebook's **Run all**;
   - a certified join in Modeling;
   - the provider;
   - Ask: an AI-drafted answer labelled for review that joins store names and
     saves a draft block;
   - lineage of that draft block back to the warehouse tables, without
     "Compiled from the dbt manifest".
6. **`create-zlens-app`** in an empty folder:
   - `npx create-zlens-app@<version> my-analytics --warehouse duckdb`;
   - checks the generated config, including `allowScripts` for
     `better-sqlite3`;
   - `npm install` (no script blocked), `npx zlens --version`, and
     `better-sqlite3` opens a database;
   - the manual driver install its README gives,
     `npm install --prefix .dql/connectors '@duckdb/node-api@^1.5.6-r.1'`: no
     install script, and the driver loads DuckDB 1.5. (Its printed next steps
     have no driver step: `zlens sync warehouse` installs it.)

The sample's own `@zlens/cli` range is a check of its own. If the range would
not install the packed version (`^0.1.0` never installs 0.2.0), that row
fails, and the gate sets the range to `^<version>` so it can test the rest.

## Where the README is not followed to the letter

- `npm run notebook -- --port <free port>` instead of 3474, so the gate never
  collides with a workbench you are running. `zlens mcp test` then needs
  `ZLENS_RUNTIME_URL`, as `docs/agents` says for a workbench on another
  address.
- Guided Setup's optional AI step is skipped. The provider is set in
  **Settings → AI provider** instead, as `docs/get-started/ai-provider.md`
  does it, so it is its own row.

## Requirements

- Node 20+, git, Python 3.9 to 3.14 (the README's `python3`, or `--python`).
- The `claude` CLI, signed in. The `claude-code` provider runs it. No API keys.
- Playwright's Chromium (`pnpm --filter @zlens/notebook-app exec playwright install chromium`).
- Network access to GitHub, PyPI and registry.npmjs.org.

## Output

Under `--out`:

| Path | What |
|---|---|
| `summary.md`, `summary.json` | The pass/fail table, with commit, version and the PATH entries hidden. |
| `logs/` | Every command, its output and exit code, one file per lane and step. |
| `evidence/<lane>/` | A screenshot (and notes) per browser check, passed or failed. |
| `playwright/` | Traces and failure screenshots from Playwright. |
| `<lane>/dbt/`, `<lane>/warehouse/`, `<lane>/create/` | The folders the quickstart ran in, per npm lane (`system`, `npm12`). |
| `lanes/` | The npm versions the gate installed for its lanes. |

The exit code is 0 only when every row passed.

`--only dbt,warehouse,create` runs a subset.
