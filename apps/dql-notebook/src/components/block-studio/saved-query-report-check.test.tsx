import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockDetailView, certificationReceiptTechnical, CERTIFIER_NOT_RECORDED, IMPORT_SOURCE_EXPORT_HINT, importSourceUploadNote, receiptMoment } from './BlockStudio';
import { CertificationReportLines, certificationReportView, comparedSinceCertified, DIFFERS_SINCE_CERTIFIED, DiffersSinceCertifiedBadge, RECEIPT_REBUILT_NOTE, receiptLineDay, receiptLineWords, reportCheckStatusWords, reportMatchReceipt, wordsOnViewerClock } from './SavedQueryReportCheck';
import { ComparisonResult, comparisonVerdictLine, recordedWords } from './ReportComparePanel';
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
    // The name is the certifier's. A receipt made where ZLens could not tell who was certifying (the app for
    // Snowflake before V13) holds a placeholder: it says plainly that nobody was recorded, and never names one.
    const nameless = certificationReceiptTechnical({ ...receipt, certifiedBy: 'local' });
    expect(nameless).toContain(CERTIFIER_NOT_RECORDED);
    expect(nameless).not.toContain('Recorded as local');
    expect(certificationReceiptTechnical({ ...receipt, certifiedBy: 'local', certifiedByName: 'Test Admin' })).toContain('Recorded as Test Admin');
    expect(certificationReceiptTechnical({ ...receipt, rules: 'enterprise' })).toContain('enterprise certification rules');
  });

  it('says when it was certified the way the lines above say a day (V4: "11/11/2026, 10:44:27 PM" under 2026-11-11)', () => {
    const certifiedAt = new Date(2026, 10, 11, 22, 44, 27).toISOString();
    expect(receiptMoment(certifiedAt)).toBe('2026-11-11 22:44:27');
    expect(certificationReceiptTechnical({ ...receipt, certifiedAt })).toContain(' · 2026-11-11 22:44:27 · ');
    expect(certificationReceiptTechnical({ ...receipt, certifiedAt })).not.toMatch(/AM|PM|\d+\/\d+\/\d{4}/);
    expect(receiptMoment('not a date')).toBe('not a date');
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
    // The day is said on the viewer's clock (V2).
    expect(reportCheckStatusWords({ match: { verdict: 'matches', words: MATCH, report: 'warriors_regular_wins_2014_2018', comparedAt: '2026-11-11T22:40:00Z' } })).toBe(`Last compared: ${wordsOnViewerClock(MATCH, '2026-11-11T22:40:00Z')}.`);
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
    expect(comparedSinceCertified(certifiedAt, later('differs', '2026-11-14T12:20:00.000Z'))?.verdict).toBe('differs');
    // Made before certifying: the receipt already states it.
    expect(comparedSinceCertified(certifiedAt, later('differs', '2026-11-11T22:40:00.000Z'))).toBeNull();
    expect(comparedSinceCertified(certifiedAt, { match: null })).toBeNull();
    expect(comparedSinceCertified(undefined, later('differs', '2026-11-14T12:20:00.000Z'))).toBeNull();
    expect(comparedSinceCertified('not a date', later('differs', '2026-11-14T12:20:00.000Z'))).toBeNull();
  });

  it('keeps the receipt\'s line from when it was certified, and shows the later Differs beside it', () => {
    const view = certificationReportView(receipt, later('differs', '2026-11-14T12:20:00.000Z'));
    const html = renderToStaticMarkup(<CertificationReportLines view={view} t={themes.paper} />);
    // Then: still Matches, said as of certification.
    expect(html).toContain(`Old report when certified: ${MATCH}`);
    // Since: the later Differs, beside it.
    expect(html).toContain('data-testid="block-certification-report-since"');
    expect(html).toContain(`Old report since certified: ${wordsOnViewerClock(later('differs', '2026-11-14T12:20:00.000Z').match!.words, '2026-11-14T12:20:00.000Z')}`);
    expect(html.indexOf('when certified')).toBeLessThan(html.indexOf('since certified'));
  });

  it('says the same about a Differs made before certifying: it is on the receipt, as of certification, with no warning', () => {
    const differs = 'Differs from warriors_regular_wins_2014_2018_edited, 2026-11-11: 1 of 5 values differs (in WINS) at whole numbers';
    const certification = { ...receipt, checks: ['run'], warnings: [differs] };
    const view = certificationReportView(certification, { match: { verdict: 'differs', words: differs, report: 'warriors_regular_wins_2014_2018_edited', comparedAt: '2026-11-11T12:30:00.000Z' } });
    const html = renderToStaticMarkup(<CertificationReportLines view={view} t={themes.paper} />);
    expect(html).toContain(`Old report when certified: ${wordsOnViewerClock(differs, '2026-11-11T12:30:00.000Z')}`);
    expect(html).not.toContain('since certified');
    expect(html).not.toContain('not compared');
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={view.since} />)).toBe('');
  });

  it('puts a short warning next to Certified only for a Differs after certification', () => {
    const differs = renderToStaticMarkup(<DiffersSinceCertifiedBadge since={comparedSinceCertified(certifiedAt, later('differs', '2026-11-14T12:20:00.000Z'))} />);
    expect(differs).toContain('data-testid="block-certification-differs-since"');
    expect(differs).toContain(DIFFERS_SINCE_CERTIFIED);
    expect(DIFFERS_SINCE_CERTIFIED.length).toBeLessThan(60);
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={comparedSinceCertified(certifiedAt, later('matches', '2026-11-14T12:20:00.000Z'))} />)).toBe('');
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

describe('V2: a comparison made after certification is never "when certified"', () => {
  // Certified at 08:00 UTC on 11 Nov: 11 Nov on every clock from UTC-8 to UTC+15.
  const certification = { ...receipt, certifiedAt: '2026-11-11T08:00:00.000Z', checks: ['metadata', 'validation', 'run'] };
  const differs13 = 'Differs from warriors_regular_wins_2014_2018_edited, 2026-11-13: 4 of 5 values at whole numbers';
  const standing = (words: string, comparedAt: string): ReportQueryMatch => ({
    match: { verdict: words.startsWith('Matches') ? 'matches' : 'differs', words, report: 'warriors_regular_wins_2014_2018_edited', comparedAt },
  });
  const lines = (view: ReturnType<typeof certificationReportView>) => renderToStaticMarkup(<CertificationReportLines view={view} t={themes.paper} />);

  it('reads the day a receipt line names', () => {
    expect(receiptLineDay(differs13)).toBe('2026-11-13');
    expect(receiptLineDay(MATCH)).toBe('2026-11-11');
    expect(receiptLineDay('Differs from sales_2026-01-01, 2026-11-12: 1 of 3 values at cents')).toBe('2026-11-12');
    expect(receiptLineDay('run')).toBeUndefined();
  });

  it('a later Differs on the receipt with nothing at certification: "not compared" then, the Differs since, and the warning', () => {
    // The receipt carries a line about a comparison made after it was certified (the V14 retest's 11 Nov query).
    const onReceipt = { ...certification, warnings: [differs13] };
    const view = certificationReportView(onReceipt, standing(differs13, '2026-11-13T12:00:00.000Z'));
    const html = lines(view);
    expect(html).toContain('Old report when certified: not compared');
    expect(html).toContain(`Old report since certified: ${wordsOnViewerClock(differs13, '2026-11-13T12:00:00.000Z')}`);
    expect(html).not.toContain('Old report when certified: Differs');
    expect(html.indexOf('when certified')).toBeLessThan(html.indexOf('since certified'));
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={view.since} />)).toContain(DIFFERS_SINCE_CERTIFIED);
  });

  it('says the same by the line\'s own day when the comparison\'s time is not to hand', () => {
    const view = certificationReportView({ ...certification, warnings: [differs13] }, null);
    expect(view.notCompared).toBe(true);
    expect(view.then).toEqual([]);
    // Written before V2, it counted the equal values: it is said as the values that differ.
    expect(view.since).toEqual({ verdict: 'differs', words: 'Differs from warriors_regular_wins_2014_2018_edited, 2026-11-13: 1 of 5 values differs at whole numbers' });
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={view.since} />)).toContain(DIFFERS_SINCE_CERTIFIED);
  });

  it('a query certified without a comparison and compared since: "not compared" then, the comparison since', () => {
    const view = certificationReportView(certification, standing(differs13, '2026-11-13T12:00:00.000Z'));
    const html = lines(view);
    expect(html).toContain('Old report when certified: not compared');
    expect(html).toContain('Old report since certified: Differs from');
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={view.since} />)).toContain(DIFFERS_SINCE_CERTIFIED);
  });

  it('keeps a Matches at certification as "when certified", beside a later Differs', () => {
    const atCertification = 'Matches warriors_regular_wins_2014_2018 · every value compared (5 of 5 at whole numbers, 2026-11-11)';
    const view = certificationReportView({ ...certification, checks: ['run', atCertification], warnings: [differs13] }, standing(differs13, '2026-11-13T12:00:00.000Z'));
    const html = lines(view);
    expect(html).toContain(`Old report when certified: ${atCertification}`);
    expect(html).toContain('Old report since certified: Differs from');
    expect(html).not.toContain('not compared');
  });

  it('a comparison made minutes before certifying, after midnight UTC, stays "when certified", on the viewer\'s clock', () => {
    // 10:30 PM and 10:44 PM on 11 Nov in California: the server wrote the comparison's day as 2026-11-12 (UTC).
    const serverWords = 'Differs from warriors_regular_wins_2014_2018_edited, 2026-11-12: 1 of 5 values differs (in WINS) at whole numbers';
    const comparedAt = '2026-11-12T06:30:00.000Z';
    const view = certificationReportView({ ...certification, certifiedAt: '2026-11-12T06:44:27.000Z', warnings: [serverWords] }, standing(serverWords, comparedAt));
    expect(view.since).toBeNull();
    expect(view.notCompared).toBe(false);
    expect(view.then).toEqual([{ line: wordsOnViewerClock(serverWords, comparedAt), matched: false }]);
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={view.since} />)).toBe('');
  });

  it('says a comparison\'s day on the viewer\'s clock, and leaves words with no day alone', () => {
    const comparedAt = '2026-11-12T06:30:00.000Z';
    const date = new Date(comparedAt);
    const local = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    expect(wordsOnViewerClock('Differs from x, 2026-11-12: 4 of 5 values', comparedAt)).toBe(`Differs from x, ${local}: 4 of 5 values`);
    expect(wordsOnViewerClock('Differs from x: 4 of 5 values', comparedAt)).toBe('Differs from x: 4 of 5 values');
    expect(reportCheckStatusWords(standing('Differs from x, 2026-11-12: 4 of 5 values', comparedAt))).toBe(`Last compared: Differs from x, ${local}: 4 of 5 values.`);
  });

  it('a query never compared says nothing about an old report', () => {
    const view = certificationReportView(certification, { match: null });
    expect(view).toEqual({ then: [], notCompared: false, since: null });
    expect(lines(view)).toBe('');
  });
});

describe('V2 retest: the comparison in effect when it was certified, and one count per comparison', () => {
  const ORIGINAL = 'warriors_regular_wins_2014_2018';
  const EDITED = 'warriors_regular_wins_2014_2018_edited';
  // What V15 wrote on the tester's 11 Nov receipt: the edited copy's Differs, counted by its equal values.
  const OLD_DIFFERS = `Differs from ${EDITED}, 2026-11-11: 4 of 5 values at whole numbers`;
  // Certified at 10:44 PM on 11 Nov in Chicago; the last comparison, with the old report, at 10:40 PM.
  const certification = { ...receipt, certifiedAt: '2026-11-12T04:44:27.000Z', checks: ['metadata', 'validation', 'run'], warnings: [OLD_DIFFERS] };
  const lastCompared = '2026-11-12T04:40:00.000Z';
  const standingMatch: ReportQueryMatch['match'] = { verdict: 'matches', words: MATCH, report: ORIGINAL, comparedAt: lastCompared };
  const lines = (view: ReturnType<typeof certificationReportView>) => renderToStaticMarkup(<CertificationReportLines view={view} t={themes.paper} />);

  it('a receipt written under the earlier rule shows the comparison in effect when it was certified: Matches, with the old report\'s file', () => {
    const status: ReportQueryMatch = { match: standingMatch, atCertification: { replaces: [OLD_DIFFERS], checks: [MATCH], warnings: [] } };
    const view = certificationReportView(certification, status);
    const html = lines(view);
    expect(html).toContain(`Old report when certified: ${wordsOnViewerClock(MATCH, lastCompared)}`);
    expect(html).toContain('block-certification-report-match');
    expect(html).not.toContain(`Old report when certified: Differs from ${EDITED}`);
    // It says the receipt file names another, and how to put this one on it.
    expect(html).toContain(RECEIPT_REBUILT_NOTE);
    expect(view.since).toBeNull();
    expect(renderToStaticMarkup(<DiffersSinceCertifiedBadge since={view.since} />)).toBe('');
    // "Last compared" in the box says the same comparison.
    expect(reportCheckStatusWords(status, true)).toBe(`Last compared: ${wordsOnViewerClock(MATCH, lastCompared)}.`);
  });

  it('a receipt written by this version is shown as written, with no note', () => {
    const view = certificationReportView({ ...certification, checks: ['run', MATCH], warnings: [] }, { match: standingMatch });
    expect(lines(view)).toContain(`Old report when certified: ${wordsOnViewerClock(MATCH, lastCompared)}`);
    expect(lines(view)).not.toContain(RECEIPT_REBUILT_NOTE);
  });

  it('a receipt line written before V2 is said as the values that differ, never as if 4 of 5 differed', () => {
    expect(receiptLineWords(OLD_DIFFERS)).toBe(`Differs from ${EDITED}, 2026-11-11: 1 of 5 values differs at whole numbers`);
    expect(receiptLineWords(`Differs from ${EDITED}, 2026-11-11: 7 of 10 values at whole numbers. Changed since compared.`)).toBe(`Differs from ${EDITED}, 2026-11-11: 3 of 10 values differ at whole numbers. Changed since compared.`);
    // Every value equal yet Differs: rows were missing. It says the values were equal.
    expect(receiptLineWords(`Differs from ${EDITED}, 2026-11-11: 4 of 4 values at whole numbers`)).toBe(`Differs from ${EDITED}, 2026-11-11: 4 of 4 values equal at whole numbers`);
    expect(receiptLineWords(`Not proven against ${EDITED}, 2026-11-11: 3 of 5 values at whole numbers`)).toBe(`Not proven against ${EDITED}, 2026-11-11: 3 of 5 values equal at whole numbers`);
    // Lines in today's words, and matches, are left alone.
    expect(receiptLineWords(MATCH)).toBe(MATCH);
    expect(receiptLineWords(`Differs from ${EDITED}, 2026-11-15: 1 of 5 values differs (in WINS) at whole numbers`)).toBe(`Differs from ${EDITED}, 2026-11-15: 1 of 5 values differs (in WINS) at whole numbers`);
    // With nothing rebuilt, the old line is still the receipt's, in today's count.
    const html = lines(certificationReportView(certification, { match: { verdict: 'differs', words: `Differs from ${EDITED}, 2026-11-11: 1 of 5 values differs at whole numbers`, report: EDITED, comparedAt: '2026-11-11T16:35:00.000Z' } }));
    expect(html).toContain('1 of 5 values differs');
    expect(html).not.toContain('4 of 5 values');
  });

  it('one differing comparison reads with one count: the result, "Last compared" and "since certified"', () => {
    // 15 Nov: a certified query compared with the edited copy.
    const comparedAt = '2026-11-15T18:20:00.000Z';
    const words = `Differs from ${EDITED}, 2026-11-15: 1 of 5 values differs (in WINS) at whole numbers`;
    const fresh = comparisonVerdictLine({
      verdict: 'differs',
      rows: { inFile: 5, inBoth: 5, onlyInFile: 0, onlyInZLens: 0, emptySetAside: 0, totalsSetAside: 0 },
      values: { compared: 5, equal: 4 },
      numbers: [{ column: 'WINS', name: 'WINS', precision: 'whole numbers' }],
      differences: [{ key: ['2016'], column: 'WINS', old: '66', zlens: 67 }],
      onlyInFile: [], onlyInZLens: [], missing: [], reasons: [], notes: [],
    });
    expect(fresh).toBe('Differs: 1 of 5 values (row 2016, WINS). 5 of 5 rows found.');
    const status: ReportQueryMatch = { match: { verdict: 'differs', words, report: EDITED, comparedAt } };
    const stored = reportCheckStatusWords(status, true);
    const since = certificationReportView({ ...receipt, certifiedAt: '2026-11-13T15:00:00.000Z', checks: ['run', MATCH] }, status).since!.words;
    for (const line of [fresh, stored, since]) {
      expect(line).toContain('1 of 5 values');
      expect(line).toContain('WINS');
      expect(line).not.toContain('4 of 5');
    }
  });
});
