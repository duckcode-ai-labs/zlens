import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppStudioAiProposal, DashboardDocumentResponse } from '../api/client';
import { setSnowflakeApp } from './snowflake-app-mode';
import {
  editedSavedQueryTags,
  importHelpLine,
  modelingEmptyWords,
  notebookRowTooltip,
  queryTargetWords,
  savedQueryTagsShown,
} from './snowflake-app-words';
import { traceCatalogEmptyWords, traceCountWords } from '../components/agent/AskObservabilityPage';
import { BlockDetailView, BlockStudioImportWorkspace } from '../components/block-studio/BlockStudio';
import { NotebookFileRow } from '../components/panels/BuildSidebar';
import { detectChartType, resolveChartType } from '../components/output/chart-helpers';
import { readerIntroMarkdown, titleInLabelWords } from '../components/apps/dashboard-presentation';
import { dataName } from '../components/apps/builder/studio-ui';
import { summarizeAppStudioAiPlan } from '../components/apps/app-studio-ai-plan';
import { useNotebookStore } from '../store/NotebookStore';
import { themes } from '../themes/notebook-theme';
import type { QueryResult } from '../store/types';

/**
 * V2 (public) / V15 (internal): what the tester's V14 retest and our own run on the released build still found.
 * In the app for Snowflake ZLens never talks like a laptop or a dbt tool; the open-source words stay as they were.
 */

const t = themes.paper;
const noop = () => {};

afterEach(() => {
  setSnowflakeApp(false);
});

describe('Ask observability counts traces, not "local" traces, in the app for Snowflake', () => {
  it('says "346 traces" there and "346 local traces" on a laptop', () => {
    expect(traceCountWords(346, true)).toBe('346 traces');
    expect(traceCountWords(1, true)).toBe('1 trace');
    expect(traceCountWords(346, false)).toBe('346 local traces');
    expect(traceCountWords(undefined, true)).toBe('Loading trace count…');
    for (const filtered of [true, false]) {
      const app = traceCatalogEmptyWords(filtered, true);
      expect(`${app.loading} ${app.empty}`).not.toMatch(/\blocal\b/i);
      expect(traceCatalogEmptyWords(filtered, false).empty).toMatch(/local/);
    }
  });
});

describe('a saved query\'s tags in the app for Snowflake', () => {
  it('leaves out "local" (a word of a table name) and the app-source marker, and editing keeps them', () => {
    const tags = ['transformed', 'local', 'team', 'game', 'facts', 'app-source'];
    expect(savedQueryTagsShown(tags, true)).toEqual(['transformed', 'team', 'game', 'facts']);
    expect(savedQueryTagsShown(tags, false)).toEqual(tags);
    expect(savedQueryTagsShown(undefined, true)).toEqual([]);
    // A person edits what they see; the hidden ones stay on the saved query.
    expect(editedSavedQueryTags(['team', 'nba'], tags, true)).toEqual(['team', 'nba', 'local', 'app-source']);
    expect(editedSavedQueryTags(['team'], tags, false)).toEqual(['team']);
  });

  it('shows neither on the saved query page header', () => {
    const page = () => renderToStaticMarkup(
      <BlockDetailView
        metadata={{ name: 'team_game_totals', domain: 'nba', owner: 'TEST_ADMIN', tags: ['transformed', 'local', 'team', 'app-source'], reviewStatus: 'draft' } as never}
        source=""
        parameters={[]}
        preview={null}
        lineageDetail={null}
        isSemanticBlock={false}
        running={false}
        onOpenBuilder={noop}
        onOpenSource={noop}
        onRun={noop}
        onOpenHistory={noop}
        t={t}
      />,
    );
    setSnowflakeApp(true);
    expect(page()).toContain('nba · TEST_ADMIN · transformed, team');
    expect(page()).not.toMatch(/\blocal\b|app-source/);
    setSnowflakeApp(false);
    expect(page()).toContain('transformed, local, team, app-source');
  });
});

describe('Import SQL\'s help line in the app for Snowflake', () => {
  it('offers pasting and uploading only, with no local path', () => {
    expect(importHelpLine(true)).toBe('Paste SQL or upload files. Analysis stays in this session until you save a saved query.');
    expect(importHelpLine(false)).toContain('or choose a local path');
    const workspace = () => renderToStaticMarkup(
      <BlockStudioImportWorkspace
        session={null}
        sessions={[]}
        sessionsLoading={false}
        onClose={noop}
        onSessionChange={noop}
        onRefreshSessions={async () => {}}
        onSelectCandidate={noop}
        onSavedCandidate={noop}
        defaultDomain="nba"
        defaultOwner=""
        themeMode="paper"
        t={t}
      />,
    );
    setSnowflakeApp(true);
    expect(workspace()).not.toMatch(/local path/i);
    setSnowflakeApp(false);
    expect(workspace()).toContain('or choose a local path');
  });
});

describe('a notebook in the app for Snowflake', () => {
  const file = { name: 'v8_warriors_seasons_check.dqlnb', path: 'notebooks/v8_warriors_seasons_check.dqlnb', type: 'notebook' as const, folder: 'notebooks' };

  it('names the notebook by its title in the tree\'s tooltip, with no path or extension', () => {
    expect(notebookRowTooltip(file, true)).toBe('v8_warriors_seasons_check');
    expect(notebookRowTooltip({ ...file, visibility: 'private' }, true)).toBe('v8_warriors_seasons_check · Private: only you see it until you publish it');
    expect(notebookRowTooltip(file, false)).toBe('notebooks/v8_warriors_seasons_check.dqlnb');
    expect(notebookRowTooltip({ ...file, visibility: 'private' }, false)).toContain('not in Git until you publish it');
    const row = () => renderToStaticMarkup(<NotebookFileRow file={file} active={false} onOpenFile={noop} publishing={false} t={t} depth={0} />);
    setSnowflakeApp(true);
    expect(row()).toContain('title="v8_warriors_seasons_check"');
    expect(row()).not.toContain('.dqlnb');
    setSnowflakeApp(false);
    expect(row()).toContain('title="notebooks/v8_warriors_seasons_check.dqlnb"');
    // The row's own label never shows the extension, in any edition.
    expect(row()).toContain('>v8_warriors_seasons_check</span>');
  });

  it('says a query runs on the app\'s warehouse, never a local analysis workspace', () => {
    const app = queryTargetWords(true);
    expect(app.connection('snowflake', true)).toBe("This app's Snowflake warehouse");
    expect(`${app.local} ${app.localKind}`).not.toMatch(/\blocal\b/i);
    const laptop = queryTargetWords(false);
    expect(laptop.local).toBe('Local analysis workspace');
    expect(laptop.connection('warehouse', true)).toBe('warehouse (default)');
    expect(laptop.localKind).toBe('Local dataset SQL');
  });
});

describe('the empty Modeling page in the app for Snowflake', () => {
  it('picks a table, never a dbt model, and imports YAML with no dbt', () => {
    const app = modelingEmptyWords(true);
    expect(app.manualDetail).toBe('Pick a single table and describe what one of its rows means. Connect it to others afterwards.');
    expect(`${app.manualDetail} ${app.yamlDetail}`).not.toMatch(/\bdbt\b|local path/i);
    const laptop = modelingEmptyWords(false);
    expect(laptop.manualDetail).toContain('Pick a single dbt model');
    expect(laptop.yamlDetail).toContain('dbt YAML');
  });
});

describe('App Studio names saved queries as they were saved (every edition)', () => {
  it('keeps a name with spaces as written, and reads an id as words', () => {
    expect(dataName('Top nations by order revenue, 1997')).toBe('Top nations by order revenue, 1997');
    expect(dataName('Customers by market segment')).toBe('Customers by market segment');
    expect(dataName('top_customers')).toBe('Top Customers');
  });

  it('names an AI pick the same way', () => {
    const proposal = {
      id: 'p', draftId: 'd', baseRevision: 0, baseProposalHash: 'h', clarifications: [],
      summary: { requirements: 1, covered: 1, gaps: 0, certifiedSources: 1, semanticSources: 0 },
      operations: [
        { type: 'upsert_source', source: { id: 's1', kind: 'certified_block', sourceRef: 'Top nations by order revenue, 1997', trustState: 'certified', reviewStatus: 'not_required' } },
        { type: 'upsert_source', source: { id: 's2', kind: 'certified_block', sourceRef: 'monthly_revenue', trustState: 'certified', reviewStatus: 'not_required' } },
      ],
    } as AppStudioAiProposal;
    expect(summarizeAppStudioAiPlan(proposal).sources.map((source) => source.label)).toEqual(['Top nations by order revenue, 1997', 'Monthly Revenue']);
  });
});

describe('a result of categories is never drawn as a line (every edition)', () => {
  const result = (columns: string[], rows: Array<Record<string, unknown>>): QueryResult => ({ columns, rows, rowCount: rows.length } as QueryResult);
  const nations = [{ NATION: 'FRANCE', ORDER_REVENUE: 120 }, { NATION: 'GERMANY', ORDER_REVENUE: 110 }, { NATION: 'CHINA', ORDER_REVENUE: 90 }];

  it('draws one category and one measure as bars, and more columns as a table', () => {
    // "NATION" holds "at": it named a date before (V2: nations joined by a line).
    expect(detectChartType(result(['NATION', 'ORDER_REVENUE'], nations))).toBe('bar');
    expect(detectChartType(result(['CATEGORY', 'TOTAL'], [{ CATEGORY: 'A', TOTAL: 1 }, { CATEGORY: 'B', TOTAL: 2 }]))).not.toBe('line');
    expect(detectChartType(result(['N_NATIONKEY', 'NATION', 'ORDER_REVENUE'], nations.map((row, index) => ({ N_NATIONKEY: index, ...row }))))).toBe('table');
    // A chart chosen as Table stays a table.
    expect(resolveChartType(result(['NATION', 'ORDER_REVENUE'], nations), { chart: 'table' })).toBe('table');
  });

  it('still draws a line along a real time axis', () => {
    expect(detectChartType(result(['ORDER_DATE', 'REVENUE'], [{ ORDER_DATE: '1997-01-01', REVENUE: 1 }, { ORDER_DATE: '1997-02-01', REVENUE: 2 }]))).toBe('line');
    expect(detectChartType(result(['created_at', 'orders'], [{ created_at: '2026-01-01T00:00:00Z', orders: 1 }]))).toBe('line');
    expect(detectChartType(result(['orderDate', 'orders'], [{ orderDate: 'Jan', orders: 1 }]))).toBe('line');
    expect(detectChartType(result(['bucket', 'orders'], [{ bucket: '2026-01-01', orders: 1 }, { bucket: '2026-01-02', orders: 3 }]))).toBe('line');
    expect(detectChartType(result(['SEASON', 'WINS'], [{ SEASON: 2015, WINS: 67 }, { SEASON: 2016, WINS: 73 }]))).toBe('line');
  });
});

describe('Ask shows its chats, not the notebook tree, after a visit to Notebooks (every edition)', () => {
  it('closes the shared sidebar when Ask, its traces or History open, and Notebooks opens it again', () => {
    const { dispatch } = useNotebookStore.getState();
    dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'files' });
    expect(useNotebookStore.getState().sidebarOpen).toBe(true);
    dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' });
    expect(useNotebookStore.getState().mainView).toBe('ask');
    expect(useNotebookStore.getState().sidebarOpen).toBe(false);
    dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'files' });
    expect(useNotebookStore.getState().sidebarOpen).toBe(true);
    dispatch({ type: 'SET_MAIN_VIEW', view: 'history' });
    expect(useNotebookStore.getState().sidebarOpen).toBe(false);
    dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'block_library' });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' });
    // A page that works with the tree keeps it.
    expect(useNotebookStore.getState().sidebarOpen).toBe(true);
  });
});

describe('an App\'s intro names only the tiles a reader sees, in label words (every edition)', () => {
  type Item = DashboardDocumentResponse['dashboard']['layout']['items'][number];
  const tile = (i: string, title: string): Item => ({ i, x: 0, y: 0, w: 6, h: 4, title, viz: { type: 'bar' } } as Item);
  const intro = { i: 'intro', x: 0, y: 0, w: 12, h: 2, viz: { type: 'text' }, text: { markdown: '' } } as Item;
  const max = tile('max', 'Max POINTS PER GAME by game type');
  const ppg = tile('ppg', 'POINTS PER GAME by game type');

  it('leaves out the tile the view hides as a repeat, and reads raw column names as words', () => {
    const markdown = '# Warriors 2016 scoring\n\nThis page shows Max POINTS PER GAME by game type and POINTS PER GAME by game type.';
    expect(readerIntroMarkdown(markdown, [intro, max, ppg], [intro, max])).toBe('# Warriors 2016 scoring\n\nThis page shows Max points per game by game type.');
  });

  it('keeps where the numbers come from, and every tile when none is hidden', () => {
    const markdown = '# Wins\n\nThis page shows WINS by SEASON and Top scorers, from 2 certified sources: Wins and Scorers.';
    const wins = tile('w', 'WINS by SEASON');
    const scorers = tile('s', 'Top scorers');
    expect(readerIntroMarkdown(markdown, [wins, scorers], [wins, scorers])).toBe('# Wins\n\nThis page shows wins by season and Top scorers, from 2 certified sources: Wins and Scorers.');
  });

  it('keeps an intro anyone wrote as written', () => {
    const own = '# Wins\n\nHow the Warriors did, season by season.';
    expect(readerIntroMarkdown(own, [max, ppg], [max])).toBe(own);
  });

  it('reads a raw column name as words and keeps a short acronym', () => {
    expect(titleInLabelWords('Max POINTS PER GAME by game type')).toBe('Max points per game by game type');
    expect(titleInLabelWords('NBA wins by TOTAL_POINTS')).toBe('NBA wins by total points');
    expect(titleInLabelWords('Revenue by region')).toBe('Revenue by region');
  });
});
