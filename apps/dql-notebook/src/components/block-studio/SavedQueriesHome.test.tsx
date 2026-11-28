import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedQueriesHome, openingSavedQueriesTab, savedQueryRows, savedQuerySourceLine, type MetricDraftEntry } from './SavedQueriesHome';
import type { BlockEntry } from '../blocks/block-types';
import type { ListedRun } from './most-asked';
import { themes } from '../../themes/notebook-theme';

/**
 * The trust flow approved 2026-11-27: Saved queries opens on the list, not on "Create saved queries" cards. Drafts
 * and Certified tabs; the Drafts tab filtered by Queries or Metrics and most asked first, counted from Ask's chat
 * runs; each row says where it came from.
 */
const block = (name: string, extra: Partial<BlockEntry> = {}): BlockEntry => ({
  name,
  domain: 'nba',
  status: 'draft',
  owner: 'TEST_ADMIN',
  tags: [],
  path: `blocks/${name}.dql`,
  lastModified: '2026-11-27T10:00:00Z',
  description: '',
  ...extra,
});
let clock = Date.parse('2026-11-27T09:00:00Z');
const asked = (question: string): ListedRun => {
  clock += 60_000;
  return { id: `run-${clock}`, question, requestedMode: 'auto', route: 'generated_answer', status: 'completed', trustState: 'review_required', startedAt: new Date(clock).toISOString() } as ListedRun;
};

const blocks = [
  block('playoff_wins_2015', { sourceQuestion: 'How many playoff games did the Golden State Warriors win in 2015?' }),
  block('regular_season_wins_2016', { sourceQuestion: 'How many regular season games did the Warriors win in 2016?', lastModified: '2026-11-27T11:00:00Z' }),
  block('team_stats', { importedFrom: { kind: 'powerbi-project', path: 'Team stats.pbit#Team stats' } }),
  block('warriors_season_review', { importedFrom: { kind: 'tableau-workbook', path: 'reports/Warriors season review.twbx#Season' } }),
  block('orders_by_store', { status: 'certified', owner: 'analytics' }),
  block('home_wins', { status: 'pending_recertification' }),
  block('old_wins', { status: 'certified', replacedBy: 'orders_by_store' }),
  block('retired', { status: 'deprecated' }),
];
const metricDrafts: MetricDraftEntry[] = [
  { name: 'win_percentage', label: 'Win percentage', path: 'semantic-layer/metrics/_drafts/win_percentage.yaml', importId: 'imp_1' },
];
const runs = [
  asked('How many playoff games did the Golden State Warriors win in 2015?'),
  asked('how many playoff games did the golden state warriors win in 2015'),
  asked('How many playoff games did the Golden State Warriors win in 2015?'),
  asked('How many regular season games did the Warriors win in 2016?'),
];

describe('Saved queries: where each one came from', () => {
  it('says Ask, how often it was asked and who saved it; the import and its file; or written here', () => {
    expect(savedQuerySourceLine(blocks[0]!, 3)).toBe('From Ask · asked 3 times · saved by TEST_ADMIN');
    expect(savedQuerySourceLine(blocks[1]!, 1)).toBe('From Ask · asked once · saved by TEST_ADMIN');
    expect(savedQuerySourceLine(blocks[2]!, 0)).toBe('From Power BI · Team stats.pbit');
    expect(savedQuerySourceLine(blocks[3]!, 0)).toBe('From Tableau · Warriors season review.twbx');
    expect(savedQuerySourceLine(block('legacy', { importedFrom: { kind: 'sql-file', path: 'queries/legacy.sql' } }), 0)).toBe('From SQL · legacy.sql');
    expect(savedQuerySourceLine(blocks[4]!, 0)).toBe('Written here · analytics');
    // A draft Ask kept on its own before Save existed: from Ask, with its own count, and no "saved by".
    expect(savedQuerySourceLine(block('auto', { automaticDraft: true, sourceQuestion: 'Q?', askedTimes: 85 }), 85)).toBe('From Ask · asked 85 times');
  });
});

describe('Saved queries: the Drafts and Certified tabs', () => {
  it('lists drafts most asked first (from Ask\'s chat runs), then the most recently changed, with metric drafts', () => {
    const rows = savedQueryRows({ blocks, metricDrafts, runs, tab: 'drafts', kind: 'all' });
    expect(rows.map((row) => [row.name, row.kind, row.askedTimes])).toEqual([
      ['playoff_wins_2015', 'query', 3],
      ['regular_season_wins_2016', 'query', 1],
      // Then, changed at the same moment, by name.
      ['home_wins', 'query', 0],
      ['team_stats', 'query', 0],
      ['warriors_season_review', 'query', 0],
      ['Win percentage', 'metric', 0],
    ]);
    expect(rows.find((row) => row.name === 'home_wins')!.state).toBe('Changed since certified');
  });

  it('filters the drafts to queries or to metrics', () => {
    expect(savedQueryRows({ blocks, metricDrafts, runs, tab: 'drafts', kind: 'metrics' }).map((row) => row.name)).toEqual(['Win percentage']);
    expect(savedQueryRows({ blocks, metricDrafts, runs, tab: 'drafts', kind: 'queries' }).every((row) => row.kind === 'query')).toBe(true);
  });

  it('lists only certified saved queries that are not retired on the Certified tab', () => {
    expect(savedQueryRows({ blocks, metricDrafts, runs, tab: 'certified', kind: 'all' }).map((row) => row.name)).toEqual(['orders_by_store']);
  });

  it('searches names and where they came from', () => {
    expect(savedQueryRows({ blocks, metricDrafts, runs, tab: 'drafts', kind: 'all', search: 'tableau' }).map((row) => row.name)).toEqual(['warriors_season_review']);
  });
});

describe('Saved queries home', () => {
  it('opens on the list with Import and New saved query, never on the "Create saved queries" cards', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      <SavedQueriesHome onImport={noop} onAskAi={noop} onBuildManually={noop} onBlankSql={noop} onReviewMetricDraft={noop} t={themes.paper} />,
    );
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
    expect(text).toContain('Saved queries');
    expect(text).toContain('Import');
    expect(text).toContain('New saved query');
    expect(text).toContain('Drafts');
    expect(text).toContain('Certified');
    expect(text).toContain('Most asked first');
    expect(text).toContain("Drafts aren't used to answer questions until you certify them.");
    expect(text).not.toMatch(/Create saved queries|Start import|Import SQL|Describe the query/);
  });
});

describe('the tab Saved queries opens on (V18 patch 2 new-user test)', () => {
  it('opens on Certified when there are no drafts and something is certified', () => {
    expect(openingSavedQueriesTab({ drafts: 0, certified: 1 })).toBe('certified');
  });

  it('opens on Drafts otherwise', () => {
    expect(openingSavedQueriesTab({ drafts: 2, certified: 1 })).toBe('drafts');
    expect(openingSavedQueriesTab({ drafts: 0, certified: 0 })).toBe('drafts');
  });
});
