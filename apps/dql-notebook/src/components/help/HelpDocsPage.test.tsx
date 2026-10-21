import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookProvider } from '../../store/NotebookStore';
import { HELP_LINKS, HelpDocsPage } from './HelpDocsPage';

const REPO = 'https://github.com/duckcode-ai-labs/zlens';
const repoRoot = join(__dirname, '..', '..', '..', '..', '..');

describe('Help page outside links (N1)', () => {
  it('points every rail link at a page that exists', () => {
    expect(HELP_LINKS.map((link) => [link.label, link.href])).toEqual([
      ['Keyboard shortcuts', `${REPO}#readme`],
      ['CLI reference', `${REPO}/blob/main/docs/reference/cli.md`],
      ['Community & support', `${REPO}/blob/main/SUPPORT.md`],
      ['Report an issue', `${REPO}/issues/new/choose`],
    ]);
  });

  it('links only to files this repository has', () => {
    expect(existsSync(join(repoRoot, 'SUPPORT.md'))).toBe(true);
    expect(existsSync(join(repoRoot, 'docs', 'reference', 'cli.md'))).toBe(true);
    // /issues/new/choose lists the issue forms; without any it would be an empty chooser.
    expect(readdirSync(join(repoRoot, '.github', 'ISSUE_TEMPLATE')).some((name) => name.endsWith('.yml') && name !== 'config.yml')).toBe(true);
  });

  it('renders those targets and never the disabled Discussions page', () => {
    const html = renderToStaticMarkup(<NotebookProvider><HelpDocsPage /></NotebookProvider>);
    for (const link of HELP_LINKS) expect(html).toContain(`href="${link.href}"`);
    expect(html).toContain('Community &amp; support');
    expect(html).not.toContain('/discussions');
  });
});

describe('Help guide matches the first start (D7)', () => {
  const html = renderToStaticMarkup(<NotebookProvider><HelpDocsPage /></NotebookProvider>);

  it('shows no image placeholders', () => {
    expect(html).not.toContain('Screenshot:');
    expect(html).not.toMatch(/border:\s*1\.5px dashed/);
  });

  it('starts from a folder, without create-zlens-app or a required dbt project', () => {
    expect(html).not.toContain('create-zlens-app');
    expect(html).not.toContain('and a dbt project');
    expect(html).toContain('zlens notebook ./shop');
    expect(html).toContain('No ZLens project here. Create one? [Y/n]');
    expect(html).toContain('Which schemas should ZLens read?');
    expect(html).toContain('Database only');
  });

  it('covers Apps', () => {
    expect(html).toContain('Build your first App');
    expect(html).toContain('Drafted — review to use');
  });
});
