import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { setSnowflakeApp } from './snowflake-app-mode';
import {
  agentMemoryDetail,
  importAddSqlStep,
  importContextHint,
  importEmptyMessage,
  importSourceModes,
  importStartDetail,
  metadataIndexDetail,
  metadataSyncingMessage,
  notebookAiScopeHint,
  notebookBreadcrumbParts,
  openFileKind,
  savedQueryFolderWords,
  sqlConvertHint,
  sqlPlaceholder,
} from './snowflake-app-words';
import {
  BlockDetailView,
  BlockStudioImportWorkspace,
  BlockStudioStartPage,
  CompactBlockIdentity,
  homeTableCount,
  savedQueriesCrumb,
  SqlBlockVisualBuilder,
} from '../components/block-studio/BlockStudio';
import { connectionDetailRows } from '../components/panels/connection-values';
import { traceStoreWords } from '../components/agent/AskObservabilityPage';
import { openFileFor, pageTitle } from '../components/shell/page-title';
import { themes } from '../themes/notebook-theme';

/**
 * V14: the app for Snowflake still read like the laptop or a dbt project in places (the V13 retest):
 * "dbt pending", "0 dbt models · 0 MetricFlow metrics", "Local path", ".dql" file paths, ".dqlnb",
 * "+ dbt", "dbt truth", "local SQLite", "Local trace recording", a "BLOCK" chip. Each is said for
 * the app for Snowflake here, and the open-source wording is unchanged.
 */

const LAPTOP_WORDS = /\bdbt\b|MetricFlow|Local path|local SQLite|\.dqlnb|\.dql\b|point (at|to) a folder|on this (machine|computer)|\{\{ ref\(/i;
const t = themes.paper;
const noop = () => {};

afterEach(() => {
  setSnowflakeApp(false);
  vi.unstubAllGlobals();
});

describe('words for the app for Snowflake, and the open-source words unchanged', () => {
  it('says each laptop or dbt line in Snowflake terms only in the app for Snowflake', () => {
    const pairs: Array<[string, string]> = [
      [agentMemoryDetail(true), agentMemoryDetail(false)],
      [metadataIndexDetail(true), metadataIndexDetail(false)],
      [metadataSyncingMessage(true), metadataSyncingMessage(false)],
      [notebookAiScopeHint(false, true), notebookAiScopeHint(false, false)],
      [notebookAiScopeHint(true, true), notebookAiScopeHint(true, false)],
      [importContextHint(true), importContextHint(false)],
      [importEmptyMessage(true), importEmptyMessage(false)],
      [importAddSqlStep(true), importAddSqlStep(false)],
      [importStartDetail(true), importStartDetail(false)],
      [sqlConvertHint(true).after, sqlConvertHint(false).after],
      [sqlPlaceholder(true), sqlPlaceholder(false)],
    ];
    for (const [snowflake, openSource] of pairs) {
      expect(snowflake).not.toMatch(LAPTOP_WORDS);
      expect(snowflake).not.toMatch(/\blocal\b|saved query files|without writing files/i);
      expect(snowflake).not.toBe(openSource);
    }
    // The open-source words, exactly as before.
    expect(agentMemoryDetail(false)).toContain('dbt truth');
    expect(metadataIndexDetail(false)).toBe('ZLens synchronizes this authorized scope into local SQLite. Warm Ask, Notebook, and Saved queries searches use that index instead of scanning the warehouse.');
    expect(notebookAiScopeHint(false, false)).toBe('Whole notebook + dbt, semantic metadata, certified saved queries, prior AI history');
    expect(importContextHint(false)).toBe('Uses dbt, MetricFlow, warehouse catalog, and existing DQL context when available.');
    expect(importEmptyMessage(false)).toBe('Add SQL to analyze DQL candidates without creating saved query files.');
    expect(sqlConvertHint(false).after).toContain('grounds tables against dbt');
  });

  it('offers no "Local path" source in Import SQL in the app for Snowflake', () => {
    expect(importSourceModes(true)).toEqual(['paste', 'upload']);
    expect(importSourceModes(false)).toEqual(['paste', 'upload', 'path']);
  });

  it('names a notebook by its title, never its file name, in the app for Snowflake', () => {
    expect(notebookBreadcrumbParts('notebooks/nba/v8_warriors_seasons_check.dqlnb', true)).toEqual(['Notebooks', 'nba', 'v8_warriors_seasons_check']);
    expect(notebookBreadcrumbParts('notebooks/nba/v8_warriors_seasons_check.dqlnb', false)).toEqual(['notebooks', 'nba', 'v8_warriors_seasons_check.dqlnb']);
    expect(notebookBreadcrumbParts('', true)).toEqual([]);
  });

  it('calls a saved query a saved query in the header chip, and leaves out ZLens\'s own _drafts folder', () => {
    expect(openFileKind('block', true)).toBe('saved query');
    expect(openFileKind('block', false)).toBe('block');
    expect(openFileKind('notebook', true)).toBe('notebook');
    expect(savedQueryFolderWords('_drafts', true)).toBeNull();
    expect(savedQueryFolderWords('executive/_drafts', true)).toBeNull();
    expect(savedQueryFolderWords('executive/monthly', true)).toBe('folder: executive/monthly');
    expect(savedQueryFolderWords('_drafts', false)).toBe('folder: _drafts');
    expect(savedQueryFolderWords(undefined, true)).toBeNull();
  });

  it('shows the app\'s sign-in as set by Snowflake, not raw authMethod and tokenFilePath rows', () => {
    const cfg = { driver: 'snowflake', account: '${SNOWFLAKE_ACCOUNT}', warehouse: 'APP_WH', database: 'NBA', authMethod: 'oauth', tokenFilePath: '/snowflake/session/token' };
    const sensitive = (field: string) => /token|password/i.test(field);
    const app = connectionDetailRows(cfg, true, sensitive);
    expect(app).toEqual([['account', 'Set by Snowflake'], ['warehouse', 'APP_WH'], ['database', 'NBA'], ['sign-in', 'Set by Snowflake']]);
    expect(JSON.stringify(app)).not.toMatch(/authMethod|tokenFilePath|oauth|•/);
    // Everywhere else every row stays, secrets masked.
    expect(connectionDetailRows(cfg, false, sensitive)).toEqual([
      ['account', 'From SNOWFLAKE_ACCOUNT in the environment'],
      ['warehouse', 'APP_WH'],
      ['database', 'NBA'],
      ['authMethod', 'oauth'],
      ['tokenFilePath', '••••••••'],
    ]);
  });

  it('says traces stay in the Snowflake account, with no "local" trace store', () => {
    const ready = { available: true, recordingEnabled: true } as never;
    const app = traceStoreWords({ status: ready, loading: false, snowflakeApp: true });
    expect(app.title).toBe('Trace recording is ready.');
    expect(app.detail).toContain('stay in your Snowflake account');
    for (const words of [
      app,
      traceStoreWords({ loading: false, error: 'x', snowflakeApp: true }),
      traceStoreWords({ loading: true, snowflakeApp: true }),
      traceStoreWords({ status: { available: false, recordingEnabled: false, reason: 'disabled' } as never, loading: false, snowflakeApp: true }),
      traceStoreWords({ status: { available: false, recordingEnabled: false, reason: 'unsupported_schema' } as never, loading: false, snowflakeApp: true }),
    ]) {
      expect(`${words.title} ${words.detail}`).not.toMatch(/\blocal\b|runtime/i);
    }
    const laptop = traceStoreWords({ status: ready, loading: false });
    expect(laptop.title).toBe('Local trace recording is ready.');
    expect(laptop.detail).toBe('Traces are local and redacted. Full prompts, SQL, rows, provider responses, credentials, and file paths are not retained here.');
  });
});

const startPage = (indexedTables: number) => renderToStaticMarkup(
  <BlockStudioStartPage
    dbtStatus={null}
    semanticStats={{ metrics: 0, measures: 0, dimensions: 0, timeDimensions: 0, entities: 0, hierarchies: 0, semanticModels: 0, savedQueries: 0 }}
    semanticObjectCount={0}
    databaseStats={{ schemas: 0, tables: homeTableCount(0, 0, indexedTables), columns: 0 }}
    onImport={noop}
    onBuildDql={noop}
    t={t}
  />,
);

describe('the Saved queries home', () => {
  it('in the app for Snowflake: no dbt chip or dbt card, and the tables ZLens indexed', () => {
    setSnowflakeApp(true);
    const html = startPage(18);
    expect(html).not.toMatch(/dbt pending|dbt ready|dbt models|MetricFlow|Waiting for dbt/);
    expect(html).toContain('18 tables');
    expect(html).not.toMatch(/point at a folder|writing files/);
  });

  it('everywhere else: as before', () => {
    const html = startPage(0);
    expect(html).toContain('dbt pending');
    expect(html).toContain('Waiting for dbt artifacts');
    expect(html).toContain('0 tables');
    expect(html).toContain('point at a folder');
  });

  it('has no "Saved queries › sql" crumb in the app for Snowflake', () => {
    const crumb = (input: Partial<Parameters<typeof savedQueriesCrumb>[0]>) => savedQueriesCrumb({ hasActiveDraft: false, importing: false, semantic: false, snowflakeApp: true, ...input });
    expect(crumb({})).toBeNull();
    expect(crumb({ importing: true })).toBe('Import SQL');
    expect(crumb({ hasActiveDraft: true })).toBe('New saved query');
    expect(crumb({ name: 'warriors_regular_wins_v13_import' })).toBe('warriors_regular_wins_v13_import');
    // Everywhere else, as before.
    expect(crumb({ snowflakeApp: false })).toBe('sql');
    expect(crumb({ snowflakeApp: false, semantic: true })).toBe('semantic');
    expect(crumb({ snowflakeApp: false, hasActiveDraft: true })).toBe('new_block');
  });

  it('counts the most tables any source knows of', () => {
    expect(homeTableCount(0, 0, 18)).toBe(18);
    expect(homeTableCount(25, 3, 18)).toBe(25);
    expect(homeTableCount(0, 4, undefined)).toBe(4);
    expect(homeTableCount(0, 0, Number.NaN)).toBe(0);
  });
});

describe('Import SQL in the app for Snowflake', () => {
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

  it('offers Paste SQL and Upload files, with no "Local path", dbt or "saved query files"', () => {
    setSnowflakeApp(true);
    const html = workspace();
    expect(html).toContain('Paste SQL');
    expect(html).toContain('Upload files');
    expect(html).not.toMatch(/Local path|dbt|MetricFlow|saved query files|folder of them/);
    expect(html).toContain(importContextHint(true));
  });

  it('keeps all three sources everywhere else', () => {
    const html = workspace();
    expect(html).toContain('Local path');
    expect(html).toContain('Uses dbt, MetricFlow, warehouse catalog');
  });
});

describe('the saved query builder in the app for Snowflake', () => {
  const metadata = { name: 'warriors_regular_wins_v13_import', path: 'domains/nba/blocks/_drafts/warriors_regular_wins_v13_import.dql', domain: 'nba', folderPath: '_drafts', description: '', owner: 'TEST_ADMIN', tags: [] } as never;

  it('shows no .dql file path under Folder', () => {
    setSnowflakeApp(true);
    const html = renderToStaticMarkup(<CompactBlockIdentity metadata={metadata} domains={[]} onTextChange={noop} onFolderChange={noop} onTagsChange={noop} t={t} />);
    expect(html).not.toContain('.dql');
    expect(html).not.toContain('domains/nba/blocks');
    setSnowflakeApp(false);
    expect(renderToStaticMarkup(<CompactBlockIdentity metadata={metadata} domains={[]} onTextChange={noop} onFolderChange={noop} onTagsChange={noop} t={t} />)).toContain('domains/nba/blocks/_drafts/warriors_regular_wins_v13_import.dql');
  });

  it('says tables are checked against the tables ZLens reads, not dbt', () => {
    const render = () => renderToStaticMarkup(
      <SqlBlockVisualBuilder source={'block "x" {\n  query = """SELECT 1"""\n}'} metadata={metadata} domainOptions={[]} chartConfig={{}} onChange={noop} onMetadataChange={noop} onConvertToDql={noop} onFillCertification={noop} fillingCertification={false} t={t} />,
    );
    setSnowflakeApp(true);
    const html = render();
    expect(html).not.toMatch(/against dbt|ref\(/);
    expect(html).toContain('checks each table against the tables ZLens reads');
    setSnowflakeApp(false);
    expect(render()).toContain('grounds tables against dbt');
  });
});

describe('the saved query page header in the app for Snowflake', () => {
  const page = () => renderToStaticMarkup(
    <BlockDetailView
      metadata={{ name: 'warriors_regular_wins_v13_import', domain: 'nba', folderPath: '_drafts', owner: 'TEST_ADMIN', tags: ['nba'], reviewStatus: 'draft' } as never}
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

  it('has no "folder: _drafts" line', () => {
    setSnowflakeApp(true);
    expect(page()).not.toContain('folder: _drafts');
    expect(page()).toContain('nba · TEST_ADMIN · nba');
    setSnowflakeApp(false);
    expect(page()).toContain('folder: _drafts');
  });
});

describe('the header after leaving a notebook (every edition)', () => {
  const notebook = { name: 'v8_warriors_seasons_check.dqlnb', path: 'notebooks/nba/v8_warriors_seasons_check.dqlnb', type: 'notebook' };
  const savedQuery = { name: 'wins.dql', path: 'domains/nba/blocks/wins.dql', type: 'block' };

  it('names no notebook on Saved queries, only an open saved query', () => {
    expect(openFileFor('block_studio', notebook)).toBeNull();
    expect(openFileFor('block_studio', savedQuery)).toBe(savedQuery);
    expect(openFileFor('notebook', notebook)).toBe(notebook);
    expect(openFileFor('ask', notebook)).toBeNull();
    expect(openFileFor('block_studio', null)).toBeNull();
    // So the browser tab says Saved queries, not the notebook's title.
    expect(pageTitle({ mainView: 'block_studio', openTitle: openFileFor('block_studio', notebook) ? 'v8-warriors-seasons-check' : null })).toBe('Saved queries · ZLens');
  });
});
