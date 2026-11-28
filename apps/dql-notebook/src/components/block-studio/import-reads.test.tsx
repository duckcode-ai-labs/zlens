import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockStudioImportWorkspace, IMPORT_PBIX_NOTE, ImportResult } from './BlockStudio';
import { setSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';
import { themes } from '../../themes/notebook-theme';

/**
 * The trust flow approved 2026-11-27: Import says up front which files it reads (and how to turn a .pbix into a
 * template it can read), and after an import it shows the query drafts, the metric drafts and what was left out.
 */
const t = themes.paper;
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

afterEach(() => setSnowflakeApp(false));

describe('Import, before anything is added', () => {
  for (const snowflakeApp of [true, false]) {
    it(`lists the files it reads, with the .pbix note (${snowflakeApp ? 'app for Snowflake' : 'open source'})`, () => {
      setSnowflakeApp(snowflakeApp);
      const words = text(renderToStaticMarkup(
        <BlockStudioImportWorkspace
          session={null}
          sessions={[]}
          sessionsLoading={false}
          onClose={noop}
          onSessionChange={noop}
          onRefreshSessions={async () => {}}
          onSelectCandidate={noop}
          onSavedCandidate={noop}
          defaultDomain="nba"
          defaultOwner=""
          themeMode="paper"
          t={t}
        />,
      ));
      expect(words).toContain('Bring in the SQL behind your existing reports. Each query becomes a draft for you to review.');
      expect(words).toContain('SQL : .sql files');
      expect(words).toContain('Tableau : workbooks, .twb or .twbx');
      expect(words).toContain('Power BI : a template (.pbit), model.bim, or TMDL files');
      expect(words).toContain(IMPORT_PBIX_NOTE);
    });
  }
});

describe('Import, after an import', () => {
  it('says what it made and what it left out, and offers to review the drafts', () => {
    const words = text(renderToStaticMarkup(<ImportResult queryDrafts={3} metricDrafts={2} leftOut={1} onReview={noop} t={t} />));
    expect(words).toContain('3 query drafts · 2 metric drafts · Left out 1');
    expect(words).toContain('none answers questions until you certify it');
    expect(words).toContain('What was left out, and why, is listed below.');
    expect(words).toContain('Review the 5 drafts');
  });

  it('says one draft in the singular, and has nothing to review when nothing was drafted', () => {
    expect(text(renderToStaticMarkup(<ImportResult queryDrafts={1} metricDrafts={0} leftOut={0} onReview={noop} t={t} />))).toContain('1 query draft Each draft');
    expect(text(renderToStaticMarkup(<ImportResult queryDrafts={1} metricDrafts={0} leftOut={0} onReview={noop} t={t} />))).toContain('Review the draft');
    expect(text(renderToStaticMarkup(<ImportResult queryDrafts={0} metricDrafts={0} leftOut={2} onReview={noop} t={t} />))).not.toContain('Review');
  });
});
