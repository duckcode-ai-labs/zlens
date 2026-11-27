import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SaveAsBlockModal } from './SaveAsBlockModal';
import { setSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';
import { makeCell } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type * as PanelModule from '../agent/UnifiedAgentRunPanel';

/**
 * The trust flow approved 2026-11-27: Ask saves an answer only when the person presses Save as saved query. A small
 * dialog shows the name and the owner, then the answer says "Saved as a draft. Review it". The draft is reviewed
 * and certified in Saved queries, where its other details are filled in.
 */
const SOURCE = 'block "Playoff wins, Warriors 2015" {\n  type = "custom"\n  status = "draft"\n  query = """\n    SELECT COUNT(*) AS playoff_wins FROM games\n  """\n}';
const noop = () => {};

afterEach(() => {
  setSnowflakeApp(false);
});

const dialog = (initialOwner?: string) => renderToStaticMarkup(
  <SaveAsBlockModal
    cell={makeCell('dql', SOURCE)}
    onClose={noop}
    initialContent={SOURCE}
    initialName="how_many_playoff_games_golden_state_warriors_win_2015"
    {...(initialOwner ? { initialOwner } : {})}
    aiQuestion="How many playoff games did the Golden State Warriors win in 2015?"
    variant="ask"
  />,
);

describe('Save as saved query, from an Ask answer: a small dialog', () => {
  for (const snowflakeApp of [true, false]) {
    it(`shows the name and the owner, and nothing else to fill in (${snowflakeApp ? 'app for Snowflake' : 'open source'})`, () => {
      setSnowflakeApp(snowflakeApp);
      const html = dialog('TEST_ADMIN');
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
      expect(html).toContain('aria-label="Save as a draft"');
      expect(text).toContain('Save as a draft');
      expect(text).toContain('You\'ll review and certify it in Saved queries.');
      expect(html).toContain('value="how_many_playoff_games_golden_state_warriors_win_2015"');
      expect(html).toContain('value="TEST_ADMIN"');
      expect(text).toContain('Save draft');
      for (const gone of ['Domain', 'Tags', 'Description', 'Governance checks', 'Content Preview', 'Agent-facing metadata', 'blocks/']) {
        expect(text).not.toContain(gone);
      }
    });
  }

  it('cannot be saved without an owner', () => {
    const html = dialog();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save draft<\/button>/);
  });
});

describe('An answer saved from Ask', () => {
  let panel: typeof PanelModule;
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/ask' } });
    panel = await import('../agent/UnifiedAgentRunPanel');
    vi.unstubAllGlobals();
  });

  it('says "Saved as a draft. Review it", and nothing about a draft Ask kept on its own', () => {
    const html = renderToStaticMarkup(<panel.SavedDraftNotice path="blocks/how_many_playoff_games.dql" t={themes.paper} />);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text).toBe('Saved as a draft. Review it');
    expect(html).toContain('data-testid="ask-saved-draft"');
    expect(text).not.toMatch(/asked \d+ times|Open draft to review|for review \(not certified\)/);
  });
});
