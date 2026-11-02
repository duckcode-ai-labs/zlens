import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@zlens/ui';
import { ActivityBar } from '../components/shell/ActivityBar';
import { HostPersonMenu } from '../components/shell/HostPersonMenu';
import { HostUiProvider, NAV_IDS, applyHostNav, navItemAllowed, type HostUi, type HostUiState } from './host-ui';

const NO_HOST: HostUiState = { host: false };

// A creator: may build and manage settings, not review hints or git.
const CREATOR = { 'project.read': true, 'project.write': true, 'dataset.author': true, ask: true, 'settings.manage': true };

function hosted(overrides: Partial<HostUi> = {}): HostUi {
  return { host: true, person: { id: 'u1', name: 'Cleo Park', kind: 'person' }, capabilities: CREATOR, links: [], answerActions: [], ...overrides };
}

function rail(state: HostUiState, expanded = false): string {
  // The rail reads its expanded/collapsed preference from the browser; here it is whatever the test says.
  vi.stubGlobal('window', { localStorage: { getItem: () => (expanded ? '1' : '0'), setItem: () => undefined } });
  return renderToStaticMarkup(<TooltipProvider><HostUiProvider initial={state}><ActivityBar /></HostUiProvider></TooltipProvider>);
}

/** The rail's items in order, by their accessible names (every item carries one, expanded or not). */
function itemNames(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]!).filter((name) => !/sidebar rail$/.test(name));
}

afterEach(() => vi.unstubAllGlobals());

describe('the rail without a host override', () => {
  it('draws ZLens\'s own words and groups for open-source users', () => {
    expect(itemNames(rail(NO_HOST))).toEqual(['Apps', 'Ask', 'Notebooks', 'Saved queries', 'Lineage', 'Modeling', 'Ask observability', 'Source control', 'Settings', 'Help']);
    const html = rail(NO_HOST, true);
    for (const label of ['Insights', 'Build', 'Govern']) expect(html).toContain(`>${label}</span>`);
    expect(html).not.toContain('nav-group-action');
  });

  it('under a host without `nav`, only the capability rules apply, with ZLens\'s own words', () => {
    expect(itemNames(rail(hosted()))).toEqual(['Apps', 'Ask', 'Notebooks', 'Saved queries', 'Lineage', 'Modeling', 'Settings', 'Help']);
  });

  it('has one stable nav id per item, the ids the contract names', () => {
    expect([...NAV_IDS]).toEqual(['apps', 'ask', 'notebooks', 'blocks', 'lineage', 'modeling', 'ask-traces', 'source-control', 'settings']);
  });
});

describe('the rail with a host override (RFC 0010 HH-9 `nav`)', () => {
  it('shows the host\'s labels instead of ZLens\'s own, and ZLens\'s own where the host sent none', () => {
    const names = itemNames(rail(hosted({ nav: { labels: { blocks: 'Blocks', 'ask-traces': 'Ask traces', settings: '   ' } } })));
    expect(names).toContain('Blocks');
    expect(names).not.toContain('Saved queries');
    expect(names).toContain('Settings');
    expect(names).toContain('Notebooks');
  });

  it('does not draw hidden items', () => {
    const names = itemNames(rail(hosted({ nav: { hidden: ['notebooks', 'modeling'] } })));
    expect(names).toEqual(['Apps', 'Ask', 'Saved queries', 'Lineage', 'Settings', 'Help']);
  });

  it('draws the host\'s groups in its order, each item once, and leaves out a group with no visible item', () => {
    const groups = [
      { id: 'insights', label: 'Insights', items: ['apps', 'ask'] },
      { id: 'build', label: 'Build', items: ['lineage', 'notebooks', 'blocks', 'apps', 'no-such-item'] },
      { id: 'review', label: 'Review', items: ['ask-traces', 'source-control'] },
      { id: 'govern', label: 'Govern', items: ['settings'] },
    ];
    const html = rail(hosted({ nav: { groups, labels: { blocks: 'Blocks' } } }), true);
    expect(itemNames(html)).toEqual(['Apps', 'Ask', 'Lineage', 'Notebooks', 'Blocks', 'Settings', 'Help']);
    expect(html).toContain('>Build</span>');
    // The creator may neither review hints nor git: that group has nothing to show, so it is not drawn.
    expect(html).not.toContain('>Review</span>');
    // Modeling is in no group: not drawn.
    expect(html).not.toContain('Modeling');
  });

  it('never shows an item the capability rules hide, whatever the groups say', () => {
    // Someone who may only ask: no project read, so nothing that needs it.
    const asker = hosted({ capabilities: { ask: true }, nav: { groups: [{ id: 'all', label: 'Everything', items: [...NAV_IDS] }] } });
    for (const key of ['files', 'block_library', 'lineage', 'domains', 'git', 'ask_observability', 'settings']) expect(navItemAllowed(asker, key)).toBe(false);
    expect(itemNames(rail(asker))).toEqual(['Apps', 'Ask', 'Help']);
    // Hidden by the host and absent for lack of capability: still absent; hidden and allowed: absent too.
    const both = hosted({ capabilities: { ask: true }, nav: { hidden: ['ask', 'notebooks'], groups: [{ id: 'all', label: 'Everything', items: [...NAV_IDS] }] } });
    expect(itemNames(rail(both))).toEqual(['Apps', 'Help']);
  });

  it('draws a group\'s action as its header link, opening as an embedded host page', () => {
    const nav = { groups: [{ id: 'build', label: 'Build', items: ['notebooks', 'blocks'], action: { label: 'My draft spaces', href: '/e/drafts' } }] };
    const expanded = rail(hosted({ nav }), true);
    expect(expanded).toContain('data-testid="nav-group-action-build"');
    expect(expanded).toContain('aria-label="My draft spaces"');
    // Collapsed, the link has no header to sit on, so it is a rail item of its own.
    const collapsed = rail(hosted({ nav }), false);
    expect(collapsed).not.toContain('nav-group-action-build');
    expect(itemNames(collapsed)).toEqual(['My draft spaces', 'Notebooks', 'Saved queries', 'Help']);
    // A group with an action but nothing visible is not drawn, action included.
    const empty = rail(hosted({ capabilities: {}, nav: { groups: [{ id: 'build', label: 'Build', items: ['notebooks'], action: { label: 'My draft spaces', href: '/e/drafts' } }] } }), true);
    expect(empty).not.toContain('My draft spaces');
  });

  it('keeps the host\'s own nav links after the groups', () => {
    const html = rail(hosted({ links: [{ id: 'work', label: 'My work', href: '/e/work', placement: 'nav' }], nav: { groups: [{ id: 'insights', label: 'Insights', items: ['apps'] }] } }));
    expect(itemNames(html)).toEqual(['Apps', 'My work', 'Help']);
  });
});

describe('applyHostNav', () => {
  const groups = [
    { id: 'a', label: 'A', items: [{ id: 'apps', title: 'Apps' }, { id: 'ask', title: 'Ask' }] },
    { id: 'b', label: 'B', items: [{ id: 'blocks', title: 'Saved queries' }] },
  ];
  const all = () => true;

  it('returns the rail\'s own groups unchanged without a host or without `nav`', () => {
    expect(applyHostNav(NO_HOST, groups, all)).toEqual(groups);
    expect(applyHostNav(hosted(), groups, all)).toEqual(groups);
  });

  it('applies the capability filter before anything the host says', () => {
    const state = hosted({ nav: { groups: [{ id: 'x', label: 'X', items: ['apps', 'ask'] }] } });
    expect(applyHostNav(state, groups, (item) => item.id !== 'ask')).toEqual([{ id: 'x', label: 'X', items: [{ id: 'apps', title: 'Apps' }] }]);
  });

  it('tolerates a malformed override: unknown ids, non-list fields, groups without a label', () => {
    const state = hosted({ nav: { hidden: 'apps' as unknown as string[], labels: { apps: 7 as unknown as string }, groups: [{ id: 'x', label: 'X', items: 'apps' as unknown as string[] }, { id: 'y', items: ['ask'] } as never, { id: 'z', label: 'Z', items: ['blocks', 'nope'] }] } });
    expect(applyHostNav(state, groups, all)).toEqual([{ id: 'z', label: 'Z', items: [{ id: 'blocks', title: 'Saved queries' }] }]);
  });
});

describe('the account menu\'s role label (RFC 0010 HH-9 `roleLabel`)', () => {
  const menu = (state: HostUiState) => renderToStaticMarkup(<HostUiProvider initial={state}><HostPersonMenu defaultOpen /></HostUiProvider>);

  it('shows the role beside the person\'s name when the host sent one', () => {
    const html = menu(hosted({ roleLabel: 'Steward' }));
    expect(html).toContain('data-testid="host-role-label"');
    expect(html).toContain('>Steward</span>');
    expect(html).toContain('title="Cleo Park · Steward"');
    expect(html.indexOf('Cleo Park</strong>')).toBeLessThan(html.indexOf('>Steward</span>'));
  });

  it('shows no role without one', () => {
    const html = menu(hosted());
    expect(html).not.toContain('host-role-label');
    expect(html).toContain('title="Cleo Park"');
  });
});
