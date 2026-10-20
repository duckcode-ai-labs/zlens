# Locked decisions

The following decisions are normative. Changing one requires an RFC/spec PR and
an acceptance-matrix update.

| ID | Decision |
| -- | -------- |
| SPEC-001 | This Git-tracked pack is the normative implementation source. |
| SPEC-002 | Work ships in dependency-ordered workstreams with independent verification. |
| CFG-001 | New dbt-backed projects default to manifest v3 and `modeling.mode: dbt-first`. |
| CFG-002 | Existing projects migrate explicitly; init/sync never silently upgrade them. |
| CFG-003 | A configured local or Git dbt project path is authoritative for profile discovery, artifact compilation, and Domain Studio; complete default dbt profile targets may supply the runtime connection without overwriting saved DQL connections. |
| CFG-004 | Setup, Settings, Home, and governed runtime share one redacted provider contract and readiness definition. Native OpenAI, Anthropic, and Gemini support optional enterprise Base URL/model routing; custom OpenAI-compatible requires Base URL/model; unsaved tests use the governed adapter; blank secret inputs preserve stored secrets. |
| ID-001 | Every domain-owned object has a domain-qualified compiled identity. |
| DOM-001 | Domains own semantics and governance, not physical dbt schema. |
| DOM-002 | Domain hierarchy scopes organization/retrieval; it grants no join or access rights. |
| DOM-003 | A domain may contain multiple focused Model Areas; Areas compile into one domain graph and never become a second semantic model or authorization boundary. |
| PRD-001 | Apps, Ask, and Notebooks remain global shared product surfaces. |
| PRD-002 | Domain Studio shows Apps/Notebooks as Related Products backlinks. |
| PRD-003 | Global products declare owner/used domains and required exports. |
| PRD-004 | App Builder composes governed dashboards requirement-first: compatible certified blocks first, governed semantic queries only for uncovered requirements, and visible gaps otherwise. |
| PRD-005 | App creation begins as one local private draft; authoring mode and source policy are chosen independently, while Project publication is a later explicit governed action. Certified blocks remain the fastest route, not a prerequisite. |
| PRD-006 | Manual and AI App authoring produce the same versioned App Build Draft and use the same preflight, review, commit, and publication gates; neither path may silently write governed project source. |
| PRD-007 | App sources are always discovered from one immutable snapshot-backed catalog across certified, review, and draft executable blocks; lifecycle affects eligibility, never visibility, and raw dbt models are not executable tiles without an adapter. |
| REL-001 | dbt lineage and matching column names are never automatic join proof. |
| REL-002 | A generated join has exactly one of three authorities: a semantic-layer join (compiler-owned), a certified, fresh, exported, fanout-safe DQL relationship, or a within-domain warehouse proof (`proven_default`) that promises structural safety only — never business identity or cross-domain permission — and is disclosed as such. Draft or unvalidated relationships are never joined; unknown or ambiguous domain membership is a modeling gap, never a proof (amendment A-003, 2026-09-09; spec 04 "Join authority"). |
| REL-003 | Cross-domain knowledge compiles as explicit `observed`, `authorized`, `blocked`, or `stale` routes; only the full provider export → contract → consumer import → validated relationship chain can authorize use, and dbt transformation lineage remains observation only. |
| REL-005 | Validation and certification are distinct actions. Validation (Domain Studio's Validate, or Ask's warehouse proof) attaches evidence to a draft; certification is a separate explicit human promotion that reuses that evidence. Asking a question never certifies anything. |
| REL-004 | dbt tests, lineage, and matching names are authoring suggestions only; imported or AI-authored relationships remain drafts and cannot create join proof. |
| CONTRACT-001 | Cross-domain use requires both certified relationship proof and matching provider export/consumer import. |
| CONTRACT-002 | Every executable metric and certified asset exposes a normalized analytical capability contract covering entity/result grain, aggregation/additivity, dimension roles, time roles/grains, freshness, supported operations, relationship paths, outputs, and execution adapters; missing capability is never inferred from display-name text. |
| SKILL-001 | Domain skills are governed domain context; global skills are reusable workflow capability. |
| SKILL-002 | Skill exclusions are negative constraints and never positive retrieval tokens. |
| SKILL-003 | The compiler emits compact Domain Knowledge Capsules and skill descriptors/hashes without skill bodies or executable scripts; Ask selects a bounded eligible skill set from the immutable snapshot, records a `KnowledgeLens`, and supports optional product/user pinning without making the pin an authorization boundary. |
| SKILL-004 | Eligible Domain/Skill policy may guide calendar, timezone, completeness, comparison alignment, ranking defaults, and narrative structure, but cannot invent members, authorize relationships, override metric capability, or hide ambiguity; exact selected IDs and hashes remain in the plan and receipt. |
| SKILL-005 | Skills may reference qualified model and relationship IDs; validated references compile as `guided_by` graph edges while legacy free-form references remain non-governed text. |
| SKILL-006 | Skills AI produces review-required drafts only; correcting an active skill creates a draft that is retrieval-ineligible until a separate exact-hash activation and reindex. |
| CTX-001 | One server-resolved `DomainContextEnvelope` scopes every governed answer. |
| CTX-002 | One immutable `snapshotId` is used from retrieval through final validation. |
| CTX-004 | Model Area identity is domain-qualified; explicit or inferred Area focus narrows modeling and Skill retrieval inside its owning domain. |
| CTX-005 | Every Ask surface acquires one qualified immutable project-search snapshot containing DQL v3/modeling, certified assets, semantic metadata, dbt metadata, safe runtime schema, and approved hints; warm retrieval does not reparse source artifacts. |
| CTX-006 | Manifest v3 owns one deterministic qualified knowledge graph for domains, Areas, terms, skills, certified assets, semantic/dbt provenance, governed interfaces, relationships, and products; legacy lineage, search, Domain 360, and agent context are compatibility projections of this graph. |
| CTX-007 | Ask builds one bounded context pack from parallel certified, semantic, relational, business, and conversation lanes, then fuses candidates by stable qualified identity and reciprocal rank. Lane failure is observable and isolated; it cannot erase successful evidence or widen authorization. |
| CTX-010 | The request-bound `LocalContextPack` is the single context projection every analytical surface reads; the Ask vocabulary is a view built from it, never from the manifest directly. The pack carries the complete eligible set for the resolved envelope (columns only for the seed neighbourhood); ranking orders seeds and chooses what renders under per-section caps; no eligible object is cut before the model sees section counts. Discovery is proven by natural-language questions whose targets lie outside the initial cards, and "not shown in this reading" is never reported as "not modeled". Every receipt carries a context ledger (retrieved → admitted → rendered → selected → enforced → used). |
| CTX-008 | Persistent Domain scope includes allowed descendants but never siblings; one-shot exact object focus may boost matching active skills and never authorizes joins, tools, imports, or data access. |
| AGT-001 | After meaning is fixed, route order is a completely compatible certified block, one compatible semantic adapter (`native`, `metricflow-cli`, or `dbt-cloud`), governed relational composition, bounded review-required exploration, then identifier-bound clarify/refuse. A failure after executable-plan selection never broadens the route. |
| AGT-002 | AI discovery produces evidence-cited drafts only and never auto-certifies. |
| AGT-003 | Ask is available before domain setup only in limited-context, review-required mode. |
| AGT-007 | App planning and analytical answering are separate orchestrators that share one server-resolved snapshot, retrieval contracts, trust vocabulary, and evidence model. |
| AGT-008 | App Business Stories verbalize server-computed facts from the settled dashboard run; unsupported numbers, comparisons, causal claims, grains, or filters are rejected. |
| AGT-009 | Analytical natural-language requests perform broad governed retrieval before general routing, then use at most one bounded AI meaning-resolution call over qualified retrieved candidates; explicit qualified references may bypass that call. |
| AGT-010 | Relevance and business meaning select the concept before trust selects the execution route; every AI recommendation is identifier-bound and must pass deterministic compatibility, policy, compilation, and execution guards. |
| AGT-011 | Clarification choices carry stable evidence IDs; selecting one rehydrates that evidence and its semantic/dbt/runtime dependencies against the original analytical question before compilation and execution. |
| AGT-012 | A question or prior result member is resolved once into a typed dimension/value binding with provenance and confidence; retrieval, planning, certified/semantic fit, SQL generation, validation, and execution preserve that binding without reinterpreting it as metadata text. |
| AGT-013 | One immutable, snapshot-bound `ResolvedAnalyticalPlan` is the sole authority for meaning, qualified members, entity/time grain, filters, member bindings, relationship paths, execution capability, output contract, and follow-ups. |
| AGT-014 | Certified and semantic adapters consume the exact resolved plan, perform no lexical lookup, join search, member reselection, metric substitution, semantic downgrade, or post-failure route fallback, and return an executable-plan/result contract tied to the plan fingerprint. |
| AGT-015 | Governed SQL is compiled from constrained relational operators over qualified allowlisted IDs and exact relationship proof; DQL owns relations, keys, joins, aliases, parameters, qualification, and dialect rendering. |
| AGT-016 | Deep Research applies typed deltas to the root plan and reuses its snapshot, Domain envelope, KnowledgeLens, relationship proof, and execution receipts; every numerical claim is receipt-backed and generated research remains review-required. |
| AGT-017 | Analytical meaning is represented as a versioned frame with exact metrics, entity grain, dimension roles, typed members, time role/calendar/timezone/completeness, bounded periods, comparison, ranking basis/ties, and requested outputs; downstream components never reconstruct these semantics from prose or SQL. |
| AGT-018 | A deterministic solver proves the complete metric/entity/dimension/member/time/period/comparison/ranking/output tuple against capability, additivity, relationship, policy, and adapter contracts; it returns one unique plan, the smallest material clarification, or an actionable gap/refusal. |
| AGT-019 | Multi-period comparison and ranking compile as a typed executable graph that aggregates at the declared entity grain, aligns governed periods, computes decimal-safe deltas, ranks after aggregation, applies deterministic ties, and validates every requested output. |
| AGT-020 | Analytical answers and stories verbalize only deterministic result facts bound to execution receipts, including freshness and caveats; unsupported numbers, causal claims, grain/filter drift, and hidden partial-period claims fail closed. |
| AGT-021 | An explicit multi-metric question preserves every requested metric in one analytical frame and output contract; execution requires one provably compatible governed tuple, otherwise the run returns a modeling gap instead of silently dropping a metric. |
| AGT-022 | App Autopilot consumes server-owned saved-App context through the shared AgentRun lifecycle; it may give context-limited explanation or repair guidance, or propose typed App changes, but cannot silently mutate App source or accept client-injected trust evidence. |
| AGT-023 | App-generated and App-executed SQL failures may use the same single bounded same-target repair boundary as Ask and Notebook; the original failure remains immutable, unsafe/access/policy failures never enter AI repair, and repaired semantic SQL is downgraded to review-required exploration rather than inheriting semantic approval. |
| AGT-024 | Modeling AI and Skills AI extend durable AgentRun with evidence-bound, write-free proposal artifacts and immutable authoring revisions; generation cannot mutate source, activate skills, certify relationships, create proof, or grant authorization. |
| AGT-025 | An underspecified App request produces a typed Build Frame with compact identifier-bound clarification choices; it never converts missing coverage into invented tiles, metrics, filters, or SQL. |
| AGT-026 | App Builder owns a separate stateful orchestration loop, reuses the shared provider/snapshot/meaning/execution foundations, plans from 8-12 identifier-bound catalog candidates with at most one AI call, and requires an explicit action for generated gaps. |
| AGT-027 | A fresh natural-language analytical turn receives exactly one bounded candidate-ID-only meaning/planning call before execution; zero planning calls are reserved for an already-resolved selection, rerun/Apply, structured clarification, or frozen Research child. Deterministic code validates and executes the selected identity; it never replaces semantic understanding with naive token search. |
| AGT-028 | Meaning resolution ranks the complete retrieved candidate package and freezes one immutable interpretation or a typed clarification/gap. A deterministic fast path may validate an explicit qualified identity, but a lexical exact match alone cannot bypass the bounded meaning call or create an execution plan. |
| AGT-029 | Ask evaluates one pre-freeze cascade in order: certified block, compatible semantic members/metrics, governed relational composition, then eligible review-required generated SQL. A missing earlier tier is not a terminal governed-query error when a later eligible tier can answer. |
| AGT-030 | Bare ranking questions do not bind a same-grain entity-count metric as the ranking measure. Ask asks for the smallest missing measure clarification once, preserves candidate IDs, and does not repeat the same clarification after a response. |
| AGT-031 | A conversational attribute lookup is metric-independent. Typed prior-result members (including singular people pronouns) remain bound while the generated SQL selects the requested descriptive attribute through inspected relations and documented joins; missing attributes return a precise typed gap. |
| AGT-032 | Every successful analytical result crosses one canonical versioned result contract before persistence or rendering: named columns, object rows, row count, execution receipt/fingerprint, and source/trust metadata. Narration and UI tables consume that same object-row contract. |
| AGT-033 | Ask conversation state is typed and source-attributed. Deictic follow-ups resolve against trusted prior result members, compound questions execute as bounded task graphs with partial success, and Research runs a receipt-backed investigation within a statement budget and deadline, with an explicit stop reason. |
| AGT-034 | A router-selected exploratory plan freezes its qualified same-snapshot closure before SQL generation. Host authorization may attach only the exact read-only SQL/target receipt to that frozen plan; an unfrozen, mismatched, or replacement receipt is terminal, records `INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH`, and never executes SQL. |
| AGT-035 | Ask enters one authoritative Ask Analyst Runtime before legacy routing. Exact stable references and structured continuations are zero-call; ordinary Ask has bounded planning continuations. |
| AGT-036 | One route-neutral analytical program bounds Ask tasks/tools/executions/repair while reusing existing safe compilers. |
| AGT-037 | Certified, MetricFlow, governed relational, and exploratory SQL are compilers selected in canonical pre-freeze order; post-freeze fallback is forbidden. |
| AGT-038 | Only materially different validated executable meanings clarify; technical/provider/retrieval failures remain typed incidents. |
| AGT-039 | `BusinessAnswerV1` is fact-bound with deterministic fallback and disclosed default top-10. |
| AGT-040 | Research runs every query of an investigation through the Ask pipeline and keeps each query's receipt. |
| OBS-001 | Ask observability is additive and fail-open: it records execution evidence but cannot route, authorize, retry, alter trust, alter a deadline, or alter an Ask result. |
| OBS-002 | An AgentRun, thread, run list, and SSE may carry only a compact versioned trace reference. Full local trace detail is never embedded in those transport contracts. |
| OBS-003 | Local Ask trace records use W3C-shaped IDs and a closed typed payload union; prompts, responses, SQL, literals, rows, values, paths, headers, secrets, and arbitrary error bodies are rejected at the persistence boundary. |
| OBS-004 | Ask traces use a separate local WAL SQLite store with bounded detail/summary retention. Store failure, a cap, expired detail, or a newer schema is observable but cannot fail or delay Ask. |
| OBS-005 | Retrieval evidence records qualified candidate lifecycle before narrowing, including admission/exclusion reasons. Pruning never becomes a false claim that an object was absent or unmodeled. |
| OBS-006 | Trace spans observe the authoritative meaning/cascade/freeze receipt and physical provider/tool/SQL/result/conversation/Research boundaries without reconstructing or substituting an authoritative decision. |
| OBS-007 | Provider diagnostics retain only redacted stable phase/cause metadata and safe actions. They never persist provider request/response bodies or credentials. |
| OBS-008 | Portable trace export is local and checksum-bound. Strict exports pseudonymize identifiers; support exports require explicit confirmation; validation/replay/OTLP mapping make no network, provider, tool, or SQL call. |
| OBS-009 | Trace APIs and CLI inspection are bounded/read-only where applicable, use stable `TRACE_*` failures, and do not leak full detail into ordinary Ask transport. |
| OBS-010 | The Ask trace UI is addressable by run ID, progressively discloses tree/graph/timeline evidence, supports keyboard and narrow layouts, and preserves the shared `paper`/`white`/`obsidian` theme contract. |
| OBS-011 | Trace-aware evaluations assert only compact evidence and use sanitized fixtures; gold answers, office data, and unredacted trace bodies never become runtime guidance. |
| OBS-012 | Ask observability preserves V1–V3 receipt readability and the local-first OSS boundary; it adds no hosted telemetry, tenancy, SSO/RBAC, managed secrets, centralized audit, or approval workflow. |
| OBS-013 | Govern exposes a local Ask trace catalog at `/ask/traces`; it supports bounded receipt-field filters and pagination, joins only a redacted question preview from the local run store at read time, and links directly to the existing run-ID trace detail without persisting that preview in trace storage. |
| OBS-014 | Ask persists one content-safe server-produced decision summary and typed terminal incident per V4 diagnostic receipt. The compact inspector and full trace render that same stored summary fingerprint; advanced spans remain supplemental and legacy runs explicitly report that the summary is unavailable. |
| OBS-015 | Ask persists a concise V5 runtime story (what happened, why, impact, next action) while detailed stages stay in Advanced/local trace views. |
| EXP-004 | An exploratory App result remains transient until explicit approval materializes an app-scoped review DQL draft; that draft cannot be published, promoted, or certified automatically. |
| API-001 | Domain, modeling, onboarding, and context APIs return stable codes and snapshot IDs. |
| API-002 | App proposal is write-free; commit is snapshot/hash guarded and atomic; dashboard run/story APIs bind filters, results, persona, trust, and evidence to stable fingerprints. |
| API-003 | Browser Ask, CLI, MCP, and Chat use the same snapshot, retrieval, meaning-resolution, route, trust, and error contracts and expose only redacted phase diagnostics. |
| API-004 | Semantic discovery declares per-metric execution capability; modern dbt/MetricFlow artifact shapes normalize without changing metric meaning; managed local-runtime setup is isolated, bounded, and status-reporting; and failed composition returns stable runtime-required or field-incompatible errors. |
| API-005 | Ask, Notebook, native tools, CLI, and MCP invoke parameterized certified blocks through one typed values-only contract and return equivalent resolved values, provenance, and redacted audit identity. |
| API-006 | Browser Ask, CLI, MCP, Chat, Notebook, Preview, and Block Studio use versioned resolved-plan, executable-plan, result-contract, and execution-receipt interfaces with identical fingerprints for equivalent requests. |
| API-007 | Every failed analytical run returns one versioned, redacted failure/repair contract binding stable code, phase, failed qualified bindings, recoverability, immutable plan/DQL/SQL fingerprints, safe actions, and derived-artifact trust transitions consistently across Browser Ask, Notebook, CLI, MCP, and Chat. |
| API-008 | Agent runs persist bounded lifecycle checkpoints and one terminal diagnostic receipt; conversation turns bind the canonical run ID so remounts hydrate the complete DQL, SQL, lineage, trust, steps, and failure contract rather than reconstructing lossy client state. |
| API-009 | Editable App plans, source preflight, existing-App changes, and publication apply only through versioned snapshot/proposal/source/app hashes and atomic commits; stale inputs return conflicts without partial writes. |
| API-010 | App repair returns a versioned trace with repair status/mode, redacted original failure, original/repaired SQL fingerprints, and explicit semantic-approval ineligibility; it never silently writes the repaired SQL into App or semantic source. |
| API-011 | DQL/dbt YAML discovery and batch model binding classify bounded inputs and produce shared, hash-guarded proposals; selection changes require server repreview. |
| API-012 | Every context-authoring path uses immutable proposal/revision IDs, exact source and snapshot fingerprints, dependency closure, compile-before-accept, atomic rollback, and stale `409` conflicts with zero partial writes. |
| API-013 | App create, edit, publish, delete, and restore operations bind an expected App revision or package fingerprint, update Git-owned source atomically, and keep recoverable local lifecycle state outside governed source. |
| API-014 | App source search is cursor-paginated and exact-resolvable; AI proposal revisions and manual/AI composition are server-owned, revision/snapshot guarded, and atomically create canonical source-to-tile bindings. |
| API-015 | Ask runtime state, typed conversation delta, compiler selection, and fact-bound answer persist in additive V5 receipts without breaking V1-V4 readers. |
| UI-001 | Domain Studio uses vertical contextual navigation; global product navigation stays stable. |
| UI-002 | dbt-owned metadata is read-only and edited only through previewed source patches. |
| UI-004 | Generated Apps render page navigation, an apply/reset filter row, a live Business Story row, KPI band, analysis tiles, detail evidence, then reviewer appendix. |
| UI-005 | App Copilot uses the canonical App run context and cannot mutate an App without an explicit previewed user action. |
| UI-006 | Domain Studio presents the nested Domain Package hierarchy and focused Areas with shareable deep links; Ask visibly preserves and can clear the selected Area context. |
| UI-007 | One Settings hub under Govern owns Overview, Project & dbt, Database, AI provider, Agent memory, and Advanced. Guided Setup launches from Settings and automatically once per project on first install and each installed CLI version change; it embeds the same project, database, and provider editors, AI is optional, saved settings remain untouched without successful test/apply, and Setup has no separate rail destination. Successful dbt Apply automatically prepares the shared governed search snapshot and exposes truthful background progress without requiring another command. |
| UI-008 | Governed Context exposes compiler-backed Domain Knowledge 360 with qualified objects, provenance, capsules, skills, and route state; business-360/API/CLI/MCP views must resolve the same snapshot and bounded neighborhood rather than independently rebuilding lineage. |
| UI-009 | Notebooks provide one searchable semantic composer for executable metrics and compatible dimensions, bounded preview/run, and insertion as a semantic DQL cell that preserves governed bindings; setup-required metrics remain discoverable with an actionable reason and navigate to the shared managed-runtime setup used by Guided Setup and Settings. |
| UI-010 | Ask renders ambiguity as identifier-bound governed choices and never presents failed grounding, policy, model, provider, or timeout outcomes as passed, reusable answers. |
| UI-012 | How it answered progressively exposes plan, DQL, compiled SQL, lineage, trust/evidence, actual steps, and stable failure details for successful and failed executable runs in the built CLI. |
| UI-013 | Capability-gated repair actions derive rather than mutate artifacts: parameter rerun, DQL repair/recompile, SQL notebook copy, snapshot refresh, authorized connection/access action, and draft-block save all show the resulting trust/review state. |
| UI-014 | Leaving and returning to Ask or another AI surface continues the accepted run in the background and hydrates current progress or the canonical terminal run without displaying a false reconnect state or dropping inspector sections. |
| UI-015 | Notebook AI uses the universal run result and exposes explicit add-cell and replace-selected-cell actions; it never edits notebook content merely because generation completed. |
| UI-016 | Block AI uses the universal run result and exposes an explicit Add to Block Studio commit that stores an ownerless review draft as DQL and opens the saved draft in the visual builder; generation alone performs no editor mutation or certification. |
| UI-017 | App Builder presents an editable Build Brief with requirement coverage, source/trust evidence, bounded previews, filters, pages, visualizations, and layout before the explicit Build Draft action. |
| UI-018 | Build Brief and App dashboard tiles visibly distinguish successful original execution, bounded repaired preview, and blocked repair; an AI-repaired semantic preview cannot enable the governed semantic approval action. |
| UI-019 | Modeling offers clean empty-state entry, batch model binding, YAML intake, and progressive relationship review while preserving the `models` deep link and Cloud theme contract. |
| UI-020 | Modeling AI uses the durable thread, evidence-bound proposal review, immutable corrections, validation handoffs, and explicit draft commit without source mutation on completion. |
| UI-021 | Skills AI uses the durable thread, guarded partial proposal review, immutable corrections, and explicit draft commit without activation or source mutation on completion. |
| UI-022 | App Studio gives manual and AI authors one canvas, contextual sources/components/filters/evidence controls, container-responsive layouts, and an explicit review-before-project-publication flow. |
| UI-023 | App Studio always labels certified/review/draft candidates, explains policy-disabled actions, sends complete source allow-lists to server composition, supports clarification revisions and explicit gap generation, and never fabricates trust-bearing tiles in React. |
| MIG-001 | Manifest v2 and legacy domain-local product paths remain readable through DQL 3.x. |
| MIG-002 | DataLex/legacy migration is deterministic, idempotent, loss-reporting, and never upgrades lifecycle. |
| MIG-003 | In-project DQL opens in place; external DQL/dbt YAML imports as reviewed sparse copies with unresolved, lossy, proof, and trust changes visible before commit. |
| MIG-004 | Readers accept legacy `review`/`unsafe`, preserve untouched spelling, and emit canonical `reviewed`/`forbidden` plus the complete DQL 2 lifecycle/fanout vocabulary on edits. |
| PERF-001 | Large projects use indexed snapshots, pagination, batch detail, and bounded graph neighborhoods. |
| PERF-002 | Ask enforces retrieval, evidence-size, provider-call, tool-call, SQL, repair, cancellation, and wall-clock budgets; simple answers never pay an open-ended planning or synthesis loop. |
| PERF-003 | Warm App exact search is p95 under 100 ms, natural-language source retrieval is p95 under 500 ms, performs zero warm artifact reads, keeps responses below 500 KB, and previews at most four tiles concurrently. |
| SEC-001 | Non-loopback serving requires authentication; wildcard CORS is not allowed there. |
| SEC-002 | App proposal, run, story, and commit trust server-owned snapshots and run evidence; clients cannot inject trusted source, result, lineage, or claim evidence. |
| SEC-003 | Search repair, runtime-value grounding, evidence packaging, and optional embeddings are allowlisted, policy-bounded, redacted, and cannot expose or persist secrets, unauthorized metadata, or plaintext sampled values. |
| SEC-004 | Analytical failure and repair never broaden permission, metadata visibility, relation scope, or route; diagnostics and stored/streamed traces redact secrets and disallowed values, while manual SQL remains bounded by connector, mutation, row, dialect, timeout, and cancellation guards. |
| E2E-001 | Release requires CLI-backed browser, agent-eval, migration, performance, and embed-contract proof. |
| E2E-002 | Release proves certified-first App planning, semantic fallback, atomic commit, filter-consistent multi-tile stories, stale-response rejection, and deterministic no-provider fallback in the built CLI UI. |
| E2E-003 | Release proves colocated and external dbt repositories, canonical and compatibility profile filenames, existing connection preservation, profile-backed runtime execution, and manifest-v3 Domain Studio compilation. |
| E2E-004 | Release proves duplicate local Area IDs across domains, explicit and inferred Area focus, Area-scoped Skills, hierarchy/deep-link round trips, and bounded context reduction in the built CLI. |
| E2E-005 | Release proves built-CLI parity across Settings and Guided Setup, automatic shared dbt snapshot/index preparation with no duplicate first-Ask rebuild, one-time first-install/version-upgrade setup prompts, all provider modes and enterprise URLs, dbt/profile/database preservation and rollback, optional-AI behavior, accurate readiness states, project-local/global npm command availability, PATH-independent internal npm resolution, and unchanged Cloud embed contracts. |
| E2E-006 | Release proves retrieval-first meaning resolution and route parity at enterprise scale: 7,000 similar/late-position metrics, 10,000 dbt models, 300,000 columns, trust-versus-relevance conflicts, bounded call budgets, accurate ambiguity, and identical built-CLI browser/CLI/MCP/Chat outcomes. |
| E2E-007 | Release proves deterministic manifest graph compilation, cross-domain route states, compact skill capsules, exact per-turn KnowledgeLens persistence, and Domain 360/Ask parity in the built CLI while preserving v2 compatibility and the Cloud embed contract. |
| E2E-008 | Release proves modern dbt semantic artifacts, filtered/simple and MetricFlow-only capability states, isolated managed MetricFlow install/test/activation, compatible metric/dimension selection, setup navigation, preview execution, and semantic-cell insertion in the built notebook. |
| E2E-009 | Release proves ambiguity selection preserves the original question and semantic identity, admits the selected backing relation into inspected SQL context, executes it, and retains truthful grounding/timeout UI states. |
| E2E-010 | Release proves named-member follow-ups bind the exact prior result value, reject otherwise-relevant assets that cannot honor the bound dimension, use at most one bounded generation call for uncovered joins, and execute only rows satisfying the binding. |
| E2E-011 | Release proves member/parameter binding, direct Ask rerun controls, first-result/Apply execution-receipt parity, transient-source preservation, derived-alias probe safety, and native/CLI/MCP invocation parity. |
| E2E-012 | Release proves the plan-first answer engine end to end: qualified retrieval, Domain/Skill selection, meaning resolution, plan binding, exact compatibility/time/join proof, single-adapter compilation, result-contract validation, typed follow-ups, bounded Research, rollback, and legacy-cascade retirement. |
| E2E-013 | Release proves complete analytical composition for revenue-today, named-customer filtering, and current-versus-prior top-customer comparison, including exact roles, governed time/completeness, additivity/join proof, ranking/output contracts, receipt-backed stories, ambiguity/gap failures, route equivalence, and cross-surface parity. |
| E2E-014 | Release proves transparent repair for missing column/relation, permission, ambiguity, dialect, drift, timeout, and result-contract failures; original artifacts remain immutable, permissions never broaden, edits follow trust transitions, and every surface returns identical failure/repair identity. |
| E2E-015 | Release proves multi-metric Ask, durable navigation/remount, complete failed-run diagnostics, canonical history hydration, explicit Notebook add/replace, and explicit ownerless Block draft commit in the built CLI. |
| E2E-016 | Release proves certified-only, semantic-only, mixed, and exploratory Personal Draft App flows; modification and stale-change rejection; publication gates; and whole-App/section Copilot plus previewed Add-to-App in the built CLI. |
| E2E-017 | Release proves App query-generation, semantic-execution, and draft-analysis repair parity with Ask/Notebook, including one-attempt bounds, same-target execution, immutable evidence, access/policy refusal, semantic trust downgrade, and unchanged successful paths in the built CLI. |
| E2E-021 | Release proves all-draft AI and manual late-position search, duplicate-name identity, filters, restart-safe receipts, source drift, provider fallback, explicit gap review, and publication blocking through the built `dql notebook` CLI. |

## App datasets and tile queries

These decisions come from
[RFC 0007](../../rfcs/0007-datasets-and-tile-queries.md). The code and tests
already cite the `APP-0xx` and `M4-*` IDs; the `M4-*` spellings are kept as
they are because the code cites them. `APP-068`–`APP-073` are new IDs for
decisions that no earlier ID covered. `APP-018`, `APP-030`, and `APP-047` are
presentation or recovery requirements, so they are recorded only in the
acceptance matrix.

| ID | Decision |
| -- | -------- |
| APP-007 | Field-based Dataset tiles are on by default. `apps.datasets: false` in `dql.config.json` is the project's off-switch (it was an opt-in, off by default, during the pilot; new projects from `dql init` and the `create-dql-app` starter still write `apps.datasets: true`). The catalog reports the feature state, and compose, AI authoring, run, save-as-block, replace, and conversion refuse with a typed `*_DISABLED` error while it is off. |
| APP-031 | An App tile may be a declarative `TileQuery` over exactly one block-backed or semantic-backed Dataset. It is persisted atomically with its `.dqld` v3 Dataset binding (source id, revision, snapshot, contract fingerprint). SQL is compiled on every run, and the tile engine never joins two Datasets. |
| APP-034 | Dataset source and field drift is detected at compile time (`APP_DATASET_SOURCE_DRIFT`, `APP_DATASET_FIELD_DRIFT`) and again against the live source at run time. A drifted tile never runs against a changed contract. |
| APP-041 | Page filters reach a Dataset only through `datasetBindings`, and cross-filters only through a declared mapping from an exact source-qualified tile output. Filters and cross-filters never match by field name. A v3 page's Dataset, filter, tile, and interaction references are validated when it is parsed and compiled. |
| APP-055 | Dataset source authoring (native grain, keys, time roles, calculated measures) produces a hash-bound source proposal from exact approved physical fields. It never declares additivity silently, never changes source trust, and never changes an App's Dataset binding. |
| APP-056 | Rebinding an App to a changed Dataset source revision or contract requires the explicit review source policy and current server authority. It rewrites the whole App binding graph atomically and marks rebound tiles `review_required`. |
| APP-057 | Rolling an aggregate Dataset above its declared grain requires run-owned, target-bound component evidence computed in the same read scope as the tile query. An unsafe distinct rollup is refused, and superseded or late proofs never become current evidence. |
| APP-058 | A review-lifecycle Dataset may produce local preview evidence only under the App's explicit `include_review_required` source policy. Governed-only preview and Project publication refuse it. |
| APP-060 | A period comparison is explicit `TileQuery.comparison` state (time field, IANA timezone, calendar, grain, completeness policy, start-inclusive/end-exclusive periods). It executes through the governed period graph and is never inferred from a title or a date control. |
| APP-061 | A hierarchy drill follows a declared Dataset hierarchy one level at a time as run-local view state. It never mutates the saved query, and returning restores the parent scope. |
| APP-062 | Measure filters apply after aggregation (`HAVING`). On the semantic route, only adapters that advertise `having` support accept them; the others refuse. |
| APP-064 | An explicit uncovered App requirement stays a visible gap. The explicit gap action routes it to an immutable, typed, review-required Dataset draft proposal and never to a SQL tile. |
| APP-065 | App Autopilot prepares Dataset changes from one fresh server-held preview, pins them to the exact source, and applies them atomically under revision and hash guards. Stale, foreign, late, or post-restart context is refused. |
| APP-066 | Ask about this chart is available only for a settled Dataset run. It uses server-issued current run context only (App, page, tile, run scope, source, fingerprints, persona). A newer run in that viewer scope, or an authored change, revokes the answer, and the answer is never publication evidence. |
| APP-067 | MCP and HTTP Dataset tools run typed TileQueries through the governed App runtime. They accept only `sourceId`, `query`, and `parameters` (no raw SQL) and return ephemeral results that never become App run, story, or publication evidence. |
| APP-068 | Every TileQuery validates to one C8 outcome (`covered`, `adapted`, `needs_review`, `rejected`) as tabled in RFC 0007. Only `covered` and `adapted` execute. The implemented adaptations are `aggregate_time_rollup` and `aggregate_entity_rollup`, and each is disclosed on the receipt. A derived tile inherits and displays its Dataset's trust and is never certified itself. Execution never changes an outcome or a lifecycle. |
| APP-069 | Tile time grains are a closed vocabulary: `second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`. Any other grain, in a query or in a Dataset's declared `timeGrain`, is rejected as `INVALID_TIME_GRAIN` and is never interpolated into SQL. |
| APP-070 | Dataset tiles compile only for `duckdb`, `file`, `postgresql`, `redshift`, `snowflake`, and `bigquery`. Other drivers refuse with `DATASET_DIALECT_UNSUPPORTED`. A dialect is added only together with a golden SQL test. BigQuery `contains` escapes with a backslash because BigQuery has no `ESCAPE` clause. |
| APP-071 | A `relative_date` preset (`last_N_days`, `today`, `yesterday`, `month_to_date`, `quarter_to_date`, `year_to_date`) resolves to an inclusive calendar range ending today in the filter's timezone and is then exactly a date range (start-inclusive, end-exclusive, local-midnight boundaries that stay correct across daylight saving). Timestamp fields require a declared IANA timezone; date fields default to UTC. |
| APP-072 | Result-cache, promotion, and equivalence identities include the active persona policy fingerprint (App id, user id, roles, RLS context, attributes), not just the App id. A persona change refuses save, replace, conversion, and chart answers that rely on an earlier run. |
| APP-073 | Save-as-block converts each positional parameter of the settled executed statement into a named `${…}` reference with a typed `params { }` default holding the value the result ran with. Anonymous placeholders, missing values, and non-scalar values refuse the save. |
| M4-CACHE-01 | The Dataset result cache is local, opt-in (`apps.datasetResultCache.enabled`), bounded, and keyed by the complete identity: Dataset, revision, contract, snapshot, target, normalized query, filter, parameter, interaction, dialect, adapter, compiler, row bound, and persona. It stores only complete ordinary physical Dataset results and labels each delivery. |
| M4-CACHE-02 | A cached delivery has no authority. It carries no executed SQL or execution provenance and cannot bind a preview or publication receipt, save, replace, or prove equivalence. Aggregate proofs, comparisons, and partial runs never use it, and Refresh always executes live. |
| M4-PROM-01 | Saving a Dataset tile as a block needs a settled, complete, live result. It creates a `draft` block under `blocks/_drafts/` carrying `dataset_tile_provenance` and leaves the tile unchanged. A period comparison cannot be saved as one block. |
| M4-REPL-01 | Replacing a tile with its saved review block is a separate explicit action. It requires current guards and a same-read-scope equivalence proof (DuckDB only today) and leaves a `review_required` block tile. |
| M4-CONV-01 | Legacy semantic → Dataset conversion is an explicit, server-owned proposal. Preview and accept each prove equivalence in one fresh read scope and preserve identity and provenance. It never happens on open or on migration. |

## Amendments

Recorded amendments to earlier locked decisions. Each states what changed, why,
and what did not change.

### A-001 — Two-tier authoring write path (amends `11-context-authoring-and-ai.md`)

`11-context-authoring-and-ai.md` required every authoring path — including
manual work — to produce an immutable `ContextAuthoringProposalV1`. In practice
that put a hash-bound YAML diff review between an author and their own typing:
writing one sentence of business context cost a server round-trip, a source
diff, and an explicit save.

Amended so that **edits to DQL-owned descriptive fields on an object that
already exists save directly**: business name, business context, concepts,
analytical role, and a subject area's name/description/intent examples. These
carry no join, lifecycle, or authorization semantics.

Everything else keeps the full proposal: creating an object, rebinding a dbt
model, asserting grain or keys, any relationship change, any lifecycle move,
cross-domain changes, dbt-source patches, YAML import, and all AI output.

**Deletion moves *into* the proposal path**, which is a net tightening — it was
previously the one write that bypassed review entirely.

### A-002 — Modeling scope is created, not demanded (amends `11-context-authoring-and-ai.md`)

`11-context-authoring-and-ai.md` states that every created or imported model
belongs to exactly one Domain and Area. That invariant is unchanged.

What changed is the failure mode. A project with no domains previously produced
blocking `MODEL_AREA_REQUIRED`/`DOMAIN_NOT_FOUND` diagnostics, and the Modeling
empty state disabled two of its three entry points — so a first-time author had
to create governance objects before they could look at their own dbt models.

DQL now synthesizes the missing `upsert_domain`/`upsert_area` operations into
the same reviewable proposal, ordered ahead of the models that depend on them.
The author reviews and edits the scope alongside the models it will hold.
Nothing is written until the proposal is committed.

"Model Area" is presented as "subject area" in the UI; the `model_area`
identifier and every persisted qualified ID are unchanged (`DOM-003`).

### A-005 — Modeling relationships and scope bind Ask (amends `04`, `05`, `12`; 2026-09-15)

Owner direction: one Modeling place, one vocabulary, and modeling that changes
what Ask does — without re-opening the A-004 decision that joins over tables
are the AI's to write.

- **Certified keys bind AI-written joins** (`REL-006`). When a drafted
  statement joins two tables a certified relationship connects, it must join
  them on exactly the certified keys; otherwise it gets the one repair every
  failed check gets and is refused if the repair still differs. Validated and
  draft relationships stay hints. The governed relational tier stays off.
- **Every join is recorded.** An AI-written answer's receipt names each join's
  two relations, its keys and the relationship it followed (certified,
  validated, draft, stale) or `none`; an undeclared join offers "Save the X → Y
  join as a relationship", which opens the builder filled in.
- **Scope is visible, never silent** (`CTX-011`). A saved Ask scope whose
  domain, subject area or pinned skill no longer exists stops the run with a
  plain message and "Clear the Ask scope"; it is never answered unscoped under a
  "Scoped to X" chip. An unscoped question whose context all came from one
  domain offers "Scope Ask to X" and never narrows on that guess by itself.
- **Author what Ask enforces** (`SKILL-007`). The skill form edits required
  filters and the enforced policy fields (date for periods, completeness,
  ranking period) and warns when a skill has no trigger words or vocabulary,
  because such a skill is never selected. Calendar, timezone and comparison
  alignment stay recorded-only and are not offered in the form.
- **Removed:** the Governed context page, the inner Modeling rail, and the
  "Validated by Ask" banner — nothing wrote that evidence since A-004.

## OSS and Cloud boundary

DQL OSS includes the complete accuracy loop for one primary dbt project:
artifact ingestion, domain modeling, skills, certified assets, relationship
safety, context routing, evaluations, local UI, CLI, and MCP. That project may
contain dbt packages, thousands of models, and many nested domains.

Cloud adds multi-repository federation, centralized identity and real RBAC,
managed approvals, hosted execution, audit retention, policy distribution, and
organization-wide discovery. OSS metadata such as `classification` is
descriptive unless a local policy adapter explicitly enforces it.
