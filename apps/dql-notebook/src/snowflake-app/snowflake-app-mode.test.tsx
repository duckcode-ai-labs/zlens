import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@zlens/ui';
import { NotebookProvider } from '../store/NotebookStore';
import { ActivityBar } from '../components/shell/ActivityBar';
import { HelpDocsPage, SNOWFLAKE_APP_HELP_LINKS } from '../components/help/HelpDocsPage';
import { PAGE_NAMES, pageTitle } from '../components/shell/page-title';
import { APPEARANCE_CHOICES, appearanceChoice } from '../components/settings/AppearanceSettings';
import { rowsPrivacy } from '../components/modals/setup-model-source';
import { CORTEX_HELP_SNOWFLAKE_APP } from '../components/settings/provider-choices';
import { isSnowflakeApp, setSnowflakeApp, snowflakeAppPage } from './snowflake-app-mode';

/**
 * V13: the ZLens app for Snowflake looked like a ported laptop tool (the CLI guide as Help, "git init",
 * ".dql/", "this machine", opening on Apps). The server marks its page; these screens read the mark.
 */
afterEach(() => {
  setSnowflakeApp(false);
  vi.unstubAllGlobals();
});

function page(content: string | null) {
  return { querySelector: (selector: string) => (content !== null && selector === 'meta[name="zlens-snowflake-app"]' ? { getAttribute: () => content } : null) } as unknown as Document;
}

describe('knowing it is the app for Snowflake', () => {
  it('reads the mark the server puts on the page, and nothing else', () => {
    expect(snowflakeAppPage(page('1'))).toBe(true);
    expect(snowflakeAppPage(page('0'))).toBe(false);
    expect(snowflakeAppPage(page(null))).toBe(false);
    expect(snowflakeAppPage(undefined)).toBe(false);
  });

  it('can be confirmed later by the setup check', () => {
    expect(isSnowflakeApp()).toBe(false);
    setSnowflakeApp(true);
    expect(isSnowflakeApp()).toBe(true);
  });
});

function rail(): string[] {
  vi.stubGlobal('window', { localStorage: { getItem: () => '0', setItem: () => undefined } });
  const html = renderToStaticMarkup(<TooltipProvider><ActivityBar /></TooltipProvider>);
  return [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]!).filter((name) => !/sidebar rail$/.test(name));
}

describe('the rail in the app for Snowflake', () => {
  it('leads with Ask and has no Source control', () => {
    setSnowflakeApp(true);
    expect(rail()).toEqual(['Ask', 'Apps', 'Notebooks', 'Saved queries', 'Lineage', 'Modeling', 'Ask observability', 'Settings', 'Help']);
  });

  it('is unchanged everywhere else', () => {
    expect(rail()).toEqual(['Apps', 'Ask', 'Notebooks', 'Saved queries', 'Lineage', 'Modeling', 'Ask observability', 'Source control', 'Settings', 'Help']);
  });
});

describe('Help in the app for Snowflake', () => {
  const render = () => renderToStaticMarkup(<NotebookProvider><HelpDocsPage /></NotebookProvider>);

  it('is a guide to the app, not the laptop install', () => {
    setSnowflakeApp(true);
    const html = render();
    expect(html).toContain('ZLens in your Snowflake account');
    for (const laptop of ['npm i -g', 'zlens notebook', 'git init', 'Source control', 'dbt', '.dql/', 'this computer', 'this machine', 'Node 20']) {
      expect(html).not.toContain(laptop);
    }
    // It covers what the reviewer needs: first open, grants, Configurations, the model, backups, stop and start.
    for (const topic of ['What ZLens did first', 'Modeling', 'GRANT SELECT ON ALL TABLES IN SCHEMA', 'Configurations', 'claude-sonnet-5', 'SNOWFLAKE.CORTEX_USER', 'app_public.back_up_now()', 'app_public.restore_backup', 'app_public.start_app()', 'reload once']) {
      expect(html).toContain(topic);
    }
    for (const link of SNOWFLAKE_APP_HELP_LINKS) expect(html).toContain(`href="${link.href}"`);
    expect(html).not.toContain('Ask about setup');
  });

  it('keeps the laptop guide everywhere else', () => {
    const html = render();
    expect(html).toContain('Getting started with ZLens');
    expect(html).toContain('zlens notebook ./shop');
    expect(html).not.toContain('ZLens in your Snowflake account');
  });
});

describe('page titles', () => {
  it('names each page in the browser tab, then ZLens', () => {
    expect(pageTitle({ mainView: 'ask' })).toBe('Ask · ZLens');
    expect(pageTitle({ mainView: 'apps' })).toBe('Apps · ZLens');
    expect(pageTitle({ mainView: 'settings' })).toBe('Settings · ZLens');
    expect(pageTitle({ mainView: 'notebook', openTitle: 'Warriors seasons' })).toBe('Warriors seasons · ZLens');
    expect(pageTitle({ mainView: 'notebook', openTitle: '  ' })).toBe('Notebooks · ZLens');
    // A title is never left over from a notebook once another page is open.
    expect(pageTitle({ mainView: 'ask', openTitle: 'Warriors seasons' })).toBe('Ask · ZLens');
    expect(pageTitle({ mainView: 'host_page' })).toBe('ZLens');
    expect(Object.values(PAGE_NAMES).join(' ')).not.toMatch(/Workbench/);
  });
});

describe('the theme lives in Settings » Appearance', () => {
  it('offers the three themes and maps older names onto them', () => {
    expect(APPEARANCE_CHOICES.map((choice) => choice.mode)).toEqual(['paper', 'white', 'obsidian']);
    expect(appearanceChoice('dark')).toBe('obsidian');
    expect(appearanceChoice('midnight')).toBe('obsidian');
    expect(appearanceChoice('arctic')).toBe('white');
    expect(appearanceChoice('light')).toBe('paper');
    expect(appearanceChoice('paper')).toBe('paper');
  });
});

describe('words for the app for Snowflake', () => {
  it('says rows stay in the Snowflake account, not on a computer', () => {
    expect(rowsPrivacy(false, false, true)).toBe('ZLens reads table structure and counts rows to check keys. Sample rows are shown only to you, inside your Snowflake account. Nothing is sent to the AI unless you turn on value profiles for AI answers.');
    expect(rowsPrivacy(false, true, true)).toBe('Reads structure and counts rows to check keys; sample rows stay in your Snowflake account. Nothing is sent to the AI unless you turn on value profiles.');
    expect(rowsPrivacy(true, false, true)).not.toContain('this computer');
  });

  it('describes Cortex as the app signing in, with no "model on this machine"', () => {
    const text = CORTEX_HELP_SNOWFLAKE_APP.join(' ');
    expect(text).toContain('no API key');
    expect(text).toContain('cross-region inference');
    expect(text).not.toMatch(/this machine|this computer/);
  });
});
