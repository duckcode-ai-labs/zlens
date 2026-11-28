import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockDetailView, BlockToolbarActions } from './BlockStudio';
import { setSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';
import { themes } from '../../themes/notebook-theme';

/**
 * The trust flow approved 2026-11-27, on the saved query's existing page: a line on how it is worked out above the
 * SQL (folded away), its checks as a list, and Compare with an old report, Modify with AI and Open in builder in ⋯.
 */
const noop = () => {};
const SOURCE = [
  'block "playoff_wins_2015" {',
  '  type = "custom"',
  '  status = "draft"',
  '  owner = "TEST_ADMIN"',
  '  query = """',
  '    SELECT SUM(CASE WHEN TEAM_WON THEN 1 ELSE 0 END) AS PLAYOFF_WINS',
  '    FROM ZLENS_DEV.TRANSFORMED.LOCAL_TEAM_GAME_FACTS',
  "    WHERE SEASON = ${season} AND CAST(GAME_ID AS VARCHAR) LIKE '4%'",
  '  """',
  '}',
].join('\n');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const page = (extra: Partial<Parameters<typeof BlockDetailView>[0]> = {}) => renderToStaticMarkup(
  <BlockDetailView
    metadata={{ name: 'playoff_wins_2015', reviewStatus: 'draft', owner: 'TEST_ADMIN' } as never}
    source={SOURCE}
    parameters={[{ name: 'season', type: 'number', default: 2015, required: true, policy: 'filter' } as never]}
    preview={null}
    lineageDetail={null}
    isSemanticBlock={false}
    running={false}
    onOpenBuilder={noop}
    onOpenSource={noop}
    onModifyWithAi={noop}
    onRun={noop}
    onOpenHistory={noop}
    blockPath="blocks/playoff_wins_2015.dql"
    t={themes.paper}
    {...extra}
  />,
);

afterEach(() => setSnowflakeApp(false));

describe('a saved query\'s page, for review', () => {
  for (const snowflakeApp of [true, false]) {
    it(`says how it is worked out above the SQL, which is folded away (${snowflakeApp ? 'app for Snowflake' : 'open source'})`, () => {
      setSnowflakeApp(snowflakeApp);
      const html = page();
      expect(text(html)).toContain("How it's worked out Reads LOCAL_TEAM_GAME_FACTS, keeps the rows where SEASON is the season you choose and GAME_ID starts with “4”, and adds them up into one row.");
      expect(html.indexOf('saved-query-worked-out')).toBeLessThan(html.indexOf('<details'));
      // Folded: a <details> without `open`.
      expect(html).toMatch(/<details(?: data-testid="saved-query-sql")?><summary/);
      expect(html).not.toMatch(/<details[^>]* open/);
    });
  }

  it('lists its checks, and the stat strip no longer counts tests', () => {
    const words = text(page());
    expect(words).toContain('Checks Runs without errors · press Run No problems in the query Has an owner: TEST_ADMIN Its parameter has a default');
    expect(words).not.toMatch(/\bTests\b/);
    expect(text(page({ runFailed: true, problems: 1 }))).toContain('Runs without errors · the last run failed No problems in the query · 1 to fix');
  });

  it('keeps Run on the page and puts Open in builder, Modify with AI and the compare in ⋯, so nothing covers the title', () => {
    const html = page();
    expect(html).toContain('aria-label="More"');
    expect(text(html)).toContain('Run');
    for (const moved of ['Open in builder', 'Modify with AI', 'Compare with an old report', 'Compare with the old report']) expect(html).not.toContain(moved);
    // A long name wraps instead of running under the buttons.
    expect(html).toMatch(/overflow-wrap:anywhere[^>]*>playoff_wins_2015</);
  });

  it('has no Modify with AI in the toolbar on the page, and keeps it in the builder', () => {
    const toolbar = { readOnly: false, readOnlyReason: '', hasActiveDraft: true, activeBlockPath: 'blocks/playoff_wins_2015.dql', running: false, saving: false, certifying: false, certified: false, onDelete: noop, onNew: noop, onAsk: noop, onModify: noop, onRun: noop, onSave: noop, onCertify: noop };
    const onPage = renderToStaticMarkup(<BlockToolbarActions {...toolbar} detail />);
    expect(onPage).not.toContain('Modify with AI');
    expect(onPage).toContain('Save draft');
    expect(onPage).toContain('Certify');
    expect(renderToStaticMarkup(<BlockToolbarActions {...toolbar} detail={false} />)).toContain('Modify with AI');
  });
});
