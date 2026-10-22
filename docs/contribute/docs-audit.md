# Docs audit (October 2026 journey refresh)

This audit covers every page under `docs/` at `origin/main` 54463174. It
supports the journey-first rebuild of the user docs (plan:
"ZLens docs refresh with feature clips", 2026-10-15). The `contribute/` folder
is excluded from the published site.

Decisions:

- **keep**: the page stays where it is, with light fixes only.
- **rewrite**: a new page replaces it, checked against the current product.
- **merge**: its content went into a new journey page. The old path is now a
  short "moved" note (so GitHub links still work), and the site redirects it.
- **archive**: the page stays at its old URL and is listed under *Archive*
  with a banner. It may not match the current product.
- **internal**: kept out of the user navigation and flagged in the PR. Nothing
  was deleted.

## User path

| Page | Decision | Where it went |
|---|---|---|
| `index.md` | rewrite | `index.md` (home, journey links, `overview` clip) |
| `README.md` (github.com landing for `docs/`) | rewrite | same path; mirrors the new navigation |
| `01-quickstart.md` | merge | `get-started/index.md` |
| `02-concepts.md` | merge | `get-started/concepts.md` |
| `03-install.md` | merge | `get-started/install.md` |
| `04-dql-in-5-concepts.md` | merge | `get-started/concepts.md` |
| `guides/README.md` | merge | `index.md` |
| `guides/connect-warehouse.md` | merge | `get-started/connect-database.md` |
| `guides/import-dbt.md` | merge | `get-started/your-dbt-project.md`, `lineage/index.md` |
| `guides/authoring-blocks.md` | merge | `blocks/block-studio.md`, `blocks/certify.md` |
| `guides/block-studio.md` | merge | `blocks/block-studio.md`, `blocks/import-sql.md` |
| `guides/mcp.md` | merge | `agents/index.md`, `agents/tools.md`, `ask/team-documents.md` (knowledge sources) |
| `guides/versioning.md` | merge | `notebooks/version-and-diff.md` |
| `guides/ask-trace-observability.md` | merge | `ask/how-it-answered.md` |
| `guides/home-and-following.md` | merge | `apps/index.md`, `apps/ask-about-an-app.md` (Home is no longer reachable in the UI; see the PR's open questions) |
| `guides/notebook-research.md` | archive | `archive/` nav entry; the Research panel is mentioned on `notebooks/index.md` only |
| `guides/dashboards.md` | archive | static `.dql` dashboards built with `zlens build`; Apps are the current path (`apps/`) |
| `guides/troubleshooting.md` | keep | Reference nav; commands checked; connection labels updated |
| `guides/faq.md` | keep | Reference nav; commands checked; links and certification answer updated |
| `guides/migrate.md` | rewrite in place | Reference nav. `zlens migrate looker/metabase/tableau` are scaffold-only and there is no `hex` source; the page now says so and points to Import SQL |
| `guides/hosted-servers.md` | keep | Architecture nav (for host authors) |
| `guides/agent-evals.yml` | keep | example file linked from the eval docs |
| `tutorials/README.md` | archive | journey pages replace the tutorial track |
| `tutorials/01-getting-started.md` | archive | replaced by `get-started/` |
| `tutorials/02-authoring-blocks.md` | archive | replaced by `blocks/` |
| `tutorials/03-dashboards-and-apps.md` | archive | replaced by `apps/` |
| `tutorials/04-agentic-analytics.md` | archive | replaced by `ask/` and `agents/` |
| `tutorials/05-ci-and-verify.md` | keep | Reference nav ("CI with zlens eval") |
| `datalex-and-dql.md` | keep | Reference nav ("Modeling and Domain Packages") |
| `agentic-answer-flow.md` | keep | Architecture nav |
| `migrations/workbook-to-dashboard.md` | keep | Reference nav; linked from compiler messages |

New pages with no predecessor: `get-started/ai-provider.md`,
`get-started/workbench.md`, `ask/index.md`, `ask/needs-review.md`,
`ask/refusals.md`, `blocks/index.md`, `blocks/certify.md`,
`notebooks/index.md`, `apps/build.md`, `lineage/index.md`, `agents/tools.md`,
`ask/team-documents.md`, `archive.md`.

## Reference

| Page | Decision | Notes |
|---|---|---|
| `reference/cli.md` | keep | linked from README and the in-app Help page; commands checked |
| `reference/language.md` | keep | |
| `reference/project-layout.md` | keep | |
| `reference/file-formats.md` | keep | |
| `reference/connectors.md` | keep | linked from README |
| `reference/semantic-layer.md` | keep | |
| `reference/compatibility.md` | keep | |
| `reference/ask-traces.md` | keep | |

## Architecture and contributing (footer, not the user path)

| Page | Decision |
|---|---|
| `architecture/overview.md` | keep |
| `architecture/graduated-trust.md` | keep |
| `architecture/lineage-model.md` | keep |
| `architecture/openlineage.md` | keep |
| `architecture/dbt-integration.md` | keep |
| `architecture/plugin-api.md` | keep |
| `architecture/generative-app-builder.md` | keep (added to nav) |
| `architecture/agentic-loop/README.md` and `01`–`07` | keep (added to nav) |
| `rfcs/0000-template.md` | internal (already excluded from the site) |
| `rfcs/0001`–`0010` (15 files) | keep; out of nav, still published as before |
| `contribute/*` (6 files, including this one) | internal (excluded from the site) |

## Internal, out of the user nav (flagged in the PR)

These pages are not in the navigation, but MkDocs still publishes them, as it
did before this refresh. Nothing was deleted or excluded; the owner decides.

| Path | Why it looks internal |
|---|---|
| `oss-readiness-checklist.md` | release checklist; already excluded from the site, linked from CONTRIBUTING.md |
| `prototypes/*.html` (3 files) | UI prototypes; published as raw HTML pages |
| `performance/PERF-001-scale-gate.md` | release gate notes |
| `performance/warehouse-metadata-sync-and-dialect-repair-plan.md` | delivery plan |
| `specs/dql-2-domain-context/**` (31 files) | implementation spec, workstreams, execution tracker, agent handoff template |
| `90-DAY-PROMOTION-PLAN.md` | untracked locally; never committed |

## Media

`media/*.png` (4 DQL-era screenshots) are no longer used by the journey pages.
Clips go to `media/clips/` (owned by the clip harness).
