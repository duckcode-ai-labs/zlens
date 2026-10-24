import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStoryBindingCatalog, type StoryBindingTileInput } from '@zlens/core';
import { QueryExecutor } from '@zlens/connectors';
import { createRuntimePageRunner } from './app-page-run.js';
import { buildAppDigest, readDigestState, type DigestLayoutItem } from './app-digest.js';
import { runAppDashboard } from './runner.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/app-datasets-pilot', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A run tile as the App runtime returns it. */
const runTile = (tileId: string, rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  tileId,
  status: 'ok',
  tileType: 'dataset',
  dataset: { trust: 'certified', validation: { outcome: 'covered' } },
  result: { columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows, rowCount: rows.length, columnsMeta: [{ name: 'revenue', kind: 'currency', unit: 'USD' }] },
  ...extra,
});

const items: DigestLayoutItem[] = [
  { i: 'revenue', title: 'Revenue', viz: { type: 'kpi' }, query: {} },
  { i: 'orders', title: 'Orders', viz: { type: 'kpi' }, query: {} },
  { i: 'by_region', title: 'Revenue by region', viz: { type: 'bar' }, query: {} },
  { i: 'why', title: 'Why revenue moved', viz: { type: 'waterfall' }, query: {}, driver: { measure: 'revenue' } },
  { i: 'note', title: 'Note', viz: { type: 'text' }, text: { markdown: 'Hi' } },
];

const pageTiles = (revenue: number, us: number) => [
  runTile('revenue', [{ revenue }]),
  runTile('orders', [{ order_count: 7 }]),
  runTile('by_region', [{ region: 'US', revenue: us }, { region: 'CA', revenue: revenue - us }]),
  runTile('why', [{ x: 1 }], { driver: { summary: 'Revenue fell by 40. The largest move was US (region): -40, 100% of the change.', headline: { current: String(revenue), prior: '125', delta: String(revenue - 125) }, dimensions: [] } }),
  { tileId: 'note', status: 'ok', tileType: 'text' },
];

const asRunTiles = (raw: Array<Record<string, unknown>>) => raw.map((tile) => ({
  tileId: String(tile.tileId), title: undefined, status: String(tile.status), tileType: tile.tileType as string, columns: [], rows: [], rowCount: 0, raw: tile,
}));

describe('rendered App digests and monitors (RFC 0008 step 10)', () => {
  it('shows headline figures with their change, what moved, why, and a firing monitor', () => {
    const first = pageTiles(125, 60);
    const firstCatalog = buildStoryBindingCatalog(first as StoryBindingTileInput[], Object.fromEntries(items.map((item) => [item.i, item.title])));
    const baseline = buildAppDigest({ appTitle: 'Commerce', pageTitle: 'Overview', items, tiles: asRunTiles(first), catalog: firstCatalog, monitors: [], previous: null, runAt: '2026-09-21T08:00:00.000Z' });
    expect(baseline.headline.map((figure) => `${figure.label}=${figure.display}`)).toEqual(['Revenue=$125', 'Orders — order count=7']);
    expect(baseline.changes).toEqual([]);

    const second = pageTiles(85, 20);
    const catalog = buildStoryBindingCatalog(second as StoryBindingTileInput[], Object.fromEntries(items.map((item) => [item.i, item.title])));
    const digest = buildAppDigest({
      appTitle: 'Commerce',
      pageTitle: 'Overview',
      items,
      tiles: asRunTiles(second),
      catalog,
      monitors: [
        { id: 'low', binding: 'revenue.revenue', when: { kind: 'threshold', op: '<', value: 100 }, label: 'Revenue' },
        { id: 'orders', binding: 'orders.order_count', when: { kind: 'change', direction: 'either', percent: 10 } },
      ],
      previous: baseline.nextState,
      runAt: '2026-09-22T08:00:00.000Z',
    });
    expect(digest.subject).toBe('[DQL alert] Overview: Revenue is $85, below $100.');
    expect(digest.firing.map((evaluation) => evaluation.monitor.id)).toEqual(['low']);
    expect(digest.headline[0]).toMatchObject({ display: '$85', previous: '$125' });
    expect(digest.headline[0]!.changePercent).toBeCloseTo(-32);
    // US fell the most among the members; derived keys (leader, driver) are not "changes".
    expect(digest.changes[0]).toMatchObject({ key: 'by_region.revenue[US]', display: '$20', previous: '$60' });
    expect(digest.changes.some((figure) => /\.(leader|current|prior)/.test(figure.key))).toBe(false);
    expect(digest.trust).toEqual({ certified: 4, total: 4, text: 'All tiles certified' });
    // A driver is related context with its own title, never stated as the cause.
    expect(digest.markdown).toContain('## Alerts\n- **Revenue is $85, below $100.**\n  From “Why revenue moved”: Revenue fell by 40. The largest move was US (region): -40, 100% of the change.');
    expect(digest.markdown).toContain('- Revenue: **$85** ▼ 32% (was $125)');
    expect(digest.markdown).toContain('Orders — order count rose 0%');
    expect(digest.html).toContain('Revenue is $85, below $100.');
    expect(digest.html).not.toMatch(/<script|<style/i);
    expect(digest.nextState.firingSince).toEqual({ low: '2026-09-22T08:00:00.000Z' });
  });

  it('escapes page text in the email body', () => {
    const tiles = [runTile('revenue', [{ revenue: 1 }])];
    const catalog = buildStoryBindingCatalog(tiles as StoryBindingTileInput[], { revenue: '<b>Revenue</b>' });
    const digest = buildAppDigest({ appTitle: 'A & B', pageTitle: '<script>x</script>', items: [{ i: 'revenue', title: '<b>Revenue</b>', viz: { type: 'kpi' }, query: {} }], tiles: asRunTiles(tiles), catalog, monitors: [], previous: null, runAt: '2026-09-22T08:00:00.000Z' });
    expect(digest.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(digest.html).toContain('A &amp; B');
    expect(digest.html).not.toContain('<b>Revenue</b>');
  });

  it('runs a schedule twice: stores the baseline, then alerts with what changed; a digest-off schedule stays quiet until a monitor fires', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-app-digest-'));
    roots.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    const appPath = join(root, 'apps/commerce-pilot/dql.app.json');
    const app = JSON.parse(readFileSync(appPath, 'utf8'));
    app.schedules = [
      {
        id: 'daily', cron: '0 8 * * *', dashboard: 'overview',
        deliver: [{ kind: 'webhook', url: 'https://hooks.example.test/daily' }],
        monitors: [{ id: 'low-revenue', binding: 'order-lines-dataset-kpi.revenue', when: { kind: 'threshold', op: '<', value: 100 }, label: 'Revenue' }],
      },
      {
        id: 'alerts-only', cron: '0 * * * *', dashboard: 'overview', digest: false,
        deliver: [{ kind: 'webhook', url: 'https://hooks.example.test/alerts' }],
        monitors: [{ id: 'swing', binding: 'order-lines-dataset-kpi.revenue', when: { kind: 'change', direction: 'down', percent: 20 } }],
      },
    ];
    writeFileSync(appPath, JSON.stringify(app, null, 2));
    let revenue = 145;
    const runtime = vi.fn(async () => new Response(JSON.stringify({ tiles: [runTile('order-lines-dataset-kpi', [{ revenue }]), runTile('order-lines-dataset-kpi-2', [{ order_count: 7 }])] }), { status: 200 }));
    const pageRunner = createRuntimePageRunner('http://127.0.0.1:9', runtime as unknown as typeof fetch);
    const webhook = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', webhook);
    const run = (scheduleId: string) => runAppDashboard('commerce-pilot', 'overview', {
      executor: new QueryExecutor(), connection: { driver: 'duckdb' }, projectRoot: root, trigger: 'cron', scheduleId, pageRunner,
    });
    const sentTo = (url: string) => webhook.mock.calls
      .filter((call) => (call as unknown as [string])[0] === url)
      .map((call) => JSON.parse(((call as unknown as [string, RequestInit])[1].body as string)));

    const first = await run('daily');
    expect(first.monitors).toEqual([expect.objectContaining({ id: 'low-revenue', status: 'ok', message: 'Revenue is $145; the alert is for below $100.' })]);
    await run('alerts-only');
    expect(sentTo('https://hooks.example.test/daily')).toHaveLength(1);
    // No baseline yet and digest off: nothing sent.
    expect(sentTo('https://hooks.example.test/alerts')).toHaveLength(0);
    expect(readDigestState(root, 'commerce-pilot', 'daily')?.values['order-lines-dataset-kpi.revenue']).toMatchObject({ value: 145, display: '$145' });

    revenue = 85;
    const second = await run('daily');
    await run('alerts-only');
    expect(second.monitors?.[0]).toMatchObject({ status: 'breached', message: 'Revenue is $85, below $100.' });
    const daily = sentTo('https://hooks.example.test/daily').at(-1);
    expect(daily.subject).toBe('[DQL alert] Overview: Revenue is $85, below $100.');
    expect(daily.markdown).toContain('▼ 41% (was $145)');
    expect(daily.monitors).toEqual([expect.objectContaining({ id: 'low-revenue', firing: true })]);
    const alerts = sentTo('https://hooks.example.test/alerts');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain('fell 41% since the last run ($145 → $85)');
  });

  it('with a host, compares each run with the last run as the same person: a run someone else starts does not set the baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-app-digest-'));
    roots.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    const appPath = join(root, 'apps/commerce-pilot/dql.app.json');
    const app = JSON.parse(readFileSync(appPath, 'utf8'));
    app.schedules = [{ id: 'daily', cron: '0 8 * * *', dashboard: 'overview', deliver: [{ kind: 'webhook', url: 'https://hooks.example.test/daily' }] }];
    writeFileSync(appPath, JSON.stringify(app, null, 2));
    // The run-as person sees 145 then 150; someone with wider rules who starts a run in between sees 9,000.
    let revenue = 145;
    const runtime = vi.fn(async () => new Response(JSON.stringify({ tiles: [runTile('order-lines-dataset-kpi', [{ revenue }])] }), { status: 200 }));
    const pageRunner = createRuntimePageRunner('http://127.0.0.1:9', runtime as unknown as typeof fetch);
    const webhook = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', webhook);
    const run = (baselineOwner: string) => runAppDashboard('commerce-pilot', 'overview', {
      executor: new QueryExecutor(), connection: { driver: 'duckdb' }, projectRoot: root, trigger: 'cron', scheduleId: 'daily', pageRunner, baselineOwner,
    });
    const sent = () => webhook.mock.calls.map((call) => JSON.parse(((call as unknown as [string, RequestInit])[1].body as string)) as { markdown: string });
    await run('p-runas');
    revenue = 9_000;
    await run('p-wider');
    // The wider run compared with no baseline of its own: it says nothing of the run-as person's figure.
    expect(sent().at(-1)!.markdown).not.toContain('$145');
    revenue = 150;
    await run('p-runas');
    const last = sent().at(-1)!.markdown;
    expect(last).toContain('(was $145)');
    expect(last).not.toContain('9,000');
    expect(readDigestState(root, 'commerce-pilot', 'daily~p-runas')?.values['order-lines-dataset-kpi.revenue']).toMatchObject({ value: 150 });
    expect(readDigestState(root, 'commerce-pilot', 'daily~p-wider')?.values['order-lines-dataset-kpi.revenue']).toMatchObject({ value: 9_000 });
    // Without a host (no person named) the schedule keeps its one baseline, as before.
    expect(readDigestState(root, 'commerce-pilot', 'daily')).toBeNull();
  });
});
