# RFC 0002: dbt-first domain modeling for ZLens

| Field              | Value                                                |
| ------------------ | ---------------------------------------------------- |
| **Author(s)**      | @KKranthi6881                                        |
| **Status**         | Accepted for implementation                          |
| **Created**        | 2026-07-10                                           |
| **Targets**        | DQL `>= 2.0` (opt-in in the v1 compatibility window) |
| **Discussion**     | TBD                                                  |
| **Implementation** | `codex/dql-2-dbt-first-modeling`                     |
| **Supersedes**     | The DataLex federation model for analytics modeling  |

## Summary

DQL 2.0 makes DQL the single open-source, dbt-first governed analytics
workspace. dbt remains the authoritative owner of physical models, columns,
tests, descriptions, model-level lineage, and MetricFlow formulas. DQL adds a
_small analytical overlay_: domain selection, business identity where dbt does
not express it, explicit relationship safety, cross-domain contracts,
conformance rules, certified blocks, notebooks, stakeholder apps, skills,
evaluations, and approved learning hints.

This is not a replacement modeling language and it is not a second copy of
`schema.yml`. A DQL v3 manifest references dbt unique IDs and artifact
fingerprints; it never serializes a parallel catalog of dbt columns,
descriptions, tests, or metric formulas. The result is one repository and one
compile/run/manifest story from dbt transformation to trusted stakeholder
answers.

## Motivation

Separate DataLex and DQL repositories make a coherent product harder to
understand, adopt, govern, and evaluate. In particular, a separate business
model that mirrors dbt models creates a predictable failure mode: two schemas
drift while an agent treats either as truth. The buyer must also learn an
additional product before receiving the visible value of DQL blocks, notebooks,
apps, lineage, and Ask AI.

Analytics agents need more than a dbt DAG. A DAG says that one model is built
from another; it does not prove a safe analytical join, a cardinality, a
fanout policy, an attribution rule, a cross-domain export boundary, or the
business definition that may be certified. Those facts belong in DQL, adjacent
to the analytical artifacts that consume them.

The design therefore has two non-negotiable truths:

1. **dbt owns physical and MetricFlow truth.** DQL reads dbt source paths,
   descriptions, tests, catalog types, lineage, semantic metadata, and
   fingerprints from artifacts.
2. **DQL owns governed analytical intent.** A relationship is usable only
   after an explicit DQL policy says how it may be used. dbt lineage alone is
   never join proof.

## Terminology and ownership

| Object                                                                   | Owner            | Stored as                    |
| ------------------------------------------------------------------------ | ---------------- | ---------------------------- |
| Model SQL, physical columns, descriptions, tests, dbt model lineage      | dbt              | dbt project + artifacts      |
| MetricFlow semantic model, measures, dimensions, metrics and formulas    | dbt / MetricFlow | dbt YAML + semantic artifact |
| Domain, subdomain and microdomain selection                              | DQL              | Domain Package               |
| dbt entity binding, grain declaration when not supplied by dbt           | DQL              | sparse overlay               |
| Relationship/cardinality/fanout and cross-domain export policy           | DQL              | Domain Package               |
| Business contract, conformance rule, skill, evaluation and approved hint | DQL              | Domain Package               |
| Reusable analytical block, notebook, business view and stakeholder app   | DQL              | DQL project                  |

A **Domain Package** is a Git-versioned folder under `domains/`. It groups a
domain's analytical intent without creating a copy of dbt source metadata:

```text
domains/
  commerce/
    domain.dql
    modeling/
      model.dql.yaml
      layouts/
    terms/
    blocks/
    notebooks/
    views/
    skills/
    evaluations/
    tests/
    apps/
  growth/
    domain.dql
    modeling/
      model.dql.yaml
    blocks/
    views/
```

Domain nesting is organizational and retrieval-scoping metadata. It does not
create an implied relationship or permission to join data across packages.

## Detailed design

### 1. Configuration and lifecycle

Manifest v3 is deliberately opt-in during the compatibility window:

```json
{
  "project": "commerce-analytics",
  "manifestVersion": 3,
  "modeling": { "mode": "dbt-first" },
  "dbt": {
    "projectDir": "../dbt",
    "manifestPath": "target/manifest.json"
  }
}
```

Projects without both settings compile exactly as manifest v2 projects. DQL 2.0
may make this configuration the default for a newly initialized project, but it
must not silently turn a v2 project into v3. `dql compile` reports the selected
mode, source artifact paths and the fingerprint that governs stale-state
diagnostics.

### 2. Artifact provenance, not source duplication

The compiler reads `manifest.json`, `catalog.json` and, when present,
`semantic_manifest.json`. v3 emits a compact `dbtProvenance` index keyed by dbt
`unique_id`. Each entry includes the artifact path, package/name/resource type,
source file path, artifact fingerprints, relation identifier, and references to
available catalog and MetricFlow records. It must not emit copied `columns`,
`description`, `tests`, compiled SQL, or MetricFlow expressions.

The UI loads dbt-owned details on demand from the configured artifacts. It
labels provenance as **dbt-owned** and makes it read-only. A request to change
one of those fields opens a previewable patch to the original dbt YAML; saving
that patch is an explicit source-control action, not a DQL overlay write.

### 3. Sparse overlay source

Each Domain Package has one logical Domain Model. New projects store its sparse
overlay in `model.dql.yaml`; large projects may split sections into multiple
YAML files without changing the compiled graph. The source grammar is versioned
and parsed by the compiler; the manifest is the generated result. A
representative package:

```yaml
# domains/commerce/modeling/model.dql.yaml
entities:
  - id: commerce.orders.order
    dbt_model: model.jaffle_shop.fct_orders
    domain: commerce.orders
    grain: order_id
  - id: commerce.customers.customer
    dbt_model: model.jaffle_shop.dim_customers
    domain: commerce.customers
    grain: customer_id
relationships:
  - id: order_to_customer
    from: commerce.orders.order
    to: commerce.customers.customer
    keys: [{ from: customer_id, to: customer_id }]
    cardinality: many_to_one
    fanout: safe
    status: certified
    owner: analytics@company.test
```

The UI and compiler treat these sections as one model. Existing
`entities.dql.yaml`, `relationships.dql.yaml`, `interfaces.dql.yaml`, and
`contracts.dql.yaml` sources remain supported for compatibility and optional
large-domain decomposition.

An entity binding is valid only if its `dbt_model` resolves to a dbt unique ID.
`grain` is optional when trustworthy dbt/MetricFlow identity metadata exists;
when declared in DQL it is an analytical assertion, not a copied column
definition. Relationships must name endpoints, key pairs, cardinality,
fanout policy and lifecycle status. A relationship with unknown cardinality,
many-to-many cardinality, or `fanout: attribution_required` cannot be used for
automatic generated joins.

### 4. Cross-domain contracts and conformance

Cross-domain joins require a certified relationship plus a certified provider
export and consumer import. The relationship declares `crossDomain: true` and
the exact import reference; the exporting domain declares the narrow entity,
keys, metrics, blocks, dimensions, filters, purposes, consumers, classification,
and contract version it exposes.
A parent domain does not automatically export all child-domain data.

Conformance declarations state that two entities represent the same governed
business concept and name the reconciliation rule. Contracts may bind a
certified block to inputs, grain, allowed filters, output semantics, owner and
evaluation requirement. Rules are reusable assertions and do not replace dbt
tests: dbt tests validate transformed data, while DQL rules validate analytical
use, such as a forbidden many-touch attribution join.

### 5. Staleness and determinism

The compiler computes a stable fingerprint from the relevant dbt node identity,
selected identity/grain metadata, relation aliases, and the relevant catalog or
semantic artifact records. A relationship or contract that depends on a
changed key/grain binding receives `stale_certification`; certification is never
silently preserved. Fingerprints, package source paths, and the complete
serialized v3 manifest are deterministic. Runtime build time belongs in
ignored cache state, not source truth; v3 emits a stable epoch `generatedAt`.

Compilation may produce diagnostics but must not mutate source files. A stale
relationship is retained for review and excluded from certified routing.

### 6. Governed answer cascade

Ask AI uses v3 in this order:

1. execute a compatible certified DQL block;
2. compose a compatible MetricFlow query from dbt semantic metadata;
3. generate governed SQL only when every required entity/relationship is
   certified and fanout-safe;
4. request an attribution policy or refuse when a required edge is ambiguous,
   unsafe, stale, unexported, or many-to-many.

dbt lineage may improve retrieval and explain upstream provenance. It is never
used to infer relationship cardinality or a join condition. A question that
uses raw `campaign_touches` with orders must therefore request a stated
attribution rule rather than silently multiply revenue.

Corrections create a draft suggestion. A required evaluation and review must
complete before the correction becomes an approved hint retrievable by Ask AI.
Neither migration nor agent learning auto-certifies a relationship, block,
contract, or hint.

### 7. DataLex migration

`dql migrate datalex` reads a legacy DataLex manifest without making it a
runtime dependency. It matches legacy objects to dbt unique IDs using an
explicit ID first, then unambiguous relation/name evidence. For each object it:

- drops mirrored dbt facts and reports them as intentionally omitted;
- converts DataLex-only business semantics into a draft sparse overlay;
- writes a suggested dbt YAML patch when DataLex diverges on dbt-owned fields;
- reports unmatchable or lossy objects explicitly; and
- preserves lifecycle status without upgrading anything to certified.

The migration output is deterministic and idempotent. Re-running it changes no
files when source artifacts are unchanged.

### 8. UI and API surface

The single **Domains** workspace presents package overview, relationship graph,
relationships, interfaces, contracts, quality, and **dbt-owned provenance**.
It supports source-previewed package edits, warehouse proof, stale diagnostics,
and lineage that distinguishes dbt transformation edges from DQL analytical
relationship edges. Context and modeling are not separate navigation roots.

Existing DQL Cloud embed selectors, token names and `dql-theme` persistence
remain unchanged. DQL owns the functionality; Cloud may reskin the existing
embedded surface only.

## Backward compatibility

Manifest v2 remains supported for two consecutive DQL majors after v3 ships.
V2 projects retain current defaults and APIs. Consumers must branch on
`manifestVersion` and ignore v3-only fields. Manifest v3 is enabled only by the
explicit configuration above; DQL will provide `dql migrate manifest` to add it
when a project is ready.

The legacy `datalex` configuration remains readable only for the migration
window. It is never required to compile or run a dbt-first DQL project.

## Alternatives considered

**Keep DataLex and DQL as two products.** Rejected for analytics modeling:
the two-repository mental model has lower adoption and mirrors dbt facts.

**Copy dbt `schema.yml` into DQL.** Rejected because every copied description,
column or test creates a drift surface and makes source-of-truth ambiguous.

**Infer joins from dbt DAGs and shared column names.** Rejected because neither
lineage nor lexical similarity proves cardinality, policy or fanout safety.

**Move transformation modeling into DQL.** Rejected: dbt remains the execution
and data-quality system of record for transformation.

## Adoption signal

The design is successful when a new user can create a domain package, compile
dbt provenance, certify a safe relationship and serve a stakeholder app from
one repository; when a changed dbt grain reliably makes the affected DQL
certification stale; and when agent evaluations prefer safe certified paths and
decline unsafe fanout questions instead of fabricating joins.
