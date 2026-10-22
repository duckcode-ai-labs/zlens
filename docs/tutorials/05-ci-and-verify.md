# 05 — CI with `zlens eval`, and what `zlens verify` is for

**Who this is for:** platform engineers wiring ZLens into CI and audits.

**What you'll do:** gate every pull request on `zlens eval`, add golden
questions of your own, and learn which checks belong in CI and which are
local.

**Time:** 15 minutes.

> Setup: a ZLens project tracked in git with at least one certified block that
> has `examples`. The [Jaffle Shop sample](https://github.com/duckcode-ai/jaffle-shop-duckdb)
> is one; the commands below run in its root.

---

## Why gate on `zlens eval`?

`zlens eval` replays every certified block's `examples[].question`, plus any
cases in `eval/*.yaml`, through the same router Ask uses, and scores where each
question went: to a certified block, to generated SQL, or to a refusal.

It builds the manifest from source in memory, reads no warehouse and calls no
model. So it runs on a clean clone: no `*.duckdb` file, no dbt `target/`, no
`dql-manifest.json`, and no API key. It exits **1** when a score is below the
thresholds you set.

---

## Step 1 — Run it locally

```bash
npx zlens eval . --min-route-accuracy 1 --min-refusal 1
```

> **You should see** one line per case, then the scores:
> ```text
>   ✓ [certified] monthly_revenue · How has revenue changed by month?
>   ✓ [certified] monthly_revenue · Show monthly gross revenue and number of orders.
>   …
>   Thresholds
>   --------------------------------------------------
>   --min-route-accuracy 1  (route accuracy 100%)
>   --min-refusal 1  (refusal recall n/a: no case measures this, so it is not applied)
>
>   ✓ PASS — thresholds met.
> ```

Thresholds are shares between 0 and 1, so 90% is `0.9`. A value outside that
range, such as `--min-route-accuracy 90`, is an error (exit 1). A threshold that
no case measures is reported as n/a and is not applied. In the sample,
`--min-refusal` waits for a case with `expectRefuse: true`, which you add in
Step 2.

### When a block example fails

A block example is a promise that the question is answered by that certified
block. Two common reasons it routes to generated SQL instead:

- **The question names a member.** "Give me the complete profile for Matthew
  Meyer." asks for one customer. A certified block runs its SQL as written, and
  `customer_profile` has no `WHERE`, so it cannot filter to one customer. Ask
  answers with generated SQL that uses the block as context. Reword the example
  ("Show customer profiles with lifetime spend and order history.") or move the
  question to `eval/*.yaml` with `expectRoute: generated`.
- **The question asks for a measure the block does not output.** In "Show
  monthly gross revenue and orders.", "orders" is not the block's `order_count`
  output. A count output answers a question that says "how many", "count",
  "number of" or "total" ("…and number of orders.").

The failure line shows what happened, for example
`route expected certified, got generated`. `--format json` adds each case's
route reason in `trace`.

---

## Step 2 — Add golden cases

```bash
npx zlens eval . --init
```

This writes `eval/golden.yaml` with commented examples written for the Jaffle
sample's blocks. Uncomment the ones that fit, swap in your own block names, and
add one case per question your team asks:

```yaml
cases:
  - name: named customer → generated, filter kept
    question: "Give me the complete profile for Matthew Meyer."
    expectRoute: generated
    expectFilters: ["Matthew Meyer"]

  - name: unanswerable refuses
    question: "What is our employee attrition rate?"
    expectRefuse: true
```

Each case can set `expectRoute` (`certified`, `generated`, `missing_context` or
`research`), `expectBlock`, `expectGrain`, `expectRefuse`, the question-plan
checks (`expectMetricTerms`, `expectNoMetricTerms`, `expectFilters`,
`expectNoFilters`, `expectEvidence`) and, for a follow-up, `priorQuestion`.
`zlens eval --help` lists them all. When Ask gets a question wrong, add the
question here before you fix it.

---

## Step 3 — Add the workflow

```bash
npx zlens ci init
```

This writes `.github/workflows/zlens-eval.yml` at the root of the git
repository:

```yaml
name: ZLens eval

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  eval:
    name: ZLens eval
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Routing eval
        run: npx -y --package=@zlens/cli@0.2.2 zlens eval . --min-route-accuracy 1 --min-refusal 1
```

- The CLI is pinned to the version that wrote the file. Run
  `zlens ci init --force` to move to a newer one.
- There is no install step. The sample ships no lockfile (it ignores
  `package-lock.json`), so `npm ci` would fail, and `npx` needs none.
- When the ZLens project is in a subfolder of the repository, the job gets
  `working-directory: <that folder>`.
- The job runs on every pull request. To run it only when ZLens files change,
  add `paths` under `pull_request` using your layout, for example
  `domains/**`, `blocks/**`, `eval/**`, `semantic-layer/**` and
  `dql.config.json` (prefixed with the project folder when it is nested).

Commit the workflow, then make the check required: **Settings → Branches →
Branch protection rules** for `main` → **Require status checks to pass before
merging** → add **ZLens eval**.

---

## Optional — `zlens agent eval` in replay mode

`zlens agent eval` scores the full answer: the route, the trust label, the
SQL and, with `--execute`, the rows. It always drives a running workbench
(`--via runtime`, the default and only driver), so in CI it needs more than
`zlens eval`:

1. **A warehouse.** The workbench answers against your connection. For the
   Jaffle sample, that means building the dbt project first (`dbt seed` and
   `dbt build`).
2. **Recorded cassettes.** Record the suite once against a real provider: start
   the workbench with `ZLENS_EVAL_CASSETTE_DIR=test-cassettes/agent-evals` and
   `ZLENS_EVAL_CASSETTE_MODE=record`, run the suite, and commit
   `test-cassettes/`. Recording needs provider credentials; replay does not.
3. **The workbench in replay mode**, then the suite:

```yaml
      - name: Start the workbench (replay)
        env:
          ZLENS_EVAL_CASSETTE_DIR: test-cassettes/agent-evals
          ZLENS_EVAL_CASSETTE_MODE: replay
        run: |
          npx -y --package=@zlens/cli@0.2.2 zlens notebook . --no-open --port 3474 > workbench.log 2>&1 &
          for i in $(seq 1 60); do
            curl -sf http://127.0.0.1:3474/api/health && exit 0
            sleep 1
          done
          cat workbench.log; exit 1
      - name: Agent eval
        run: >
          npx -y --package=@zlens/cli@0.2.2 zlens agent eval agent-evals.yml
          --runtime-url http://127.0.0.1:3474 --cassette replay
          --max-false-refusal 0.05 --min-refusal-recall 1
```

In replay mode a question whose provider call was not recorded fails; it
never reaches a live model. The workbench makes the provider calls, so the
environment variables above are what make it replay. `--cassette replay`
checks that: when the workbench's `/api/health` reports another mode, the eval
stops before any case runs and prints the command to start the workbench in
replay mode. The `--cassette` check and the mode in `/api/health` are new
after 0.2.2; 0.2.2 does not check the workbench's mode.

`--judge` and `--min-judge-pass` need a live provider, so keep them for a
scheduled, credentialed job rather than a pull-request gate.

---

## What `zlens verify` is for

`zlens verify` recompiles the manifest in memory and compares it with the
`dql-manifest.json` that `zlens compile` wrote in the folder. It is a **local**
check, not a CI gate:

- `dql-manifest.json` is gitignored, and `zlens doctor git-hygiene` flags it
  when it is tracked. A clean clone has none, so `zlens verify` stops with
  "dql-manifest.json not found".
- Running `zlens compile` and then `zlens verify` in the same job always passes:
  it compares a fresh compile with itself.

Use it after `zlens compile` to confirm the manifest your local tools read
(MCP, lineage, the agent index) matches the source:

```bash
npx zlens compile .
npx zlens verify .
```

> **You should see**
> ```text
>   ✓ Manifest verified — no drift between source tree and dql-manifest.json.
> ```

Rename a block without recompiling and run it again:

```bash
sed -i.bak 's/block "monthly_revenue"/block "monthly_revenue_v2"/' \
  domains/commerce/blocks/monthly_revenue.dql
npx zlens verify .
```

> **You should see**
> ```text
>   ✗ Manifest drift detected:
>     - blocks: removed "monthly_revenue"
>     - blocks: added "monthly_revenue_v2"
>
>   Run `zlens compile` to regenerate it.
> ```

Both reports go to stdout; the exit code is **1** on drift. Restore the file
with `mv domains/commerce/blocks/monthly_revenue.dql.bak domains/commerce/blocks/monthly_revenue.dql`.

What it compares, from
[`apps/cli/src/commands/verify.ts`](https://github.com/duckcode-ai-labs/zlens/blob/main/apps/cli/src/commands/verify.ts):

| Check | Drift signal |
|---|---|
| Block, notebook, App, dashboard keys | Added or removed |
| Semantic-layer metric and dimension keys | Added or removed |
| Source keys | Added or removed |
| Per-block SQL | Block SQL changed without recompiling |
| Per-block status | Certification status changed |
| Per-block domain | Domain reassigned |

It does not compare anything else inside a block (description, owner,
examples, outputs), App or dashboard contents beyond their keys, or lineage
edges.

---

## Optional — certify and impact checks (need a warehouse)

These run against your data, so add them only where CI can reach the
connection (for the Jaffle sample, after building the dbt project).

**Certify changed blocks.** Use a git pathspec so the glob matches both
layouts (`domains/<domain>/blocks/` and `blocks/`). `--relative` keeps the
paths relative to the project folder when it is nested:

```yaml
- name: Certify changed blocks
  run: |
    mkdir -p certify-reports
    for blk in $(git diff --name-only --relative origin/main... -- 'domains/*/blocks/*.dql' 'blocks/*.dql'); do
      npx zlens certify "$blk" --format json > "certify-reports/$(basename "$blk" .dql).json"
    done
- uses: actions/upload-artifact@v4
  with:
    name: certify-reports
    path: certify-reports/
```

Fetch enough history for `origin/main...` to resolve (`fetch-depth: 0` on
`actions/checkout`). Each report holds `blockName`, `certified`, `checkedAt`,
the rules that failed (`errors`) or warned (`warnings`), and the test,
invariant and DataLex results. Rules that passed are not listed.

**Impact of a change.** `zlens diff <file> --impact` reads the compiled
lineage, so run `zlens compile` first; without `dql-manifest.json` it prints
the diff and a note, and exits 0. With it, the command exits **1** only when a
changed block invalidates a certified downstream item that
`--write-recertification` did not mark for recertification. Plain
`zlens diff <file>`, without `--impact`, exits 1 on any change.

---

## What you now have

✓ A pull-request gate that replays your golden questions through the router
✓ Golden cases for certified, generated and refused answers
✓ A local check that your compiled manifest matches the source
✓ Optional answer-level and certification checks where CI can reach data

Stuck anywhere? See the [troubleshooting guide](../guides/troubleshooting.md).
