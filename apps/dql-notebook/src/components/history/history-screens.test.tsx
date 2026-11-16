import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@zlens/ui';
import type { HistoryCompare, HistoryFeedEntry, HistoryItem, HistoryRunCompare, HistoryStatus } from '../../api/history';
import { themes } from '../../themes/notebook-theme';
import { ActivityBar } from '../shell/ActivityBar';
import { HostUiProvider } from '../../host/host-ui';
import { setSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';
import { AppHistoryButton, AppHistoryDialog, AppHistoryMenuItem } from './AppHistory';
import { CompareView, runSummary } from './CompareVersions';
import { ChangeLine, GitCopyCard } from './HistoryPage';
import { historyStorageWords } from './HistoryStorageNote';
import { ItemHistoryView } from './ItemHistory';
import { historyRoute, requestBlockHistoryTab, setHistoryRoute, takeBlockHistoryTab } from './history-route';
import { appIdOf } from './history-navigation';
import {
  actionLabel, authorLabel, bannerText, dayLabel, formatBytes, groupByDay, historySql, initials, itemLabel, kindsLabel, restorableVersion, restoredNotice, whenLabel,
} from './history-words';

/**
 * V15 History screens in the ZLens app for Snowflake: the left bar's History item, the project's changes, the
 * History tab of an item, and Compare (design: history-canvas Main, ItemHistory, Compare, Rails).
 */
const t = themes.paper;
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  setSnowflakeApp(false);
});

function rail(): string {
  vi.stubGlobal('window', { localStorage: { getItem: () => '1', setItem: () => undefined } });
  return renderToStaticMarkup(<TooltipProvider><HostUiProvider initial={{ host: false }}><ActivityBar /></HostUiProvider></TooltipProvider>);
}

const names = (html: string) => [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]!).filter((name) => !/sidebar rail$/.test(name));

describe('the left bar', () => {
  it('puts History in Source control\'s slot in the Govern group, in the app for Snowflake only', () => {
    expect(names(rail())).toEqual(['Apps', 'Ask', 'Notebooks', 'Saved queries', 'Lineage', 'Modeling', 'Ask observability', 'Source control', 'Settings', 'Help']);
    setSnowflakeApp(true);
    expect(names(rail())).toEqual(['Ask', 'Apps', 'Notebooks', 'Saved queries', 'Lineage', 'Modeling', 'Ask observability', 'History', 'Settings', 'Help']);
  });
});

describe('the words', () => {
  const now = new Date(2026, 10, 14, 18, 0);
  it('names days, times and people as the screens do', () => {
    expect(dayLabel(new Date(2026, 10, 14, 16, 13).toISOString(), now)).toBe('Today · Sat 14 Nov');
    expect(dayLabel(new Date(2026, 10, 13, 9, 2).toISOString(), now)).toBe('Yesterday · Fri 13 Nov');
    expect(dayLabel(new Date(2026, 10, 11, 14, 20).toISOString(), now)).toBe('Wed 11 Nov');
    expect(dayLabel(new Date(2025, 10, 11, 14, 20).toISOString(), now)).toBe('Tue 11 Nov 2025');
    expect(whenLabel(new Date(2026, 10, 14, 10, 42).toISOString(), now)).toBe('Today 10:42');
    expect(whenLabel(new Date(2026, 10, 11, 14, 20).toISOString(), now)).toBe('11 Nov 14:20');
    expect(initials('TEST_ADMIN')).toBe('TA');
    expect(initials('jsmith')).toBe('JS');
    expect(authorLabel({ name: 'AI (Ask)', kind: 'ai', askedBy: 'JSMITH' })).toBe('AI (Ask) for JSMITH');
    expect(authorLabel({ name: 'AI (Ask)', kind: 'ai' }, true)).toBe('AI');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 3 * 1.25)).toBe('1.3 GB');
    const groups = groupByDay([{ at: new Date(2026, 10, 14, 16).toISOString() }, { at: new Date(2026, 10, 14, 9).toISOString() }, { at: new Date(2026, 10, 11, 9).toISOString() }], now);
    expect(groups.map((group) => [group.label, group.entries.length])).toEqual([['Today · Sat 14 Nov', 2], ['Wed 11 Nov', 1]]);
    expect(historySql('ZLENS_APP')).toContain('FROM ZLENS_APP.app_public.history');
  });

  it('says what a line did: cleared drafts, an upgrade\'s clean-up, a restore of the version before a removal', () => {
    const base = { by: { name: 'JSMITH', kind: 'person' as const }, count: 45 };
    expect(actionLabel({ ...base, change: 'removed', action: 'clear-drafts' })).toBe('cleared');
    expect(itemLabel({ items: [], count: 45, kind: 'saved_query', action: 'clear-drafts' })).toBe('45 automatic Ask drafts');
    expect(actionLabel({ ...base, by: { name: 'ZLens', kind: 'zlens' }, change: 'removed', action: 'upgrade' })).toBe('moved to the trash:');
    expect(actionLabel({ ...base, by: { name: 'ZLens', kind: 'zlens' }, change: 'removed', action: 'trash' })).toBe('found in the trash:');
    expect(actionLabel({ ...base, count: 1, change: 'published', action: 'save' })).toBe('published');
    expect(itemLabel({ items: [], count: 5, kind: 'app', action: 'upgrade' })).toBe('5 Apps');
    expect(itemLabel({ items: [], count: 4, kind: 'saved_query', action: 'upgrade' })).toBe('4 saved queries');
    expect(actionLabel({ ...base, count: 1, change: 'created', action: 'ask', by: { name: 'AI (Ask)', kind: 'ai' } })).toBe('drafted');
    expect(restorableVersion({ change: 'removed', version: 4 })).toBe(3);
    expect(restorableVersion({ change: 'edited', version: 2 })).toBe(2);
  });
});

const certifiedLine: HistoryFeedEntry = {
  id: 'c1:blocks/nba/wins.dql',
  commit: 'c1',
  at: new Date(2026, 10, 14, 16, 13).toISOString(),
  by: { name: 'TEST_ADMIN', kind: 'person' },
  action: 'certify',
  change: 'certified',
  kind: 'saved_query',
  items: [{ key: 'blocks/nba/wins.dql', current: 'blocks/nba/wins.dql', name: 'warriors_regular_wins', kind: 'saved_query', version: 3, certified: true, removed: false, isCurrentVersion: true }],
  count: 1,
  version: 3,
  certified: true,
  detail: 'Matches warriors_wins.xlsx · every value compared',
  canCompare: true,
  canRestore: false,
};

describe('a line in the project\'s History', () => {
  it('says when, who, what and which item, with the version and CERTIFIED pills', () => {
    const html = renderToStaticMarkup(<ChangeLine entry={certifiedLine} first t={t} expanded={false} onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(html).toContain('16:13');
    expect(html).toContain('>TA<');
    expect(html).toContain('TEST_ADMIN');
    expect(html).toContain('certified');
    expect(html).toContain('warriors_regular_wins');
    expect(html).toContain('Saved query · Matches warriors_wins.xlsx');
    expect(html).toContain('CERTIFIED');
    expect(html).toContain('v3');
    expect(html).toContain('>Compare<');
    // The current version has nothing to restore.
    expect(html).not.toContain('Restore');
  });

  it('offers Restore of the version before a removal, and lists a clean-up\'s items', () => {
    const removed: HistoryFeedEntry = {
      ...certifiedLine, id: 'c2', action: 'delete', change: 'removed', certified: false, detail: 'It can be restored from History', canCompare: false, canRestore: true, version: 4,
      items: [{ ...certifiedLine.items[0]!, version: 4, removed: true }],
    };
    const html = renderToStaticMarkup(<ChangeLine entry={removed} first t={t} expanded={false} onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(html).toContain('removed');
    expect(html).toContain('aria-label="Restore v3 of warriors_regular_wins"');
    const cleared: HistoryFeedEntry = {
      ...removed, id: 'c3', action: 'clear-drafts', count: 2, version: undefined,
      items: [{ ...removed.items[0]!, key: 'a', name: 'draft_a', version: 2 }, { ...removed.items[0]!, key: 'b', name: 'draft_b', version: 2 }],
    };
    const closed = renderToStaticMarkup(<ChangeLine entry={cleared} first t={t} expanded={false} onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(closed).toContain('cleared');
    expect(closed).toContain('2 automatic Ask drafts');
    const open = renderToStaticMarkup(<ChangeLine entry={cleared} first t={t} expanded onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(open).toContain('draft_a');
    expect(open).toContain('draft_b');
  });
});

const item: HistoryItem = {
  item: { key: 'blocks/nba/wins.dql', kind: 'saved_query', name: 'wins', removed: false, currentVersion: 5 },
  banner: { draft: 5, certified: 4 },
  versions: [
    { version: 5, commit: 'e', path: 'blocks/_drafts/nba/wins-0123456789abcdef.dql', at: new Date(2026, 10, 14, 10, 42).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, change: 'edited', detail: 'Draft edit of certified v4. SQL changed. Not certified yet', state: 'draft', current: true, canRestore: false },
    { version: 4, commit: 'd', path: 'blocks/nba/wins.dql', at: new Date(2026, 10, 11, 14, 20).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, change: 'certified', detail: 'Matches warriors_wins.xlsx', state: 'certified', current: false, canRestore: true },
    { version: 1, commit: 'a', path: 'blocks/nba/wins.dql', at: new Date(2026, 10, 10, 17, 29).toISOString(), by: { name: 'AI (Ask)', kind: 'ai', askedBy: 'TEST_ADMIN' }, change: 'drafted', detail: 'From Ask: "How many games?"', state: 'draft', current: false, canRestore: true },
  ],
};

describe('the History tab', () => {
  it('shows the banner for a draft edit of a certified version, the versions table and what restore does', () => {
    const html = renderToStaticMarkup(<ItemHistoryView item={item} t={t} selected={[4, 5]} onToggle={noop} onCompare={noop} onView={noop} onRestore={noop} onCloseView={noop} />);
    expect(html).toContain('v5 is an edit of certified v4 and is not certified yet. Compare the two, then certify v5 or restore v4.');
    expect(html).toContain('Compare v4 and v5');
    expect(html).toContain('2 versions selected');
    for (const header of ['Version', 'Saved', 'By', 'What changed', 'State']) expect(html).toContain(`>${header}</th>`);
    expect(html).toContain('AI (Ask) for TEST_ADMIN');
    expect(html).toContain('>Certified<');
    expect(html).toContain('>Draft<');
    expect(html).toContain('>Current<');
    expect(html).toContain('aria-label="Restore v4"');
    expect(html).not.toContain('aria-label="Restore v5"');
    expect(html).toContain('Restoring never changes an old version: it saves a copy as the next version (v6), as a draft. Certified versions stay exactly as they were certified, with their receipts.');
  });
});

const compare: HistoryCompare = {
  item: item.item,
  from: { version: 4, commit: 'd', path: 'blocks/nba/wins.dql', at: new Date(2026, 10, 11, 14, 20).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, state: 'certified', certifiedBy: 'TEST_ADMIN', oldReport: 'Matches warriors_wins.xlsx · every value compared' },
  to: { version: 5, commit: 'e', path: 'blocks/_drafts/nba/wins-0123456789abcdef.dql', at: new Date(2026, 10, 14, 10, 42).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, state: 'draft' },
  sql: {
    changed: 1,
    lines: [
      { kind: 'same', text: 'SELECT season, wins', oldNumber: 1, newNumber: 1 },
      { kind: 'removed', text: '  AND season BETWEEN 2014 AND 2018', oldNumber: 2 },
      { kind: 'added', text: '  AND season BETWEEN 2014 AND 2019', newNumber: 2 },
    ],
  },
  fields: [
    { field: 'description', label: 'Description', before: 'Wins, 2014–2018', after: 'Wins, 2014–2019', changed: true },
    { field: 'owner', label: 'Owner', before: 'TEST_ADMIN', after: 'TEST_ADMIN', changed: false },
    { field: 'tags', label: 'Tags', before: '', after: '', changed: false },
    { field: 'chart', label: 'Chart', before: 'bar', after: 'bar', changed: false },
  ],
  files: [],
};

const run: HistoryRunCompare = {
  from: { columns: ['SEASON', 'WINS'], rowCount: 5 },
  to: { columns: ['SEASON', 'WINS'], rowCount: 6 },
  keyColumns: ['SEASON'],
  valueColumns: ['WINS'],
  rows: [
    { key: [2018], from: [57], to: [57], state: 'same' },
    { key: [2019], from: null, to: [15], state: 'new' },
  ],
  summary: { same: 5, changed: 0, new: 1, removed: 0 },
};

describe('Compare', () => {
  it('shows both versions, the SQL line diff, the fields, the result run now, and Restore and Certify', () => {
    const html = renderToStaticMarkup(<CompareView compare={compare} item={item} run={run} from={4} to={5} t={t} onRestore={noop} onRunBoth={noop} onCertify={noop} onBack={noop} />);
    expect(html).toContain('Compare v4 and v5');
    expect(html).toContain('What changed between the certified version and the draft edit');
    expect(html).toContain('Restore v4 as v6');
    expect(html).toContain('Certify v5');
    expect(html).toContain('Old report: Matches warriors_wins.xlsx');
    expect(html).toContain('Not compared with the old report yet');
    expect(html).toContain('SQL · 1 line changed');
    expect(html).toContain('Description changed');
    expect(html).toContain('Result · 1 new row, 5 rows the same');
    expect(html).toContain('Owner, tags and chart unchanged');
    expect(html).toContain('data-diff="removed"');
    expect(html).toContain('data-diff="added"');
    expect(html).toContain('v4 WINS');
    expect(html).toContain('data-row-state="new"');
    expect(html).toContain('Back to History');
    expect(runSummary(run, 4, 5)).toBe('The 5 rows in v4 come out the same. v5 adds 1.');
  });

  it('offers Run both before anything ran, and no Certify for an older draft', () => {
    const html = renderToStaticMarkup(<CompareView compare={compare} item={{ ...item, item: { ...item.item, currentVersion: 6 } }} run={null} from={4} to={5} t={t} onRestore={noop} onRunBoth={noop} onCertify={noop} onBack={noop} />);
    expect(html).toContain('Run both');
    expect(html).not.toContain('Certify v5');
  });
});

describe('Settings » Backups: the room History takes', () => {
  it('says how much, warns from 1 GiB, and whether the SQL log was written', () => {
    const status: HistoryStatus = { enabled: true, versions: 12, items: 4, sizeBytes: 300 * 1024, warnAtBytes: 1024 ** 3, sizeWarning: false, sqlLog: { state: 'written', table: 'ZLENS_APP.CORE.HISTORY_LOG', pending: 0, lastWrittenAt: '2026-11-14T00:00:00Z' } };
    expect(historyStorageWords(status)).toEqual({
      line: 'History keeps 12 versions of 4 items and takes 300 KB of the app\'s volume.',
      log: 'Its change log is readable with SQL in ZLENS_APP.app_public.history.',
    });
    const big = historyStorageWords({ ...status, sizeBytes: 1.5 * 1024 ** 3, sizeWarning: true, sqlLog: { ...status.sqlLog, state: 'skipped' } });
    expect(big.warning).toMatch(/over 1\.0 GB/);
    expect(big.log).toMatch(/could not be written.*History itself works/);
  });
});

describe('where History goes next', () => {
  it('keeps its page apart from the store, and opens a saved query\'s History tab once', () => {
    setHistoryRoute({ page: 'compare', path: 'blocks/a.dql', from: 1, to: 2 });
    expect(historyRoute()).toEqual({ page: 'compare', path: 'blocks/a.dql', from: 1, to: 2 });
    requestBlockHistoryTab('blocks/a.dql');
    expect(takeBlockHistoryTab('blocks/b.dql')).toBe(false);
    expect(takeBlockHistoryTab('blocks/a.dql')).toBe(true);
    expect(takeBlockHistoryTab('blocks/a.dql')).toBe(false);
    setHistoryRoute({ page: 'feed' });
  });
});

describe('V2: one AI label, the first line, and readable kinds', () => {
  it('says "AI (Ask) for <person>" on a line, as the SQL view does', () => {
    const drafted: HistoryFeedEntry = {
      ...certifiedLine, id: 'a1', by: { name: 'AI (Ask)', kind: 'ai', askedBy: 'TEST_ADMIN' }, action: 'ask', change: 'drafted', certified: false, canCompare: false, detail: 'From Ask: "Lakers wins?"',
      items: [{ ...certifiedLine.items[0]!, name: 'lakers_wins', version: 1, certified: false }], version: 1,
    };
    const html = renderToStaticMarkup(<ChangeLine entry={drafted} first t={t} expanded={false} onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(html).toContain('AI (Ask) for TEST_ADMIN');
    expect(html).not.toMatch(/>AI<\/strong>/);
  });

  it('starts with "History starts here: N items" and names each kind, never "Apps" for mixed items', () => {
    const items = [
      { key: 'apps/sales-overview', current: 'apps/sales-overview', name: 'Sales overview', kind: 'app' as const, version: 1, certified: false, removed: false, isCurrentVersion: true },
      { key: 'blocks/wins.dql', current: 'blocks/wins.dql', name: 'wins', kind: 'saved_query' as const, version: 1, certified: false, removed: false, isCurrentVersion: true },
      { key: 'domains/tpch/modeling/areas/core.dql.yaml', current: 'domains/tpch/modeling/areas/core.dql.yaml', name: 'Model: Tpch core', kind: 'model' as const, version: 1, certified: false, removed: false, isCurrentVersion: true },
      { key: 'notebooks/welcome.dqlnb', current: 'notebooks/welcome.dqlnb', name: 'workspace - ZLens Workbench', kind: 'notebook' as const, version: 1, certified: false, removed: false, isCurrentVersion: true },
    ];
    const started: HistoryFeedEntry = {
      id: 's', commit: 's', at: new Date(2026, 10, 14, 9).toISOString(), by: { name: 'ZLens', kind: 'zlens' }, action: 'start', change: 'started', kind: 'app',
      items, count: 4, certified: false, canCompare: false, canRestore: false,
    };
    const html = renderToStaticMarkup(<ChangeLine entry={started} first t={t} expanded={false} onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    // Who: ZLens, as on every line; then what.
    expect(html).toContain('>ZLens</strong>');
    expect(html.indexOf('>ZLens</strong>')).toBeLessThan(html.indexOf('History starts here:'));
    expect(html).toContain('History starts here:');
    expect(html).toContain('4 items');
    expect(html).toContain('1 saved query, 1 App, 1 notebook, 1 model file');
    expect(html).not.toContain('started History with');
    expect(html).not.toContain('>Apps<');
    // One item is still a count, with its kind.
    const one = renderToStaticMarkup(<ChangeLine entry={{ ...started, items: [items[3]!], count: 1, kind: 'notebook' }} first t={t} expanded={false} onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(one).toContain('History starts here:');
    expect(one).toContain('1 item');
    expect(one).toContain('1 notebook');
    expect(one).not.toContain('started History with workspace');
    // Opened, each item says its own name and kind.
    const open = renderToStaticMarkup(<ChangeLine entry={started} first t={t} expanded onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    for (const name of ['Sales overview', 'wins', 'Model: Tpch core', 'workspace - ZLens Workbench']) expect(open).toContain(name);
    expect(open).toContain('>Model file<');
    expect(itemLabel({ ...started, change: 'started' })).toBe('4 items');
    expect(kindsLabel([{ kind: 'app' }, { kind: 'app' }, { kind: 'semantic' }])).toBe('2 Apps, 1 semantic layer file');
  });

  it('says a restored certified version is a restore, not an edit', () => {
    expect(bannerText({ draft: 3, certified: 1, restored: 1 })).toBe('v3 restores certified v1 as a draft. Certify v3 or keep using v1.');
    expect(bannerText({ draft: 5, certified: 4 })).toBe('v5 is an edit of certified v4 and is not certified yet. Compare the two, then certify v5 or restore v4.');
    const restored: HistoryItem = { ...item, banner: { draft: 3, certified: 1, restored: 1 }, item: { ...item.item, currentVersion: 3 } };
    const html = renderToStaticMarkup(<ItemHistoryView item={restored} t={t} selected={[]} onToggle={noop} onCompare={noop} onView={noop} onRestore={noop} onCloseView={noop} />);
    expect(html).toContain('v3 restores certified v1 as a draft. Certify v3 or keep using v1.');
    expect(html).not.toContain('is an edit of certified');
    expect(restoredNotice('Restored v1 as v3')).toBe('Restored v1 as v3, as a draft.');
    expect(restoredNotice('Restored v1 as a new draft, "Sales (2)"', 'Sales')).toBe('Sales: Restored v1 as a new draft, "Sales (2)".');
  });
});

describe('V3: History in plain words', () => {
  const app = (key: string, name: string, extra: Partial<HistoryFeedEntry['items'][number]> = {}) => ({ key, current: key, name, kind: 'app' as const, version: 2, certified: false, removed: true, isCurrentVersion: true, ...extra });

  it('says ZLens started keeping versions of what it found, never that it created it', () => {
    const zlens = { name: 'ZLens', kind: 'zlens' as const };
    expect(actionLabel({ by: zlens, count: 5, change: 'created', action: 'found' })).toBe('started keeping versions of');
    expect(actionLabel({ by: { name: 'TEST_ADMIN', kind: 'person' }, count: 1, change: 'created', action: 'save' })).toBe('created');
    const found: HistoryFeedEntry = {
      id: 'f', commit: 'f', at: new Date(2026, 10, 14, 9).toISOString(), by: zlens, action: 'found', change: 'created', kind: 'app',
      items: [1, 2, 3, 4, 5].map((n) => app(`apps/a${n}`, `App ${n}`, { version: 1, removed: false })), count: 5, certified: false, canCompare: false, canRestore: false,
    };
    const html = renderToStaticMarkup(<ChangeLine entry={found} first t={t} expanded={false} onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(html).toContain('started keeping versions of');
    expect(html).toContain('5 Apps');
    expect(html).not.toMatch(/<\/strong> created/);
  });

  it('shows what was found in the trash as one line that opens, each item restorable with its reason', () => {
    const trash: HistoryFeedEntry = {
      id: 'trash:t1', commit: 't1', at: new Date(2026, 10, 14, 9).toISOString(), by: { name: 'ZLens', kind: 'zlens' }, action: 'trash', change: 'removed', kind: 'app',
      items: [app('apps/a', 'Points per game', { detail: 'Deleted on 2026-11-10, before History kept App drafts. It can be restored from History' }), app('apps/b', 'Wins (3)', { detail: 'An empty copy of another App, moved to the trash on 2026-11-12. It can be restored from History' })],
      count: 2, certified: false, detail: 'Each can be restored from History', canCompare: false, canRestore: true,
    };
    const closed = renderToStaticMarkup(<ChangeLine entry={trash} first t={t} expanded={false} onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(closed).toContain('found in the trash:');
    expect(closed).toContain('2 Apps');
    expect(closed).toContain('Each can be restored from History');
    expect(closed).not.toContain('Points per game');
    const open = renderToStaticMarkup(<ChangeLine entry={trash} first t={t} expanded onExpand={noop} onOpen={noop} onCompare={noop} onRestore={async () => undefined} />);
    expect(open).toContain('Points per game');
    expect(open).toContain('Deleted on 2026-11-10, before History kept App drafts');
    expect(open.match(/> Restore</g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('compares an App in words, with its files under Technical details, closed', () => {
    const appItem: HistoryItem = {
      item: { key: 'apps/warriors-wins', kind: 'app', name: 'Warriors Wins By Season', removed: false, currentVersion: 3 },
      banner: null,
      versions: [{ version: 1, commit: 'a', path: 'apps/warriors-wins', at: new Date(2026, 10, 14, 18, 13).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, change: 'created', state: 'saved', current: false, canRestore: true }],
    };
    const appCompare: HistoryCompare = {
      item: appItem.item,
      from: { version: 1, commit: 'a', path: 'apps/warriors-wins', at: new Date(2026, 10, 14, 18, 13).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, state: 'saved' },
      to: { version: 3, commit: 'c', path: 'apps/warriors-wins', at: new Date(2026, 10, 14, 18, 20).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, state: 'saved' },
      app: { changes: [
        { kind: 'tile', text: 'Tile added: "Points per game"' },
        { kind: 'text', text: 'Text changed in "Intro"' },
        { kind: 'layout', text: 'Layout changed: 2 tiles moved or resized' },
      ] },
      files: [{ path: 'apps/warriors-wins/studio-draft.json', status: 'changed', changed: 1, lines: [{ kind: 'added', text: '  "sourceRef": "blocks/nba/ppg.dql", "sha256": "abc"', newNumber: 180 }] }],
    };
    const html = renderToStaticMarkup(<CompareView compare={appCompare} item={appItem} run={null} from={1} to={3} t={t} onRestore={noop} onRunBoth={noop} onBack={noop} />);
    expect(html).toContain('Restore v1 as v4');
    expect(html).toContain('3 changes');
    expect(html).toContain('aria-label="What changed"');
    expect(html).toContain('Tile added: &quot;Points per game&quot;');
    expect(html).toContain('Text changed in &quot;Intro&quot;');
    expect(html).toContain('data-app-change="layout"');
    expect(html).not.toContain('file changed');
    // The files are there, closed, under Technical details: nothing of them before it.
    expect(html).toMatch(/<details data-technical-details[^>]*><summary[^>]*>Technical details<\/summary>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html.indexOf('studio-draft.json')).toBeGreaterThan(html.indexOf('Technical details'));
    expect(html.indexOf('Restore v1 as v4')).toBeLessThan(html.indexOf('aria-label="What changed"'));
    // Nothing wider than the page: the column shrinks, long lines scroll inside their own box.
    expect(html).toMatch(/^<div style="display:flex;flex-direction:column;gap:16px;min-width:0;max-width:100%/);
    const same = renderToStaticMarkup(<CompareView compare={{ ...appCompare, app: { changes: [] }, files: [] }} item={appItem} run={null} from={1} to={3} t={t} onRestore={noop} onRunBoth={noop} onBack={noop} />);
    expect(same).toContain('v1 and v3 have the same name, pages, tiles and data.');
    expect(same).not.toContain('Technical details');
  });

  it('keeps the History pages to the page\'s width (one column that shrinks)', () => {
    const page = readFileSync(fileURLToPath(new URL('./HistoryPage.tsx', import.meta.url)), 'utf8');
    expect(page.match(/display: 'grid', gridTemplateColumns: 'minmax\(0, 1fr\)', gap: 14/g)).toHaveLength(2);
    expect(page).not.toMatch(/display: 'grid', gap: 14 \}/);
  });
});

describe('V2: Copy to your Git repository', () => {
  it('says plainly it is not in this version, with no link and no steps', () => {
    const html = renderToStaticMarkup(<GitCopyCard t={t} />);
    expect(html).toContain('Copy to your Git repository');
    expect(html).toContain('Not available in this version.');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('How to allow it');
    expect(html).not.toContain('admin');
    expect(html).not.toMatch(/>Off</);
  });
});

describe('V2: an App\'s History', () => {
  const appItem: HistoryItem = {
    item: { key: 'apps/sales-overview', kind: 'app', name: 'Sales overview', removed: false, currentVersion: 4 },
    banner: null,
    versions: [
      { version: 4, commit: 'd', path: 'apps/sales-overview', at: new Date(2026, 10, 14, 10, 42).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, change: 'edited', detail: 'Added 1 tile', state: 'saved', current: true, canRestore: false },
      { version: 2, commit: 'b', path: 'apps/sales-overview', at: new Date(2026, 10, 14, 10, 40).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, change: 'published', state: 'saved', current: false, canRestore: true },
      { version: 1, commit: 'a', path: 'apps/sales-overview', at: new Date(2026, 10, 14, 10, 38).toISOString(), by: { name: 'TEST_ADMIN', kind: 'person' }, change: 'created', detail: 'In App Studio, not published yet', state: 'saved', current: false, canRestore: true },
    ],
  };

  it('is in App Studio\'s draft menu and the App view in the app for Snowflake only', () => {
    expect(renderToStaticMarkup(<AppHistoryMenuItem onOpen={noop} />)).toBe('');
    expect(renderToStaticMarkup(<AppHistoryButton appId="sales-overview" onOpen={noop} />)).toBe('');
    setSnowflakeApp(true);
    const menu = renderToStaticMarkup(<AppHistoryMenuItem onOpen={noop} />);
    expect(menu).toContain('role="menuitem"');
    expect(menu).toContain('History');
    expect(renderToStaticMarkup(<AppHistoryButton appId="sales-overview" onOpen={noop} />)).toContain('aria-label="History"');
    // In App Studio's "More draft actions" menu, after App settings and before Delete draft; and in the App view.
    const studio = readFileSync(fileURLToPath(new URL('../apps/AppStudioV2.tsx', import.meta.url)), 'utf8');
    const menuAt = studio.indexOf('aria-label="More draft actions"');
    const settingsAt = studio.indexOf('App settings</button>', menuAt);
    const historyAt = studio.indexOf('<AppHistoryMenuItem', menuAt);
    const deleteAt = studio.indexOf('Delete draft</button>', menuAt);
    expect(menuAt).toBeGreaterThan(0);
    expect(settingsAt).toBeLessThan(historyAt);
    expect(historyAt).toBeLessThan(deleteAt);
    expect(studio).toContain('<AppHistoryDialog');
    const view = readFileSync(fileURLToPath(new URL('../apps/AppsView.tsx', import.meta.url)), 'utf8');
    expect(view).toContain('<AppHistoryButton appId={workspaceAppId}');
  });

  it('shows the App\'s versions with the same table, Compare and Restore, as a draft in App Studio', () => {
    setSnowflakeApp(true);
    const dialog = renderToStaticMarkup(<AppHistoryDialog appId="sales-overview" name="Sales overview" t={t} onClose={noop} onCompare={noop} />);
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('History · Sales overview');
    expect(dialog).toContain('aria-label="Close History"');
    const html = renderToStaticMarkup(<ItemHistoryView item={appItem} t={t} selected={[1, 4]} onToggle={noop} onCompare={noop} onView={noop} onRestore={noop} onCloseView={noop} />);
    for (const header of ['Version', 'Saved', 'By', 'What changed', 'State']) expect(html).toContain(`>${header}</th>`);
    expect(html).toContain('Compare selected');
    expect(html).toContain('Added 1 tile');
    expect(html).toContain('>Published<');
    expect(html).toContain('aria-label="Restore v2"');
    expect(html).toContain('saves a copy as the App&#x27;s draft in App Studio (v5). The published App does not change until you publish.');
    const removed = renderToStaticMarkup(<ItemHistoryView item={{ ...appItem, item: { ...appItem.item, removed: true } }} t={t} selected={[]} onToggle={noop} onCompare={noop} onView={noop} onRestore={noop} onCloseView={noop} />);
    expect(removed).toContain('it brings the App back as a new draft in App Studio. Nothing is published until you publish it.');
    expect(appIdOf('apps/sales-overview')).toBe('sales-overview');
    expect(appIdOf('domains/nba/apps/seasons')).toBe('seasons');
  });
});
