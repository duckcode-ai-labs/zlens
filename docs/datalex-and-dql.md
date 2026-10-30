# Modeling and Domain Packages

ZLens is the open-source workspace for governed analytics: it connects your
warehouse, and dbt and MetricFlow when you use them, to analytical blocks,
notebooks, business views, stakeholder apps, lineage, Ask AI, evaluations,
and approved learning hints.

The **Modeling** page holds the entities (one per table or dbt model), the
relationships between them, and the domains that own them. Ask relies on
these relationships when it writes SQL.

## Modeling modes

A project models its data in one of three ways, set by `modeling.mode` in
`dql.config.json` (with `"manifestVersion": 3`):

| Mode | Entities bind to | Use it when | How to set it up |
|---|---|---|---|
| `dbt-first` | dbt models | You have a dbt project | `zlens init` in a dbt repo, or **Settings → Project & dbt** |
| `warehouse-first` | your database's own tables | You have no dbt | `zlens init --warehouse-first`, or **Modeling → Model my warehouse without dbt** |
| `hybrid` | dbt models and warehouse tables | dbt covers some schemas, not all | Apply a dbt project to a warehouse-first project, or set `"mode": "hybrid"` |

The rest of the page, Domain Packages and how Ask uses relationships, is the
same in every mode. The [warehouse-first](#warehouse-first-model-your-database-without-dbt)
and [hybrid](#hybrid-dbt-plus-schemas-dbt-does-not-cover) sections below say
what differs without dbt.

## dbt-first: one source of truth, one sparse overlay

In dbt-first mode, **dbt owns physical modeling**. ZLens does not replace dbt and does
not maintain a second `schema.yml`.

| Concern                                                         | Owner            | ZLens behavior                                                     |
| --------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| Model SQL, columns, descriptions, dbt tests                     | dbt              | Read from dbt artifacts; edit through a previewed dbt YAML patch |
| Transformation lineage                                          | dbt              | Import as provenance and transformation lineage                  |
| MetricFlow models, measures, dimensions and formulas            | dbt / MetricFlow | Compose from the dbt semantic artifact                           |
| Domain/subdomain/microdomain organization                       | ZLens              | Git-versioned Domain Packages                                    |
| Entity binding, relationship cardinality, fanout, export policy | ZLens              | Sparse analytical overlay only where dbt is insufficient         |
| Business contracts, conformance, reusable blocks and apps       | ZLens              | Version, review and certify in the ZLens project                   |
| Agent hints and evaluations                                     | ZLens              | Draft → evaluate → review → approved retrieval                   |

The compiler records dbt **provenance**—unique IDs, artifact paths,
fingerprints and availability—not a serialized copy of physical columns,
descriptions, tests, or MetricFlow formulas. This prevents a second schema from
drifting out of sync with dbt.

## Domain Packages

Each analytical domain is an ordinary Git folder:

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
    apps/
```

The model file is unified by default: entities, relationships, contracts, and
cross-domain interfaces are sections of the same Git-versioned Domain Model.
Split files remain an optional organization choice for large domains.

Domains organize ownership and retrieval; they do **not** imply a safe join or
automatic cross-domain access. A generated analytical join needs a DQL
relationship with explicit keys, cardinality, fanout policy, lifecycle state,
and—across a domain boundary—a certified provider export plus a purpose-bound
consumer import.

## Safe agent behavior

Ask AI follows this order:

1. compatible certified DQL block;
2. compatible dbt/MetricFlow semantic query;
3. review-required generated SQL backed by certified, fanout-safe DQL
   relationships;
4. a clarification or refusal when policy is missing, stale, unsafe, or
   attribution-dependent.

dbt's DAG can explain how a model was transformed. It never proves that two
models may be joined or that a revenue aggregate will not fan out. For example,
revenue by customer acquisition channel can use a certified customer-grain
relationship; revenue through raw campaign touches must ask for first-touch,
last-touch, fractional, or another explicit attribution policy.

## Enable dbt-first mode

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

Then run:

```bash
dbt parse
zlens compile .
zlens notebook .
```

Manifest v3 is opt-in during the compatibility window. Existing manifest v2
projects keep their current behavior and do not need a separate migration.

## Migrating from DataLex

DataLex can be migrated into a dbt-first ZLens project without treating it as a
second runtime dependency:

```bash
# Review only; default and --dry-run never write source
zlens migrate datalex --input ../datalex/datalex-manifest.json --dry-run

# Write draft Domain Package overlays and suggested dbt YAML patch files
zlens migrate datalex --input ../datalex/datalex-manifest.json --apply
```

The migration matches legacy objects to dbt unique IDs, deliberately drops
mirrored dbt facts, converts only DataLex-specific analytical semantics into
draft overlays, writes divergent dbt-owned descriptions as suggested patches,
and reports every loss. It is idempotent and never auto-certifies a migrated
relationship, contract, block, or hint.

See [RFC 0002](rfcs/0002-dbt-first-domain-modeling.md) for the full contract
and [the implementation plan](rfcs/0002-implementation-plan.md) for acceptance
gates.

## Warehouse-first: model your database without dbt

Without dbt, entities bind to your database's own tables, and ZLens reads
what it needs from the database itself:

```json
{
  "project": "commerce-analytics",
  "manifestVersion": 3,
  "modeling": { "mode": "warehouse-first" }
}
```

1. **Choose the schemas and sync.** In **Settings → Database → Metadata
   scope**, choose the schemas to model and click **Apply and synchronize**,
   or run `zlens sync warehouse --schemas <schema>`. ZLens reads their
   tables, views, columns, comments, declared keys and view SQL (metadata
   only, never rows) into `.dql/warehouse-catalog.json`. The compiler reads
   that file the way it reads a dbt `manifest.json`, so a new sync refreshes
   the project.
2. **Draft from warehouse.** On the **Modeling** page, **Draft from
   warehouse** drafts an entity per table and the relationships between
   them, from declared primary and foreign keys, view SQL and naming
   conventions. It checks each join on the data with aggregate-only queries
   and proposes the cardinality it saw. Each draft cites its evidence. The
   drafts open as a proposal you review before anything is saved. Tick **Use
   query history** to also count the joins in recent queries your login can
   see (Snowflake, PostgreSQL, Databricks, BigQuery); query text is read in
   memory and dropped. From the terminal, `zlens model discover --validate`
   previews the same drafts and `zlens model apply-discovery --apply --validate`
   writes them.
3. **Review and certify** the relationships Ask should rely on; see
   [Review and certify relationships](#review-and-certify-relationships).
4. **Add metrics.** **Modeling → New metric** writes a metric to ZLens's own
   semantic layer: an aggregation of one catalog column. Ask answers from it
   with the **From Metrics** label.

Each re-sync compares the new catalog with the previous one. It reports new
and removed tables and columns and changed types, and names the entities and
joins they touch. A certified join whose keys changed stops being automatic
until it is validated again.

The full walkthrough is [No dbt? Start from your database](get-started/no-dbt.md).

## Hybrid: dbt plus schemas dbt does not cover

A hybrid project models its dbt models and, next to them, warehouse tables
dbt does not cover, such as a vendor's schema or a legacy mart. A
warehouse-first project becomes hybrid when you apply a dbt project to it in
**Settings → Project & dbt**; its warehouse-bound entities keep working. You
can also set `"mode": "hybrid"` in `dql.config.json`.

- Pick **dbt relations plus selected schemas** under **Metadata scope** and
  name the extra schemas, then **Apply and synchronize**. The extra schemas
  are read into the warehouse catalog as in warehouse-first mode.
- `zlens model discover` drafts from dbt while the project has a dbt
  manifest. Add `--source warehouse` to draft from the warehouse catalog
  instead.

## Review and certify relationships

Drafted and imported relationships start as drafts; only a person promotes
them. On the **Modeling** map, click a relationship, then
**Edit relationship**.

Before you can certify a join, both models need a grain and keys.
Right-click a model on the map and choose **Edit model**. Set **Grain
override** (what one row means, such as `one row per order`) and **Key
overrides** (such as `order_id`). By default these come from dbt `meta.dql`.
Click **Preview source change**, then **Save**. The model card then shows
**1 row = …**. When you open **Edit relationship**, the **Warehouse check**
must say **Safe to join**.

{{ video("sem4-certify-joins") }}

**What Ask may do with it** has three levels:

| Level | What Ask does with it |
|---|---|
| **Draft** | Sees it as a hint only. |
| **Validated** | Checked safe to join. Ask prefers it when it writes SQL. |
| **Certified** | Ask must join these models on exactly these keys. |

Pick a level, click **Review change**, check the proposal and click
**Save**. The change is written to the domain's modeling files, so it is
reviewed in git like the rest of the project.
`zlens model explain <relationship-id>` says whether a relationship is
automatic join proof for Ask.

Once a join is certified, Ask adds the check **Joins certified tables on
their certified keys** to AI-written SQL that joins those tables.

## Certify business terms

A term is a business word Ask should read one way, such as "Revenue" or
"Active customer". Create and edit terms on **Modeling → Terms & concepts**.
Saving a term always keeps it a draft. To certify it:

1. Open the term and make sure it has an **Owner** and a **Meaning** (its
   definition). Any metric it links must exist in the semantic layer.
2. Save it, then click **Certify**. If something is missing, ZLens says what.

Certify writes `status = "certified"` into the term's file and a receipt next
to it (`terms/revenue.dql` gets `terms/revenue.certification.yaml`), with who
certified it and when. Commit both files.

Editing a certified term makes it a draft again until someone certifies it
again. A term whose file says `certified` without a receipt that matches it,
for example one typed by hand or changed in a merge, counts as a draft.
`zlens doctor` lists such terms under **Certified terms**.

From the terminal, `zlens certify terms/revenue.dql` checks every term in the
file, and `zlens certify terms/revenue.dql --apply` certifies the ones that
pass.
