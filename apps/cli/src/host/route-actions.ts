/**
 * WHAT A REQUEST DOES (RFC 0010, slice HH-2). Every API route maps to one
 * action and one resource, so a host's `authorize` hook can answer "may this
 * person do this?" without knowing DQL's routes. Specific rules come first;
 * anything not named reads as `project.read` (GET) or `project.write`, so a
 * new route is never more open than the project itself.
 */
export type DqlAction =
  | 'project.read'
  | 'project.write'
  | 'connection.manage'
  | 'settings.manage'
  | 'dataset.author'
  | 'dataset.certify'
  | 'hint.review'
  | 'app.view'
  | 'app.author'
  | 'app.publish'
  | 'ask'
  | 'research'
  | 'query.run'
  | 'export'
  | 'schedule.manage'
  | 'git.review'
  | 'request.create'
  | `tool.${string}`;

export interface DqlResource {
  type: 'project' | 'app' | 'app-build' | 'hint' | 'connection';
  id?: string;
}

export interface DqlRouteAction {
  action: DqlAction;
  resource: DqlResource;
}

const AUTHORING_FAMILIES = [
  '/api/blocks', '/api/block-studio', '/api/modeling', '/api/semantic-layer', '/api/semantic-builder',
  '/api/domains', '/api/domain-workspaces', '/api/domain-packages', '/api/terms', '/api/propose',
  '/api/context-proposals', '/api/context-bootstrap', '/api/onboarding', '/api/skills', '/api/datasets',
  '/api/app-datasets', '/api/lineage',
];

/** Families whose routes are asking or investigating; a route under them not listed below is classed as a change. */
const ASK_FAMILIES = ['/api/agent-runs', '/api/ask', '/api/ai', '/api/agent', '/api/llm', '/api/research-plan', '/api/notebook/research'];

/** Non-GET routes that ask: they write only the person's own runs, threads, notes and traces. */
const ASK_ROUTES: ReadonlyArray<string | RegExp> = [
  '/api/agent-runs',
  '/api/agent-runs/request-certification',
  /^\/api\/agent-runs\/[^/]+\/(cancel|repair-execution|analytical-repair)$/,
  '/api/semantic-query',
  '/api/llm/run',
  '/api/ai/sql-draft/preview',
  // Building a notebook cell with AI returns SQL and writes nothing.
  '/api/ai/build/cell',
  // A recorded correction writes a candidate hint and its trace into the project (.dql/hints, .dql/traces): it is
  // a change to the project (project.write), made where changes are made, not part of asking.
  // A person's own notes; notes for everyone are checked as project.write by the route itself.
  '/api/agent/memory',
  '/api/agent/threads',
  '/api/agent/threads/search',
  /^\/api\/agent\/threads\/[^/]+(\/(archive|promote))?$/,
];

/** Non-GET routes that investigate. */
const RESEARCH_ROUTES: ReadonlyArray<string | RegExp> = [
  '/api/research-plan',
  '/api/notebook/research',
  /^\/api\/notebook\/research\/[^/]+(\/[^/]+)?$/,
];

function under(path: string, family: string): boolean {
  return path === family || path.startsWith(`${family}/`);
}

function segment(path: string, family: string): string | undefined {
  if (!path.startsWith(`${family}/`)) return undefined;
  const raw = path.slice(family.length + 1).split('/')[0];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function resourceFor(path: string): DqlResource {
  const app = segment(path, '/api/apps');
  if (app) return { type: 'app', id: app };
  const build = segment(path, '/api/app-builds');
  if (build) return { type: 'app-build', id: build };
  const hint = segment(path, '/api/agent/hints');
  if (hint) return { type: 'hint', id: hint };
  const connection = segment(path, '/api/connections');
  if (connection) return { type: 'connection', id: connection };
  return { type: 'project' };
}

function actionFor(method: string, path: string): DqlAction {
  const read = method === 'GET' || method === 'HEAD';

  if (path === '/api/health' || path === '/api/identity' || under(path, '/api/user-prefs')) return 'project.read';

  // Changing where data comes from, and the server's own settings.
  if (under(path, '/api/connections') || path === '/api/test-connection') return read ? 'project.read' : 'connection.manage';
  if (path === '/api/persona') return read ? 'project.read' : 'app.author';
  if (under(path, '/api/settings') || under(path, '/api/server') || under(path, '/api/semantic-runtime')) return read ? 'project.read' : 'settings.manage';
  // Setting the project up and installing drivers run programs on the server (dbt, npm): the server's administrator's.
  if (!read && (under(path, '/api/onboarding') || under(path, '/api/connectors'))) return 'settings.manage';
  if (under(path, '/api/git')) return read ? 'project.read' : 'git.review';

  // Trust decisions. Every route that can leave something certified is a
  // certification: the Block Studio job route, the older synchronous route,
  // "I vouch for this — certify" on App data (`/api/app-datasets/certify`,
  // design Q1), and approving a semantic tile on an App page. Saving (a
  // notebook cell, an Ask answer, an imported candidate) only ever writes a
  // draft, and "Check and use" on a table or a saved query only leaves it
  // Checked · Needs certifying, so they are authoring, not certification.
  if (!read && (
    /\/certify(\/|$)/.test(path)
    || /^\/api\/block-studio\/certifications(\/|$)/.test(path)
    || /^\/api\/apps\/[^/]+\/dashboards\/[^/]+\/approve-semantic$/.test(path)
    // Approving a metric draft makes it answer, labelled From Metrics.
    || path === '/api/semantic-layer/metric-drafts/approve'
  )) return 'dataset.certify';
  if (!read && /^\/api\/agent\/hints\/[^/]+(\/(review|lifecycle))?$/.test(path)) return 'hint.review';
  // Ask observability (the list of recent questions and a trace's detail) is the steward's screen: people who
  // review answers open it. Everyone else's own chats stay in Ask's own history. Status, the CLI capability probe and
  // the export (an `export`) are not part of it.
  if (read && (path === '/api/ask-traces' || /^\/api\/ask-traces\/(by-run\/[^/]+|[0-9a-f]{32})$/.test(path))) return 'hint.review';

  // Taking data out.
  if (/\/export$/.test(path) || /^\/api\/apps\/[^/]+\/dashboards\/[^/]+\/snapshot$/.test(path)) return 'export';
  if (!read && /\/monitors(\/|$)/.test(path)) return 'schedule.manage';
  if (!read && /^\/api\/apps\/[^/]+\/schedules\/[^/]+\/run$/.test(path)) return 'schedule.manage';

  // Apps: readers view and run pages; authors change them; publishing is its own step.
  if (under(path, '/api/apps')) {
    // The list of every App is the project's, not one App's.
    if (path === '/api/apps') return read ? 'project.read' : 'app.author';
    if (!read && /\/(promote|publish-to-project)$/.test(path)) return 'app.publish';
    if (!read && /^\/api\/apps\/[^/]+\/ask$/.test(path)) return 'ask';
    // Following a page is reading it (HH-16): the person's own state, not the App's.
    if (/^\/api\/apps\/[^/]+\/follow$/.test(path)) return 'app.view';
    // Running a page, and its story drawn from that run, are reading it.
    if (read || /^\/api\/apps\/[^/]+\/dashboards\/[^/]+\/(run|story)$/.test(path)) return 'app.view';
    return 'app.author';
  }
  if (under(path, '/api/app-builds')) {
    if (!read && /\/(publish-to-project|commit)$/.test(path)) return 'app.publish';
    return read ? 'project.read' : 'app.author';
  }

  // What the app shows around its screens and one's own answers' facts (HH-9, HH-10): reading.
  if (under(path, '/api/host')) return read || path === '/api/host/answer-status' ? 'project.read' : 'project.write';

  // Asking and investigating, route by route: each of these keeps its effects to the person's own runs,
  // threads and notes (runtime state, never the project's files). Asking for certification is part of
  // asking: the requester is whoever is signed in. Anything else under these families changes the
  // project, so it is an authoring action (and Production's read-only rule applies to it).
  // Promoting a research run writes a draft block into the project: authoring, not investigating.
  if (!read && /^\/api\/notebook\/research\/[^/]+\/promote-dql$/.test(path)) return 'dataset.author';
  if (!read) {
    if (ASK_ROUTES.some((route) => (typeof route === 'string' ? path === route : route.test(path)))) return 'ask';
    if (RESEARCH_ROUTES.some((route) => (typeof route === 'string' ? path === route : route.test(path)))) return 'research';
    // Building with AI writes a draft block, or rewrites one in place: authoring, like any other edit.
    if (path === '/api/ai/build') return 'dataset.author';
    // Applying an App autopilot change writes the App's files.
    if (/^\/api\/agent-runs\/[^/]+\/app-autopilot-changes\/[^/]+\/apply$/.test(path)) return 'app.author';
    if (ASK_FAMILIES.some((family) => under(path, family))) return 'project.write';
  }

  // SQL the person writes themselves.
  if (!read && (path === '/api/query' || path === '/api/notebook/execute' || path === '/api/dql/artifacts/execute')) return 'query.run';
  // Proving the keys certified content declares: read-only probes as the person, counts only (RFC 0010 key proofs).
  if (!read && path === '/api/keys/prove') return 'query.run';

  // A published page runs its Dataset tiles and filter lists through these.
  if (!read && (path === '/api/app-datasets/run' || path === '/api/app-datasets/field-values')) return 'app.view';
  if (!read && path === '/api/app-datasets/enable') return 'settings.manage';
  if (!read && (path === '/api/app-datasets/tables/draft' || path === '/api/app-datasets/saved-queries/draft')) return 'dataset.author';
  // "Check and use" writes a checked Dataset that still needs certifying: authoring (design Q1).
  if (!read && (path === '/api/app-datasets/tables/create' || path === '/api/app-datasets/saved-queries/create')) return 'dataset.author';
  // Reading a saved query's result columns as fields (design D1) is part of building an App: it changes no block.
  if (!read && path === '/api/app-datasets/saved-queries/fields') return 'app.author';
  if (!read && AUTHORING_FAMILIES.some((family) => under(path, family))) return 'dataset.author';

  return read ? 'project.read' : 'project.write';
}

/** The action and resource of one API request. */
export function routeAction(method: string | undefined, path: string): DqlRouteAction {
  const verb = (method ?? 'GET').toUpperCase();
  return { action: actionFor(verb, path), resource: resourceFor(path) };
}
