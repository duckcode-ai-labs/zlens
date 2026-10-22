# ZLens Tutorials

!!! warning "Archived page"
    This page was written for an earlier version of ZLens and may not match the
    current product. See [About the archive](../archive.md) for the current page.

Hands-on walkthroughs that take you from a plain dbt project to certified
blocks, dashboards in an App, agent answers, and a CI gate.

Every tutorial works on **your own dbt repo**. The ZLens repo stays
product-focused; the complete worked example lives in the separate
[duckcode-ai/jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb)
repo.

## Reading order

1. **[01 — Getting started](./01-getting-started.md)** — add ZLens to a dbt
   repo, sync the dbt DAG, open the notebook.
2. **[02 — Authoring blocks](./02-authoring-blocks.md)** — write a certified
   block on top of a dbt model: SQL, metadata, tests, the certification gate.
3. **[03 — Dashboards & Apps](./03-dashboards-and-apps.md)** — compose
   certified blocks into a dashboard page inside an App.
4. **[04 — Agentic analytics](./04-agentic-analytics.md)** — the knowledge
   graph, governed agent answers, the uncertified → certified promotion loop,
   and the MCP server.
5. **[05 — CI with `zlens eval`](./05-ci-and-verify.md)** — gate pull
   requests on the routing eval, and check the local manifest with
   `zlens verify`.

## End-to-end Example

Use
[duckcode-ai/jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb)
when you want a complete dbt + ZLens project to explore. It is already a ZLens
workspace, so you do not run `create-zlens-app` in it. Follow
[its README](https://github.com/duckcode-ai/jaffle-shop-duckdb#readme) (or the
[Quickstart](../get-started/index.md)): build the dbt project, install ZLens
into the sample's own workspace, and take the tour of its domain, certified
blocks, App, lineage and Ask.

Stuck? See the [troubleshooting guide](../guides/troubleshooting.md).

## Mental model in one paragraph

dbt models your warehouse; ZLens governs what happens after. Analysts author
**certified `.dql` blocks** (SQL + governance metadata + tests) on top of dbt
models. **Apps** bundle dashboard pages and notebooks into a consumption
surface for a domain. `zlens compile` writes `dql-manifest.json`, which powers
**lineage** (`source → dbt model → block → dashboard → App`), the local
**knowledge graph**, and the **agent**: it retrieves certified blocks first;
if nothing matches, an LLM proposes SQL marked *Uncertified* that analysts
review and certify back into blocks. **`zlens eval`** replays your golden
questions through the router so CI can gate changes.

If you'd rather skim the architecture first, jump to
[../architecture/overview.md](../architecture/overview.md).

## Conventions

- Code blocks fenced with **`bash`** are commands you run; the prompt is
  implied.
- Code blocks fenced with **`text`** are screen output you should see.
- File-content blocks are labelled with their **path as a comment on the
  first line** so you can copy them as-is.
- **"You should see"** boxes describe the expected outcome of a step. If you
  don't see it, jump to the
  [troubleshooting guide](../guides/troubleshooting.md).

Ready? [Start with tutorial 01 →](./01-getting-started.md)
