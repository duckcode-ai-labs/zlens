# Agentic analytics answer flow

This is the operating contract for a fast, governed answer in a large ZLens
project. It is deliberately a routing system, not a "generate SQL for every
question" system.

## Answer lanes

1. **Certified block** — execute a suitable certified block first. A block is
   selected only when its measure, grain, filters, and requested shape fit the
   question.
2. **Answer from Metrics** — when no block fits, resolve one or more
   semantic metrics and compile them deterministically. This is a completed,
   governed answer, but it does not certify a newly saved DQL block.
3. **Review-required generated answer** — generate SQL only when the semantic
   layer cannot express the request. Validate it against the selected project
   context, execute only within the normal runtime guardrails, and retain it as
   a draft until reviewed.
4. **Clarify** — ask a concise question only when none of the first three lanes
   can establish a safe measure, entity, or grain.

The UI and API must keep these lanes distinct. In particular, a compiler-owned
semantic query must never be shown as generated SQL merely because the compact
retrieval pack happened to contain dbt objects.

## Fast path

On each question, the provider runner first reuses a warmed project state. Its
source version covers compiled DQL/dbt/semantic inputs and the small governed
skills and hints trees. A concurrent or unchanged request shares the same
index; a relevant source change invalidates it.

The runner builds one compact metadata context pack, performs certified and
semantic resolution, and loads runtime schema only when that compact context is
insufficient. Embedding providers are retained across questions so their cache
is useful. This prevents the previous pattern of rebuilding the project index,
context pack, and embedding cache for every request.

## Retrieval and composition

Metadata retrieval remains the first discovery mechanism. If that compact
index is thin or lacks a relation needed for an answer, the agent can use a
bounded, read-only project-file search over authored DQL, SQL, YAML, JSON, and
Markdown. This provides the same practical source discovery users expect from
an interactive repository assistant without letting a broad recursive tool loop
replace governed retrieval.

Metric matching considers names, governed tags/families, strong descriptions,
and real embedding confidence. It rejects weak one-word or ambiguous matches.
Relevant skills are selected with explicit domain affinity, and only those
selected skills can contribute preferred-block hints.

For multiple metrics, the semantic compiler may use aggregate islands: each
metric is aggregated at the requested grain in its own CTE and the results are
joined only at that grain (or cross-joined for scalar results). This avoids a
raw fact-to-fact join and the fanout errors it creates.

### Analytical composition before execution

For metric questions, ZLens freezes one versioned analytical frame before it
chooses an executable asset. The frame records the metric concept, entity
grain, dimension roles, canonical member values, reporting-time role,
calendar/timezone, completeness policy, comparison alignment, ranking basis,
tie policy, and requested outputs. A deterministic compatibility solver checks
that complete tuple against normalized metric/asset capabilities. It returns
one compatible route, a focused clarification, or a modeling gap; neither the
AI provider nor repository text can authorize a missing relationship or infer
additivity from a column name.

Examples:

- **“What is revenue today?”** binds the governed revenue metric and its
  authoritative reporting-time dimension. `latest_complete` performs one
  route-locked, snapshot-bound freshness lookup before resolving concrete time
  bounds; it never searches for another metric or table.
- **“What is revenue from Zoom customer?”** binds `Zoom` as a canonical member
  filter on the governed customer dimension. It does not add customer grouping,
  and execution requires the metric-to-customer relationship proof.
- **“Current and last-year revenue for the top five customers”** aggregates
  both governed periods at customer grain, aligns them, calculates exact decimal
  deltas and percent change, ranks on the declared current period, applies a
  stable tie policy, and validates every requested output before narration.

The selected plan is immutable. A compatible certified block is adopted as the
complete implementation; otherwise the semantic adapter compiles that same
plan; a plan over raw tables is handed to the AI, which writes review-required
SQL from the schema (amendment A-004). ZLens does not rebuild the question from
scratch after a route has been selected.

### Receipts, explanation, and repair

The execution graph produces a receipt before ZLens creates business prose. Every
number, comparison, rank, freshness statement, and material caveat in the
deterministic narrative points to a result fact and that receipt. Unsupported
numbers or causal claims fail closed.

Successful and failed executable runs expose the same seven-part **How it
answered** view: Plan, DQL, Compiled SQL, Lineage, Trust & evidence, Actual
steps, and Failure & repair. A failed run retains immutable plan/DQL/SQL
fingerprints and a redacted stable error such as `RELATION_NOT_FOUND`,
`PERMISSION_DENIED`, or `RESULT_CONTRACT_MISMATCH`. Repair actions derive a new
artifact: parameter-only reruns can preserve certified identity, DQL edits lose
certification and re-enter validation, and SQL copies are exploratory notebook
work. Permission failure never triggers another route or broader metadata
search.

## Generation guardrails

Generated SQL gets a small, explicit tool surface: contextual metadata search,
schema inspection, bounded source search, and SQL validation. It cannot re-run
the whole answer system recursively. Lookup, multi-entity, and deep questions
also use bounded tool-call budgets; deep investigation remains an intentional,
separate cost choice rather than the default route.

Approved hints are advisory and scoped. They can assist retrieval and
generation, but cannot override a certified block or promote generated SQL.

## Observable quality gates

Every provider-run answer records timings for project preparation, context
retrieval, optional source search, optional schema loading, answer resolution,
and total time. Product evaluation should track at least:

- warm and cold latency by lane;
- percentage of eligible questions answered by certified or semantic lanes;
- semantic compilation success for multi-metric and cross-domain questions;
- generated SQL validation/execution success;
- incorrect-certification rate and review promotion rate.

Before release, run the agent, semantic compiler, CLI runtime, and notebook
tests together. Include fixtures for exact certified answers, description-only
metric matches, multi-metric aggregate-island queries, dbt-only retrieval packs
that still resolve semantic metrics, bounded source search, and generated
fallback/refusal behavior.

## Joins in Ask (amendment A-004)

Ask has two governed sources: certified blocks and the semantic layer, whose
compiler owns its joins. A semantic answer is From Metrics only when every
join its compile takes is a certified relationship (the check
`resolve_analytical_path` applies: certified, valid warehouse proof, safe
fanout). A compile that joins through a draft relationship, or a join no
relationship models, is headed "Answer to review, from governed definitions",
and the answer names the join. Everything else is answered by AI-written SQL,
and the AI writes the joins:

- Relationships declared in Domain Studio are hints in the drafter's context:
  a certified relationship is the preferred join ("certified in Domain
  Studio"), a draft is named "declared, not validated". The answer's proof says
  which relationship the statement joined on.
- Tables that share a key with the reading's tables are shown first; none are
  dropped for failing to join. The drafted statement is still checked before
  it runs: read-only, only the tables it inspected, every stated value applied,
  every required filter present, and a join key that repeats on both sides
  under an aggregate is refused.
- Domain Studio's Validate and certification (REL-002, REL-005) are unchanged
  and govern how a relationship becomes certified. They do not gate AI-written
  SQL; they decide whether a semantic answer that joins is From Metrics.
