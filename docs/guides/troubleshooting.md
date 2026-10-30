# Troubleshooting + FAQ

Real fixes for the things that bite people first.

---

## Setup

### `zlens` says "command not found"

**In a scaffolded project** the CLI is a local dev dependency, exposed through
npm scripts (`npm run notebook`, `npm run compile`, …). For ad-hoc commands
use `npx`:

```bash
npx zlens --version
npx zlens certify blocks/revenue_by_month.dql
```

If `npx zlens` still fails, re-run `npm install` — the dependency link
probably broke.

**With a global install** (`npm i -g @zlens/cli`), a bare `zlens`
that reports "command not found" almost always means one of three things:

```bash
npx -p @zlens/cli@latest zlens --version   # escape hatch: no PATH needed at all
which -a zlens          # a stale Homebrew / venv / old global copy shadowing it?
hash -r                 # clear the shell's cached path, or just open a new terminal
npm prefix -g           # ensure "<that path>/bin" is on your $PATH
npm i -g @zlens/cli@latest --allow-scripts=better-sqlite3   # a failed earlier install never links the bin
```

The last one is the usual culprit for existing users: before **1.6.30**, a
global install could **fail on Node 23/24**. A
failed `npm i -g` never creates the `zlens` symlink, so the command is missing
even though "install" appeared to run. Reinstalling `@latest` on any Node ≥20
fixes it — see [How do I upgrade ZLens?](#how-do-i-upgrade-zlens) below.

### "ZLens could not load better-sqlite3" (npm 12)

npm 12 blocks a dependency's install script unless `package.json` lists it in
`allowScripts`. `better-sqlite3`, which holds ZLens's local index, downloads
its native binary in that script, so without the entry `npm install` prints
`install scripts blocked because they are not covered by allowScripts` and
every ZLens command that opens the index stops with this message (older ZLens
versions printed "Could not locate the bindings file"). In the project
folder:

```bash
npm install-scripts approve better-sqlite3
npm rebuild better-sqlite3
```

To keep fresh clones working, add the entry to `package.json` (projects from
`create-zlens-app` and the samples already have it):

```json
"allowScripts": {
  "better-sqlite3": true
}
```

The DuckDB driver (`@duckdb/node-api`) has no install script, so it needs no
entry.

A global install has no `package.json`: reinstall with
`npm install -g @zlens/cli --allow-scripts=better-sqlite3`. `npm run doctor`
checks both packages.

### How do I upgrade ZLens?

ZLens is plain npm packages — upgrading is just installing the latest version.

```bash
# Global CLI (npm 12 needs --allow-scripts=better-sqlite3)
npm i -g @zlens/cli@latest --allow-scripts=better-sqlite3 && zlens --version

# Project-local CLI (recommended)
npm i -D @zlens/cli@latest && npx zlens --version
```

You do **not** need a working `zlens` to upgrade, and you do **not** need to
downgrade Node — ZLens installs on Node 20, 22, 24 and 26. If `zlens --version`
still shows the old number afterward, run `hash -r` (or open a new shell) and
check `which -a zlens` for a shadowing copy.

### `zlens --version` works, but `cd dql` says "no such file or directory"

The CLI install only installs the command. It does not create a project folder.
From your dbt repo root, initialize ZLens first:

```bash
zlens init ./dql
cd dql
zlens doctor
```

Use `zlens init .` only if you want ZLens folders directly in the current repo
root.

### "The DuckDB driver in .dql/connectors has no binary for this computer"

The DuckDB driver, `@duckdb/node-api`, gets its binary from a per-platform
optional dependency. Nothing is compiled, and one install works on every Node
from 20 up. The binary is missing when optional dependencies were skipped
(`--omit=optional` or `--no-optional`), or when the `.dql` folder was copied
from another operating system. ZLens reinstalls the driver the next time the
workbench starts or `zlens sync warehouse` runs. By hand:

```bash
npm --prefix .dql/connectors install @duckdb/node-api --include=optional
```

If you used an older ZLens, `.dql/connectors` may still hold the old `duckdb`
package. ZLens installs `@duckdb/node-api` next to it on the next start, and
you can delete `.dql/connectors/node_modules/duckdb`.

### Optional connector package errors

DuckDB and Snowflake drivers are installed project-locally when needed. If the
**Settings → Database** says a driver package is missing, click **Install connector** or
run the printed project-local install command. If a native package fails to
build on a fresh OS install, check Node `20`, `22`, `24` or `26` and local build tools.

```bash
node -v
npm -v
```

Then retry the connector install. For local project dependencies, wiping and
reinstalling can help:

```bash
rm -rf node_modules package-lock.json
npm install
```

(Building the framework repo from source? Use `pnpm install && pnpm -r build`.)

### Preview doesn't open

`zlens preview` opens your default browser. If you're on a headless box or
the open command silently fails:

```bash
zlens preview blocks/revenue_by_month.dql --no-open
```

It still serves on localhost; the URL is printed in the console output.

### "DuckDB file … is in use by another process"

DuckDB lets only one process open a database file at a time. While
`zlens notebook` is running on the project, `zlens certify`,
`zlens model discover --validate`, `zlens model validate-relationship`,
`zlens sync warehouse` and `zlens doctor` send their
read-only queries to it instead of opening the file again, and print
`Running … through zlens notebook (pid …)`. You see this error when the file
is held by something else: a workbench from an older ZLens, a workbench on a
different folder that points at the same file, `dbt build`, or a SQL client.
Stop that process (Ctrl+C in the workbench's terminal) and run the command
again. The workbench shows the same message when another program holds the
file.

### "This database file was written by a newer DuckDB (2.x)"

The full message also shows DuckDB's own words: "Trying to read a database
file with version number 999, but we can only read versions between 64 and
67. The database file was created with an newer version of DuckDB."

ZLens reads files written by DuckDB 1.5 and older. DuckDB 2.0 (Python
`duckdb` 2.0, which `dbt-duckdb` installs unless you pin it, or the 2.0
`duckdb` CLI) writes files that 1.5 cannot open. Stop the workbench, install
DuckDB 1.5 where the file is built, and rebuild the file:

```bash
pip install 'duckdb<1.6'   # in the virtual environment that runs dbt
rm jaffle_shop.duckdb      # your DuckDB file; dbt recreates it
dbt seed && dbt build
```

To keep it pinned, add `duckdb<1.6` to your `requirements.txt`. The samples
pin DuckDB below 2.0 too, and their `./setup.sh` rebuilds a file written by a
newer DuckDB for you.

---

## Authoring saved queries

### `zlens certify` says `tests-pass: ✗` but the data looks right

The certifier runs the saved query against `defaultConnection` from
`dql.config.json` (or the connection you pass with `--connection`). If
your local DuckDB doesn't have the tables but your prod warehouse does,
you'll see different test results. Pin the connection explicitly:

```bash
zlens certify blocks/foo.dql --connection duckdb
```

— and make sure the connection actually contains the tables the saved query
reads (for a dbt project, run `dbt build` first).

### `Block parse error in blocks/foo.dql`

The most common cause is `query = "..."` (single-line) where the SQL
contains characters that need escaping. Use triple-quoted strings:

```dql
query = """
  SELECT 1
"""
```

### Saved query doesn't show up in the manifest

`zlens compile` only scans `blocks/`, `dashboards/`, `workbooks/`, and
`apps/<id>/blocks/` (when configured). If your saved query lives somewhere
else, add the directory to `dql.config.json`:

```json
{
  "extraBlockDirs": ["custom_blocks"]
}
```

### Two saved queries have the same name

The manifest keys by `block.name` (the string after `block "..."`). If
two `.dql` files both declare `block "foo"`, the second one silently
overwrites the first — but `zlens validate` catches it as an error. Run
`zlens validate` early.

---

## Apps + Local Policies

### `zlens app build` says "homepage references unknown dashboard"

Either:

1. The dashboard id in `dql.app.json`'s `homepage` doesn't match any
   `.dqld` file's `id` field, or
2. You renamed a `.dqld` file but kept the homepage id pointing at the
   old name.

Open `apps/<id>/dashboards/*.dqld` and confirm the `id` field matches.

### Persona switcher does nothing

Two common causes:

1. **You're not in the App view.** The persona switcher only renders when
   `mainView === 'apps'`. Click the **Apps** activity bar icon first.
2. **The App has no members.** Open `dql.app.json` — the `members[]`
   array must be non-empty.

Verify on the server:

```bash
curl -s http://127.0.0.1:3475/api/persona | jq
curl -s http://127.0.0.1:3475/api/apps    | jq
```

### Branch viewer sees rows from other branches

`@rls` only narrows when the **saved query** carries the decorator. Confirm:

1. The saved query declares `@rls("branch", "{user.branch}")` (and `@rls("region", …)`).
2. The App has `rlsBindings` mapping `role: "branch_viewer"` → `from: "branch"`.
3. The member's `attributes.branch` is set.

Trace the resolution:

```bash
curl -s http://127.0.0.1:3475/api/persona | jq '.persona.rlsContext'
```

`rlsContext` should show the substituted values. If it's `{}`, the App
binding didn't match the member's roles + attributes.

### `policies[].domain = "*"` doesn't match my saved query's domain

Wildcard `*` matches every domain. If you want "any domain in the cards
org", make policies explicit per domain (`cards`, `cards.fraud`,
`cards.chargebacks`) — the engine doesn't currently parse hierarchical
domains.

---

## Agent

### `zlens agent ask` says "KG not built"

Run the reindex:

```bash
zlens agent reindex
```

That's the build step for `.dql/cache/agent-kg.sqlite`. It's also a no-op
fast on rebuilds because the manifest fingerprint is checked first.

### Provider returns nothing

Check `available()` per-provider:

```bash
node -e "
  const a = require('@zlens/agent');
  for (const name of ['claude','openai','gemini','ollama']) {
    a.buildProvider(name).available().then(ok => console.log(name, ok));
  }
"
```

> If only `ollama` shows `true`, you have no API keys set. That's fine —
> the agent will use Ollama. If `ollama` returns `false`, the daemon
> isn't running. Start it: `ollama serve`.

### Every certified saved query answer cites the same saved query, even when wrong

The FTS5 retrieval threshold is too loose for your domain. Tune in
[`packages/dql-agent/src/answer-loop.ts`](https://github.com/duckcode-ai-labs/zlens/blob/main/packages/dql-agent/src/answer-loop.ts):

```ts
const CERTIFIED_HIT_THRESHOLD = 0.18;   // raise to 0.30 for stricter matching
const HARD_NEGATIVE_RATIO     = 0.5;    // lower to 0.3 to disqualify on fewer downvotes
```

Rebuild and reindex.

### Ask found the right metric but says the governed query failed

Open **How it was answered** on the failed answer. The inspector keeps the exact
plan and, when compilation reached them, the DQL and SQL that were attempted.
Its final section shows a stable failure code and only the repairs allowed for
that failure.

- `RELATION_NOT_FOUND` or `COLUMN_NOT_FOUND`: make the active connection point
  at the warehouse containing the dbt-built relations, run `dbt build` when
  appropriate, then use **Refresh snapshot and prepare retry**. Do not replace
  the governed relation with a similarly named table.
- `PERMISSION_DENIED`: change to an explicitly authorized connection or request
  access. ZLens will not retry another source automatically.
- `DIALECT_ERROR` or `AMBIGUOUS_COLUMN`: open the retained DQL/SQL in Notebook,
  edit the derived copy, and rerun through the normal guards. The source run and
  its receipt remain unchanged.
- `TIMEOUT`: retry the same bounded plan. Research is not started implicitly.
- `RESULT_CONTRACT_MISMATCH`: the query did not return every field promised by
  the plan, so the result cannot be narrated or saved as a complete answer.

For “today” and other relative periods, `latest_complete` also needs a governed
reporting-time dimension and an authorized freshness observation. ZLens performs
one bounded lookup using the already selected semantic metric/time members. A
missing table or permission during that lookup is reported with the same stable
warehouse failure code.

### Ask cannot connect a metric to a customer or time dimension

Check the semantic model rather than adding a broad repository search. The
metric capability must declare its primary entity, additivity, supported
customer/time dimensions and roles, relationship path, time grains, freshness
policy, operations, outputs, and adapter. Domain Skills may choose defaults such
as timezone, completeness, comparison alignment, or ranking period, but they
cannot invent a member, authorize a join, or override an incompatible metric.

Repository text search remains discovery evidence for dbt models and columns
when governed coverage is absent. It can help build a review-required SQL plan;
it never upgrades a grep match into semantic relationship proof.

### Slack bot returns 401 "Bad signature"

In order of likelihood:

1. **Body modification.** Slack signs the raw body. Some reverse proxies
   strip whitespace or rewrite content-type. Bypass them or move the bot
   directly behind ngrok.
2. **Wrong signing secret.** Compare with the **Basic Information** page
   of your Slack app — not the Bot User OAuth Token (which is different).
3. **Stale request.** The verifier rejects requests > 5 minutes old.
   Clock skew is rare but check `date` on your server.

### Slack bot reply never arrives

The bot acks immediately ("Working on it…") then posts the real reply
via `response_url`. If the response URL POST fails (firewall, DNS,
timeouts), Slack will not retry. Check the bot logs for the failed
fetch — `zlens slack serve` doesn't yet have structured logging; pipe to
a file or wrap with `2>&1 | tee dql-slack.log`.

---

## CI / `zlens eval` and `zlens verify`

### `zlens eval` fails in CI: a block example routes to generated

A certified block's `examples` must be questions that block answers as
written. In Ask, an example question asked word for word (case, spacing and
trailing punctuation aside) is answered by its block before any model reads
it; `zlens eval` checks the examples the way the router reads them. The failing line
names what happened, for example `route expected certified, got generated`.
The usual causes:

- The example names a member ("…for Matthew Meyer"). A certified block runs its
  SQL as written and cannot filter to one member, so Ask generates SQL. Reword
  the example, or move it to `eval/*.yaml` with `expectRoute: generated`.
- The example asks for a measure the block does not output. A count output such
  as `order_count` answers "number of orders" or "how many orders", not
  "orders".

Run `zlens eval . --format json` to see each case's route reason in `trace`.
See [CI with zlens eval](../tutorials/05-ci-and-verify.md#when-a-block-example-fails).

### `zlens eval` rejects `--min-route-accuracy 90`

Thresholds are shares between 0 and 1: use `0.9` for 90%. Older versions
silently ignored an out-of-range value, which left the gate off.

### `zlens verify` fails in CI with "dql-manifest.json not found"

`dql-manifest.json` is gitignored, so a clean clone has none. `zlens verify` is
a local check after `zlens compile`; running both in one CI job always passes,
because it compares a fresh compile with itself. Gate pull requests on
`zlens eval` instead (`zlens ci init` writes the workflow).

### `zlens verify` reports drift you did not expect

`zlens verify` lists each difference on its own line, and `--format json`
prints the same list (`{ "ok": false, "drift": [...] }`). It compares block
SQL, status and domain, plus added or removed blocks, notebooks, Apps,
dashboards, metrics, dimensions and sources. Common causes:

- A block was edited, renamed or re-certified after the last `zlens compile`.
- A semantic-layer metric or dimension was added, removed or renamed.
- `dbtImport` filters or the dbt manifest changed the set of sources.

To compare the full manifests:

```bash
mv dql-manifest.json /tmp/old-manifest.json
zlens compile
diff /tmp/old-manifest.json dql-manifest.json | head -80
```

### `zlens certify` is non-deterministic in CI

If a saved query test like `assert row_count >= 100` flickers, the underlying data
is non-deterministic. Either:

1. Pin the test data (commit a small CSV that drives the test).
2. Loosen the assertion (a lower bound rather than an exact `==`).
3. Move volatile expectations to `invariants` (which are documentation for the
   agent, not executable). Note `assert` compares a returned column to a value
   on every row (`assert <column> <op> <value>`) — wrap any aggregation in the
   saved query's SQL and assert on the resulting column.

---

## When in doubt, look at the source

The architecture is small and readable. Bookmark these:

- Saved query lifecycle and certification: [`packages/dql-governance/src/certifier.ts`](https://github.com/duckcode-ai-labs/zlens/blob/main/packages/dql-governance/src/certifier.ts)
- Apps + dashboards parsing: [`packages/dql-core/src/apps/`](https://github.com/duckcode-ai-labs/zlens/tree/main/packages/dql-core/src/apps)
- Persona registry: [`packages/dql-project/src/persona.ts`](https://github.com/duckcode-ai-labs/zlens/blob/main/packages/dql-project/src/persona.ts)
- RLS lowering: [`packages/dql-compiler/src/ir/lowering.ts:440`](https://github.com/duckcode-ai-labs/zlens/blob/main/packages/dql-compiler/src/ir/lowering.ts) (`applyRLSDecorators`)
- Agent answer loop: [`packages/dql-agent/src/answer-loop.ts`](https://github.com/duckcode-ai-labs/zlens/blob/main/packages/dql-agent/src/answer-loop.ts)
- Slack server: [`packages/dql-slack/src/server.ts`](https://github.com/duckcode-ai-labs/zlens/blob/main/packages/dql-slack/src/server.ts)

If you find a bug or rough edge in any of these:

1. File an issue at <https://github.com/duckcode-ai-labs/zlens/issues/new/choose>, or ask in
   [Discussions → Q&A](https://github.com/duckcode-ai-labs/zlens/discussions/categories/q-a) if you're not sure it's a bug.
2. PRs welcome — every package has tests in `*.test.ts` next to the
   source it covers.

---

## Need more?

- The end-to-end story: [tutorials](../tutorials/README.md).
- The roadmap: [ROADMAP.md](https://github.com/duckcode-ai-labs/zlens/blob/main/ROADMAP.md).
