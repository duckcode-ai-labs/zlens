import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotebookProvider } from '../../store/NotebookStore';
import { ConnectionPanel, type ConnectionInfo } from '../panels/ConnectionPanel';
import { looksLikeGeneratedId } from '../panels/connection-metadata-scope';
import { DbtProjectEditor } from '../settings/DbtProjectEditor';

/**
 * Guided Setup asks plain questions; technical panels sit, closed, under
 * Advanced (design D7). Database only never shows personal ~/.dbt profiles.
 */
const homeProfile = {
  id: 'home:elementary:dev',
  profileName: 'elementary',
  targetName: 'dev',
  adapter: 'postgres',
  path: '/Users/someone/.dbt/profiles.yml',
  connection: { driver: 'postgresql' },
  missingFields: [],
  warnings: [],
};

function info(modelingMode: string): ConnectionInfo {
  return {
    default: 'default',
    connections: { default: { driver: 'duckdb', filepath: 'jaffle_shop.duckdb' } },
    dbtProfiles: [homeProfile] as unknown as ConnectionInfo['dbtProfiles'],
    modelingMode,
    metadataStatus: {
      state: 'ready',
      relationCount: 13,
      columnCount: 80,
      scopes: [],
      observedTarget: { accountOrWorkspace: 'LOCAL_88B5DE228E554CBCCCF7F634', defaultCatalogOrDatabase: 'jaffle_shop', defaultSchema: 'main' },
    } as unknown as ConnectionInfo['metadataStatus'],
  };
}

function setupPanel(setupSource: 'dbt' | 'warehouse', modelingMode: string): string {
  return renderToStaticMarkup(<NotebookProvider><ConnectionPanel variant="setup" setupSource={setupSource} initialInfo={info(modelingMode)} /></NotebookProvider>);
}

/** The text sits inside a closed `<details data-setup-advanced>`. */
function insideClosedAdvanced(markup: string, text: string): boolean {
  const at = markup.indexOf(text);
  if (at < 0) return false;
  const open = markup.lastIndexOf('<details data-setup-advanced', at);
  if (open < 0) return false;
  const closeBefore = markup.lastIndexOf('</details>', at);
  const tag = markup.slice(open, markup.indexOf('>', open) + 1);
  return closeBefore < open && !/\bopen\b/.test(tag);
}

describe('Guided Setup: two plain questions, Advanced closed (D7)', () => {
  it('Database only asks "Which schemas should ZLens read?" and hides index mode, the typed list and dbt profiles', () => {
    const markup = setupPanel('warehouse', 'warehouse-first');
    expect(markup).toContain('Which schemas should ZLens read?');
    expect(markup).toContain('Find available databases &amp; schemas');
    expect(markup).toContain('Apply and synchronize');
    expect(insideClosedAdvanced(markup, 'Index mode')).toBe(true);
    expect(insideClosedAdvanced(markup, 'Databases/catalogs and schemas')).toBe(true);
    expect(markup).not.toContain('Metadata scope');
    // Personal ~/.dbt profiles never show without dbt.
    expect(markup).not.toContain('Import dbt profiles.yml');
    expect(markup).not.toContain('elementary');
    // No random identifiers in the panel.
    expect(markup).not.toContain('LOCAL_88B5');
    expect(markup).not.toContain('outside the configured dbt project');
  });

  it('a dbt setup keeps profile import and the warehouse scope under Advanced', () => {
    const markup = setupPanel('dbt', 'dbt-first');
    expect(insideClosedAdvanced(markup, 'Import dbt profiles.yml')).toBe(true);
    expect(insideClosedAdvanced(markup, 'Metadata scope')).toBe(true);
    expect(markup).not.toContain('LOCAL_88B5');
  });

  it('Settings shows the full panel with nothing hidden', () => {
    const markup = renderToStaticMarkup(<NotebookProvider><ConnectionPanel variant="panel" initialInfo={info('dbt-first')} /></NotebookProvider>);
    expect(markup).not.toContain('data-setup-advanced');
  });

  it('step 1 puts the semantic execution adapters under Advanced', () => {
    const setup = renderToStaticMarkup(<NotebookProvider><DbtProjectEditor compact /></NotebookProvider>);
    expect(insideClosedAdvanced(setup, 'Semantic execution adapters')).toBe(true);
    const settings = renderToStaticMarkup(<NotebookProvider><DbtProjectEditor /></NotebookProvider>);
    expect(settings).toContain('Semantic execution adapters');
    expect(settings).not.toContain('data-setup-advanced');
  });

  it('recognises generated identifiers', () => {
    expect(looksLikeGeneratedId('LOCAL_88B5DE228E554CBCCCF7F634')).toBe(true);
    expect(looksLikeGeneratedId('8f7fac5d-8eae-416e-b39b-a1b2c3d4e5f6')).toBe(true);
    expect(looksLikeGeneratedId('jaffle_shop')).toBe(false);
    expect(looksLikeGeneratedId('ANALYTICS_PROD')).toBe(false);
  });
});
