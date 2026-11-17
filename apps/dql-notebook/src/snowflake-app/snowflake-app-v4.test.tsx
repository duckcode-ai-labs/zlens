import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { setSnowflakeApp } from './snowflake-app-mode';
import {
  axisOptionLabel,
  clarificationChoiceWords,
  draftNameTooltip,
  generateGapLabel,
  notebookWriteWords,
  semanticLayerName,
  sourceEditorWords,
  sqlConvertHint,
} from './snowflake-app-words';
import { appLibraryWords } from '../components/apps/app-library-words';
import { buildCatalogFooter } from '../components/panels/build-footer';
import { humanize } from '../components/apps/builder/studio-ui';
import { BlockDetailView } from '../components/block-studio/BlockStudio';
import { ProviderSettingsForm } from '../components/settings/SettingsPage';
import type { ProviderSettings } from '../api/client';
import { themes } from '../themes/notebook-theme';

/**
 * V4 tester, in the app for Snowflake: open-source words still showed ("Reading local app files", a
 * "blocks/_drafts/<name>.dql" tooltip, "DQL semantic layer synced", "DQL SOURCE", "write SQL/DQL", "Generate draft
 * DQL"), columns read as SQL spells them ("PLAYER_NAME", "POINTS PER GAME", "game_count by SEASON"), and Settings did
 * not say which model was in use. Each is said in plain words there; the open-source words are unchanged.
 */

const t = themes.paper;
const noop = () => {};

afterEach(() => {
  setSnowflakeApp(false);
  vi.unstubAllGlobals();
});

describe('open-source words, said plainly in the app for Snowflake', () => {
  it('says each in plain words there, and as before everywhere else', () => {
    expect(appLibraryWords(false, true).loadingDetail).toBe('Getting your Apps.');
    expect(appLibraryWords(false).loadingDetail).toBe('Reading local app files from this ZLens project.');
    expect(draftNameTooltip('blocks/_drafts/how_many_teams.dql', true)).toBeUndefined();
    expect(draftNameTooltip('blocks/_drafts/how_many_teams.dql', false)).toBe('blocks/_drafts/how_many_teams.dql');
    expect(sourceEditorWords(true)).toEqual({ tab: 'Source', section: 'Source', open: 'Open in Source' });
    expect(sourceEditorWords(false)).toEqual({ tab: 'DQL Source', section: 'DQL source', open: 'Open in DQL Source' });
    expect(semanticLayerName(true)).toBe('Semantic layer');
    expect(semanticLayerName(false)).toBe('DQL semantic layer');
    expect(notebookWriteWords(true)).toBe('write SQL');
    expect(notebookWriteWords(false)).toBe('write SQL/DQL');
    expect(generateGapLabel(true)).toBe('Generate a draft');
    expect(generateGapLabel(false)).toBe('Generate draft DQL');
    // V4 review: no hint points to the Source editor in the app for Snowflake.
    expect(sqlConvertHint(true).after).not.toContain('Source editor');
    expect(sqlConvertHint(false).after).toContain('Open the DQL Source editor');
    for (const words of [appLibraryWords(false, true).loadingDetail, sourceEditorWords(true).open, semanticLayerName(true), notebookWriteWords(true), generateGapLabel(true), sqlConvertHint(true).after]) {
      expect(words).not.toMatch(/\bDQL\b|\blocal\b|_drafts|\.dql\b/);
    }
  });

  it('says "Semantic layer synced" in the Build sidebar', () => {
    expect(buildCatalogFooter({ provider: 'dql', metrics: 9, snowflakeApp: true })).toBe('Semantic layer synced · 9 metrics');
    expect(buildCatalogFooter({ provider: 'dql', metrics: 9 })).toBe('DQL semantic layer synced · 9 metrics');
  });

  it('shows no source panel on the saved query page in the app for Snowflake (V4 review), and "DQL source" in open source', () => {
    const page = () => renderToStaticMarkup(
      <BlockDetailView
        metadata={{ name: 'wins', domain: 'nba', owner: 'TEST_ADMIN', reviewStatus: 'draft' } as never}
        source={'block "wins" {\n  query = """SELECT 1"""\n}'}
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
    const snowflake = page();
    expect(snowflake).not.toContain('Open in Source');
    expect(snowflake).toContain('SELECT 1');
    expect(snowflake).not.toContain('DQL source');
    expect(snowflake).not.toContain('DQL Source');
    setSnowflakeApp(false);
    expect(page()).toContain('Open in DQL Source');
  });
});

describe('column names in words in the app for Snowflake, the column kept as the value', () => {
  it('names a chart axis choice in words', () => {
    expect(axisOptionLabel('PLAYER_NAME', true)).toBe('Player name');
    expect(axisOptionLabel('TOTAL_POINTS', true)).toBe('Total points');
    expect(axisOptionLabel('PLAYER_NAME', false)).toBe('PLAYER_NAME');
  });

  it('names an App Studio field in words, not in capitals', () => {
    setSnowflakeApp(true);
    expect(humanize('POINTS_PER_GAME')).toBe('Points Per Game');
    expect(humanize('GAME TYPE')).toBe('Game Type');
    expect(humanize('order_total')).toBe('Order Total');
    setSnowflakeApp(false);
    expect(humanize('POINTS_PER_GAME')).toBe('POINTS PER GAME');
    expect(humanize('order_total')).toBe('Order Total');
  });

  it('names Ask\'s choices of meaning in words, and leaves a value from the data as it is', () => {
    expect(clarificationChoiceWords({ label: 'TOTAL POINTS', description: 'SEASON 2003–2022', kind: 'vocabulary' }, true)).toEqual({ label: 'Total points', description: 'Season 2003–2022' });
    expect(clarificationChoiceWords({ label: 'GAMES', description: 'game_count by SEASON' }, true)).toEqual({ label: 'Games', description: 'Game count by season' });
    expect(clarificationChoiceWords({ label: 'LOS ANGELES LAKERS', kind: 'member' }, true)).toEqual({ label: 'LOS ANGELES LAKERS' });
    expect(clarificationChoiceWords({ label: 'TOTAL POINTS', description: 'SEASON 2003–2022', kind: 'vocabulary' }, false)).toEqual({ label: 'TOTAL POINTS', description: 'SEASON 2003–2022' });
  });
});

describe('Settings » AI provider in the app for Snowflake', () => {
  const cortex = (model?: string): ProviderSettings => ({
    id: 'cortex', label: 'Snowflake Cortex', enabled: true, active: true, hasApiKey: false, configured: true, source: 'local', envVars: [],
    authMode: 'snowflake_connection', allowed: true, connectionSignIn: { connection: 'snowflake', method: 'key_pair' }, defaultModel: 'claude-sonnet-5-5',
    ...(model ? { model } : {}),
  });
  const form = (provider: ProviderSettings) => renderToStaticMarkup(
    <ProviderSettingsForm providers={[provider]} cliStatus={{}} t={t} onSaved={noop} onStatus={noop} editorMode="settings" />,
  );

  it('says which model is in use: the default when none is saved', () => {
    setSnowflakeApp(true);
    expect(form(cortex())).toContain('In use: claude-sonnet-5-5 (the default)');
    expect(form(cortex('claude-opus-5'))).toContain('In use: claude-opus-5');
  });
});
