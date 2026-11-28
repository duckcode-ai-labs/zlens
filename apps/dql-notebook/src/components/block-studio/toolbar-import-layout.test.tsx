import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockStudioImportWorkspace, IMPORT_OWNER_HINT, blockToolbarStyles } from './BlockStudio';
import { themes } from '../../themes/notebook-theme';

/**
 * The V18 p2 new-user test: at about 1024px the saved query toolbar showed "Con…" under New saved query, and Import's
 * header and steps ran past the right edge. Its Owner box also showed "analytics", which read like a real value.
 */
const t = themes.paper;
const noop = () => {};

const importPage = (defaultOwner: string) => renderToStaticMarkup(
  <BlockStudioImportWorkspace
    session={null}
    sessions={[]}
    sessionsLoading={false}
    onClose={noop}
    onSessionChange={noop}
    onRefreshSessions={async () => {}}
    onSelectCandidate={noop}
    onSavedCandidate={noop}
    defaultDomain="sales"
    defaultOwner={defaultOwner}
    themeMode="paper"
    t={t}
    inline
  />,
);

/** The input inside the label whose text is "Owner". */
const ownerInput = (html: string) => html.match(/>Owner<\/span>(<input[^>]*>)/)?.[1] ?? '';

describe('The saved query toolbar at narrow widths', () => {
  it('wraps onto a second line instead of scrolling under the actions', () => {
    const { row, actions } = blockToolbarStyles(t);
    expect(row.flexWrap).toBe('wrap');
    expect(row.overflowX).toBeUndefined();
    expect(row.height).toBeUndefined();
    expect(row.minHeight).toBe(46);
    // The actions no longer sit over the row: that is what hid Context and the name.
    expect(actions.position).toBeUndefined();
    expect(actions.flexWrap).toBe('wrap');
    expect(actions.marginLeft).toBe('auto');
  });
});

describe('Import at narrow widths', () => {
  it('lets the header and the steps wrap, with no fixed minimum width', () => {
    const html = importPage('');
    const header = html.match(/<header[^>]*>/)?.[0] ?? '';
    expect(header).toContain('flex-wrap:wrap');
    expect(html).not.toContain('min-width:390px');
    expect(html).not.toContain('min-width:260px');
    expect(html).not.toContain('grid-template-rows:80px');
    expect(html).toContain('aria-label="Close import"');
  });
});

describe('Import, the Owner box', () => {
  it('is empty with a neutral hint, never "analytics"', () => {
    const input = ownerInput(importPage(''));
    expect(input).toContain(`placeholder="${IMPORT_OWNER_HINT}"`);
    expect(input).toContain('value=""');
    expect(input).not.toContain('analytics');
  });

  it('keeps an owner it was given', () => {
    expect(ownerInput(importPage('sales-team'))).toContain('value="sales-team"');
  });
});
