import { describe, expect, it } from 'vitest';
import { compareExport, ComparisonStopped, type ComparisonPlan, type CompareOptions } from './compare.js';
import { readExport } from './read-export.js';

const table = (text: string) => readExport(Buffer.from(text), 'export.csv');
const byRegion: ComparisonPlan = {
  keys: [{ header: 'Region', output: 'region', kind: 'text' }],
  numbers: [{ header: 'Sales', output: 'sales', name: 'sales' }],
  notCompared: [],
};
const compare = (text: string, rows: Array<Record<string, unknown>>, plan: ComparisonPlan = byRegion, options: CompareOptions = {}) => compareExport(table(text), plan, rows, options);

describe('comparing rows', () => {
  it('matches rows by key, not position, at the precision the file prints', () => {
    const result = compare('Region,Sales\nWest,$20.25\nEast,$10.50\n', [{ region: 'East', sales: 10.5 }, { region: 'West', sales: 20.25 }]);
    expect(result.verdict).toBe('matches');
    expect(result.rows).toMatchObject({ inFile: 2, inBoth: 2, onlyInFile: 0, onlyInZLens: 0 });
    expect(result.values).toEqual({ compared: 2, equal: 2 });
    expect(result.numbers[0]).toMatchObject({ verdict: 'matches', precision: '2 decimals' });
  });

  it('says exactly which value differs, and by what', () => {
    const result = compare('Region,Sales\nEast,10.50\nWest,20.25\n', [{ region: 'East', sales: 10.5 }, { region: 'West', sales: 21 }]);
    expect(result.verdict).toBe('differs');
    expect(result.differences).toEqual([{ key: ['West'], column: 'Sales', old: '20.25', zlens: 21, kind: 'value' }]);
  });

  it('calls a row in only one side a difference', () => {
    const result = compare('Region,Sales\nEast,10\nNorth,5\n', [{ region: 'East', sales: 10 }, { region: 'South', sales: 7 }]);
    expect(result.verdict).toBe('differs');
    expect(result.onlyInFile).toEqual([['North']]);
    expect(result.onlyInZLens).toEqual([['South']]);
  });

  it('compares only the file\'s rows when asked, and says nothing about the rest', () => {
    const result = compare('Region,Sales\nEast,10\n', [{ region: 'East', sales: 10 }, { region: 'South', sales: 7 }], byRegion, { fileRowsOnly: true });
    expect(result.verdict).toBe('matches');
    expect(result.rows.onlyInZLens).toBe(0);
  });

  it('does not count rows whose values are all empty, on either side', () => {
    const blankInFile = compare('Region,Sales\nEast,10\nWest,\n', [{ region: 'East', sales: 10 }]);
    expect(blankInFile).toMatchObject({ verdict: 'matches', rows: { emptySetAside: 1, onlyInFile: 0 } });
    const blankInZLens = compare('Region,Sales\nEast,10\n', [{ region: 'East', sales: 10 }, { region: 'West', sales: null }]);
    expect(blankInZLens).toMatchObject({ verdict: 'matches', rows: { emptySetAside: 1, onlyInZLens: 0 } });
  });

  it('stops when a key repeats, on either side, or a file has rows and no keys', () => {
    expect(() => compare('Region,Sales\nEast,1\nEast,2\n', [])).toThrow(ComparisonStopped);
    expect(() => compare('Region,Sales\nEast,1\n', [{ region: 'East', sales: 1 }, { region: 'East', sales: 2 }])).toThrow('grain is finer');
    expect(() => compare('Sales\n1\n2\n', [], { keys: [], numbers: [{ header: 'Sales', output: 'sales', name: 'sales' }], notCompared: [] })).toThrow('no column to tell them apart');
  });

  it('compares one row with no keys against the total', () => {
    expect(compare('Sales\n$10.50\n', [{ sales: 10.5 }], { keys: [], numbers: [{ header: 'Sales', output: 'sales', name: 'sales' }], notCompared: [] }).verdict).toBe('matches');
  });

  it('treats every empty key as one, and keeps a zip code\'s zero', () => {
    expect(compare('Region,Sales\n(Blank),1\n', [{ region: null, sales: 1 }]).verdict).toBe('matches');
    expect(compare('Region,Sales\nNull,1\n', [{ region: '', sales: 1 }]).verdict).toBe('matches');
    expect(compare('Region,Sales\n02134,1\n', [{ region: '02134', sales: 1 }]).verdict).toBe('matches');
    expect(compare('Region,Sales\n02134,1\n', [{ region: 2134, sales: 1 }]).verdict).toBe('differs');
    expect(compare('Region,Sales\n"1,234",1\n', [{ region: 1234, sales: 1 }]).verdict).toBe('matches');
    expect(compare('Region,Sales\nTrue,1\n', [{ region: true, sales: 1 }]).verdict).toBe('matches');
  });
});

describe('equal at the printed precision', () => {
  const one = (printed: string, ours: number) => compare(`Region,Sales\nEast,"${printed}"\n`, [{ region: 'East', sales: ours }]).verdict;

  it('holds a value within half a printed unit, both ends counting', () => {
    expect(one('14.9%', 0.1493)).toBe('matches');
    expect(one('14.9%', 0.1496)).toBe('differs');
    expect(one('1.01', 1.005)).toBe('matches'); // (1.005).toFixed(2) gives 1.00.
    expect(one('12', 12.5)).toBe('matches');
    expect(one('13', 12.5)).toBe('matches');
    expect(one('12', 12.51)).toBe('differs');
    expect(one('(41,000)', -41000.4)).toBe('matches');
    expect(one('1.2M', 1234567)).toBe('matches');
    expect(one('1.2M', 1260000)).toBe('differs');
  });

  it('uses the most decimals anywhere in the column, so 2 beside 2.25 means 2.00', () => {
    const result = compare('Region,Sales\nEast,2\nWest,2.25\n', [{ region: 'East', sales: 2.4 }, { region: 'West', sales: 2.25 }]);
    expect(result.verdict).toBe('differs');
    expect(result.differences[0]).toMatchObject({ key: ['East'], zlens: 2.4 });
  });

  it('tells empty from 0, with its own label', () => {
    const emptyInFile = compare('Region,Sales\nEast,\nWest,1\n', [{ region: 'East', sales: 0 }, { region: 'West', sales: 1 }]);
    expect(emptyInFile.verdict).toBe('differs');
    expect(emptyInFile.differences[0]).toMatchObject({ kind: 'empty-vs-zero' });
    const zeroInFile = compare('Region,Sales\nEast,0\nWest,1\n', [{ region: 'East', sales: null }, { region: 'West', sales: 1 }]);
    expect(zeroInFile.differences[0]).toMatchObject({ kind: 'empty-vs-zero' });
  });

  it('reads a percent against a metric holding percent points, and says so', () => {
    const result = compare('Region,Sales\nEast,14.9%\nWest,15.0%\n', [{ region: 'East', sales: 14.93 }, { region: 'West', sales: 15.01 }], byRegion, { pointColumns: new Set(['sales']) });
    expect(result.verdict).toBe('matches');
    expect(result.numbers[0]).toMatchObject({ percentPoints: true, precision: '0.1%, the metric holding 14.9 for 14.9%' });
  });

  it('does not let the percent retry hide a number 100 times too small', () => {
    // 0.05% is 0.0005: a metric holding 0.05 is 5%.
    expect(compare('Region,Sales\nEast,0.05%\nWest,0.12%\n', [{ region: 'East', sales: 0.05 }, { region: 'West', sales: 0.12 }]).verdict).toBe('differs');
    // Only a percent cell moves: 5 is 5.
    const mixed = compare('Region,Sales\nEast,12%\nWest,5\n', [{ region: 'East', sales: 12 }, { region: 'West', sales: 500 }], byRegion, { pointColumns: new Set(['sales']) });
    expect(mixed.verdict).toBe('differs');
    expect(mixed.differences.map((item) => item.key[0])).toEqual(['West']);
  });

  it('allows a printed number only its printed unit, however large', () => {
    expect(compare('Region,Sales\nEast,"$5,000,000,000.00"\n', [{ region: 'East', sales: 5_000_000_004.99 }]).verdict).toBe('differs');
    expect(compare('Region,Sales\nEast,"$5,000,000,000.00"\n', [{ region: 'East', sales: 5_000_000_000.004 }]).verdict).toBe('matches');
  });

  it('compares the most rows a file can hold', () => {
    const rows = Array.from({ length: 150_000 }, (_, index) => ({ region: `R${index}`, sales: index }));
    const text = `Region,Sales\n${rows.map((row) => `${row.region},${row.sales}`).join('\n')}\n`;
    expect(compare(text, rows).verdict).toBe('matches');
  });

  it('applies a tolerance only when asked, and says it did', () => {
    const lagging = 'Region,Sales\nEast,100.00\n';
    expect(compare(lagging, [{ region: 'East', sales: 100.4 }]).verdict).toBe('differs');
    const loose = compare(lagging, [{ region: 'East', sales: 100.4 }], byRegion, { tolerance: 0.005 });
    expect(loose.verdict).toBe('matches');
    expect(loose.numbers[0]!.precision).toBe('2 decimals, within 0.5%');
  });

  it('says how coarse a comparison was', () => {
    expect(compare('Region,Sales\nEast,1.2M\n', [{ region: 'East', sales: 1200000 }]).numbers[0]).toMatchObject({ coarse: true, precision: 'the nearest 100,000' });
  });

  it('reads a decimal comma from the whole column', () => {
    expect(compare('Region;Sales\nEast;1.234,56\nWest;12,5\n', [{ region: 'East', sales: 1234.56 }, { region: 'West', sales: 12.5 }]).verdict).toBe('matches');
  });
});

describe('verdicts', () => {
  const twoMetrics: ComparisonPlan = {
    keys: [{ header: 'Region', output: 'region', kind: 'text' }],
    numbers: [{ header: 'Sales', output: 'sales', name: 'sales' }, { header: 'Cost', output: 'cost', name: 'cost' }],
    notCompared: [],
  };

  it('gives each metric its own verdict, and the file the worst', () => {
    const result = compare('Region,Sales,Cost\nEast,10,5\n', [{ region: 'East', sales: 10, cost: 6 }], twoMetrics);
    expect(result.verdict).toBe('differs');
    expect(result.numbers.map((number) => number.verdict)).toEqual(['matches', 'differs']);
  });

  it('is Not proven when nothing was compared, whatever else is true', () => {
    expect(compare('Region,Sales\nEast,\n', [{ region: 'East', sales: null }]).verdict).toBe('not-proven');
    const noColumns = compare('Region\nEast\n', [{ region: 'East' }], { keys: byRegion.keys, numbers: [], notCompared: [] });
    expect(noColumns).toMatchObject({ verdict: 'not-proven', missing: ['No number column was compared.'] });
  });

  it('is Not proven when a column was left out, the export was cut short, or a filter went unanswered', () => {
    const partial = compare('Region,Sales,Cost\nEast,10,5\n', [{ region: 'East', sales: 10 }], { ...byRegion, notCompared: ['Cost'] });
    expect(partial).toMatchObject({ verdict: 'not-proven', missing: ['Cost was not compared.'] });
    expect(partial.numbers[0]!.verdict).toBe('matches');
    expect(compare('Region,Sales\nEast,10\nExported data exceeded the allowed volume\n', [{ region: 'East', sales: 10 }]).verdict).toBe('not-proven');
    const filtered = compare('Region,Sales\nEast,10\n', [{ region: 'East', sales: 10 }], byRegion, { unansweredFilters: ['Order Date'] });
    expect(filtered).toMatchObject({ verdict: 'not-proven', missing: ['Nobody stated or waived the filter on Order Date.'] });
    expect(filtered.reasons[0]).toContain('The report filters Order Date');
    expect(compare('Region,Sales\nEast,10\n', [{ region: 'East', sales: 10 }], byRegion, { resultIncomplete: true }).verdict).toBe('not-proven');
  });

  it('lets a difference win over anything missing', () => {
    expect(compare('Region,Sales\nEast,10\n', [{ region: 'East', sales: 11 }], byRegion, { unansweredFilters: ['Order Date'] }).verdict).toBe('differs');
  });
});

describe('dates as keys', () => {
  const byMonth: ComparisonPlan = {
    keys: [{ header: 'Month', output: 'order_date_month', kind: 'date', grain: 'month' }],
    numbers: [{ header: 'Sales', output: 'sales', name: 'sales' }],
    notCompared: [],
  };

  it('matches a printed period with a truncated date, whatever form it comes back in', () => {
    const text = 'Month,Sales\nJanuary 2026,10\nFebruary 2026,20\n';
    expect(compare(text, [{ order_date_month: '2026-01-01', sales: 10 }, { order_date_month: '2026-02-01 00:00:00', sales: 20 }], byMonth).verdict).toBe('matches');
    // Local midnight in a zone west and east of UTC is still that day.
    expect(compare(text, [{ order_date_month: new Date('2026-01-01T06:00:00Z'), sales: 10 }, { order_date_month: new Date('2026-02-01T06:00:00Z'), sales: 20 }], byMonth).verdict).toBe('matches');
    expect(compare(text, [{ order_date_month: new Date('2025-12-31T19:00:00Z'), sales: 10 }, { order_date_month: new Date('2026-01-31T19:00:00Z'), sales: 20 }], byMonth).verdict).toBe('matches');
    expect(compare(text, [{ order_date_month: '2026-01-01 00:00:00-06', sales: 10 }, { order_date_month: '2026-02-01 00:00:00-06', sales: 20 }], byMonth).verdict).toBe('matches');
  });

  it('keeps truncated dates on their day across a clock change, even at midnight UTC', () => {
    const across = 'Month,Sales\nMarch 2026,10\nApril 2026,20\n';
    expect(compare(across, [{ order_date_month: new Date('2026-03-01T06:00:00Z'), sales: 10 }, { order_date_month: new Date('2026-04-01T05:00:00Z'), sales: 20 }], byMonth).verdict).toBe('matches');
    expect(compare(across, [{ order_date_month: new Date('2026-03-01T00:00:00Z'), sales: 10 }, { order_date_month: new Date('2026-03-31T23:00:00Z'), sales: 20 }], byMonth).verdict).toBe('matches');
  });

  it('leaves a real timestamp on its own day', () => {
    const plan: ComparisonPlan = { ...byMonth, keys: [{ header: 'Day', output: 'day', kind: 'date', grain: 'day' }] };
    const rows = [{ day: new Date('2026-02-01T18:00:00Z'), sales: 1 }, { day: new Date('2026-02-02T09:15:00Z'), sales: 2 }, { day: new Date('2026-02-03T13:30:00Z'), sales: 3 }];
    expect(compare('Day,Sales\n2026-02-01,1\n2026-02-02,2\n2026-02-03,3\n', rows, plan).verdict).toBe('matches');
  });

  it('reads day first when a value settles it, or when told', () => {
    const plan: ComparisonPlan = { ...byMonth, keys: [{ header: 'Day', output: 'day', kind: 'date', grain: 'day' }] };
    expect(compare('Day,Sales\n13/2/2026,1\n1/2/2026,2\n', [{ day: '2026-02-13', sales: 1 }, { day: '2026-02-01', sales: 2 }], plan).verdict).toBe('matches');
    const unclear = compare('Day,Sales\n3/4/2026,1\n', [{ day: '2026-04-03', sales: 1 }], plan);
    expect(unclear.verdict).toBe('differs');
    expect(unclear.notes[0]).toContain('--dates dmy');
    expect(compare('Day,Sales\n3/4/2026,1\n', [{ day: '2026-04-03', sales: 1 }], plan, { dateOrder: 'dmy' }).verdict).toBe('matches');
  });

  it('stops on a date it cannot read, rather than miss every row', () => {
    expect(() => compare('Month,Sales\nsoon,1\n', [], byMonth)).toThrow('cannot read as a date');
  });
});

describe('possible reasons, only from evidence', () => {
  it('sees one factor across every value', () => {
    const result = compare('Region,Sales\nEast,10\nWest,20\n', [{ region: 'East', sales: 30 }, { region: 'West', sales: 60 }]);
    expect(result.reasons[0]).toBe("Every ZLens value is 3× the old report's: a join or a filter.");
  });

  it('sees data that has moved on', () => {
    const plan: ComparisonPlan = { keys: [{ header: 'Day', output: 'day', kind: 'date', grain: 'day' }], numbers: byRegion.numbers, notCompared: [] };
    const result = compare('Day,Sales\n2026-01-01,1\n', [{ day: '2026-01-01', sales: 1 }, { day: '2026-01-02', sales: 2 }], plan);
    expect(result.reasons[0]).toContain("The old report's data stops at 2026-01-01");
  });

  it('sees keys that differ only in case', () => {
    const result = compare('Region,Sales\nEast,1\n', [{ region: 'east', sales: 1 }]);
    expect(result.reasons[0]).toContain('differ only in case');
  });

  it('passes on the metric\'s own notes, and does not guess when it matches', () => {
    expect(compare('Region,Sales\nEast,1\n', [{ region: 'East', sales: 2 }], byRegion, { metricNotes: ['Data source Orders joins 2 tables.'] }).reasons).toContain('Data source Orders joins 2 tables.');
    expect(compare('Region,Sales\nEast,1\n', [{ region: 'East', sales: 1 }]).reasons).toEqual([]);
  });
});

describe('keys that look like something else', () => {
  it('reads an empty key the same way on both sides', () => {
    for (const written of ['N/A', '-', 'Null', '(Blank)']) {
      expect(compare('Region,Sales\n,5\nEast,1\n', [{ region: written, sales: 5 }, { region: 'East', sales: 1 }]).verdict, written).toBe('matches');
    }
  });

  it('keeps a row labelled Total when ZLens has that key, and sets it aside when it does not', () => {
    const text = 'Region,Sales\nEast,1\nTotal,2\n';
    const real = compare(text, [{ region: 'East', sales: 1 }, { region: 'Total', sales: 2 }]);
    expect(real).toMatchObject({ verdict: 'matches', rows: { inFile: 2, totalsSetAside: 0 } });
    expect(compare(text, [{ region: 'East', sales: 1 }, { region: 'Total', sales: 3 }]).verdict).toBe('differs');
    expect(compare(text, [{ region: 'East', sales: 1 }]).rows).toMatchObject({ inFile: 1, totalsSetAside: 1 });
  });

  it('sets aside a Total in a date column', () => {
    const plan: ComparisonPlan = { ...byRegion, keys: [{ header: 'Month', output: 'order_date_month', kind: 'date', grain: 'month' }] };
    expect(compare('Month,Sales\nJanuary 2026,1\nGrand Total,1\n', [{ order_date_month: '2026-01-01', sales: 1 }], plan).rows.totalsSetAside).toBe(1);
  });

  it('takes a key held as a decimal for the whole number it is', () => {
    expect(compare('Region,Sales\n2026,1\n', [{ region: '2026.00', sales: 1 }]).verdict).toBe('matches');
  });
});

