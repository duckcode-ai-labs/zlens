import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryExecutor } from '@zlens/connectors';
import { createRuntimePageRunner, summarizeAppPageRun, type AppPageRunTile } from './app-page-run.js';
import { createWebhookNotifier } from './notifiers/webhook.js';
import { runAppDashboard } from './runner.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/app-datasets-pilot', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const okResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const tiles: AppPageRunTile[] = [
  { tileId: 'revenue', title: 'Revenue', status: 'ok', tileType: 'dataset', vizType: 'kpi', certificationStatus: 'certified', columns: ['revenue'], rows: [{ revenue: 4212940 }], rowCount: 1 },
  { tileId: 'by-region', title: 'Revenue by region', status: 'ok', tileType: 'dataset', vizType: 'bar', certificationStatus: 'certified', columns: ['region', 'revenue'], rows: [{ region: 'US', revenue: 1 }, { region: 'EU', revenue: 2 }], rowCount: 2 },
  { tileId: 'margin', title: 'Margin rate', status: 'error', tileType: 'semantic', columns: [], rows: [], rowCount: 0, error: 'The warehouse timed out.' },
  { tileId: 'note', title: 'Note', status: 'ok', tileType: 'text', columns: [], rows: [], rowCount: 0 },
];

describe('scheduled App page runs (RFC 0008 step 3c)', () => {
  it('asks the runtime for a full page run and reads every tile kind', async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      tiles: [
        { tileId: 'k', status: 'ok', tileType: 'dataset', title: 'Revenue', viz: { type: 'kpi' }, trustState: 'certified', result: { columns: [{ name: 'revenue' }], rows: [{ revenue: 10 }], rowCount: 1 } },
        { tileId: 'b', status: 'ok', tileType: 'block', certificationStatus: 'certified', viz: { type: 'bar' }, result: { columns: ['region'], rows: [{ region: 'EU' }] } },
        { tileId: 'e', status: 'error', tileType: 'semantic', error: 'boom' },
      ],
    }));
    const run = await createRuntimePageRunner('http://127.0.0.1:9/', fetchImpl as unknown as typeof fetch)('commerce-pilot', 'overview');
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9/api/apps/commerce-pilot/dashboards/overview/run', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ fullRun: true, variables: {} }),
    }));
    expect(run).toEqual([
      expect.objectContaining({ tileId: 'k', vizType: 'kpi', certificationStatus: 'certified', columns: ['revenue'], rowCount: 1 }),
      expect.objectContaining({ tileId: 'b', tileType: 'block', rowCount: 1 }),
      expect.objectContaining({ tileId: 'e', status: 'error', error: 'boom' }),
    ]);
  });

  it('surfaces a refused page run as an error', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ error: 'Dashboard "x" not found in App "y"' }, 404));
    await expect(createRuntimePageRunner('http://127.0.0.1:9', fetchImpl as unknown as typeof fetch)('y', 'x'))
      .rejects.toThrow('Dashboard "x" not found in App "y"');
  });

  it('writes a digest with KPI values, row counts, trust and the tiles that failed', () => {
    const summary = summarizeAppPageRun('Overview', tiles, 1);
    expect(summary.markdown).toBe([
      '# Overview',
      '',
      '2 of 3 tiles ran; 1 did not.',
      '',
      '- Revenue: **4,212,940** (certified)',
      '- Revenue by region: 2 rows (certified)',
      '',
      'Did not run:',
      '- Margin rate: The warehouse timed out.',
    ].join('\n'));
    expect(summary.queries.map((query) => query.chartId)).toEqual(['revenue', 'by-region', 'margin']);
    expect(summary.queries[1]!.preview).toEqual([{ region: 'US', revenue: 1 }]);
    expect(summary.queries[2]!.error).toBe('The warehouse timed out.');
  });

  it('writes a season or a year as a year, never 2,014 (V11)', () => {
    const latest: AppPageRunTile = { tileId: 'latest', title: 'Latest season', status: 'ok', tileType: 'dataset', vizType: 'kpi', certificationStatus: 'certified', columns: ['SEASON'], rows: [{ SEASON: 2018 }], rowCount: 1 };
    const wins: AppPageRunTile = { ...latest, tileId: 'wins', title: 'Wins', columns: ['WINS'], rows: [{ WINS: 2014 }] };
    expect(summarizeAppPageRun('Overview', [latest, wins], 1).markdown).toContain('- Latest season: **2018** (certified)\n- Wins: **2,014** (certified)');
  });

  it('posts JSON to http(s) webhooks and reports what was not delivered', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.includes('bad') ? new Response('failed', { status: 500 }) : new Response(null, { status: 204 })));
    const notifier = createWebhookNotifier(fetchImpl as unknown as typeof fetch);
    const payload = { block: 'app/a/p', path: 'apps/a/dashboards/p.dqld', startedAt: 't', alerts: [], queries: [{ chartId: 'k', sql: '', rowCount: 1, durationMs: 0, preview: [{ v: 1 }] }], trigger: 'cron' as const, markdown: '# P', digestTitle: 'P' };
    expect(await notifier.send(['https://hooks.example.test/ok'], payload)).toEqual({ delivered: true });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ source: 'dql', kind: 'app_schedule', title: 'P', markdown: '# P', tiles: [{ tileId: 'k', rowCount: 1, preview: [{ v: 1 }] }] });
    expect(await notifier.send(['https://hooks.example.test/bad', 'ftp://files.example.test/x'], payload)).toEqual({
      delivered: false,
      error: 'https://hooks.example.test: HTTP 500; ftp://files.example.test: only http and https webhooks are supported',
    });
  });

  it('runs a scheduled App page through the runtime and delivers to its webhook', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-app-schedule-'));
    roots.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    const appPath = join(root, 'apps/commerce-pilot/dql.app.json');
    const app = JSON.parse(readFileSync(appPath, 'utf8'));
    app.schedules = [{ id: 'weekly', cron: '0 8 * * 1', dashboard: 'overview', deliver: [{ kind: 'webhook', url: 'https://hooks.example.test/dql' }] }];
    writeFileSync(appPath, JSON.stringify(app, null, 2));
    const webhook = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', webhook);
    const pageRunner = vi.fn(async () => tiles);

    const record = await runAppDashboard('commerce-pilot', 'overview', {
      executor: new QueryExecutor(), connection: { driver: 'duckdb' }, projectRoot: root,
      trigger: 'cron', scheduleId: 'weekly', pageRunner,
    });

    expect(pageRunner).toHaveBeenCalledWith('commerce-pilot', 'overview');
    expect(record.error).toBeUndefined();
    // Dataset and semantic tiles run now, not only certified blocks.
    expect(record.queries.map((query) => query.chartId)).toEqual(['revenue', 'by-region', 'margin']);
    expect(record.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'webhook', recipients: ['https://hooks.example.test/dql'], delivered: true }),
    ]));
    const sent = JSON.parse((webhook.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    // The rendered digest (RFC 0008 step 10) says what ran and what did not.
    expect(sent.markdown).toContain('2 of 3 tiles ran');
    expect(sent.markdown).toContain('## Did not run\n- Margin rate: The warehouse timed out.');
    expect(sent.html).toContain('Overview');
    // The link that opens this page in DQL, for hosts and link-only deliveries.
    expect(sent.appPage).toEqual({ appId: 'commerce-pilot', pageId: 'overview', title: 'Overview', href: '/?app=commerce-pilot&page=overview' });
  });
});
