import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { setSnowflakeApp } from './snowflake-app-mode';
import {
  buildSearchPlaceholder,
  builderQueryWords,
  businessContextPrompt,
  importDraftWords,
  noDomainLabel,
  savedQueryDomainWords,
  sqlConvertHint,
  warehouseDraftDetail,
} from './snowflake-app-words';
import { BlockDetailView, CompactBlockIdentity, dedentSql, SqlBlockVisualBuilder } from '../components/block-studio/BlockStudio';
import { SaveAsBlockModal } from '../components/modals/SaveAsBlockModal';
import { makeCell } from '../store/NotebookStore';
import { themes } from '../themes/notebook-theme';
import type * as PanelModule from '../components/agent/UnifiedAgentRunPanel';

/**
 * V4 review, in the ZLens app for Snowflake. A Snowflake reviewer's script asks a question, saves the answer with
 * "Save as saved query", opens it, edits its SQL in the builder, certifies it and opens History. On that path they
 * met words and screens meant for the open-source edition's developers: a `blocks/<name>.dql` path and the raw
 * saved query source in the save dialog, agent-facing metadata, "Has LLM context (for agents)", "Global /
 * cross-domain", the saved query page's SOURCE panel with "Open in Source", "uncategorized", the builder's
 * "Generated DQL preview" and hints about "the Source editor", Ask's DQL tab, "Search blocks…", and "DQL drafts
 * models". Each is hidden or said plainly there; the open-source edition is unchanged.
 */

const t = themes.paper;
const noop = () => {};
const DEV_WORDS = /\bDQL\b|\.dql\b|blocks\/|Source editor|Open in Source|uncategorized|Global \/ cross-domain|LLM|Agent-facing|dql-format|block "/;

let panel: typeof PanelModule;
beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/ask' } });
  panel = await import('../components/agent/UnifiedAgentRunPanel');
  vi.unstubAllGlobals();
});

afterEach(() => {
  setSnowflakeApp(false);
});

const ASKED_SOURCE = 'block "Top nations by order revenue, 1997" {\n  type = "custom"\n  status = "draft"\n  query = """\n    SELECT n_name, SUM(o_totalprice) AS revenue\n    FROM orders\n    GROUP BY 1\n  """\n}\n';
const SAVED_SOURCE = `// dql-format: 1\n${ASKED_SOURCE.replace('  status = "draft"\n', '  status = "draft"\n  domain = "uncategorized"\n  tags = ["app-source"]\n')}`;

describe('Save as saved query, from an Ask answer', () => {
  const dialog = () => renderToStaticMarkup(
    <SaveAsBlockModal
      cell={makeCell('dql', ASKED_SOURCE)}
      onClose={noop}
      initialContent={ASKED_SOURCE}
      initialName="Top nations by order revenue, 1997"
      initialOwner="TEST_ADMIN"
      aiQuestion="Which nations had the most order revenue in 1997?"
    />,
  );

  it('shows no file path, no raw source, no agent-facing metadata and no LLM check in the app for Snowflake', () => {
    setSnowflakeApp(true);
    const html = dialog();
    expect(html).toContain('Save as saved query');
    expect(html).not.toContain('blocks/top-nations-by-order-revenue-1997.dql');
    expect(html).not.toContain('Content Preview');
    expect(html).not.toContain('type = &quot;custom&quot;');
    expect(html).not.toContain('Agent-facing metadata');
    expect(html).not.toContain('Has LLM context');
    expect(html).toContain('<option value="" selected="">No domain</option>');
    expect(html).not.toContain('Global / cross-domain');
    // The dialog's own footer stays.
    expect(html).toContain('Saved as a draft that needs review. Saving never certifies');
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(DEV_WORDS);
  });

  it('is unchanged in the open-source edition', () => {
    const html = dialog();
    expect(html).toContain('blocks/top-nations-by-order-revenue-1997.dql');
    expect(html).toContain('Content Preview');
    expect(html).toContain('Agent-facing metadata (optional — helps AI tools ground answers on this block)');
    expect(html).toContain('Has LLM context (for agents)');
    expect(html).toContain('Global / cross-domain');
  });
});

describe('the saved query page', () => {
  const page = () => renderToStaticMarkup(
    <BlockDetailView
      metadata={{ name: 'Top nations by order revenue, 1997', domain: 'uncategorized', owner: 'TEST_ADMIN', tags: ['app-source'], reviewStatus: 'draft' } as never}
      source={SAVED_SOURCE}
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

  it('shows the SQL it runs, not its source, and "No domain", in the app for Snowflake', () => {
    setSnowflakeApp(true);
    const html = page();
    expect(html).toContain('Open in builder');
    expect(html).not.toContain('Open in Source');
    expect(html).not.toContain('// dql-format: 1');
    expect(html).not.toContain('block &quot;');
    expect(html).not.toContain('tags = [');
    expect(html).not.toContain('uncategorized');
    expect(html).toContain('No domain · TEST_ADMIN');
    expect(html).toContain('data-testid="saved-query-sql"');
    expect(html).toContain('SELECT n_name, SUM(o_totalprice) AS revenue\nFROM orders\nGROUP BY 1');
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(DEV_WORDS);
  });

  it('keeps its DQL source panel and stored domain in the open-source edition', () => {
    const html = page();
    expect(html).toContain('Open in DQL Source');
    expect(html).toContain('// dql-format: 1');
    expect(html).toContain('uncategorized · TEST_ADMIN');
    expect(html).not.toContain('data-testid="saved-query-sql"');
  });

  it('names a domain in words only when there is none', () => {
    expect(savedQueryDomainWords('uncategorized', true)).toBe('No domain');
    expect(savedQueryDomainWords('', true)).toBe('No domain');
    expect(savedQueryDomainWords(undefined, true)).toBe('No domain');
    expect(savedQueryDomainWords('sales', true)).toBe('sales');
    expect(savedQueryDomainWords('uncategorized', false)).toBe('uncategorized');
    expect(noDomainLabel(true)).toBe('No domain');
    expect(noDomainLabel(false)).toBe('Global / cross-domain');
    expect(dedentSql('SELECT 1\n    FROM x\n      WHERE y')).toBe('SELECT 1\nFROM x\n  WHERE y');
  });
});

describe('the builder', () => {
  const metadata = { name: 'Top nations by order revenue, 1997', domain: 'uncategorized', owner: 'TEST_ADMIN', tags: [], description: '', path: 'blocks/top-nations-by-order-revenue-1997.dql', sourceFingerprint: 'x' } as never;
  const builder = () => renderToStaticMarkup(
    <SqlBlockVisualBuilder source={SAVED_SOURCE} metadata={metadata} domainOptions={[]} chartConfig={{}} onChange={noop} onMetadataChange={noop} onConvertToDql={noop} onFillCertification={noop} fillingCertification={false} t={t} />,
  );

  it('keeps the SQL editor and shows no generated source, no Source editor hint and no DQL in the app for Snowflake', () => {
    setSnowflakeApp(true);
    const html = builder();
    expect(html).toContain('aria-label="Saved query SQL"');
    expect(html).not.toContain('Generated DQL preview');
    expect(html).not.toContain('Convert to DQL script');
    expect(html).not.toContain('Source editor');
    expect(html).toContain('Write the SQL this saved query runs.');
    expect(html).toContain('and checks each table against the tables ZLens reads.');
    expect(html).toContain('<option value="" selected="">No domain</option>');
    // The SQL editor holds the SQL; nothing else on the page names DQL, the Source editor or a file.
    const text = html.replace(/<textarea[\s\S]*?<\/textarea>/g, '').replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(DEV_WORDS);
  });

  it('is unchanged in the open-source edition', () => {
    const html = builder();
    expect(html).toContain('Generated DQL preview');
    expect(html).toContain('Convert to DQL script');
    expect(html).toContain('Write raw SQL — it compiles into a governed DQL script.');
    expect(html).toContain('Open the DQL Source editor for the full script.');
    expect(html).toContain('Global / cross-domain');
  });

  it('says its other hints without DQL or the Source editor in the app for Snowflake', () => {
    const snowflake = builderQueryWords(true);
    for (const words of Object.values(snowflake)) expect(words).not.toMatch(/\bDQL\b|Source editor/);
    expect(snowflake.noParameters).toBe('This saved query has no runtime parameters.');
    expect(sqlConvertHint(true).after).toBe(' and checks each table against the tables ZLens reads.');
    expect(builderQueryWords(false)).toMatchObject({
      semanticModeHint: 'Pick governed metrics & dimensions — they compile to DQL.',
      aliasHint: 'Add aliases in DQL Source to expose business-friendly output names.',
      editSource: 'Edit DQL',
    });
    expect(renderToStaticMarkup(<CompactBlockIdentity metadata={metadata} domains={[]} onTextChange={noop} onFolderChange={noop} onTagsChange={noop} t={t} />)).toContain('Global / cross-domain');
  });
});

describe('Ask: How it was answered', () => {
  const state = { analytical: false, blocked: false, hasDql: true, hasSql: true, hasLineage: true, pipeline: true, hasChecks: true };

  it('has no DQL tab in the app for Snowflake', () => {
    expect(panel.askInspectorTabsForState({ ...state, snowflakeApp: true }).map((tab) => tab.label)).toEqual(['How it answered', 'SQL', 'Data used', 'Checks']);
    expect(panel.askInspectorTabsForState({ ...state, investigation: true, snowflakeApp: true }).map((tab) => tab.id)).not.toContain('dql');
    expect(panel.askInspectorTabsForState({ analytical: true, blocked: true, hasDql: false, hasSql: false, hasLineage: false, snowflakeApp: true }).map((tab) => tab.id)).not.toContain('dql');
    expect(panel.askInspectorTabsForState(state).map((tab) => tab.label)).toEqual(['How it answered', 'DQL', 'SQL', 'Data used', 'Checks']);
  });
});

describe('Saved queries, Modeling and Import SQL', () => {
  it('searches saved queries by that name in the app for Snowflake', () => {
    expect(buildSearchPlaceholder('blocks', true)).toBe('Search saved queries…');
    expect(buildSearchPlaceholder('blocks', false)).toBe('Search blocks…');
    expect(buildSearchPlaceholder('semantic', true)).toBe('Search semantic…');
  });

  it('says ZLens drafts the models in the app for Snowflake', () => {
    expect(warehouseDraftDetail(8, true)).toBe('8 tables synced. ZLens drafts models from their keys and joins from declared foreign keys, view SQL and column names, checks each join on the warehouse, and shows you every change to review.');
    expect(warehouseDraftDetail(1, false)).toMatch(/^1 table synced\. DQL drafts models/);
    expect(businessContextPrompt('orders', true)).toBe('Add the business context for orders.');
    expect(businessContextPrompt('orders', false)).toContain('DQL-owned');
  });

  it('names no DQL, drafts folder or blocks/ folder in Import SQL in the app for Snowflake', () => {
    for (const words of Object.values(importDraftWords(true))) expect(words).not.toMatch(/\bDQL\b|_drafts|blocks\//);
    expect(importDraftWords(false).title).toBe('Import SQL to DQL');
    expect(importDraftWords(false).savedDetail).toContain('blocks/ folder');
  });
});
