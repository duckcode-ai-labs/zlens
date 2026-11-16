import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportMetricDraftsSection } from './BlockStudio';
import { ComparisonResult, comparisonVerdictLine, screenWords } from './ReportComparePanel';
import { themes } from '../../themes/notebook-theme';
import type { ImportMetricDrafts, ReportComparison } from '../../store/types';

const t = themes.light;

const comparison = (overrides: Partial<ReportComparison['comparison']> = {}): ReportComparison => ({
  id: 'cmp_1',
  report: 'Sales by Region',
  file: { name: 'Sales by Region.xlsx', sha256: 'x', rows: 3 },
  comparedAt: '2026-10-31T10:00:00.000Z',
  mapping: { Region: 'the dimension region', 'Total Sales': 'the metric total_sales' },
  filters: { stated: ['ordered_at >= 2026-01-01'], waived: [], seen: ['ordered_at >= 2026-01-01'] },
  comparison: {
    verdict: 'differs',
    rows: { inFile: 3, inBoth: 3, onlyInFile: 0, onlyInZLens: 1, emptySetAside: 0, totalsSetAside: 1 },
    values: { compared: 3, equal: 2 },
    numbers: [{ column: 'Total Sales', name: 'total_sales', precision: 'the full value' }],
    differences: [{ key: ['West'], column: 'Total Sales', old: '200.004', zlens: 200 }],
    onlyInFile: [],
    onlyInZLens: [['Central']],
    missing: [],
    reasons: ['No filter was stated. Use --filter or --waive.'],
    notes: [],
    ...overrides,
  },
});

const result = (input: ReportComparison, recording: 'with-compare' | 'separate' | 'refused' | null, recorded = false) => renderToStaticMarkup(
  <ComparisonResult result={input} recording={recording} recorded={recorded} onRecord={vi.fn()} primaryButton={{}} t={t} />,
);

describe('reading a comparison on the screen', () => {
  it('says the verdict, the filters, each difference and the rows on one side', () => {
    const html = result(comparison(), 'with-compare', true);
    // A row only ZLens has is said in the verdict line, as on the record.
    expect(html).toContain('Differs: 1 of 3 values (row West, Total Sales). 3 of 3 rows found, 1 more in ZLens, with ordered_at &gt;= 2026-01-01.');
    expect(html).toContain('200.004');
    expect(html).toContain('Only in ZLens: Central');
    expect(html).toContain('1 total row set aside.');
    expect(html).toContain('Recorded beside each metric it compared. Approving a draft shows this result.');
  });

  it('says a saved query\'s result is recorded for the query, and shows on its receipt when certified', () => {
    const html = result({ ...comparison({ verdict: 'matches' }), target: { kind: 'query', name: 'warriors_regular_season_wins_2014_2018' } }, 'with-compare', true);
    expect(html).toContain('Recorded for the saved query warriors_regular_season_wins_2014_2018. When you certify it, its receipt shows this result.');
    expect(html).not.toContain('Recorded beside Sales by Region');
  });

  it('says which column it matched rows on, when it chose one', () => {
    const html = result(comparison({ verdict: 'matches', notes: ['Rows were matched on SEASON: no two rows share a value there. If another column says which row is which, name it with --key.'] }), 'with-compare', true);
    expect(html).toContain('If another column says which row is which, name it under More options, in Keys.');
    expect(screenWords('With no keys it must have one row, the total. If a column says which row is which, name it with --key.')).toBe('With no keys it must have one row, the total. If a column says which row is which, name it under More options, in Keys.');
  });

  it('names the fields of this panel, not the flags of the terminal', () => {
    expect(result(comparison(), null)).toContain('Use Filters or Waived filters.');
    expect(screenWords('Use --map, --key, --ignore, --file-rows, --dates dmy or --query.')).toBe("Use Column names, Keys, Ignore, Only the file's rows, Dates day first or a saved query.");
  });

  it('offers recording as a second step on a server, and says why not when it is refused', () => {
    expect(result(comparison(), 'separate')).toContain('Record this result');
    const refused = result(comparison(), 'refused');
    expect(refused).toContain('this result is yours and is not recorded');
    expect(refused).not.toContain('Record this result');
    expect(result(comparison(), 'with-compare')).not.toContain('Record this result');
  });

  it('shows only so many differences, and says how many more', () => {
    const differences = Array.from({ length: 53 }, (_, index) => ({ key: [`Row ${index}`], column: 'Total Sales', old: '1', zlens: 2 }));
    const html = result(comparison({ differences }), null);
    expect(html).toContain('Row 49');
    expect(html).not.toContain('Row 50');
    expect(html).toContain('…and 3 more.');
  });
});

describe('metric drafts beside their comparison', () => {
  const item = (metric: string, extra: Partial<ImportMetricDrafts['items'][number]> = {}): ImportMetricDrafts['items'][number] => ({
    calculation: metric, formula: 'SUM(x)', language: 'tableau', sourcePath: 'a.twb', kind: 'simple', outcome: 'drafted', metric, path: `semantic-layer/metrics/_drafts/sales/${metric}.yaml`, value: 1, notes: [], ...extra,
  });
  const section = (items: ImportMetricDrafts['items']) => renderToStaticMarkup(
    <ImportMetricDraftsSection
      record={{ importId: 'i1', domain: 'sales', ranAt: '2026-10-31', written: true, checked: true, items, dimensions: [] }}
      done={{}}
      busy={null}
      message={null}
      onApprove={vi.fn()}
      onApproveAll={vi.fn()}
      onDiscard={vi.fn()}
      onCompared={vi.fn()}
      t={t}
    />,
  );

  it('shows each verdict, its words, and when the draft has changed since', () => {
    const html = section([
      item('total_sales', { match: { verdict: 'matches', words: 'Matches Sales by Region, 2026-10-31: 4 of 4 values', changed: false } }),
      item('orders', { match: { verdict: 'not-proven', words: 'Not proven against Sales by Region', changed: true } }),
    ]);
    expect(html).toContain('Matches Sales by Region, 2026-10-31: 4 of 4 values');
    expect(html).toContain('Not proven');
    expect(html).toContain('Changed since compared');
    expect(html).toContain('Compare with the old report');
  });

  it('counts Approve all as the server does, whatever the parts look like here', () => {
    const html = section([
      item('a'),
      item('b'),
      item('c', { heldBack: true, match: { verdict: 'differs', words: 'Differs from Sales', changed: false } }),
      item('ratio', { parts: ['d'], heldBack: true }),
      item('stale', { parts: ['c'] }),
    ]);
    expect(html).toContain('Approve all that ran (3)');
    expect(html).toContain('2 left out of Approve all');
  });
});

describe('V2: the verdict line says what differs, then what was found', () => {
  const base = { ...comparison().comparison, rows: { ...comparison().comparison.rows, onlyInZLens: 0 }, onlyInZLens: [] };
  it('names the one value that differs and says every row was found', () => {
    const differs = { ...base, rows: { ...base.rows, inFile: 5, inBoth: 5 }, values: { compared: 5, equal: 4 }, differences: [{ key: ['FRANCE'], column: 'Order revenue', old: '10', zlens: 11 }] };
    expect(comparisonVerdictLine(differs)).toBe('Differs: 1 of 5 values (row FRANCE, Order revenue). 5 of 5 rows found.');
    // Never "5 of 5 rows, 4 of 5 values", which reads as if every row differed.
    expect(comparisonVerdictLine(differs)).not.toMatch(/^Differs: 5 of 5 rows/);
  });

  it('counts several differences without naming one, and keeps the stated filters', () => {
    const differs = { ...base, rows: { ...base.rows, inFile: 5, inBoth: 5 }, values: { compared: 10, equal: 7 }, differences: [] };
    expect(comparisonVerdictLine(differs, ['region = EU'])).toBe('Differs: 3 of 10 values. 5 of 5 rows found, with region = EU.');
  });

  it('says rows were missing when every value found matches', () => {
    const missing = { ...base, rows: { ...base.rows, inFile: 5, inBoth: 4 }, values: { compared: 4, equal: 4 }, differences: [] };
    expect(comparisonVerdictLine(missing)).toBe('Differs: 4 of 5 rows found; all 4 values in them match.');
  });

  it('a match says every value', () => {
    const matches = { ...base, verdict: 'matches' as const, rows: { ...base.rows, inFile: 5, inBoth: 5 }, values: { compared: 5, equal: 5 }, differences: [] };
    expect(comparisonVerdictLine(matches)).toBe('Matches: 5 of 5 rows, every value.');
    expect(comparisonVerdictLine({ ...matches, rows: { ...matches.rows, inFile: 1, inBoth: 1 }, values: { compared: 1, equal: 1 } })).toBe('Matches: 1 of 1 row, every value.');
  });

  it('says rows only ZLens has, so a Differs with every value equal never reads as a match', () => {
    const extra = { ...base, rows: { ...base.rows, inFile: 5, inBoth: 5, onlyInZLens: 2 }, values: { compared: 5, equal: 5 }, differences: [] };
    expect(comparisonVerdictLine(extra)).toBe('Differs: 5 of 5 rows found, 2 more in ZLens; all 5 values in them match.');
  });

  it('names the total when the difference is in it', () => {
    const total = { ...base, rows: { ...base.rows, inFile: 1, inBoth: 1 }, values: { compared: 1, equal: 0 }, differences: [{ key: [], column: 'Revenue', old: '1', zlens: 2 }] };
    expect(comparisonVerdictLine(total)).toBe('Differs: 1 of 1 value (the total, Revenue). 1 of 1 row found.');
  });
});
