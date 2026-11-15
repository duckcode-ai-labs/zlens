import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockDetailView, certificationReceiptTechnical, IMPORT_SOURCE_EXPORT_HINT, importSourceUploadNote } from './BlockStudio';
import { CertificationReportLines, comparedSinceCertified, DIFFERS_SINCE_CERTIFIED, DiffersSinceCertifiedBadge, reportCheckStatusWords, reportMatchReceipt } from './SavedQueryReportCheck';
import { ComparisonResult, recordedWords } from './ReportComparePanel';
import type { ReportComparison, ReportQueryMatch } from '../../store/types';
import { themes } from '../../themes/notebook-theme';

/**
 * The report check on a saved query's own page (V13 13-15): the receipt's line
 * about the old report, who certified it, and the compare box on the page
 * rather than only on the Import screen.
 */

const noop = () => {};
const MATCH = 'Matches warriors_regular_wins_2014_2018 · every value compared (5 of 5 at whole numbers, 2026-11-11)';
const receipt = {
  certifiedBy: 'TEST_ADMIN',
  certifiedAt: '2026-11-11T22:44:27.000Z',
  via: 'sql-import',
  rules: 'oss' as const,
  sourceSha256: 'a'.repeat(64),
  checks: ['metadata', 'validation', 'run', MATCH],
};

const page = (metadata: Record<string, unknown>, blockPath?: string) => renderToStaticMarkup(
  <BlockDetailView
    metadata={{ name: 'warriors_regular_season_wins_2014_2018', reviewStatus: 'certified', certification: receipt, ...metadata } as never}
    source=""
    parameters={[]}
    preview={null}
    lineageDetail={null}
    isSemanticBlock={false}
    running={false}
    onOpenBuilder={noop}
    onOpenSource={noop}
    onRun={noop}
    onOpenHistory={noop}
    blockPath={blockPath}
    t={themes.paper}
  />,
);

describe('the receipt of a saved query compared with its old report', () => {
  it('names the Snowflake user and says it matches, apart from the other checks', () => {
    const html = page({});
    expect(html).toContain('Certified by TEST_ADMIN');
    expect(html).toContain('Checks passed: Has an owner and a description · The definition is valid · Ran without errors</div>');
    expect(html).toContain(`Old report when certified: ${MATCH}`);
  });

  it('shows a comparison that no longer holds as a warning, never as a passed check', () => {
    const differs = 'Differs from warriors_regular_wins_2014_2018, 2026-11-11: 4 of 5 values at whole numbers. Changed since compared.';
    const html = page({ certification: { ...receipt, checks: ['run'], warnings: [differs, 'Block declares grain: Missing grain metadata'] } });
    expect(html).toContain('block-certification-report-warning');
    expect(html).toContain('Old report when certified: Differs from warriors_regular_wins_2014_2018');
    expect(html).not.toContain('Missing grain metadata');
    expect(reportMatchReceipt({ checks: ['run', MATCH], warnings: [differs, 'x'] })).toEqual({ checks: ['run'], matched: [MATCH], warnings: [differs] });
  });

  it('says plainly who recorded it and under which rules', () => {
    expect(certificationReceiptTechnical(receipt)).toContain('Recorded as TEST_ADMIN');
    expect(certificationReceiptTechnical(receipt)).toContain('standard certification rules');
    expect(certificationReceiptTechnical(receipt)).not.toContain('OSS');
    // A placeholder names nobody.
    const nameless = certificationReceiptTechnical({ ...receipt, certifiedBy: 'local' });
    expect(nameless).toContain('No name recorded');
    expect(nameless).not.toContain('Recorded as local');
    expect(certificationReceiptTechnical({ ...receipt, rules: 'enterprise' })).toContain('enterprise certification rules');
  });
});

describe('the compare box on the saved query page', () => {
  it('is on every saved query\'s own page, with its own file box for the old report\'s export', () => {
    const html = page({}, 'blocks/nba/warriors_regular_season_wins_2014_2018.dql');
    expect(html).toContain('data-testid="saved-query-report-check"');
    expect(html).toContain('Compare with the old report');
    expect(html).toContain('The old report&#x27;s export (CSV or Excel)');
    expect(html).toContain('accept=".csv,.tsv,.txt,.xlsx"');
    // A saved query takes no stated filters: that box is only for metrics.
    expect(html).not.toContain('Filters on the report, one per line');
  });

  it('is not offered for a draft that was never saved', () => {
    expect(page({ name: '' }, 'blocks/nba/x.dql')).not.toContain('saved-query-report-check');
    expect(page({})).not.toContain('saved-query-report-check');
  });

  it('says what the last comparison found, or that there is none yet', () => {
    expect(reportCheckStatusWords({ match: { verdict: 'matches', words: MATCH, report: 'warriors_regular_wins_2014_2018', comparedAt: '2026-11-11T22:40:00Z' } })).toBe(`Last compared: ${MATCH}.`);
    expect(reportCheckStatusWords({ match: null })).toContain('Not compared with an old report yet.');
    expect(reportCheckStatusWords({ match: null, unreadable: "The record of its comparison with the old report can't be read." })).toContain("can't be read");
  });
});

describe('a report export chosen in the Import screen\'s Source box', () => {
  it('is pointed to the compare box, not silently dropped', () => {
    expect(importSourceUploadNote(['legacy.sql'])).toBeNull();
    expect(importSourceUploadNote(['Untitled_2026-11-11-2154.csv'])).toBe("Untitled_2026-11-11-2154.csv looks like a report's export, not SQL, so it was left out. To check a saved query against it, open the saved query and use Compare with the old report.");
    expect(importSourceUploadNote(['a.csv', 'b.xlsx', 'c.sql'])).toContain('a.csv, b.xlsx look like');
    expect(IMPORT_SOURCE_EXPORT_HINT).toContain('Compare with the old report');
  });
});

describe('V14: one rule for a certified query compared again later', () => {
  const later = (verdict: 'matches' | 'differs', comparedAt: string): ReportQueryMatch => ({
    match: {
      verdict,
      words: verdict === 'differs'
        ? 'Differs from warriors_regular_wins_2014_2018_edited, 2026-11-14: 4 of 5 values at whole numbers'
        : MATCH,
      report: 'warriors_regular_wins_2014_2018_edited',
      comparedAt,
    },
  });
  const certifiedAt = receipt.certifiedAt; // 2026-11-11T22:44:27Z

  it('finds a comparison only when it was made after the query was certified', () => {
    expect(comparedSinceCertified(certifiedAt, later('differs', '2026-11-14T22:20:00.000Z'))?.verdict).toBe('differs');
    // Made before certifying: the receipt already states it.
    expect(comparedSinceCertified(certifiedAt, later('differs', '2026-11-11T22:40:00.000Z'))).toBeNull();
    expect(comparedSinceCertified(certifiedAt, { match: null })).toBeNull();
    expect(comparedSinceCertified(undefined, later('differs', '2026-11-14T22:20:00.000Z'))).toBeNull();
    expect(comparedSinceCertified('not a date', later('differs', '2026-11-14T22:20:00.000Z'))).toBeNull();
  });

  it('keeps the receipt\'s line from when it was certified, and shows the later Differs beside it', () => {
    const since = comparedSinceCertified(certifiedAt, later('differs', '2026-11-14T22:20:00.000Z'));
    const html = renderToStaticMarkup(<CertificationReportLines certification={receipt} since={since} t={themes.paper} />);
    // Then: still Matches, said as of certification.
    expect(html).toContain(`Old report when certified: ${MATCH}`);
    // Since: the later Differs, beside it.
    expect(html).toContain('data-testid="block-certification-report-since"');
    expect(html).toContain('Old report since certified: Differs from warriors_regular_wins_2014_2018_edited, 2026-11-14');
    expect(html.indexOf('when certified')).toBeLessThan(html.indexOf('since certified'));
  });

  it('says the same about a Differs made before certifying: it is on the receipt, as of certification, with no warning', () => {
    const differs = 'Differs from warriors_regular_wins_2014_2018_edited, 2026-11-12: 4 of 5 values at whole numbers';
    const certification = { ...receipt, checks: ['run'], warnings: [differs] };
    const since = comparedSinceCertified(certifiedAt, later('differs', '2026-11-11T22:30:00.000Z'));
    const html = renderToStaticMarkup(<CertificationReportLines certification={certification} since={since} t={themes.paper} />);
    expect(html).toContain(`Old report when certified: ${differs}`);
    expect(html).not.toContain('since certified');
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={since} />)).toBe('');
  });

  it('puts a short warning next to Certified only for a Differs after certification', () => {
    const differs = renderToStaticMarkup(<DiffersSinceCertifiedBadge since={comparedSinceCertified(certifiedAt, later('differs', '2026-11-14T22:20:00.000Z'))} />);
    expect(differs).toContain('data-testid="block-certification-differs-since"');
    expect(differs).toContain(DIFFERS_SINCE_CERTIFIED);
    expect(DIFFERS_SINCE_CERTIFIED.length).toBeLessThan(60);
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={comparedSinceCertified(certifiedAt, later('matches', '2026-11-14T22:20:00.000Z'))} />)).toBe('');
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={null} />)).toBe('');
  });

  it('the page shows the receipt lines in the header, beside Certified', () => {
    const html = page({}, 'blocks/nba/warriors_regular_season_wins_2014_2018.dql');
    expect(html).toContain('data-testid="block-certification-receipt"');
    expect(html).toContain(`Old report when certified: ${MATCH}`);
  });

  it('the compare box speaks to a query that is already certified', () => {
    expect(reportCheckStatusWords({ match: null }, true)).toContain('Its receipt keeps what was true when it was certified');
    expect(reportCheckStatusWords({ match: null }, true)).not.toContain('certifying records');
    expect(reportCheckStatusWords({ match: null }, false)).toContain('certifying records the result on its receipt');
    const result = (verdict: 'matches' | 'differs'): ReportComparison => ({
      id: 'cmp_1',
      report: 'warriors_regular_wins_2014_2018_edited',
      file: { name: 'warriors_regular_wins_2014_2018_edited.csv', sha256: 'x', rows: 5 },
      comparedAt: '2026-11-14T22:20:00.000Z',
      target: { kind: 'query', name: 'warriors_regular_wins_v13_import' },
      mapping: {},
      filters: { stated: [], waived: [], seen: [] },
      comparison: { verdict, rows: { inFile: 5, inBoth: 5, onlyInFile: 0, onlyInZLens: 0, emptySetAside: 0, totalsSetAside: 0 }, values: { compared: 5, equal: verdict === 'matches' ? 5 : 4 }, numbers: [], differences: [], onlyInFile: [], onlyInZLens: [], missing: [], reasons: [], notes: [] },
    } as unknown as ReportComparison);
    expect(recordedWords(result('differs'), true)).toBe('Recorded for the saved query warriors_regular_wins_v13_import. It is already certified: its receipt keeps what was true when it was certified, and this result shows beside it, with a warning next to Certified.');
    expect(recordedWords(result('matches'), true)).not.toContain('When you certify it');
    expect(recordedWords(result('matches'), false)).toBe('Recorded for the saved query warriors_regular_wins_v13_import. When you certify it, its receipt shows this result.');
    const html = renderToStaticMarkup(<ComparisonResult result={result('differs')} recording="with-compare" recorded certified onRecord={noop} primaryButton={{}} t={themes.paper} />);
    expect(html).toContain('It is already certified');
    expect(html).not.toContain('When you certify it');
  });
});
