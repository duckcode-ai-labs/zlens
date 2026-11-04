# Domain modeling and governance

## One analytical model, two ownership layers

The Domain Model is a single user-facing graph. Its nodes combine read-only dbt
provenance with a sparse DQL analytical overlay; this is not a separate
conceptual/logical/physical modeling product. The UI distinguishes ownership
within the same model:

- **dbt implementation:** relation, columns, types, descriptions, tests,
  transformation DAG, MetricFlow;
- **DQL analytical context:** business identity, optional asserted grain,
  concepts, relationship safety, contract/export policy, lifecycle, evidence.

`model.dql.yaml` is the default source for bindings and relationships. Split
legacy files remain readable, but the UI presents one model and offers a
lossless consolidation migration.

### Focused Model Areas (OSS v1)

Large domains can be authored as several small, reviewable Model Areas without
creating competing models. Each `modeling/areas/<area-id>.dql.yaml` carries a
short business scope, example questions, owned entities/relationships, and
optional read-only boundary-entity references. The compiler merges every Area
and legacy/default source into one qualified domain graph. A relationship is
owned by its active Area and may cross Areas; cross-domain policy remains the
same explicit relationship/export/import/contract path. Area selection boosts
retrieval only after the domain and lifecycle gates have passed.

An Area marked `shared: true` is the Shared area (model-at-scale design S1):
tables several Areas read and none owns, such as accounts and dates. It is
modeled once, in its own `shared` Domain, and other Areas list its tables as
boundary references instead of copying them. `zlens model draft` places each
drafted table in the Area the domain finder proposes, and a table several
Domains read in the Shared area.

## Entity bindings

Each binding resolves a qualified entity to one dbt unique ID. It may add a
business name, business context, concepts, analytical role, and grain assertion
only where dbt/MetricFlow is insufficient. Binding validation checks referenced
columns against the current snapshot without copying them into source.

## Relationship proof

A relationship requires:

- qualified endpoints and exact column pairs;
- cardinality (`one_to_one`, `one_to_many`, `many_to_one`, `many_to_many`, or
  `unknown`);
- fanout policy (`safe`, `dedupe_required`, `attribution_required`, or
  `forbidden`);
- lifecycle, owner, evidence, validation query/test fingerprint, and dependency
  fingerprint;
- cross-domain import/export reference when endpoints cross domains.

Automatic generated joins require all of the following (`REL-002`):

1. relationship status is `certified`;
2. dependency and evidence fingerprints match the active snapshot;
3. all relationship key columns still exist and satisfy the recorded proof;
4. evidence has not expired and the validation query has not changed;
5. cardinality/fanout is automatically safe for the requested aggregation;
6. any cross-domain export/import and purpose are certified and compatible.

Unknown/many-to-many/attribution-required edges may remain visible but cause a
clarification or refusal. A dbt DAG edge never supplies join proof (`REL-001`).

### Ask answers over raw tables (amendment A-004, 2026-09-11)

Owner direction: **certified blocks and semantic models are governed; dbt
models, columns, joins and SQL over them are AI free-form.** DQL does not judge
whether a raw table or a join is "right", because nobody vouched for it.

- Ask's cascade is certified block → semantic layer → AI-written SQL. There is
  no governed tier over raw tables; an answer whose SQL the AI wrote is always
  review-required and says so, whatever relationships it used.
- A reading is governed only when every ref is a certified block or an object
  authored in a semantic layer. A dimension a provider built from dbt model
  columns because no semantic layer exists is a column.
- Declared relationships are **hints** for AI-written SQL: a certified one is
  offered as the preferred join, a draft as "declared, not validated", and the
  answer discloses a relationship it joined on. They never admit or prove a
  join in Ask. **Amended by A-005 (2026-09-15):** a certified relationship's
  keys bind a statement that joins its two tables — other keys get one repair,
  then a refusal (`REL-006`) — and every AI-written join is recorded with the
  relationship it followed, or none.
- Only security policy stops AI-written SQL (a question that contradicts a
  required filter; a required filter the drafted statement leaves out). Domain
  boundaries choose which tables the drafter sees first; they are not a join
  gate in Ask.
- REL-002, amendment A-003 and REL-005 below continue to govern Domain Studio:
  validation, evidence, certification and the conditions under which a
  relationship is certified. They no longer gate Ask answers.

### Join authority (amendment A-003, 2026-09-09)

A generated join has exactly one of three authorities, recorded on every
executed join step and in the run receipt (`JoinAuthorityV1`):

| Source | Authority | Promise |
| ------ | --------- | ------- |
| Semantic layer (`semantic_layer`) | compiler-owned | The dbt/MetricFlow or native semantic model declares the join; DQL does not re-certify it. |
| Certified DQL relationship (`dql_relationship`, `certified`) | the six conditions above (`automaticJoinAllowed`) | Business meaning, direction, fanout, freshness and any cross-domain interface are certified by a human. |
| Warehouse proof (`warehouse_proof`, `proven_default`) | structural only | On this snapshot and execution target the join key is unique in the label relation and every fact key is present there, so the join neither multiplies nor drops rows. **It does not establish that the keys identify the same business entity, that historical mappings hold, or that cross-domain use is permitted; those remain certification.** |

`proven_default` is admitted only when all of the following hold:

1. the two relations resolve to **one** domain, or the project declares no
   domains at all; an endpoint with unknown or ambiguous domain membership (no
   modeled entity, or entities in several domains bound to one relation) is a
   modeling gap, never a proof — missing domain information never widens
   eligibility;
2. endpoints in different domains are never probed: cross-domain use requires
   the complete export/import/purpose/contract/certified-relationship chain
   (`REL-003`, `CONTRACT-001`), and a blocked import, mismatched purpose or
   stale route is refused before any warehouse statement runs;
3. a declared draft relationship, when one exists, supplies the keys, direction
   and cardinality (a declared `many_to_many` or `attribution_required` is
   never probed as `many_to_one`); with no draft the probe runs fact → label
   only, on key columns whose names match on both sides;
4. the evidence is fresh: it carries `checkedAt`, the execution-target identity,
   and a data-generation token where the driver offers one; execution authority
   requires the token to match and `checkedAt` to be within the configured
   bound (`agent.relationshipEvidenceTtlHours`, default 24). Expired or changed
   evidence requires another probe. Persisted evidence remains available for
   review and certification after it has lost execution authority.

Every `proven_default` join is disclosed in the answer in plain words and shown
in the trust facet as "join: proven, not certified". The emitted evidence has
the same shape as Domain Studio validation evidence, so certification can reuse
it without re-running the proof.

**Validation and certification are distinct actions.** Validation gathers
evidence — from Domain Studio's Validate action or from Ask's warehouse proof —
and can attach it to a draft. Certification is a separate, explicit human
promotion that reuses that evidence. Asking a question never certifies anything
(`REL-005`).

## Relationship authoring UX contract

Users drag from a source column handle to a target column handle. The UI creates
a draft edge and opens a compact inspector. It pre-fills only evidence-backed
values. Required choices are presented progressively: relationship meaning,
cardinality/fanout, evidence/validation, and certification workflow. Handles,
PK/unique/not-null/foreign-key indicators, and source ownership remain visible
without clipping at all supported zooms. Entity boxes are freely movable,
resizable, auto-layoutable, collapsible, and persisted as a separate layout so
visual movement never changes semantic source.

## Contracts, interfaces, and conformance

- **Interface:** the narrow provider export/consumer import boundary: entity,
  keys, dimensions/metrics/blocks, filters, purpose, consumers,
  classification, owner, version, lifecycle.
- **Contract:** the runtime promise for an analytical asset: required inputs,
  grain, allowed filters, output semantics, owner, freshness, and evaluations.
- **Conformance:** an assertion that identities/dimensions represent the same
  concept, with an explicit reconciliation rule.

These are executable readiness gates, not documentation tabs. A failed required
evaluation makes the dependent relationship/asset unavailable to certified
routing. The UI leads with plain-language readiness and reveals source details
on demand (`CONTRACT-001`).

## Skills and terms

Domain skills specify intent examples, vocabulary, policies, ambiguity rules,
tool guidance, exclusions, and evaluation links. Global skills specify reusable
workflow/tool technique and cannot override domain safety. A domain skill is
selected only when the active/allowed domain matches and evidence is fresh.
Skills may optionally name focused Model Areas; that further narrows ranking
inside their already-authorized domain and never grants context outside it.
`exclusions` reduce or veto a match and are never indexed as positive search
tokens (`SKILL-001`, `SKILL-002`).

## Lifecycle

All authored semantics use `draft → evaluated → reviewed → certified`, plus
`deprecated` and computed `stale_certification`. AI, import, migration, and
warehouse proof can attach evidence or advance evaluation results but cannot
perform the human review/certification transition; a warehouse proof gathered
while answering a question attaches evidence to the draft exactly as Domain
Studio's Validate action does, and nothing more (`REL-005`). Corrections enter the same
draft/evaluation/review path before they become approved hints.

## Lineage

End-to-end lineage keeps edge types distinct: dbt transformation, DQL entity
binding, analytical relationship, contract/interface dependency, block/view
consumption, notebook/app consumption, and answer/tool execution. A user and an
agent can trace an answer to exact source paths, proof, snapshot, and lifecycle.
