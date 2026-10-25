# RFC 0010: Host hooks — who is asking, what they may see, and where state lives

| Field | Value |
|---|---|
| **Author(s)** | @KKranthi6881 (with Claude) |
| **Status** | Draft |
| **Created** | 2026-09-25 |
| **Targets** | DQL 1.18 → 1.20 (in slices) |
| **Discussion** | — |
| **Implementation** | — |
| **Supersedes** | — |

## Summary

`startLocalServer` gains one optional object, `hostHooks`. A program that
embeds DQL can use it to tell DQL:

- who is making each request;
- whether that person may do what they asked;
- which rows their queries may return;
- whose warehouse credentials to use;
- which model to call;
- where runs, memory, traces and audit events are kept;
- how tool calls are checked;
- which team documents an answer may read, with whose token.

Each hook is bound once per request through `AsyncLocalStorage`, so none of
the more than 250 routes has to pass anything new along. With no hooks,
`dql notebook` behaves exactly as it does today: one local owner, one
connection, SQLite state in the project folder.

This RFC defines the interfaces and their local defaults. It does not add
sign-in, roles, multi-tenancy, central audit or managed secrets to the open
source. Those belong to whoever supplies the hooks.

## Motivation

DQL is a strong governed engine for one person on one machine. Teams run it
on a shared server, and commercial hosts run it inside a customer's cloud
account. Both need the same engine to answer as the person asking. Today it
can't, because the single-user assumption is spread through the code:

| Assumption | Where |
|---|---|
| One shared bearer token; no idea who is asking | `local-runtime.ts` request handler (`DQL_SERVER_TOKEN` check) |
| Actors taken from the request body (`reviewer`, `author`, `owner`) or from `git config` | `metadata/identity.ts` `resolveLocalOwner`; certify, review and owner routes |
| One active persona per process, which any caller can switch | `dql-project/src/persona.ts` `defaultPersonaRegistry`; `POST /api/persona` |
| Row rules only for blocks marked `@rls`; many query sites call `executeQuery` directly, and AI-written SQL is never narrowed | `dql-compiler` `applyRLSDecorators`; direct `executor.executeQuery` calls |
| One connection per process, with credentials from project config | `startLocalServer` `let connection`; `connection-pool.ts` |
| A closed list of model providers; the "values only to a local model" rule is hard-coded to Ollama on loopback | `providers/types.ts`; `selectAssistProvider`; story and canvas draft routes |
| Runs, threads, memory and traces created with `new` against SQLite files, with no person recorded | `SqliteAgentRunStore`, `MemoryStore`, `ConversationStore`, `AskTraceSqliteStoreV1` |
| Tool calls (MCP and native) with no single place to check them | `dql-mcp` `mcpToolHandlers`; `llm/tools.ts` `buildAgentTools` |

The fix is the same for all of them. Give each assumption one named seam with
a local default, then let a host replace the default.

## Detailed design

### The request context

```ts
export interface DqlPrincipal {
  /** Stable id; for the local default, the resolved local owner. */
  id: string;
  kind: 'person' | 'service';
  displayName?: string;
  email?: string;
  groups?: string[];
  /** Values row rules can read, e.g. region, cost_center. */
  attributes?: Record<string, string | number | boolean | string[]>;
  /** HH-11: Apps the host gave this person beyond each App's own policies, by App id ('execute' runs its tiles; 'read' opens it). */
  appGrants?: Record<string, 'read' | 'execute'>;
  /** 'host' when a hook supplied it; 'link' for a read-only page link (its one App, as the owner publishes it); 'local' for the local owner. */
  source: 'local' | 'host' | 'link';
}

export interface DqlRequestContext {
  /** The signed-in person; absent when the host names no one for this request (it then reads and keeps no one's content). */
  principal?: DqlPrincipal;
  requestId: string;
  /** The route action this request was authorized as (HH-2); statements it runs carry it (HH-17). */
  action?: DqlAction;
  /** Where the request's statements' results go (HH-17): person, model, delivery or export. */
  destination?: DqlDestination;
  /** The hooks of the server this request arrived at (one process may run several servers). */
  hooks?: DqlHostHooks;
}
```

The request handler resolves the principal before dispatching a route. It
then runs the route inside `requestContext.run(ctx, …)`, using the same
`AsyncLocalStorage` pattern already used for provider evidence and Ask
traces. A host's request without anyone signed in (a host without
`resolvePrincipal`) runs with a context that names its server's hooks and no
principal.

Code reads the principal with `currentPrincipal()`. Background work (agent
runs, schedules) captures the context when it starts and restores it for
every step.

### The hooks

Every hook and field, once (`apps/cli/src/host/request-context.ts` is the source; each may also return its value
directly instead of a Promise). The defaults without a hook are in the table below.

```ts
export interface DqlHostHooks {
  // Who is asking and what they may do (HH-1, HH-2, HH-12)
  resolvePrincipal?(req: IncomingMessage): Promise<DqlPrincipal | null>;   // null → 401; replaces the shared token
  authorize?(principal: DqlPrincipal, action: DqlAction, resource: DqlResource): Promise<DqlDecision>; // reason, next
  enterpriseCertification?: boolean;      // certify with every enterprise gate; the host decides, not the request
  onePerson?: boolean;                    // one person works here (a draft space): private drafts and local datasets allowed

  // The one query path (HH-3, HH-4, HH-6, HH-17)
  rowPolicy?(query: DqlQueryContext): Promise<{ sql: string; params?: unknown[]; groupRows?: { column: string; minimum: number; refusal: string } } | { refuse: string }>;
  credentials?(input: DqlCredentialsContext): Promise<DqlCredentialsResult>;   // the person's own warehouse sign-in
  statements?(event: DqlStatementEvent): void;                                // outcome and duration, never SQL
  columnsVisible?(principal: DqlPrincipal, relation: string, columns: string[]): Promise<string[]>;
  sensitiveQuestions?: 'wording' | 'columns';
  purposeAttributes?: readonly string[];  // marks the host sets per request for where values go (rule 5)

  // Models and the privacy boundary (HH-5)
  modelProvider?(input: { principal: DqlPrincipal | null }): { id: string; provider: DqlModelProvider } | undefined;
  isInBoundary?(model: { id: string; name: string; model?: string; baseUrl?: string }, context?: { relations?: string[] }): boolean;

  // What answers show to whom (HH-9, HH-13, HH-14, HH-15)
  audience?(principal: DqlPrincipal): Promise<'stakeholder' | 'analyst' | undefined>;
  answerStatus?(principal: DqlPrincipal, runIds: string[]): Promise<Record<string, DqlAnswerStatus>>;
  sourceAccess?(principal: DqlPrincipal, sources: DqlSourceRef[]): Promise<Iterable<string>>;
  answerFigures?(principal: DqlPrincipal): Promise<'show' | 'withhold_review'>;   // only `show` shows; an error or anything else withholds
  figuresDependOnReader?(input: { relations?: string[] }): Promise<boolean>;     // an error is yes
  keepsAnswerText?(principal: DqlPrincipal, input: { appId: string }): Promise<boolean>; // an error is no
  knowledgeSources?(principal: DqlPrincipal): Promise<DqlKnowledgeServer[]>;

  // The host around DQL's screens (HH-9, HH-16)
  ui?(principal: DqlPrincipal): Promise<{
    signOutUrl?: string;
    links?: Array<{ id: string; label: string; href: string; placement: 'menu' | 'nav'; badge?: number; icon?: DqlHostIcon }>;
    answerActions?: Array<{ id: string; label: string; url: string; description?: string; on?: Array<'review' | 'unanswered' | 'answered'> }>;
    environment?: string;
    banner?: DqlHostBanner;
    audience?: 'reader';                                                         // reader words on stakeholder screens
    appNotFound?: { message: string; next?: { label: string; href: string } };  // an App link this host cannot open here
    certification?: 'proposes';                                                  // certifying here proposes; the host certifies through review, so screens say "propose"
  }>;
  homeCards?(principal: DqlPrincipal): Promise<DqlHomeCard[]>;
  follows?: { list(principal: DqlPrincipal): Promise<DqlFollow[]>; set(principal: DqlPrincipal, follow: DqlFollow, following: boolean): Promise<void> };
  pageEdition?(edition: DqlPageEdition): Promise<void>;
  directoryGroups?(principal: DqlPrincipal): Promise<DqlDirectoryGroup[]>;

  // Where state lives, and what leaves (HH-6, HH-7, HH-8)
  stores?: {
    runs?: DqlRunStore;
    memory?: (projectRoot: string) => DqlMemoryStore;
    conversations?: (defaultPath: string) => DqlConversationStore;
  };
  audit?: DqlAuditSink;
  traces?: DqlTraceSink;
  traceSalt?: string;                     // the key exported question fingerprints are keyed with
  tools?(call: { name: string; args: unknown; principal: DqlPrincipal | null }, next: () => Promise<unknown>): Promise<unknown>;
  delivery?: DeliverySink;
  signing?: SnapshotSigner;
  git?: { openPullRequest?(input: { gitRoot: string; branch: string; base: string; title: string; body: string; principal: DqlPrincipal | null }): Promise<{ url: string }> };
}
```

`LocalServerOptions` gains `hostHooks?: DqlHostHooks`. The CLI package adds
an `exports` entry for `startLocalServer` and the hook types, so an embedding
program imports a supported API rather than a file path.

### Local defaults (no hooks)

| Hook or field | Default |
|---|---|
| `resolvePrincipal` | No host: the local owner from `resolveLocalOwner`. A host without it: no one is placed, so nothing personal is read or kept (threads, runs, notes and Home are no one's and list empty), and `GET /api/identity` names no one (`{ owner: '', principal: null }`), never the machine's own owner. Either way the shared-token check keeps guarding non-loopback binds |
| `authorize` | Today's persona and App-policy checks, unchanged |
| `enterpriseCertification` | No host: the request's own choice, as today. With a host: off unless the host sets it (the request's choice is ignored) |
| `onePerson` | With a host: no (a shared server: no private drafts, no local dataset workspace). No host: one person |
| `rowPolicy` | Today's `@rls` lowering for blocks. Every other query passes through unchanged; no `groupRows` |
| `credentials` | Project config plus the local credential vault (`.dql/local/private`) |
| `statements` | Nothing is told |
| `columnsVisible` | Every column is listed |
| `sensitiveQuestions` | `wording`: Ask and Research refuse direct payment, health, contact and protected-attribute questions about individuals by their words, before planning (today's check) |
| `purposeAttributes` | None: every attribute counts when DQL finds a person's own earlier run. A value that is not a list of names names none |
| `modelProvider` | Today's provider selection. With the hook: undefined uses it too; an error, or an answer that is not `{ id, provider }`, refuses the model step in plain words (`HostModelUnavailableError`), never the project's own provider |
| `isInBoundary` | A model on this machine only: Ollama, and every address the provider can contact is a loopback URL. The Ollama provider talks to its one configured base URL (else `http://127.0.0.1:11434`) and tries no other address; a model on this machine never fails over to another provider the project has |
| `audience` | The request body's `audience`, as today. With the hook: its `stakeholder` or `analyst`; undefined leaves DQL's default; an error or any other answer means `stakeholder` |
| `answerStatus` | No status beside answers |
| `sourceAccess` | Every source |
| `answerFigures` | `show`. With the hook, only a clear `show` shows; an error or any other answer withholds |
| `figuresDependOnReader` | No host: no. A host with `rowPolicy` or `credentials`: yes. An error: yes |
| `keepsAnswerText` | `authorize` for `app.author` on the App, then `dataset.certify`. An error, or no decision: no |
| `knowledgeSources` | No host: the project's `.dql/mcp-servers.json` servers marked `use: ["knowledge"]`. A host without it: none |
| `ui` (all fields) | No host: `GET /api/host/ui` is `{ host: false }` and the screens use the single-user words. With a host and no field: no host links, actions, banner or sign-out; the screens' words and the App reader's "could not be read" message are as before |
| `homeCards` | None |
| `follows` | The person's own file in `.dql/local/private/home/` |
| `pageEdition` | Nothing is told (a scheduled edition is still recorded, without figures) |
| `directoryGroups` | The author types group names |
| `stores.*` | Today's SQLite files |
| `audit` | Nothing is told |
| `traces` | The local trace store; OTLP too when the standard `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| `traceSalt` | A key DQL makes once in `.dql/local/private/trace-salt` |
| `tools` | Pass-through |
| `delivery`, `signing`, `git` | Today's notifiers, local signing key and `gh` |

### Rules every hook follows

1. **Fail closed:**
   - a hook that throws is treated as a refusal;
   - so is an answer that is not of the hook's shape (a bare string or number where an object is due, a list, a
     wrong type): DQL refuses in its own words and never repeats the answer back (it could be SQL or a token);
   - with a host, a failure DQL did not expect while serving a request (a JavaScript runtime error) reads as a plain
     sentence with a reference of eight letters; its own text goes only to the server's log, under that reference;
   - the hooks DQL calls for status and effects read their answers the same way: `answerStatus` passes on only
     well-formed statuses (a known state, a label, a same-origin link); `delivery` counts a message delivered only
     on `{ delivered: true }`, and a sink that fails is "not delivered" with a reference; a `signing` service that
     fails, answers late or answers something that does not verify against the key it names gives no export (a
     plain refusal with a reference), never one that claims to be signed; `git.openPullRequest` must answer a web
     address or a same-origin path, else the review request is refused plainly; `pageEdition` and `traces` errors
     are logged (counted) and change nothing; a `traceSalt` that is not a non-empty text is not used;
   - a hook that does not answer in time counts as one that failed. Every hook DQL waits for has a time limit:
     decisions and stores (`resolvePrincipal`, `authorize`, `rowPolicy`, `credentials`, `columnsVisible`,
     `audience`, `ui`, `answerStatus`, `sourceAccess`, `answerFigures`, `figuresDependOnReader`, `keepsAnswerText`,
     `knowledgeSources`, `homeCards`, `directoryGroups`, `follows`, every `stores` call) get
     `LocalServerOptions.hostHookTimeoutMs`, 10 seconds unless the embedding program sets it; `delivery`, `signing`
     and `git`, which do work outside DQL, get six times that; the tool gate gets it to decide (until it calls
     `next()`), and the tool's own run is not bounded here. `resolvePrincipal` that does not answer in time is a 503
     "DQL could not check who you are right now", `authorize` a refusal "DQL could not check what you may do right
     now"; the others fail closed as they do on an error. An answer that comes after the limit is ignored. Observers
     DQL does not wait for (`audit`, `traces`, `statements`, `pageEdition`) and the synchronous model hooks
     (`modelProvider`, `isInBoundary`) have no limit;
   - `resolvePrincipal` returning null gives a 401;
   - a `DqlRefusal` from `rowPolicy` or `credentials` is shown to the person, never retried with broader rights.
2. **Never fall back to a service credential.** If `credentials` refuses (for example, the person's warehouse token has expired), the answer is "reconnect", not a quiet retry as the service account.
3. **With a host, the request body no longer names actors.** Reviews, correction authors and the default owner of new content are stamped from the host's principal, and request fields such as `reviewer` and `author` are ignored. A content `owner` the author types (for example a team) stays content metadata; only its default comes from the person. The rule set a certification uses (`enterprise`) comes from the host, not the request. With no hooks, today's behaviour is kept exactly: the local owner, and names from the body. Recording who certified what is part of the audit sink (HH-6).
4. **One query path.** Every warehouse query goes through `ExecutionService.execute` or `executePreparedAgenticSqlBoundary`, including AI-written SQL. That path calls `rowPolicy` exactly once. A test enumerates direct `executeQuery` call sites and fails when a new one appears outside the allowlist.
5. **Caches are keyed by access.** The Dataset result cache already includes the persona policy fingerprint. It adds the principal's policy fingerprint, the hash of what `rowPolicy` returned, and the credential id. A host that marks a principal per request with where its values go (for the model, a delivery) names those attributes in `purposeAttributes`: they stay in every cache and proof key, so a result read for one destination never serves another, and DQL leaves them out only to find a person's own earlier run again (a question about a chart on screen finds the chart that person ran; its rows reach a model only through `isInBoundary` with the tables they came from).
6. **Records carry the person.** Runs, threads, memory items and trace spans record `principal.id`. With no hooks this is the local owner, so existing SQLite files gain a column with a default. Ask traces (`/api/ask-traces`, by id, by run, export) follow their runs: only the asker sees them. Operations (an Ask in progress, a page run, a refresh: `/api/operations`, its live stream and cancelling) are each person's own too: with a principal, a person lists, reads, follows and cancels only operations started in their own requests, and someone else's is "not found"; work nobody asked for has no owner and is shown to no one. Cancelling a run and superseding a page run are the asker's alone. A host ends a person's open streams when their session ends (DQL has no sessions of its own).
7. **With a host, the server chooses the connection.** A request may pick one of the project's own connections by name (`executionTarget: { target: 'connection', connectionName }`); a name the project does not have is refused without being repeated back. Connection settings a request carries (`connection`) are ignored: only the project's own configuration and the `credentials` hook supply a connection's settings. `rowPolicy` and `credentials` see the name the server resolved, never one the request made up. The server's own local DuckDB workspace (`executionTarget: { target: 'local' }`) is shared by everyone the server serves, so it is refused unless the host sets `onePerson: true` (a server only one person uses). This also applies to anyone the server placed without a host (a read-only link, a scheduled run's pass). With no hooks, the notebook picks connections as before.
8. **With a host, file routes serve project content only.** The routes that open a file by path (`/api/notebook-content` read and write, `/api/notebook/file`, a block's body, a filter's block) open notebooks, blocks, Apps and their pages, domains, the semantic layer and docs (`.dqlnb`, `.dql`, `.dqld`, `.md`, `.sql`, `.yaml`, `.yml`, `.json`), never a dot folder or dotfile (`.dql/` holds caches, run traces, each person's Home state and stored secrets; `.git/`, `.github/`, `.env`), `dql.config.json`, dbt profiles, `data/`, `target/`, `node_modules/` or a database file; a symlink is judged by where it points. A refused path answers 403 whether or not it exists. The bootstrap lists only such files, names no server path and shows the default connection's kind only. A notebook's last run (`/api/run-snapshot`) is kept per person. The server's own configuration (connection settings, the server user's dbt profiles, driver install paths, which provider keys its environment holds, its folders) is shown only to someone the host lets manage connections or settings. Private notebook drafts (`.dql/local/private/notebooks`) sit in one folder for everyone a server serves, so with a host they are listed, opened, created and published only where the host sets `onePerson: true`. Single-user `dql notebook` is unchanged: its UI opens the one user's own files. Every other request field that names a file or folder follows the same rule, refused whether or not it exists: a block run by its file (`artifact.sourcePath` on `/api/dql/artifacts/execute`, a `.dql` file), a diff by path (`/api/git/diff`, matched literally, never as a pattern; the whole diff shows project content only), and what an import reads (SQL and modeling YAML imports read from a path read only project content files under it, a semantic layer import's project path, a skills folder, a dbt profiles path). A dataset is uploaded, never read from a path on the server; a semantic layer import clones only the repository the project configures; a table description reads tables, never files. Ids a request names (an import candidate, a hint, a trace) are ids, never paths (this also holds without a host).
9. **With a host, programs run on project content get a minimal environment.** Setting the project up (`/api/onboarding/*`) and installing drivers (`/api/connectors/*`) are `settings.manage`; onboarding's dbt project must be inside the project (real path), and `dbt parse` gets only where programs are, a home, a locale, a temporary folder and `DBT_*` settings, never the server's secrets. MetricFlow, which reads the project's dbt files for semantic queries, gets the same with all of dbt's `DBT_*` settings (its profile's warehouse settings).
10. **Columns a person may not see are not listed.** The optional `columnsVisible(principal, relation, columns)` hook names the columns the schema routes (`/api/schema`, `/api/describe-table`) list to that person; a hook that throws lists none of the table's columns. (The Ask vocabulary does not use it yet.)
11. **Every route is classed by what it does.** A route under the asking families (`/api/agent-runs`, `/api/ask`, `/api/ai`, `/api/agent`, `/api/llm`, research) is `ask` or `research` only when it is listed as one (it writes only the person's own runs, threads, notes and traces); any other route there is `project.write`, so a host's role ladder and read-only rules apply. Building a block with AI (`POST /api/ai/build`) is `dataset.author`; building a notebook cell (`POST /api/ai/build/cell`) returns SQL and is `ask`; applying an App autopilot change is `app.author`. With a host, a draft block built with AI is written only where one person works (`onePerson`), an edit stays on a `.dql` file inside the project, a certified block is never rewritten in place (it changes through review), the draft's owner is the signed-in person and nothing is saved in `dql.config.json`; favorites and recent items are each person's own.

### Action vocabulary (for `authorize`)

`project.read`, `project.write`, `connection.manage`, `settings.manage`,
`dataset.author`, `dataset.certify`, `hint.review`, `app.view`,
`app.author`, `app.publish`, `ask`, `research`, `query.run` (SQL the
person writes), `export`, `schedule.manage`, `git.review`, `request.create` (asked only by `GET /api/host/ui`, so Home can show "Open requests"), `tool.<name>`.

Each request maps to one action and one resource (`project`, `app`,
`app-build`, `hint`, `connection`, each with an id where the path names
one) through `routeAction(method, path)` in `apps/cli/src/host/route-actions.ts`.
Specific rules come first. Anything else is `project.read` for GET and
`project.write` otherwise, so a new route is never more open than the
project itself.

### Privacy boundary

The OSS rule stays: result values reach a model only when the model runs on
this machine. "On this machine" is judged from the provider itself: an Ollama
provider talks to one base URL (its setting, else `OLLAMA_BASE_URL`, else
`http://127.0.0.1:11434`) and never another address of its own, a model on
this machine never fails over to another provider, and the model is local only
when every address it can contact is a loopback URL. When that Ollama does not
answer, the call fails with "Ollama is not running at <url>".

A grouped tile's members are results too. A story or page draft whose model is
outside the boundary gets every binding without its value, and a grouped
tile's per-member bindings named by position (`{{tile.column[group 1]}}`, "…
for group 1"), never by member; the accepted draft is mapped back to the real
bindings before it is saved, so nothing of the member reaches that model.

A follow-up's earlier values are values too. Outside the boundary, the
earlier reading's restriction values (a member as typed, or as the warehouse
stores it) and the literals of its AI-drafted SQL reach the model named by
position (`[value 1]`), and what the model writes gets the real values back
before DQL reads it; the member-spelling lookups (a stored spelling, the
members a name could mean) are not made for such a model. `isInBoundary` generalises the check, which today is
hard-coded to Ollama on loopback, so a host can declare its own boundary.
The commercial host's wording, approved on 2026-09-25, is:

> Result values reach a model only when the model runs in the customer's own
> cloud account, in a region their admin approved, with data retention off —
> or on the person's own machine.

Every model prompt that can carry result values decides through one function,
`valuesMayReachProvider` (`apps/cli/src/local-runtime.ts`): with a host, its
`isInBoundary` (told every table the values came from when DQL knows them all;
an error or anything but `true` is no); a host without that rule, or no host
for a story or page draft and a chart question, only a model on this machine.
Without a host, the prompts the single-user product has always sent to the
model the person chose keep doing so: a conversation's memory, a follow-up's
earlier answer (the reading and the drafted SQL get it), App Autopilot's
preview, and the Research narration the person asked for. When the decision is
no, the prompt is built without values: conversation memory gives the questions
and the result columns only (and the person's own earlier messages, not the
answers); a follow-up gets the earlier reading and SQL but not the answer or the
thread's summary; App Autopilot gets the preview's columns, row count and filter
names; Research keeps the summary written from its figures without a model; a
story or page draft gets bindings without values and grouped members by
position; a chart question is answered without a model. Research narration
also needs the project's `providerResultRowEgress` switch not to be `disabled`.
`resolveProviderResultRowEgressPolicy` does not consult `isInBoundary`: it caps
the rows the dispatch ledger lets through (none for ordinary Ask, whatever the
boundary; a Research run's own opt-in up to the project's ceiling).

### Slices

Each slice ships on its own, with tests, and keeps the no-hooks behaviour
identical.

| Slice | Contents | Check |
|---|---|---|
| HH-1 | Request context, `resolvePrincipal`, `currentPrincipal()`; actors stamped from the principal; certification mode from the host; `startLocalServer` exported as `@zlens/cli/host` | A test server with a fake `resolvePrincipal` refuses unplaced requests (401, health open), answers overlapping requests as their own people, and records the principal as correction author and hint reviewer despite other names in the body; with no hooks, `/api/identity` and body-supplied names are unchanged |
| HH-2 | `authorize` at route dispatch; the persona registry reads the request context | Two concurrent requests with different principals see different App access; switching the persona in one request does not affect the other |
| HH-3 | One query path plus `rowPolicy`; cache keys by access | Call-site allowlist test; two principals, same question, different rows, from both a certified Dataset and AI-written SQL; a `rowPolicy` refusal stops the query |
| HH-4 | `credentials` and a connector factory registry (the documented plugin seam) | Pool keyed by credential id; a refusal gives "reconnect", never a service-account retry |
| HH-5 | `modelProvider`, `isInBoundary`; Bedrock and Vertex providers (OSS features in their own right) | Every prompt that can carry values decides through `valuesMayReachProvider` (`isInBoundary` with a host); a Bedrock provider passes the provider contract tests |
| HH-6 | Store interfaces and injection (runs, memory, conversations, traces, audit); OTLP trace export; asynchronous stores; statement metrics | Stores swapped for Promise-returning fakes in tests; two copies share one set; a principal id on every record |
| HH-7 | `tools` gateway around MCP and native tool calls; MCP HTTP transport with a host authenticator | A gateway that refuses `tool.run_sql` blocks it in both paths |
| HH-8 | `schedules`, `delivery`, `signing`, `git` | A schedule runs as its owner's principal; a delivery sink receives the digest |

## Progress

All slices below have landed on `main`, implemented 2026-09-25 and awaiting independent verification. Items marked **needs a live check** were built from the vendors' public documentation and tested on recorded replies, not against the live service.

### HH-1 — who is asking
`apps/cli/src/host/`. With `resolvePrincipal`, every API request except health runs as the person the host names. Unplaced requests get 401. Reviews, correction authors and the default owner of new content come from the person, never the request body. The certification rule set comes from the host. `@zlens/cli/host` exports the supported API. Tests: `host-hooks.test.ts`.

### HH-2 — what each person may do
- **Permission checks:** every placed request maps to an action and resource (`route-actions.ts`) and goes to `authorize`. A refusal answers 403 `PERMISSION_DENIED` with the action.
- **View as:** personas are kept per person (`PersonaRegistry.useSlots`), in memory for at most 5,000 people (`PERSONA_SLOT_LIMIT`); past that the least recently used person's goes, and they see Apps as themselves again.
- **People without a persona:** App policies check their own groups, never the owner default. Row rules read their attributes as `{user.<name>}`.
- **Caches:** cache and proof keys include the person, only when a host is present.

Tests: `route-actions.test.ts`, `host-hooks.test.ts`, `governance-runtime.test.ts`, dql-project `persona.test.ts`.

### HH-2 — read-only page links
`viewer-links.ts`.
- **What the link is:** on a network-shared server without a host, the Share menu's network link carries a signed viewer token for one App. It lasts 14 days, and changing the server token ends every link.
- **What it can do:** view, run and export that App's pages, and nothing else. It sees the App as the owner publishes it.
- **Apps it can't open:** Apps with per-member row rules cannot be shared by link. This is checked both when the link is made and on every request.
- **What the viewer sees:** the UI shows only that App's reader.

Checked in the built CLI. Tests: `viewer-links.test.ts`, notebook `server-auth.test.ts`.

### HH-3 — one query path
`row-policy.ts`.
- **Single entry point:** with `rowPolicy`, the server wraps its one executor. Every statement passes the policy once first: executor calls, connectors, streams, and DuckDB read scopes.
- **What the policy is told:** the person, SQL, values, tables (parser-based), connection and purpose. Schema reads are tagged `metadata`, the connector's own catalog lookups (`listTables`, `listColumns`) included: they run through this path, so the policy sees them and the statement observer (HH-6) hears of them. A statement DQL issues itself to keep its own objects (a project's data-file views) is tagged `platform`; no request sets that purpose. `platform` is an additive value of `QueryPurpose` (`'data' | 'metadata' | 'platform'`, from `@zlens/connectors`): `rowPolicy` and `credentials` may receive it, so a host that switches exhaustively on `purpose` needs a case for it (treat it like `data` unless the host wants otherwise). Statement events (HH-6) keep two purposes and report a `platform` statement as `data`.
- **Names are values:** every driver's catalog lookup binds schema and table names (and the schema search its text, and Ask's member lookups their value) as parameters, never inside the statement's text. With a host, `GET /api/describe-table` refuses a name holding a quote, a backslash or a control character (`RELATION_NAME_REFUSED`).
- **Refusals:** a refusal answers `ROW_POLICY_REFUSED` and runs nothing.
- **When the warehouse refuses a statement (any host):** the warehouse's own words can quote the statement it was sent, which after a rewrite holds the rule's predicate and the person's values. They go to the server's log under a reference of eight letters (no digits, so a host that scrubs numbers from its log keeps it whole). What DQL carries on is a `WarehouseStatementError`: the warehouse's diagnosis cut before any excerpt of the statement, with every literal only the rewrite added left out, and the reference. Ask says a plain sentence (a missing table, a column or a function the warehouse does not have, a statement it could not run) naming only the tables the statement reads, and "Ask your administrator about reference …"; the warehouse's words never reach the answer, its steps, the stream or the thread. A corrective draft of AI-written SQL still gets the diagnosis. The log line is that same diagnosis (never the excerpt, which can cut a rewrite value short), the failure's kind and the statement's own tables, so the host's predicate and its values never reach the log either. DQL's own deadline and cancellation errors pass on unchanged.
- **Guard test:** a source scan fails if server code creates another executor or connector.

Checked on real DuckDB: an admin, a CA user and a US user get all rows, CA only and US only; a user with no region is refused.

**The engine reaches the database only.** With any host, every statement on the one path reaches the connection's tables and views, whatever the host's policy decides (a policy that returns the statement as it is does not open anything more):
- DuckDB and `file` connections open restricted (`restrictExternalAccess`), after the database itself is open: external access off (no file readers, replacement scans, `COPY`, `ATTACH`, `EXPORT`/`IMPORT DATABASE`), extensions neither installed nor loaded, and the settings locked so no statement turns them back on. Every connector on the same file shares the restriction.
- A statement check (`host/engine-guard.ts`) refuses the same families on every engine where it can see them, before the policy is asked: file readers, `getenv`, queries given as text, `COPY`, `ATTACH`, `INSTALL`, `LOAD`, `PRAGMA`, `SET`/`RESET`, `EXPORT`/`IMPORT`, `PREPARE`/`EXECUTE`, `CALL`, and each engine's own: `pg_read_file` and the large-object, `query_to_xml` and session functions, `LOAD DATA` and `INTO OUTFILE`, `load_extension` and SQLite's file functions, Snowflake stages (`@stage`, `LIST`, `PUT`/`GET`, stage and query-history functions, `RESULT_SCAN`), Spark path tables (a table named by a file path, such as `csv.` with a quoted path) and `read_files`, `secret`, `reflect`, BigQuery `EXTERNAL_QUERY` and `ML.`/`AI.`/`OBJ.` functions, SQL Server `OPENROWSET`, ClickHouse table functions that reach files, URLs or other servers. The refusal is `ROW_POLICY_REFUSED` with plain text; the engine's own refusal reads the same way.
- The check reads a statement the way its engine does (`host/sql-lexicon.ts`): each engine's strings (backslash escapes, doubled quotes, `$$` and `$tag$`, triple-quoted and raw strings), quoted names (double quotes, backticks, brackets) and comments (`--`, `#`, `//`, block and executable comments). Where the engine's reading depends on a setting DQL cannot see (MySQL `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES`, Postgres `standard_conforming_strings`, Spark `escapedStringLiterals`), every reading must agree. What it cannot decide it refuses: an unterminated string or comment, a nested or executable comment, a line comment with a line break other than its own, a character outside text that engines read differently, an engine it does not know. A word that a case fold or Unicode normalisation turns into a keyword is read as that keyword.
- **Statements a person or a model writes only read**, on every connection whatever its protections (Ask, notebook cells, App tiles, the query API, MCP, Slack): one statement, a `SELECT` (or `WITH`, `VALUES`, `TABLE`, `SHOW`, `DESCRIBE`, `SUMMARIZE`, `PIVOT`, or `EXPLAIN` of one); a change to data, objects, settings or the session, a row lock or `SELECT … INTO`, an effect function (`nextval`) or several statements are refused in plain words. Statements DQL issues itself (`platform`) keep their shapes. Nor does such a statement read the warehouse's own record of other sessions, their queries, its users or its settings, engine by engine (query-history, session and activity views and their table functions, server settings and `@@` variables, SHOW of sessions, users, grants or settings; the list per engine is in docs/reference/connectors.md), matched on the statement's names in any case, quoted or not, however qualified; there is no setting to allow them. The warehouse role behind a hosted connection should still be read only, with no grant on those views: the check is a second layer, not a substitute.
- A host that checks a statement before passing it on uses the same check and reading from `@zlens/cli/host`: `hostedStatementRefusal(sql, driver, allowedDirectories, { readOnly })` (null, or the plain refusal), `lexStatement(sql, driver)` (the tokens with their positions; throws `UnreadableStatement`) and `knownLexicon(driver)`.
- `allowedDirectories` on a connection (none by default) names folders whose files stay readable through plain paths. DuckDB 1.2 and later enforce them in the engine; on DuckDB 1.1 the connection keeps external access in the engine (extensions stay out) and the statement check enforces them.
- The notebook's local dataset workspace (a draft space's uploads) reads each uploaded or staged file itself, with a private in-memory engine no statement reaches, and keeps its rows in a table of the workspace database instead of a view over the file.

Tests: `host/engine-guard.test.ts` (real DuckDB: canary file and variable never returned, tables, views, an allowed folder, a draft space's upload, no host unchanged), `drivers/duckdb.test.ts`.

### HH-4 — the person's own warehouse sign-in
`credentials` in `withHostQueryHooks`.
- **Order:** before any statement, the host lays the person's settings (token, user, role or target) over the connection. The row policy then sees the final connection.
- **Pooling:** connections are pooled by their full settings.
- **Refusals:** a refusal answers `CREDENTIALS_REQUIRED` ("reconnect"), and there is never a service-credential retry.
- **Whose connection:** with a host, the connection is the project's (rule 7): the request may only name one, and the hooks see the name the server resolved.

Checked on real DuckDB with per-person warehouses. Not built: a connector registry, and idle eviction of per-person connections.

### HH-5 — Claude on Bedrock and Vertex, and the privacy boundary (**needs a live check**)
`packages/dql-agent/src/providers/claude-cloud.ts`, with no cloud SDKs.
- **Bedrock:** InvokeModel with the `bedrock-2023-05-31` body, signed with AWS SigV4. The signing matches AWS's published "get-vanilla" test vector. Credentials come from the environment, the ECS/EKS container endpoint, or the host. Answers come back whole.
- **Vertex:** `rawPredict` and `streamRawPredict` with the `vertex-2023-10-16` body and a Google token from the environment, the metadata server, or the host.
- **Server hooks:** `modelProvider` is consulted first in provider selection. `isInBoundary` decides whether result values may reach a model, replacing the Ollama-on-loopback rule; an error means no.
- **Guardrails:** `guardrail: { id, version }` applies an Amazon Bedrock Guardrail to every call (signed request headers).

Not built: choosing Bedrock or Vertex in the Settings page. Tests: `claude-cloud.test.ts`, `host-hooks.test.ts`.

### HH-6 — audit, traces and stores
`observability.ts`.
- **Audit:** `audit` receives one event per request that changed something or was refused (who, action, resource, status, outcome). It also receives one per finished answer: trust label, SQL fingerprints and sources, with no question, SQL or values.
- **Traces:** each finished Ask trace, as the strict redacted bundle, goes to `traces` and/or as OTLP/JSON to `OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT` (**needs a live check** with a collector). Export never slows or fails an answer. The question's fingerprint (a hash of its text) leaves keyed: HMAC-SHA256 under the host's `traceSalt`, or a key DQL makes once in `.dql/local/private/trace-salt`, so it cannot be checked against likely questions elsewhere; the same question keys the same way on one install.
- **Stores:** `stores.runs|memory|conversations` replace the project's SQLite files. Every store method returns a Promise and DQL awaits each call, so a host can keep them in a shared database and run several copies of DQL for one project (update, E4). DQL's own SQLite stores answer synchronously and are used exactly as before. The ownership rules do not change: with a host, runs carry `ownerId` and read as not found for anyone else; threads carry their owner and list, search, open and continue only for them; a run interrupted because its copy of DQL stopped is closed for the person who asked. `dql-agent` exports the records the SQLite stores keep, so a host store keeps the same ones: `agentRunForStorage` / `agentRunFromStorage`, the progress pair, `interruptedAgentRun`, `newConversationThread`, `conversationTurnForStorage`, `conversationTurnSearchTags`, `memoryRecordForStorage` and `ftsTokens`. `loadConversationSnapshot` and `advanceThreadStateAsync` read and fold a thread held in any such store. Two copies sharing one set of stores continue each other's threads (`async-stores.test.ts`). What stays in one copy's memory is listed for hosts: a run's evidence for stories, snapshots and chart questions (`PersonScopedMap`), cancelling a run that copy is running, a streamed answer, and Ask traces (the project's trace file). A host sends each person's requests to one copy, or accepts that these start again after a move ("run the page again"). A store call that fails (throws or rejects) is never shown to the person in its own words: they read "DQL could not reach its saved answers (conversations, notes) right now" with a reference of eight letters, and the store's text goes to the server's log under that reference (`host/host-stores.ts`). An answer of the wrong shape is read as nothing (a list that is not a list is empty, a count that is not a number is 0), or as such a failure where DQL needs the record (a created thread, an appended turn, a request claim).
- **Statements:** `statements` hears of every warehouse statement DQL ran — the engine, whether it read data or schema, the outcome (`ok`, `error`, or `refused` by the row policy or the person's connection) and how long it took — for a host's metrics. It never sees the SQL, parameters, rows or who asked; its errors are ignored.

Not built: a hint-store factory. Tests: `observability.test.ts`, `async-stores.test.ts`, `row-policy.test.ts`, `dql-agent/src/conversation/async-store.test.ts`.

### HH-7 — one place every tool runs
`packages/dql-agent/src/agentic/tool-gate.ts`.
- **What passes the gate:** every tool an agent runs in the server, with the person asking. That covers the providers' native loops, the agent loops including `finish_answer`, and the CLI chat runners.
- **What the host can do:** check, log, reshape or refuse (throw) each call.
- **Guard test:** a source scan fails if a tool runs outside the gate.

Not built: an MCP HTTP transport with a host authenticator. Tests: `tool-gate.test.ts`, `host-hooks.test.ts`.

### HH-8 — schedules, delivery, signing and git
- **Schedules:** `POST /api/apps/:app/schedules/:schedule/run` (action `schedule.manage`) lets an outside scheduler run one App schedule as its owner. The page runs through the reader's full-page run route under a pass (`schedule-runs.ts`). The pass is random, accepted only from this machine and only for that App's page runs, lasts two minutes, and is revoked when the run ends. Permission checks and row policy therefore apply as the owner. The digest compares each run with the last run as the same person: the baseline (`.dql/local/digests`) is kept per person a run ran as, so a run someone else starts neither reads the run-as person's baseline nor sets it, and the monitors list shows each person the last run and firing monitors as they ran it.
- **Delivery:** `delivery` replaces DQL's email, Slack and webhook senders for digests and alerts.
- **Signing:** `signing` is a key service (for example a KMS or HSM Ed25519 key) that signs exported snapshots without handing out the private key. Exports record `signedBy`, and the existing verifier accepts them.
- **Git:** commits are authored as the signed-in person when they have an email. `git.openPullRequest` replaces the GitHub CLI for review requests.

Not built: moving the `dql notebook` block scheduler onto this route. Tests: `delivery-signing-git.test.ts`, `route-actions.test.ts`.

### Fixes from the first host's review
- **Certifying is a certification:** `/api/block-studio/certifications` (the route the UI uses), `/api/blocks/save-from-cell` (which certifies what it saves) and `approve-semantic` now map to `dataset.certify`; they had fallen through to `dataset.author`, so a person allowed only to author could certify. Creating a Dataset from a table and saving a cell apply the host's enterprise gates.
- **The boundary hears where values came from:** when DQL hands a model values from a run that already happened (a story drafted from a page run, a question about a chart on screen), `isInBoundary` gets `context.relations`, every table those values came from, scanned from the SQL DQL sent for each tile. When one tile's tables cannot be listed (no SQL kept, or SQL the scan cannot read), `relations` is absent and the host decides as if the values could have come from anywhere. A host that keeps some columns from the model can then refuse only the values that drew on them.
- **Chart questions respect the privacy boundary:** asking about an App chart sends its displayed rows to a model only when `isInBoundary` (or, without a host, a model on this machine) allows it; otherwise the answer is the deterministic summary, written without a model.
- **Who and for whom:** a certification request records the signed-in person, not a name in the body; Apps published or created with a host are owned by the signed-in person; the new `audience` hook decides whether answers are written for a stakeholder or an analyst (the body's `audience` is ignored); Research requested through Ask needs the `research` action.
- **Conversations belong to a person:** with a host, threads record their owner and each person lists, searches, opens and continues only their own; someone else's thread answers 404. The local notebook is unchanged.

Tests: `route-actions.test.ts`, `privacy-boundary.test.ts`, `per-person.test.ts`.

### HH-9 — the host around DQL's own screens
A host serves every role with DQL's app. It does not rebuild Ask, Apps or notebooks; it adds to them.
- **`ui(principal)`** returns what the host adds for this person: `signOutUrl`, an `environment` label, `links` (placed in the account `menu` or the side `nav`), `answerActions` (buttons on an answer that needs review, such as "Ask an analyst to check this") and an optional `banner` — a strip above every screen for something the person must keep in mind everywhere, such as "Draft space — changes go to review, not Production", with a `tone` (`info` or `caution`) and up to three links (for example "Back to Production"). Only same-origin paths are kept, at most 12 links in the side nav and 12 in the menu (each in the host's order) and 4 actions; banner text is plain text of at most 200 characters.
- **`ui(principal)`** may also say who the screens speak to and what a missing App says:
  - `audience: 'reader'` — the person reads and asks here but does not build (a hosted stakeholder). The App library then shows only All, Shared Apps and Favourites, without the local-draft and private counts, "local insights" or "Local DQL App", and Ask's header says "Certified answers first, then approved metrics, then new SQL marked Needs review". Any other value, or none, changes nothing.
  - `appNotFound: { message, next? }` — what the App reader says when this project has no such App or page (with a host, it may be in another of the host's projects): plain text of at most 200 characters, and an optional same-origin link (for example "Switch workspace"), opened as a host page. Absent: DQL's own message, as before.
- **`GET /api/host/ui`** answers `{ host: false }` without a host. With one, it answers the person, those additions and `capabilities`, which say whether each action is allowed (Ask, authoring, certifying, publishing, git review, settings and others), and `refusals`: for an action that is not allowed, the reason and the same-origin `next` link the host's `authorize` gave (HH-12). The same `authorize` hook still guards every route, so `capabilities` and `refusals` only decide what the app shows. Each capability is asked on the project; where a route asks more than one action, the map says what the route would: `export` is allowed only when `query.run` is too (exporting a statement runs it), with the refusal of whichever says no. The `app.*` and `schedule.manage` capabilities are the project-wide answer: an App's own routes ask about that App (its policies, audience and grants), so a person may still be refused on one App the map allows, or allowed on one they were given. Ask uses them: a person who may not ask is not offered the question box or suggested questions; the screen shows the host's reason and its `next` link (for example "Request access") instead.
- **In the app:**
  - Navigation hides screens the person may not use.
  - The header shows the person, the environment and sign-out.
  - A host `banner` is a strip above the header; its links open at the top level, since they may take the person to another environment (a host that runs a writable copy of a project per person, beside Production, says so here).
  - A host `nav` link opens the host's page inside DQL's main area, with `embed=1` added so the page leaves out its own frame.
  - An answer that needs review offers the host's answer actions, which POST `{ runId, question, trustState }` to the host's path.
- **A hosted page never falls back to the single-user screens.** With `resolvePrincipal`, the server marks the app's page (`<meta name="dql-hosted" content="1">`) and every answer (`X-DQL-Hosted: 1`, refusals and failures too). Until the person's map arrives the app shows only "Connecting…" (no screens, no settings, no source control, no browser-side download); it retries quickly and then every 30 seconds, and after 15 seconds says "DQL can't be reached right now" with a Reload button. A map that loaded once is kept when a later reload fails (a 502 while a worker restarts, a 429). Only a server that is not hosted may answer `{ host: false }`. `GET /api/host/ui` passes on each `ui` field only in its own shape (a list that is not a list, entries that are not objects, links that are not same-origin paths, a non-text environment: left out) and never fails because of the hook; it reads the hook's error as no additions.
- **Sign-in:** a host's 401 may carry `X-DQL-Sign-In: <same-origin path>`. The app then goes there once, with `returnTo` set to the current page, instead of asking for an access link.
- **Readers read:** without `app.author`, the App library hides Build new App, Edit and Delete, and the App opens without the View/Edit switch, personas or the local handoff.
- **No first-run review:** the host sets up the project, so `/api/onboarding/launch` never opens the installer's setup review for the people it signs in (`hostManaged: true`).

Without a host nothing changes. Tests: `per-person.test.ts` (route), `host-ui.test.tsx` (app).

### HH-10 — answers belong to who asked, and the host can follow them
- **Ownership:** with a host, every run records the signed-in person as `ownerId`. Someone else's run reads as not found wherever DQL reads runs (the run routes, traces, repair, follow-ups, Research), and the run list and count are that person's own. Runs from before the host have no owner and are hidden from host people. The SQLite store filters by owner in SQL. Notebook research runs (`/api/notebook/research*`) are kept in a store per person (`.dql/local/private/research/<person>.sqlite`) and record the signed-in person as their owner; the project's shared research store from before the host is not read with one. An App's analysis memos, App conversations and AI pins record the signed-in person as their owner and are read, run, pinned, refreshed and reused only for them (`LocalAppStorage` `owner`; a page run shows a pin's stored answer and rows only to the person who pinned it); rows from before the host have no owner and are no one's.
- **`GET /api/host/answers/:runId`** gives the host one of the caller's own answers as it may keep it: question, status, trust, the SQL and where it came from, its fingerprint, the tables it read, the trace id and the object the person had open. Never the written answer, rows or result values (`answerFactsFromRun`).
- **`answerStatus(principal, runIds)`** tells the app where the host's review of each answer stands (`requested`, `in_progress`, `checked`, `certified`, `declined`, with a label, detail and a same-origin page). `POST /api/host/answer-status` asks only about the caller's own runs. The answer shows the status in place of the host's answer actions, with Open for the page.
- **Rail links** may carry a `badge` count and one of DQL's icons (`inbox`, `requests`, `review`, `work`, `health`, `admin`, `people`, `git`, `link`).
- **Which answers get an action:** each answer action says where it applies with `on`: `review` (an AI answer no certified source backs; the default) and/or `unanswered` (DQL could not answer). Both Ask views (the Ask screen and the side panel) show them.
- **"This looks wrong" on trusted answers:** `on` also takes `answered` (a completed certified or governed answer); those actions show as a quiet link. A host's answer facts carry `sqlSha256` and `sources`, computed exactly as the answer's audit event does, so a host can find others who got the same answer.
- **Authoring stays with authors:** without `app.author` an answer has no Add to app; without `dataset.author`, no Save as block.
- **Counts stay current:** the app reloads the host's links when a same-origin host page inside it posts `{ type: 'dql-host:changed' }`, when the tab regains focus, and once a minute.

Tests: `per-person.test.ts`, `answer-facts.test.ts`, `host-ui.test.tsx`.

### HH-11 — a host's grant opens one App
A host may add `appGrants` to the principal it resolves: App id → `read` (open it) or `execute` (also run its tiles). `assertAppAccess` honours a grant before the App's own policies, so a person the host gave one App (for example after an approved access request) can use it without joining its groups. Only host principals carry grants; absent, the App's policies decide alone, as before.

Tests: `governance-runtime.test.ts`, `host-hooks.test.ts`.

### HH-12 — a refusal can say where to go
`authorize` may return `next: { label, href }` with a refusal. DQL passes it on in the 403 body only when `href` is a same-origin path (`/…`, not `//…`); the App reader shows the reason with that link, opened as a host page inside DQL, instead of "Dashboard could not be loaded". Without `next`, a refusal reads as before.

Tests: `host-hooks.test.ts`, `app-workspace-loader.test.ts`.

### Schema refresh for hosts
`startProjectRuntime` returns `syncSchema()`: it refreshes DQL's schema snapshot (table and column names, no values) through the runtime's own connection, so a DuckDB file is never opened twice. A host that applies column policies in `rowPolicy` uses it to know every protected table's columns. No project files change.

### Host follow-ups (from a hosting product's first full build)
- **Background requests:** the app marks any API request made more than 30 seconds after the person last touched the page `x-dql-background: 1` (polls, refreshes, recovery loops), so a host's idle sign-out isn't kept alive by an unattended tab.
- **App page links:** `/?app=<id>&page=<id>` opens that App page (the App's home page without `page`); the parameters are removed once read. App schedule deliveries carry `appPage { appId, pageId, title, href }` with that same-origin link, so a host can send a link-only message that opens the page.
- **Model usage:** with an audit sink, every model call's provider, model, operation and token counts (including a streamed Claude reply's) is a `model_usage` audit event for the person whose request made it — never prompt or reply text. `setProviderUsageListener` in `@zlens/agent` is the underlying listener.
- **The Apps list follows `app.view`:** with a host that authorizes, `GET /api/apps` lists only the Apps the person may open.
- **Reading a published page is `read`:** an App's `read` policy (the scaffolded `viewer` role) runs a published page's tiles; ad-hoc SQL, investigations and notebooks still need `execute`.
- **`dql app check <id> [--format json]`:** each tile's source and whether it passes the checks publication runs (a certified block, an approved semantic result with its preflight receipt, a matching Dataset binding, preflighted filters), with what would stop it publishing; exits 1 when not ready.

Tests: `server-auth.test.ts`, `ask-trace-navigation.test.ts`, `app-page-run.test.ts`, `usage-ledger.test.ts`, `observability.test.ts`, `host-hooks.test.ts`, `app.test.ts`.

### HH-13 — which certified sources a person may use
`sourceAccess(principal, sources)` gets App Datasets (`app:block:…`, `app:semantic:…`), certified blocks (their `app:block:` id when the block has a file) and metrics (`metric:<name>`), and returns the ids the person may use; an error allows none. Ask builds its vocabulary only from the admitted ones, before anything reaches the model (the cached view is keyed by the person's access), and an App page refuses just the tiles on a refused Dataset ("You don't have access to the Dataset …"), which also covers `/api/app-datasets/run` and field values. Tables themselves stay governed by row rules and warehouse permissions: a restricted Dataset is not a restricted table.

### HH-14 — figures of an answer that needs review
`answerFigures(principal)` returns `show` or `withhold_review`. For a person it withholds from, an Ask answer that needs review is stored and sent without any value: its answer text, result rows, step summaries, events, evaluations and receipts are left out, and the run keeps its trust, SQL, sources, tables and each result's column names and row count (`figuresWithheld: true`). Nothing that could quote a figure streams to that person while the run is going: no answer deltas, and each run event carries only its kind, route, status and trust (no wording, no payload: an `artifact.created` event otherwise carries the whole answer). The same decision applies on every asking door: the notebook chat cell (`/api/llm/run`) is refused for such a person, notebook research runs and App analysis memos show them their question, SQL and result shape only and are not run for them, and a repaired answer is withheld like an Ask answer. Certified and governed answers are unchanged; the host's answer actions (ask an analyst, make it certified) stay on the answer. Only a clear `show` shows: an error, or an answer that is not one of the two values (undefined, a typo, another type), withholds. The decision is taken on every read too: a run read by id while it is still going carries no wording, event payload, artifact or step note (as on the stream); a run that ended before its trust was settled (cancelled, interrupted, blocked) is withheld whole when it holds a result that is not certified or governed, and otherwise keeps its own words but none of its workings; a replay, the run list and the host's answer facts read the same way, and what the run store keeps for such a person is withheld from the first write.

**AI pins are each person's own.** With a host, an AI pin (an answer pinned to an App page from Copilot, with its stored rows) is kept for the person who pinned it and is not shared App content: the page holds its tile, but only the pinner sees its answer and rows, and refreshes and promotes it. Creating one answers with `notice: "Only you see this pin; keep it as a live tile to share it."`, and the App's pin panel and the tile say the same. To share an answer, add it as a live tile. For a person the host keeps needs-review figures from (HH-14), an AI-written pin reads as its question, SQL and result shape only, wherever it is read: when it is made, listed, refreshed, opened with its App and run on its page.

**An answer's text on an App page.** `figuresDependOnReader({ relations })` says whether figures read from those tables can differ by who reads them (a row rule, column policy, tag, or each person's own warehouse sign-in). An Ask answer added to an App page as its written text would show every reader the figures its author saw, so with a host DQL refuses it where the answer is yes: when it is added from Ask (`POST /api/app-builds/:id/ask-results`, 409 `ANSWER_FIGURES_DEPEND_ON_READER`, "This answer's figures depend on who is looking. Add it as a live tile instead."), when a draft edit or a page write adds one, and at the publish preflight. The way forward is a live tile (`mode: 'live'`), which runs the answer's own SQL (read from the person's own run, never from the browser) for each reader; its source says the question, not the figures. The tile records the tables the answer read (`sourceEvidence` of kind `answer_relation`), so the check holds later; a tile with no record is judged as if it read any table. Tiles of this kind published before are not removed: `GET /api/app-answer-tiles` lists them (ids and titles, never their text) for the stewards who replace them. Without the hook, a host with `rowPolicy` or `credentials` counts as yes; an error is yes; without a host nothing changes. Until they are replaced, everyone except the people who replace them reads a placeholder in place of their text ("This answer's figures depend on who is looking. A steward needs to replace it with a live tile.") on the page and in every run of it, and so in its stories, snapshots, digests and what agents read; `keepsAnswerText(principal, { appId })` names those people (an error is no), and without it DQL asks `authorize` for `app.author` on the App, then `dataset.certify`.

### HH-15 — knowledge sources: answers that cite documents
`knowledgeSources(principal)` returns the read-only document servers this person may use — streamable HTTP MCP endpoints, each with **this person's** headers (e.g. their own OAuth token) — as `DqlKnowledgeServer { id, label?, url, headers?, searchTool?, searchArg?, fetchTool?, fetchArg?, searchArgs?, fetchArgs? }`.
- **Who decides:** with the hook, the host alone (an error or a malformed server: none) — it returns sources only when its model may read them, as a host's model runs in its own account. A host that signs people in but has no hook gives none — a project-file key never reads a host's people's documents. Without a host, `.dql/mcp-servers.json` servers with `use: ["knowledge"]` (HTTP or stdio), and their pages reach only a model on this machine (Ollama on loopback) unless the person set `knowledge.hostedModels: true` for that server; held-back servers are named in a "Team documents not read" step.
- **DQL's own MCP client** (`@zlens/mcp` `createMcpKnowledgeSource`) reads them, so knowledge works with every provider, Bedrock, Vertex and local models included. It calls only the search and fetch tools, both on the allowlist; a server that says either writes is refused. Plain http only on this machine.
- **Ask:** after the governed answer, a bounded tool loop (`search_knowledge`, `fetch_knowledge_page`, at most three calls) runs through the HH-7 gate with the person asking; a page can be read only if a search in this answer returned it. The run gains `knowledge { note?, citations[], contextOnly: true }` and a story step. **Research:** a context source reads the best pages after framing; context is never used in a verdict.
- **The answer contract, enforced in code:** a sentence in the note that states a figure is removed; a sentence in the answer that states a figure only a document holds is removed; trust, status and sources come from the governed answer alone (citations are never read for trust).
- **Audit:** each search and page read is a `knowledge` event — source id, page id and link, outcome, result count, run and person — never the question, search words or document text.

Tests: `host/knowledge.test.ts` (Ask end to end through the server with a fake MCP document server, with and without a host), `llm/mcp-config.test.ts`, dql-agent `knowledge/knowledge.test.ts`, dql-mcp `knowledge-client.test.ts`, notebook `CitedDocuments.test.tsx`.

**Needs a live check:** Atlassian's remote MCP server (tool names and result shapes of its search and fetch, and its OAuth audience), with a real Confluence Cloud site.

### HH-16 — a Home that summarises, following pages, and who an App is for
Stakeholders open DQL to see what changed, not to start from an empty question. Every hook here has a local default, so `dql notebook` gets the same Home for its one person.
- **Home (`GET /api/home`)**, above Ask on a new chat, loaded after it: **My Apps** (the Apps the person may open — followed first, then the ones they opened last), and **What moved** on the pages they follow or opened: each page's certified or governed single figures (a KPI's value, a driver's current value, a leader's value) from the person's **own** last two complete runs of it, under one scope (filters, parameters and persona). Never another person's figures, never a tile that needs review, never rows; nothing is cached across people. Kept in `.dql/local/private/home/<person>.json` (a hash of the host's id; `local` without a host). When a scheduled run is newer than the person's last look, Home says so and shows no figure: they open the page and see it as themselves.
- **`homeCards(principal)`** adds the host's own cards to Home — for example "Open requests": a title and up to eight items with a status and a same-origin link (`GET /api/host/home-cards`, called only when Home opens; plain text, other links dropped; an error or a host slower than 5 seconds: none).
- **Follow a page** (`POST /api/apps/:app/follow { pageId, following }`, action `app.view`). With **`follows: { list, set }`** the host keeps follows, so it can tell each person about new editions through their own notification preferences; without it, follows are the person's own state in the private folder.
- **`pageEdition(edition)`**: a scheduled run of a page (HH-8's run pass) whose governed figures differ from the last scheduled run is a new edition. The host hears `{ appId, pageId, appTitle, pageTitle, href, runId, at, scheduleId }` — never a figure; the link is `/?app=…&page=…`. A reader's own run is never an edition.
- **Story editions are per person with a host.** An edition holds the values one person's run showed (their row rules); each person now has their own file, so one person's values are never listed to another. Without a host there is one file, as before.
- **Ask about this App.** The App reader has one question box for the whole App beside the per-chart questions. It is Ask with `workspaceContext.surface = 'apps'`, so the server scopes it from the App's own files (its domain and the filters on screen, `app-copilot-scope.ts`) and the answer carries the usual trust label. It is refused for someone the App's audience excludes.
- **Who an App is for: `audienceGroups`** in `dql.app.json` — identity-provider groups. **`directoryGroups(principal)`** lists the groups an author may pick (`GET /api/host/groups`; an error: none may be saved); without it the author types them. Saving is `PUT /api/apps/:app/audience { groups, text? }` (`app.author`); a host that keeps Production to reviewed changes refuses it there with its `next` link (e.g. a draft space). With a host that signs people in, an App with audience groups opens — is listed, run, exported or asked about — only for members of those groups, its owners, people the host granted it (HH-11), and people the host lets author it (so an author sees their change). Without a host it is a note that carries over.

Tests: `host/home.test.ts` (two people through the server on DuckDB: their own What moved, a scheduled edition told once without a figure, host cards, audience groups), `home/home-state.test.ts`, `story/story-editions.test.ts`, notebook `HomeSummary.test.tsx`, `StakeholderReader.test.tsx`.

### HH-15, continued — definitions and Research
- A reply that explains a governed term — an Ask definition, or a conversation reply about one — reads the person's documents under the same contract: cited, figure-free, never part of trust, the same model rule (`hostedModels`).
- Research names the servers it did not read because the model runs off this machine: a **Team documents not read** step, as in Ask.

Tests: `host/knowledge.test.ts` (a definition question), `host/knowledge-research.test.ts` (Research through the server with the fake knowledge server, read and held back).

### HH-17 — where a statement's result goes; questions and exports by column
- **`DqlQueryContext.destination`** — `person`, `model`, `delivery` or `export` — and **`action`**, the request's route action (HH-2), on every statement a request runs. DQL sets them from the request: `ask` and `research` are `model`, the two file exports below are `export` (a signed snapshot or a trace download, also the `export` action, reads a run already made and is `person`), `schedule.manage` and a scheduled run's pass are `delivery`, anything else `person`; work nobody asked for (a startup sync) has neither. The request context carries `action` and `destination`, so every statement a request starts — directly, streamed, in a read scope, or from an agent's tool — hears the same.
- **Exports are files made on the server**: `POST /api/query/export` (`{ sql, format, title?, executionTarget? }`, route action `export`; with a host the person must also be allowed `query.run`) and `POST /api/apps/:app/dashboards/:page/export` (`{ tileId, format, variables? }`, one tile of a published page, action `export` on that App). `format` is `csv`, `json` or `xlsx`. The statement runs again for the file with `destination: 'export'`, so the host's policy decides what the file may hold (mask, or refuse with a reason: 403 `EXPORT_REFUSED` for SQL, 422 for a tile). CSV text a spreadsheet would read as a formula is prefixed with `'`; Excel cells are inline strings, never formulas. An export's results are cached apart from what the person sees on screen (`destination` is part of the host principal's cache identity when it is `export`).
- **The app**: with a host, a table's CSV / JSON / Excel buttons and an App tile's **Download** items call these routes; a hosted table with no export route (an Ask answer, a Block Studio preview) offers no download, since the host decides what may leave. Without a host nothing changes: CSV and JSON are saved from the table on screen.
- **A person's own connections**: `.dql/local/private/connections.json` (`{ defaultConnection?, connections }`, outside git) adds to the project's connections, replaces one of the same name, and its `defaultConnection` wins, wherever DQL reads the project config (the notebook, `dql certify`, schedules). A host's command line writes the development copy an admin named for a workspace, so a developer's laptop never needs Production's credentials. Without the file nothing changes; the Connections page still lists and edits only the shared connections.
- **`sensitiveQuestions: 'columns'`** tells Ask and Research that the host refuses personal data by column: its `rowPolicy` refuses a `model` statement that would list classified columns (health, card data) for individuals, with a reason the person reads, and lets aggregates through ("claims by diagnosis"). The wording check for payment, health, contact and protected attributes is then skipped; regulated identifiers (SSN, passport, date of birth) and one person's pay stay refused by wording. Without the setting (and without a host) the wording check is unchanged. A row policy's refusal (`ROW_POLICY_REFUSED`) is classified `POLICY_DENIED`: nothing an automatic repair can change.

Tests: `host/exports.test.ts` (destinations from actions, SQL and tile exports as CSV, JSON and Excel with a host that masks and refuses, the screen and the file kept apart, standalone unchanged), `export/result-file.test.ts`, `private-connections.test.ts`, dql-agent `analytical-request-policy.test.ts`, `analytical-failure-repair.test.ts`.

### Answers, links and connections for hosts
- **An answer's values for its owner:** `GET /api/host/answers/:runId?values=1` adds the answer's written text and first table (at most 500 rows) to its facts — only for the answer's owner, and nothing when HH-14 withheld its figures. Without `values=1`, facts carry no value, as before.
- **A certified answer names its block:** its facts' `sources` (and its audit event's) list the certified block it ran as `block:<domain>.<name>` and `app:block:<domain>:<hash>`, the ids HH-13 `sourceAccess` hears, and `source` is `{ kind: 'block', name }` — so a host can tell whether the answer read a Dataset it restricts.
- **A link to one answer:** `/ask?run=<runId>` opens the conversation the answer was given in (`GET /api/agent-runs/:id/thread`, only for someone who may see it); otherwise plain Ask.
- **Metadata through the runtime's own connection:** `startProjectRuntime` also returns `metadataQuery(sql)` — one read-only statement (SELECT, WITH, SHOW, DESCRIBE) as metadata, e.g. a host reading warehouse tags without opening a second connection.
- **Idle connectors close:** the connection pool disconnects network connectors unused for 30 minutes and keeps at most 64 (least recently used first), since per-person sign-in makes one per person per token; local embedded databases are never evicted.
- **Governed answers are headed "Governed answer"**, not "AI-generated answer".
- **Run evidence belongs to who ran it:** the page and chart runs DQL keeps for snapshots, story drafts, chart questions and App Autopilot are found only by the person and App persona who ran them (`activePersonaPolicyFingerprint`); a run id alone reads as not current.

### Key proofs: checking the keys certified content declares
`POST /api/keys/prove` (action `query.run`) proves, as the person asking, the keys certified content declares: each certified block Dataset with a declared grain (`grain = { keys = [...], keyEvidence = "..." }`) runs DQL's own grain proof (the same complete-source probe `POST /api/datasets/validate-grain` runs), and each certified modeling join with keys runs DQL's own relationship validation (the statement `POST /api/modeling/dbt-first/relationships/validate` runs). Both go through the one query path, so the host's row policy and per-person credentials apply.
- **Narrowing:** `blocks` (block names or file paths) and `relationships` (ids, qualified ids or source paths) limit it to what a change touched; without them it proves everything certified that declares keys.
- **What comes back:** per Dataset its keys, `status` (`passed`, `failed` or `error`) and `uniqueness` (row, distinct-key, null-key and duplicate-key counts); per join its keys, cardinality, `status` and the validation's counts; `ok` when every one passed. Never a row or a key value. A Dataset proof keeps DQL's local, git-ignored proof evidence as `validate-grain` does; nothing else is written.
- **Why a route:** both proofs existed only behind authoring routes (`dataset.author`), which a host refuses where Production follows main and in a pull request's read-only preview. Proving keys only reads, so it is `query.run`.

The first host runs it on a pull request's preview as the steward reviewing it, and shows the result as the change's "Keys proven" check. Tests: `datasets/key-proofs.test.ts` (real DuckDB), `route-actions.test.ts`.

### One process, several servers
Every server runs each request it answers, and the work its startup begins, in its own scope (`withServerScope`), and each request carries its server's hooks in its request context. So a host that runs Production and pull request previews in one process — or a server without a host beside them — never has one server's git, delivery, model, privacy boundary, tool-gate or usage hooks used for another's: a server without a host uses none of a host's, and "view as" (the App persona) is kept per person and per server. The process-wide values serve only work outside every server (a host's own call into DQL code), and are a host's hooks only while every server running in the process has the same ones; with servers whose hooks differ they are empty. Starting or stopping a server never removes another's tool gate (one gate serves the process and asks the current work's server). A runtime's `close()` also ends open event streams (a browser tab with DQL open used to hold it forever), a host's own model id (`bedrock`, `vertex`) no longer fails the local provider settings, and `dql app ls` / `GET /api/apps` (without a host) name App files that don't load and why.

Tests: `host-hooks.test.ts`, `host-scope.test.ts`, `scoped-hooks.test.ts`, `notebook.test.ts`, `provider-settings.test.ts`, `app.test.ts`.

### Entry point
`@zlens/cli/host` also exports `startProjectRuntime`: the full server with its UI for one project, as `dql notebook` runs it, taking `hostHooks`, `allowedOrigins` and a host-managed `connection`. The first host starts every workspace this way.

### Needs a live check before release
1. Claude on Amazon Bedrock (in-region and Geo profile model ids, long answers, tool use) with real AWS credentials, and from an ECS task role.
2. Claude on Google Vertex AI (regional, `us`/`eu` multi-region and global endpoints; streaming) with a real service account and from the metadata server.
3. OTLP trace export to a real collector (for example the AWS Distro for OpenTelemetry or the Google Cloud telemetry endpoint).
4. `credentials` against a real per-user warehouse sign-in (Snowflake External OAuth or Databricks OAuth).
5. A snapshot signed by a real KMS/HSM Ed25519 key.
6. `git.openPullRequest` through a GitHub App, and delivery through a real Slack app and mail service.

## Backward compatibility

Nothing changes for projects or for `dql notebook` with no hooks.

- The new principal columns are added with a default of the local owner.
- `dql.config.json`, `.dql` files and the manifest are unchanged.
- The one visible change is that the certify and review routes stop trusting
  actor fields in the request body when a principal exists. With no hooks, the
  principal is the local owner, which is what the UI already sends.

## Security considerations

- **Why the request body stops naming actors.** Today, anyone who can reach the server can certify in someone else's name. After HH-1, only the server can say who acted.
- **The one query path protects against more than row rules.** It is also where read-only checking, deadlines and cost guards are enforced for every query, not only those that remember to call it.
- **Hooks run in-process with full trust.** A host that loads untrusted hooks has already lost. The contract gives no sandbox.
- **Why the engine is restricted, not only the statement.** A statement check reads text; an engine can be reached in more ways than any check lists. With a host, DuckDB's own settings close files, extensions and settings, and the check is the second layer (and the only DQL-side one for engines whose settings DQL does not control).
- **Why a request only names a connection (rule 7).** A request names one of the project's connections; the project's config and the credentials hook supply its settings, so row rules scoped to a connection hold.

## Alternatives considered

- **Fork DQL for commercial hosting.** Every OSS release would become merge work. An earlier host embed drifted three months behind for this reason.
- **Put a proxy in front of the server.** It can check who is asking, but it can't narrow AI-written SQL, stamp certification actors or key caches by access. Those decisions live inside the engine.
- **Pass the principal as a parameter through every call.** That touches hundreds of call sites. `AsyncLocalStorage` is already used for the same purpose in this file.
- **Build sign-in and roles into OSS.** Out of scope by the OSS boundary (AGENTS.md, `delivery-orchestration.md`).

## Unresolved questions

1. **Scope of `routeAction` for HH-2.** Should the first cut cover only routes that change state and routes that read data, with everything else treated as `project.read`?
2. **Store migration.** When a host supplies Postgres stores, do we provide a one-time import from existing SQLite files, or start empty?
3. ~~**Viewer links.**~~ Resolved in HH-2: network links are signed, read-only, one-App viewer links (see Progress).

## Adoption signal

- A commercial host runs DQL unchanged with its own sign-in, row rules and
  stores.
- Teams on a shared server can see who certified what.
- The `executeQuery` allowlist test stays green release after release.

## Process

Implement slice by slice on short branches. Each slice goes through
independent verification before it lands on main. OSS releases follow the
normal quiet-release path. Nothing in this RFC is pushed or published
without the owner's go-ahead.
