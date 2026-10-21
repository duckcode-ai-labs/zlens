import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as UnifiedAgentRunPanelModule from './UnifiedAgentRunPanel';

let UnifiedAgentRunPanel: typeof UnifiedAgentRunPanelModule.UnifiedAgentRunPanel;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  UnifiedAgentRunPanel = (await import('./UnifiedAgentRunPanel')).UnifiedAgentRunPanel;
});

/** The markup of the first `<div>` carrying `marker`, up to its own closing tag. */
function divContaining(markup: string, marker: string): string {
  const start = markup.lastIndexOf('<div', markup.indexOf(marker));
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(markup); match; match = tags.exec(markup)) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return markup.slice(start, tags.lastIndex);
  }
  throw new Error(`Unclosed div around ${marker}`);
}

describe('Ask page layout', () => {
  it('docks the composer and its Scope chip below the thread, never over the end of an answer', () => {
    const markup = renderToStaticMarkup(createElement(UnifiedAgentRunPanel, {
      themeMode: 'light',
      askLayout: true,
      title: 'Ask your data',
      scopeControl: createElement('span', { 'data-testid': 'scope-chip' }, 'Scope: All domains'),
    }));
    const thread = divContaining(markup, 'data-testid="ask-thread-scroll"');
    expect(markup).toContain('data-testid="scope-chip"');
    // The scroll area holds the thread only: the composer is not a sticky overlay inside it.
    expect(thread).not.toContain('scope-chip');
    expect(thread).not.toContain('dql-ask-composer');
    expect(divContaining(markup, 'data-testid="ask-composer-dock"')).toContain('scope-chip');
    expect(markup).not.toMatch(/position:\s*sticky/);
  });
});
