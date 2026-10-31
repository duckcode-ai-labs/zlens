# 04 — Agentic analytics

!!! warning "Archived page"
    This page was written for an earlier version of ZLens and may not match the
    current product. See [About the archive](../archive.md) for the current page.

**Who this is for:** anyone who wants AI to answer data questions **from
governed blocks**, not from improvised SQL.

**What you'll do:** build the local knowledge graph, ask questions through
the agent, watch the graduated-trust model route between certified blocks
and flagged proposals, promote a good proposal to a certified block, generate
a local App package from a prompt, and connect the MCP server so Claude/Cursor
can do the same.

**Time:** 25 minutes.

> Setup: continues from [03 — Dashboards & Apps](./03-dashboards-and-apps.md).
> You'll need one LLM provider: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
> `GEMINI_API_KEY`, or a local [Ollama](https://ollama.com) daemon
> (`ollama pull llama3.1`). Keys can also be set in the notebook's
> **Settings** page; they're stored locally with `0600` permissions.

---

## The graduated-trust model

The agent never silently invents SQL. Every answer is routed through tiers:

| Tier | Source                                                                                                                                            | Label                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1    | A **certified DQL artifact** exactly matches the question: executable blocks for direct KPI/saved-block answers, or business terms/views for definition and context answers | ✓ Certified                  |
| 2    | No exact match, or the user asks for a named entity, custom filter, ranking, breakdown, comparison, drill-through, or different grain — the agent proposes SQL grounded in business context, dbt, semantic metadata, and runtime schema, saved as a **draft** | ⚠ Uncertified                |
| 3    | Not answerable from the project                                                                                                                   | Refusal, with what's missing |

Tier-2 drafts land in `domains/<domain>/blocks/_drafts/` in domain-first
projects, or `blocks/_drafts/` in legacy projects, so popular questions become
candidates for certification — that's the promotion loop.

Follow-up questions keep the same trust model. If a user asks "drill into
Enterprise last week" after a certified revenue answer, the agent uses the
prior answer as context, searches for a distinct certified drilldown block
first, and only then creates a review-ready draft. It does not silently reuse
the top-level block or mark generated drilldown SQL as certified.

The same rule applies to single-customer or single-user questions. A certified
`total_revenue` block can ground the business meaning of revenue, but a question
like "what is revenue for Alice Johnson?" is a custom filter and should produce
review-required SQL unless a certified block already covers that exact grain.

---

## Step 1 — Build the knowledge graph

```bash
zlens agent reindex
```

> **You should see** a node/edge count — your business terms, business views,
> certified blocks, dbt models, metrics, and dimensions indexed into a local SQLite FTS5 knowledge graph
> at `.dql/cache/agent-kg.sqlite`. Nothing leaves your machine except the
> LLM calls you configure.

---

## Step 2 — Ask a question that hits a certified block

```bash
zlens agent ask "how has revenue trended by month?"
```

> **You should see**
>
> ```text
> ✓ Certified
> Answered from block: revenue_by_month (revenue · certified)
> ```
>
> followed by the result rows. The `llmContext`, `examples`, attached `terms`,
> and related `business_view` context you wrote earlier are what made retrieval land.

Inspect the routing decision:

```bash
zlens agent ask "how has revenue trended by month?" --format json | jq '.kind'
```

> **You should see** `"certified"`.

---

## Step 3 — Ask something no block covers

```bash
zlens agent ask "what share of orders are food vs drink?"
```

> **You should see** the answer clearly labelled **Uncertified**: the LLM
> proposed SQL against the dbt `orders` mart (`is_food_order` /
> `is_drink_order`), and the proposal was saved as a review draft.

List accumulated proposals:

```bash
find domains blocks -path "*/_drafts/*.dql" 2>/dev/null
```

Questions that get asked repeatedly accumulate in `_drafts/` — that's your
prioritized review queue for what to certify next.

When several certified blocks repeat the same metric expression or filtered
definition, the local runtime can propose a semantic-layer composting changeset:
draft metric YAML under `semantic-layer/metrics/_drafts/` plus a PR-body summary
with the donor blocks that proved the pattern. The preview endpoint is
read-only (`/api/propose/composting`); the generate endpoint writes only selected
candidate ids (`/api/propose/composting/generate`). These drafts are still
human-reviewed and start with `status: draft`. A draft answers no question:
Ask, `query_semantic_model` and the semantic panel read only metrics outside
`_drafts/`, and MCP `list_proposals` lists the drafts for review.

Measure the follow-up path with an eval suite:

```bash
zlens agent eval docs/guides/agent-evals.yml --format json
```

> **You should see** certified hit rate, generated follow-up pass rate, safe
> refusal rate, wrong-certified count, draft capture count, and context size
> metrics. JSON output also includes a per-case trace for context selection,
> follow-up rewrite/carry, lane routing, validation, execution, draft capture, and scoring. Add
> `--execute` when a local runtime is running and you want bounded SQL previews
> compared against expected rows. Add `--save` when eval-generated drafts should
> be written to the local draft queue; otherwise eval reports the draft path
> without mutating the project. For tool-observed flows, add
> `expected.minToolCalls` to a case so a deep/research eval fails when the
> provider loop returns without using the governed tools; use
> `--min-tool-requirement 1` to make those tool-observation cases a hard gate.

---

## Step 4 — Promote a good proposal to a certified block

Review the draft like any code: open it in Block Studio, fix the SQL if
needed, add `owner`, `llmContext`, and `tests`, then run it through the same
gate as tutorial 02:

```bash
zlens certify --from-draft domains/<domain>/blocks/_drafts/<draft-file>.dql
```

> **You should see** the rule table go green and the block land in the domain
> block folder as `certified`. Re-run `zlens agent reindex`, ask the same
> question again, and the answer is now **✓ Certified** — the loop is
> closed.

Feedback tunes retrieval over time:

```bash
zlens agent feedback up --question "monthly revenue" --block "block:revenue_by_month"
```

Follow-up drilldowns use the same loop:

```bash
zlens agent ask "drill into Enterprise last week"
```

> **You should see** either a certified drilldown block, if one exists, or an
> **Uncertified** draft proposal tagged for review. Repeated drilldown asks
> make the draft a stronger certification candidate.

---

## Step 5 — Generate a local App from a prompt

The OSS app builder drafts an App from certified blocks. It does not generate
hidden React or bypass certification state:

```bash
zlens app generate "Build a weekly revenue health app for the COO"
```

> **You should see** `✓ Created AI-assisted local App draft` with its draft
> id and `Project source: unchanged`. The draft is stored locally, not as
> files under `apps/`.

Certified blocks become certified dashboard tiles. Missing or AI-created
sections become text/draft placeholders with review tasks.

Run `zlens notebook`, open **Apps**, and continue the draft under
**Not published yet**. Publishing it writes `apps/<app-id>/` with
`dql.app.json` and its `.dqld` pages, ready for Git review. Then build the
App manifest:

```bash
zlens app build
```

---

## Step 6 — Connect an external AI agent

The same graduated-trust loop is exposed to any MCP client (Claude Code,
Claude Desktop, Cursor, Codex):

```bash
zlens mcp test
zlens connect claude-code
# or: zlens connect codex
# or: zlens connect all
```

`zlens connect claude-code` writes project-local `.mcp.json` plus `CLAUDE.md`.
`zlens connect codex` writes project-local `.codex/config.toml` plus `AGENTS.md`.
Full setup for every client is in [Connect an AI agent (MCP)](../agents/index.md).

The server exposes workflow tools such as `inspect_dql_project`, `ask_dql`,
`query_via_block`, `query_via_metadata`, `build_dql_block`, and
`build_dql_app`. Ask your agent a revenue question and it answers **from your
certified blocks** when the block grain fits, citing them — and files drafts
when it has to generate a deeper or different-grain answer.

---

## What you now have

✓ A local knowledge graph over blocks, dbt models, and metrics
✓ Agent answers that are certified-first, flagged when improvised
✓ The promotion loop: draft → review → certify → re-ask → certified
✓ A local generated App package with certified tiles and draft review tasks
✓ An MCP server giving Claude, Codex, Cursor, and other agents governed access to your analytics

[Continue to tutorial 05 — CI with `zlens eval` →](./05-ci-and-verify.md)
