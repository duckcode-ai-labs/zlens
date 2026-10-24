import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProvider } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { WITHHELD_ANSWER } from './host/answer-figures.js';
import type { DqlPrincipal } from './host/request-context.js';

/**
 * ZLens 0.1.0 e2e N3: on the App `give-me-top-5-players-who`, the App's own
 * Ask control was asked "Which player is ranked first in this App, and what
 * source supports that result?". The page showed James Harden first, read
 * from a review-required draft block, and the answer said it could not see
 * the App's ranking or its source: the request named the App and its filters
 * but nothing the page showed.
 *
 * The App Ask now names the page run it was asked from; the server reads that
 * run's tiles, sources, trust labels and rows from its own evidence and
 * answers from them, labelled with the weakest trust it read.
 */
const QUESTION = 'Which player is ranked first in this App, and what source supports that result?';
const TOP5 = [
  { rank: 1, player_name: 'James Harden', points_2016: 2646, points_2017: 2888, total_points_2016_2017: 5534 },
  { rank: 2, player_name: 'LeBron James', points_2016: 2511, points_2017: 2820, total_points_2016_2017: 5331 },
  { rank: 3, player_name: 'Russell Westbrook', points_2016: 2610, points_2017: 2642, total_points_2016_2017: 5252 },
  { rank: 4, player_name: 'Anthony Davis', points_2016: 2420, points_2017: 2588, total_points_2016_2017: 5008 },
  { rank: 5, player_name: 'Kevin Durant', points_2016: 2290, points_2017: 2490, total_points_2016_2017: 4780 },
];
const TEAMS = [{ team: 'Rockets', wins: 79 }, { team: 'Warriors', wins: 70 }];

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-app-view-ask-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'nba' }));
  mkdirSync(join(root, 'blocks', '_drafts'), { recursive: true });
  // The e2e App's tile: an uncertified draft block.
  writeFileSync(join(root, 'blocks', '_drafts', 'top_5_players_points_2016_2017.dql'), `// dql-format: 1
block "top_5_players_points_2016_2017" {
  domain = "uncategorized"
  owner = "analytics"
  description = "Top 5 players ranked by total points scored across 2016 and 2017."
  query {
    sql = """
SELECT rank, player_name, points_2016, points_2017, total_points_2016_2017 FROM player_points_ranked WHERE rank <= 5 ORDER BY rank
    """
  }
  visualization { chart = "table" }
}
`);
  // A second tile from a certified block, so one page holds both trust states.
  writeFileSync(join(root, 'blocks', 'team_wins.dql'), `block "team_wins" {
  domain = "uncategorized"
  type = "custom"
  status = "certified"
  owner = "analytics"
  description = "Team wins in the 2017 season."
  query = """
SELECT team, wins FROM team_wins_2017 ORDER BY wins DESC
  """
  visualization { chart = "table" }
}
`);
  const appDir = join(root, 'apps', 'give-me-top-5-players-who');
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
    version: 1, id: 'give-me-top-5-players-who', name: 'Give Me Top 5 Players Who', domain: 'business', visibility: 'shared',
    audience: 'stakeholders', lifecycle: 'draft', owners: ['analytics'], homepage: { type: 'dashboard', id: 'overview' },
  }));
  writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), JSON.stringify({
    version: 1,
    id: 'overview',
    metadata: { title: 'Business Overview', domain: 'business' },
    filters: [{ id: 'period', type: 'daterange', bindsTo: 'date' }],
    layout: {
      kind: 'grid', cols: 12, rowHeight: 80,
      items: [
        { i: 'top-5-players-points-2016-2017', x: 0, y: 0, w: 6, h: 4, block: { ref: 'blocks/_drafts/top_5_players_points_2016_2017.dql' }, viz: { type: 'table' }, title: 'top_5_players_points_2016_2017' },
        { i: 'team-wins', x: 6, y: 0, w: 6, h: 4, block: { ref: 'blocks/team_wins.dql' }, viz: { type: 'table' }, title: 'Team wins 2017' },
      ],
    },
  }));
  // A second App, certified, for the one-conversation-per-App checks.
  const certifiedDir = join(root, 'apps', 'certified-team-wins');
  mkdirSync(join(certifiedDir, 'dashboards'), { recursive: true });
  writeFileSync(join(certifiedDir, 'dql.app.json'), JSON.stringify({
    version: 1, id: 'certified-team-wins', name: 'Certified Team Wins', domain: 'business', visibility: 'shared',
    audience: 'stakeholders', lifecycle: 'draft', owners: ['analytics'], homepage: { type: 'dashboard', id: 'overview' },
  }));
  writeFileSync(join(certifiedDir, 'dashboards', 'overview.dqld'), JSON.stringify({
    version: 1,
    id: 'overview',
    metadata: { title: 'Team Overview', domain: 'business' },
    layout: {
      kind: 'grid', cols: 12, rowHeight: 80,
      items: [{ i: 'team-wins', x: 0, y: 0, w: 6, h: 4, block: { ref: 'blocks/team_wins.dql' }, viz: { type: 'table' }, title: 'Team wins 2017' }],
    },
  }));
  return root;
}

/** The certified App's top 5: no rank column, ordered and limited by its SQL. */
const TOP5_UNRANKED = [
  { player_name: 'James Harden', total_points: 5534, games_played: 189 },
  { player_name: 'LeBron James', total_points: 5331, games_played: 214 },
  { player_name: 'Russell Westbrook', total_points: 5252, games_played: 198 },
  { player_name: 'Stephen Curry', total_points: 5251, games_played: 201 },
  { player_name: 'Kevin Durant', total_points: 4835, games_played: 188 },
];

function writeUnrankedTopFiveApp(root: string): void {
  writeFileSync(join(root, 'blocks', 'top_scorers.dql'), `block "Scorers 2016 2017" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics"
  description = "The five players with the most points across 2016 and 2017."
  params {
    top_n = 5
  }
  query = """
SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points, COUNT(DISTINCT game_id) AS games_played
FROM int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) BETWEEN 2016 AND 2017
GROUP BY player_name
ORDER BY total_points DESC, player_name ASC
LIMIT \${top_n}
  """
  visualization { chart = "table" }
}
`);
  const appDir = join(root, 'apps', 'certified-scorers');
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
    version: 1, id: 'certified-scorers', name: 'Certified Scorers', domain: 'nba', visibility: 'shared',
    audience: 'stakeholders', lifecycle: 'draft', owners: ['analytics'], homepage: { type: 'dashboard', id: 'overview' },
  }));
  writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), JSON.stringify({
    version: 1,
    id: 'overview',
    metadata: { title: 'Scorers', domain: 'nba' },
    layout: {
      kind: 'grid', cols: 12, rowHeight: 80,
      // A title with no "Top" in it: the block's ORDER BY … LIMIT says it is a top 5.
      items: [{ i: 'scorers', x: 0, y: 0, w: 8, h: 4, block: { ref: 'blocks/top_scorers.dql' }, viz: { type: 'bar' }, title: 'Scorers 2016 2017' }],
    },
  }));
}

const executor = {
  executeQuery: async (sql: string) => {
    const rows = /team_wins_2017/.test(sql) ? TEAMS : /player_points_ranked/.test(sql) ? TOP5 : /int_player_stats/.test(sql) ? TOP5_UNRANKED : [{ value: 1 }];
    return { columns: Object.keys(rows[0]!), rows, rowCount: rows.length, sql };
  },
} as unknown as QueryExecutor;

type Seen = { prompts: string[] };

/**
 * A deterministic model: it answers from APP_VIEW_CONTEXT the way a model
 * would (the first row of the tile the question is about) and declines
 * everything else, so the Ask pipeline cannot invent an answer.
 */
function appViewModel(seen: Seen): AgentProvider {
  return {
    // A stand-in, not a model on this machine: the boundary decides by the host's rule, never by this name.
    name: 'openai',
    available: async () => true,
    generate: async (messages) => {
      const text = messages.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n');
      seen.prompts.push(text);
      const marker = text.indexOf('APP_VIEW_CONTEXT:\n');
      if (marker < 0) return '{"declined": true}';
      const context = JSON.parse(text.slice(marker + 'APP_VIEW_CONTEXT:\n'.length)) as { tiles: Array<{ tileId: string; rowsShown?: Array<Record<string, unknown>> }> };
      const wantsTeams = /\bteam/i.test(text.slice(0, marker));
      const tile = context.tiles.find((candidate) => (wantsTeams ? candidate.tileId === 'team-wins' : candidate.tileId !== 'team-wins'));
      const first = tile?.rowsShown?.[0];
      if (!tile || !first) return '{"answerable": false, "reason": "no rows"}';
      const name = String(first.player_name ?? first.team);
      return `<think>reading the page</think>\n\`\`\`json\n${JSON.stringify({ answerable: true, answer: `${name} is first on this page.`, tileIds: [tile.tileId] })}\n\`\`\``;
    },
  };
}

async function start(options: { hostRule?: 'show' | 'withhold_review'; extend?: (root: string) => void } = {}) {
  const root = writeProject();
  options.extend?.(root);
  const seen: Seen = { prompts: [] };
  const hostRule = options.hostRule;
  const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'file' },
    preferredPort: 0,
    askAnalyticalPlannerProviderFactory: () => appViewModel(seen),
    ...(hostRule ? { hostHooks: { resolvePrincipal: () => priya, answerFigures: () => hostRule } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
  return { post, get, seen };
}

async function runPage(post: Awaited<ReturnType<typeof start>>['post']): Promise<string> {
  const page = await post('/api/apps/give-me-top-5-players-who/dashboards/overview/run', { variables: {} });
  expect(page.status, page.text.slice(0, 400)).toBe(200);
  expect(page.body.tiles.map((tile: { status: string }) => tile.status)).toEqual(['ok', 'ok']);
  return page.body.runId as string;
}

/** The App page's Ask control: what AppsView sends for "Ask about this App". */
function appAsk(question: string, dashboardRunId?: string) {
  return {
    question,
    requestedMode: 'ask',
    audience: 'stakeholder',
    selectedObject: { kind: 'app', id: 'give-me-top-5-players-who', title: 'Give Me Top 5 Players Who' },
    workspaceContext: {
      surface: 'apps',
      appId: 'give-me-top-5-players-who',
      appName: 'Give Me Top 5 Players Who',
      dashboardId: 'overview',
      dashboardTitle: 'Business Overview',
      dashboardFilters: {},
      ...(dashboardRunId ? { dashboardRunId } : {}),
    },
  };
}

describe('Ask from an App sees that App (N3)', () => {
  it('answers "ranked first in this App" from the page run, citing the draft tile as needing review', async () => {
    const { post, seen } = await start();
    const pageRunId = await runPage(post);
    const asked = await post('/api/agent-runs', appAsk(QUESTION, pageRunId));
    expect(asked.status, asked.text.slice(0, 600)).toBe(201);
    const run = asked.body.run;

    // The model was given the App's own context: the page, its tiles, their sources and trust, and the rows shown.
    const prompt = seen.prompts.find((entry) => entry.includes('APP_VIEW_CONTEXT'));
    expect(prompt).toBeDefined();
    const context = JSON.parse(prompt!.slice(prompt!.indexOf('APP_VIEW_CONTEXT:\n') + 'APP_VIEW_CONTEXT:\n'.length));
    expect(context).toMatchObject({ app: 'Give Me Top 5 Players Who', page: 'Business Overview' });
    expect(context.tiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tileId: 'top-5-players-points-2016-2017',
        // The tile's own trust, in the App's two words (T1).
        trust: 'Not certified yet',
        source: expect.objectContaining({ kind: 'block', name: 'top_5_players_points_2016_2017', path: 'blocks/_drafts/top_5_players_points_2016_2017.dql' }),
        rowsShown: expect.arrayContaining([expect.objectContaining({ rank: 1, player_name: 'James Harden' })]),
      }),
      expect.objectContaining({ tileId: 'team-wins', trust: 'Certified' }),
    ]));

    // The answer reads the App's result, cites the tile's block, and is labelled for review, not certified.
    expect(run.answer).toContain('James Harden');
    expect(run.answer).toContain('blocks/_drafts/top_5_players_points_2016_2017.dql');
    // It names the block the way readers know it: a saved query (#165).
    expect(run.answer).toMatch(/reads saved query \S+ \(blocks\/_drafts\/top_5_players_points_2016_2017\.dql\)/);
    expect(run.answer).not.toContain('reads block');
    // It cites the tile's own trust words; the answer itself stays labelled for review (Ask's labels are unchanged).
    expect(run.answer).toContain('Not certified yet');
    expect(run.trustState).toBe('review_required');
    expect(run.trustState).not.toBe('certified');
    const answer = (run.artifacts ?? []).find((artifact: { kind: string }) => artifact.kind === 'answer');
    expect(answer).toMatchObject({ trustState: 'review_required', payload: { appView: { pageRunId, tiles: [{ tileId: 'top-5-players-points-2016-2017', trust: { state: 'review', label: 'Not certified yet' } }] } } });
  });

  it('labels an answer read only from a certified tile as certified', async () => {
    const { post } = await start();
    const pageRunId = await runPage(post);
    const asked = await post('/api/agent-runs', appAsk('Which team has the most wins on this page?', pageRunId));
    expect(asked.status, asked.text.slice(0, 600)).toBe(201);
    expect(asked.body.run.answer).toContain('Rockets');
    expect(asked.body.run.answer).toContain('team_wins');
    expect(asked.body.run.trustState).toBe('certified');
  });

  it('says it cannot see the page results, rather than answering past them, when it has no page run', async () => {
    const { post, seen } = await start();
    await runPage(post);
    const forged = await post('/api/agent-runs', appAsk(QUESTION, 'not-a-run-of-this-page'));
    expect(forged.status, forged.text.slice(0, 600)).toBe(201);
    expect(forged.body.run.answer).toMatch(/can't see this page's current results/);
    expect(forged.body.run.answer).not.toContain('James Harden');
    expect(seen.prompts.some((entry) => entry.includes('APP_VIEW_CONTEXT'))).toBe(false);
  });

  it('keeps the page values out of a model outside the privacy boundary (HH-5)', async () => {
    const { post, seen } = await start({ hostRule: 'show' });
    const pageRunId = await runPage(post);
    const asked = await post('/api/agent-runs', appAsk(QUESTION, pageRunId));
    expect(asked.status, asked.text.slice(0, 600)).toBe(201);
    expect(seen.prompts.some((entry) => entry.includes('James Harden'))).toBe(false);
    // Read from the page without a model, and still labelled for review.
    expect(asked.body.run.answer).toMatch(/no model wrote this/);
    expect(asked.body.run.answer).toContain('James Harden');
    expect(asked.body.run.trustState).toBe('review_required');
  });

  it('withholds the answer from a person the host keeps needs-review figures from (HH-14)', async () => {
    const { post } = await start({ hostRule: 'withhold_review' });
    const pageRunId = await runPage(post);
    const asked = await post('/api/agent-runs', appAsk(QUESTION, pageRunId));
    expect(asked.status, asked.text.slice(0, 600)).toBe(201);
    expect(asked.text).not.toContain('James Harden');
    // Search for the withheld figure only outside generated ids, hashes and
    // timestamps: a random run id such as 5f28884c-… can contain "2888".
    const withoutIds = asked.text
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/(?:sha256:)?[0-9a-f]{32,64}/gi, '<hash>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
    expect(withoutIds).not.toContain('2888');
    expect(asked.body.run.answer).toBe(WITHHELD_ANSWER);
  });
});

describe('one Ask conversation per App page (0.1.0 re-test #2)', () => {
  it('never continues, or saves into, the conversation of another App', async () => {
    const { post, get } = await start();
    const pageRunId = await runPage(post);
    const created = await post('/api/agent/threads', { surface: 'apps', title: QUESTION });
    expect(created.status, created.text.slice(0, 400)).toBeLessThan(300);
    const threadId = created.body.thread.id as string;

    const first = await post('/api/agent-runs', { ...appAsk(QUESTION, pageRunId), threadId });
    expect(first.status, first.text.slice(0, 600)).toBe(201);
    const afterFirst = await get(`/api/agent/threads/${threadId}`);
    expect(afterFirst.body.thread.scopeKey).toBe('app:give-me-top-5-players-who:overview');
    expect(afterFirst.body.turns).toHaveLength(1);

    // The re-test: the certified App's question arrived on the first App's thread.
    const other = await post('/api/agent-runs', {
      question: 'Which team has the most wins on this page?',
      requestedMode: 'ask',
      audience: 'stakeholder',
      threadId,
      selectedObject: { kind: 'app', id: 'certified-team-wins', title: 'Certified Team Wins' },
      workspaceContext: { surface: 'apps', appId: 'certified-team-wins', appName: 'Certified Team Wins', dashboardId: 'overview', dashboardTitle: 'Team Overview', dashboardFilters: {} },
    });
    expect(other.status, other.text.slice(0, 600)).toBe(201);
    // The first App's answer was not its context, and its answer is not saved into the first App's thread.
    expect(other.body.run.conversationBinding ?? 'none').toBe('none');
    const afterOther = await get(`/api/agent/threads/${threadId}`);
    expect(afterOther.body.turns).toHaveLength(1);
    expect(afterOther.body.turns[0].question).toBe(QUESTION);

    // The same App page continues its own thread.
    const again = await post('/api/agent-runs', { ...appAsk('Which team has the most wins on this page?', pageRunId), threadId });
    expect(again.status, again.text.slice(0, 600)).toBe(201);
    expect((await get(`/api/agent/threads/${threadId}`)).body.turns).toHaveLength(2);
  });
});

describe('the App page story never treats a rank as a measure (0.1.0 re-test #1)', () => {
  it('names the player ranked first on total points, and sums no rank', async () => {
    const { post } = await start();
    const page = await post('/api/apps/give-me-top-5-players-who/dashboards/overview/run', { variables: {} });
    expect(page.status, page.text.slice(0, 400)).toBe(200);
    const story = [page.body.story?.headline, ...(page.body.story?.paragraphs ?? [])].join(' ');
    expect(story).toContain('**James Harden** is ranked first, with **5,534** total points 2016 2017');
    expect(story).not.toMatch(/rank is/i);
    expect(story).not.toContain('Kevin Durant');
    // The certified tile beside it still reads normally.
    expect(story).toContain('Rockets: 79');
  });

  it('leads a top 5 with no rank column with its first row and never sums it', async () => {
    const { post } = await start({ extend: writeUnrankedTopFiveApp });
    const page = await post('/api/apps/certified-scorers/dashboards/overview/run', { variables: {} });
    expect(page.status, page.text.slice(0, 400)).toBe(200);
    expect(page.body.tiles[0].ordering).toMatchObject({ kind: 'top_n', reason: 'order_limit', orderColumn: 'total_points', direction: 'desc' });
    const story = [page.body.story?.headline, ...(page.body.story?.paragraphs ?? [])].join(' ');
    expect(story).toContain('**James Harden** leads with **5,534** total points');
    // Not "total points is 26,203" (the five players summed), nor 990 games.
    expect(story).not.toContain('26,203');
    expect(story).not.toContain('990');
  });
});
