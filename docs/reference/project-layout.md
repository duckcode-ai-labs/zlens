# Project layout

A ZLens project is a local-first Git repo with a few conventional directories.
Shared assets are plain files. The governed Hint Graph also uses plain files
under selected `.dql/` subdirectories. Private App overlays, local indexes,
saved layouts, and AI pins stay ignored.

For new enterprise-style repos, prefer the domain-first layout:

```text
my-dql-project/
├─ dql.config.json
├─ domains/
│   ├─ customer/
│   │   ├─ domain.dql
│   │   ├─ modeling/
│   │   │   ├─ model.dql.yaml       # entities, relationships, contracts, interfaces
│   │   │   └─ layouts/
│   │   ├─ terms/
│   │   ├─ skills/
│   │   ├─ blocks/
│   │   │   └─ _drafts/
│   │   ├─ views/
│   │   ├─ contracts/
│   │   ├─ interfaces/
│   │   ├─ evaluations/
│   │   └─ tests/
│   └─ revenue/
├─ skills/                  # shared, Git-tracked agent guidance
├─ tests/                   # block and agent-eval checks
├─ notebooks/
├─ apps/
├─ semantic-layer/          # optional local semantic source
└─ .dql/
    ├─ hints/               # Git-owned governed hint candidates and decisions
    ├─ traces/              # Git-owned correction provenance
    ├─ evaluations/         # Git-owned evaluation evidence
    ├─ reviews/             # Git-owned human review decisions
    └─ cache/               # ignored, rebuildable local indexes
```

`model.dql.yaml` is the simple default. A large domain may split its sections
into multiple `*.dql.yaml` files under `modeling/`; both layouts compile into
the same Domain Model and manifest.

The compiler scans both layouts and emits one manifest. Use:

```bash
zlens new domain customer
zlens new block --domain customer --pattern entity_profile "Customer Profile"
zlens new view --domain customer "Customer 360"
zlens migrate layout --to domain-first --dry-run
```

```text
my-dql-project/
├─ dql.config.json          # connection, semantic layer, dbt wiring
├─ package.json             # npm scripts: notebook, compile, sync, doctor
├─ blocks/                  # certified reusable .dql files
│   └─ revenue_by_segment.dql
├─ terms/                   # .dql business vocabulary terms
│   └─ customer.dql
├─ business-views/          # .dql business composition views
│   └─ customer_360.dql
├─ notebooks/               # .dqlnb interactive notebooks
│   └─ welcome.dqlnb
├─ apps/                    # OSS App packages for decision-facing work
│   └─ cards-fraud-ops/
│       ├─ dql.app.json     # App metadata: domain, subdomain, group, lifecycle
│       ├─ README.md
│       ├─ dashboards/
│       │   └─ daily-ops.dqld
│       ├─ notebooks/
│       │   └─ investigation.dqlnb
│       └─ drafts/
│           └─ ai-generated-block.dql
├─ semantic-layer/          # metrics, dimensions, hierarchies, cubes (YAML)
│   ├─ metrics/revenue.yaml
│   └─ dimensions/customer.yaml
├─ data/                    # local CSV/Parquet — git-ignored by default
└─ .dql/
    ├─ hints/               # committed *.hint.yaml governed hints
    ├─ traces/              # committed *.trace.json correction provenance
    ├─ evaluations/         # committed *.hint-evaluation.yaml evidence
    ├─ reviews/             # committed *.review.yaml decisions
    ├─ cache/               # ignored, rebuildable SQLite indexes
    ├─ imports/             # ignored local SQL import review sessions
    └─ local/apps.sqlite    # ignored private Apps, AI pins, saved layouts
```

## What each directory holds

- **`domains/<domain>/domain.dql`** — the only canonical package declaration:
  stable id, parent, owner, business owner, bounded context, source systems,
  primary terms, cadence, and tags. Domain folders recursively own
  `modeling/`, `terms/`, `skills/`, `blocks/`, `views/`, `contracts/`,
  `interfaces/`, `evaluations/`, and `tests/`.
- **`domains/<domain>/modeling/`** — sparse analytical identity, relationship
  proof, cross-domain interfaces, contracts, conformance, and saved layouts.
  It references dbt unique IDs and never copies dbt schema metadata.
- **`blocks/`** — one `.dql` file per block. Governance fields (`domain`,
  `owner`) are required by default; the certification check runs on CI.
- **`terms/`** — one `.dql` file per `term`. These define business vocabulary,
  identifiers, synonyms, business rules, and caveats without requiring SQL. A
  certified term has a receipt beside its file (`<name>.certification.yaml`);
  commit it with the term.
- **`business-views/`** — one `.dql` file per `business_view`. These compose
  blocks and other business views into business lineage, without running SQL.
- **`notebooks/`** — interactive analysis. Saved results live beside the
  notebook as `.run.json` (git-ignored). Notebooks remain global products and
  use `ownerDomain` / `usesDomains` metadata to appear in Domain Studio. The
  Notebook explorer renders a virtual `Domains/<ownerDomain>/` tree from that
  metadata while keeping one canonical file under `notebooks/`; notebooks
  without an owner remain under the virtual `Project` folder.
- **`apps/`** — global decision-facing packages. An App can have dashboard pages,
  attached notebooks, AI conversations and pins, and draft DQL blocks. In OSS, `domain`,
  `subdomain`, `groups`, `audience`, `visibility`, and `lifecycle` are
  organization metadata, not enterprise access-control boundaries.
- **`domains/**/{notebooks,apps}/`** — legacy-read-compatible product paths.
  New authoring keeps products in root `notebooks/` and `apps/` and records
  domain ownership/use through `ProductDomainContext`.
- **`semantic-layer/`** — metrics and dimensions authored locally. When you
  configure dbt artifacts, ZLens reads MetricFlow semantics from
  `target/semantic_manifest.json` and keeps generated cache files under `.dql/`.
- **`skills/`** — shared Markdown/YAML-frontmatter agent guidance. New projects
  write here; `.dql/skills/` is read only for legacy migration compatibility.
- **`tests/`** — committed block assertions and agent evaluation fixtures.
- **`data/`** — sample data for local exploration. Production projects usually
  query a warehouse instead.
- **`.dql/hints/`, `.dql/traces/`, `.dql/evaluations/`, `.dql/reviews/`** —
  committed governed-learning source. A clone rebuilds its local Hint Graph
  index from these files. Candidates are reviewable but not retrievable;
  approval still requires the lifecycle's evidence and human review gates.
- **`.dql/cache/`** — ignored, rebuildable metadata, advisory-memory, and Hint
  Graph indexes. `metadata.sqlite` contains the activated, scope-qualified
  warehouse relation/column generation used by warm Ask, schema browsing, and
  semantic table mapping. It stores no credentials or sampled values. It never
  contains canonical chat history and SQLite is never the shared governed
  source of truth. Ask's context packs (the question and the vocabulary an
  answer was built from, for follow-ups and the run's trace) are kept bounded:
  the newest 200, none older than 7 days, at most 64 MB in all
  (`ZLENS_CONTEXT_PACK_MAX`, `ZLENS_CONTEXT_PACK_DAYS`, `ZLENS_CONTEXT_PACK_MAX_MB`).
  Space freed by older packs is reused; `VACUUM` shrinks the file.
- **`.dql/imports/`** — local import review sessions. AI SQL imports follow
  `extract -> parameterize -> match/reuse -> validate -> review -> certify`.
  The session stores draft candidates, parameter decisions, evidence, and
  duplicate/reuse recommendations.
- **`.dql/local/apps.sqlite`** — private single-user state such as local Apps,
  layout overrides, AI pins, and saved views.
- **`.dql/local/agent-conversations.sqlite`** and
  **`.dql/local/agent-runs.sqlite`** — private project chat threads and bounded
  execution history. They survive cache rebuilds and ZLens upgrades, remain
  outside Git, and can be removed explicitly when a user wants to clear local
  history.

Do not add a broad `.dql/` rule to `.gitignore`: it hides the governed Hint
Graph files. ZLens scaffolds and notebook startup use granular ignores for
`cache/`, `local/`, `imports/`, runtime state, connectors, and credentials.

## App mental model

Use one library model:

```text
Domain -> Subdomain -> Group / Use Case -> App
  -> Dashboard pages
  -> Supporting notebooks
  -> AI conversations and pinned summaries
  -> Draft blocks
```

- **Domain** is the business area, such as Cards, Lending, or Deposits.
- **Subdomain** is the narrower area, such as Fraud or Merchant Risk.
- **Group** is a local use-case/team label in OSS.
- **App** is the main user-facing package.
- **Dashboard page** is a curated grid inside an App.
- **Notebook** is the analysis workbench attached to an App.
- **AI Pin** is local output that can be promoted to a review draft.

`certified` is a trust label in OSS. It is not SSO, RBAC, or hosted governance.

## Notebook UI workflow

The OSS notebook UI is organized around the work a single user does most often:

- **Apps** — browse My Local, Shared, Templates, and Review App views by
  domain, subdomain, group, owner, lifecycle, certification, and tags.
- **Notebooks** — open and edit `.dqlnb` analysis files.
- **Blocks** — browse reusable `.dql` blocks and open the dbt-first Block
  Studio. Import SQL is a top action inside this surface, not a separate left
  navigation item.
- **Review** — inspect Apps in review, AI pins, draft blocks, and certified
  App counts before promoting work.
- **Settings** — local provider keys and runtime settings.

Inside an App, the UI has two modes:

- **View** shows dashboard pages, attached notebook previews, AI conversations,
  and pinned summaries. It hides builder controls, drafts, and settings.
- **Build** exposes dashboard page creation, chart tile editing, notebook
  attachment, AI pin promotion, draft blocks, and App settings.

The create-App flow starts from one of four sources: empty App, notebook,
template, or import. Import opens Block Studio's SQL import wizard first, then
you add the saved draft/certified blocks from the App Build catalog.

## Working with dbt

For an existing single dbt repo, keep ZLens isolated under `dql/`:

```text
my-dbt-repo/
├─ dbt_project.yml
├─ models/
├─ macros/
├─ target/
│   └─ manifest.json       # produced by `dbt parse` or `dbt build`
└─ dql/
    ├─ dql.config.json     # dbt.projectDir: ".."
    ├─ domains/
    ├─ skills/
    ├─ notebooks/
    ├─ apps/
    └─ .dql/
```

This is the recommended OSS path. The dbt project stays clean, while all DQL
blocks, notebooks, Apps, imports, private state, and cache files live in one
folder.

The sibling layout keeps the ZLens workspace next to dbt:

```text
my-team/
├─ dbt/                     # your dbt project (dbt_project.yml)
│   └─ target/manifest.json # produced by `dbt parse` or `dbt build`
└─ dql/                     # your ZLens project
    └─ dql.config.json      # dbt.projectDir: "../dbt"
```

`zlens init ./dql` detects the parent dbt project. `create-zlens-app` and
`zlens init` also auto-detect common sibling layouts and wire the config for you.
After `dbt build`, run `zlens compile ./dql`, `zlens sync dbt ./dql`, and
`cd dql && zlens agent reindex` to refresh lineage, cache status, and the agent
index.

The lineage flow is:

```text
business term -> DQL block -> business_view -> dashboard page -> App
dbt source -> dbt model -> semantic metric -> DQL block -> business_view -> dashboard page -> App
```

## What gets committed

**Commit:** durable shared source: `domains/**/domain.dql`,
`domains/**/{modeling,terms,skills,blocks,views,contracts,interfaces,evaluations,tests}/**`,
legacy/global `blocks/**/*.dql`, `terms/**/*.dql`, `skills/**/*.skill.md`,
`business-views/**/*.dql`, `semantic-layer/**/*.yaml`, reviewed
`apps/*/dql.app.json`, reviewed `apps/*/dashboards/*.dqld`, curated/shared
`.dqlnb` notebooks, `dql.config.json`, and `package.json`.

**Don't commit:** local or generated state: `.dql/cache/**`, `.dql/local/**`,
`.dql/imports/**` by default, `*.run.json`, `dql-manifest.json`, `data/**`,
AI pins, saved views, personal layout overrides, local SQLite/DuckDB files, and
temporary generated artifacts.

Use `zlens promote notebook <path> --to shared`, `zlens promote app <app-id> --to shared`,
or `zlens promote dashboard <app-id>/<dashboard-id> --to shared` to turn private
work into clean shared source. Run `zlens doctor git-hygiene` before committing to
flag tracked files that violate this policy.
