import { describe, expect, it } from 'vitest';
import { dateOrderOf, decimalStyleOf, ExportRefused, isEmptyCell, parseDateCell, parseNumberCell, readExport } from './read-export.js';

const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

describe('reading an export', () => {
  it('reads a Tableau crosstab: UTF-16, tabs, formatted text, a total row', () => {
    const table = readExport(utf16('Region\tTotal Sales\tProfit Ratio\nEast\t$678,781.24\t14.9%\nWest\t$725,457.82\t15.0%\nGrand Total\t$1,404,239.06\t15.0%\n'), 'Sales by Region.csv');
    expect(table.headers).toEqual(['Region', 'Total Sales', 'Profit Ratio']);
    expect(table.rows).toEqual([['East', '$678,781.24', '14.9%'], ['West', '$725,457.82', '15.0%']]);
    expect(table.totalsSetAside).toBe(1);
    expect(table.tool).toBe('tableau');
    expect(table.sha256).toHaveLength(64);
  });

  it('reads UTF-16 with no mark, UTF-8 with a mark, CRLF, and quoted thousands', () => {
    expect(readExport(Buffer.from('a\tb\nx\t1\n', 'utf16le'), 'a.csv').rows).toEqual([['x', '1']]);
    const table = readExport(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Region,Sales\r\n"East","358,562"\r\n"O""Brien",7\r\n')]), 'b.csv');
    expect(table.headers).toEqual(['Region', 'Sales']);
    expect(table.rows).toEqual([['East', '358,562'], ['O"Brien', '7']]);
    expect(table.tool).toBeUndefined();
  });

  it('picks the separator from the lines, not from commas inside numbers', () => {
    expect(readExport(Buffer.from('Region;Sales\nEast;1,5\nWest;2,5\n'), 'c.csv').rows).toEqual([['East', '1,5'], ['West', '2,5']]);
    expect(readExport(Buffer.from('Region\tSales\nEast\t"1,234"\n'), 'd.tsv').rows).toEqual([['East', '1,234']]);
  });

  it('reshapes both of Tableau\'s Measure Names forms to one column per measure', () => {
    const long = readExport(Buffer.from('Region,Measure Names,Measure Values\nEast,Sales,10\nEast,Profit,2\nWest,Sales,20\nWest,Profit,4\n'), 'e.csv');
    expect(long.headers).toEqual(['Region', 'Sales', 'Profit']);
    expect(long.rows).toEqual([['East', '10', '2'], ['West', '20', '4']]);
    expect(long.tool).toBe('tableau');
    const wide = readExport(Buffer.from('Region,Measure Names,Sales,Profit\nEast,Sales,10,\nEast,Profit,,2\n'), 'f.csv');
    expect(wide.headers).toEqual(['Region', 'Sales', 'Profit']);
    expect(wide.rows).toEqual([['East', '10', '2']]);
  });

  it('takes Power BI\'s filter line and overflow note out of the table, and its quote off text', () => {
    const table = readExport(Buffer.from('Applied filters: Region is East\nRegion,Sales\n\'=East,1\nExported data exceeded the allowed volume\n'), 'g.csv');
    expect(table.appliedFilters).toBe('Region is East');
    expect(table.cutShort).toContain('exceeded');
    expect(table.tool).toBe('powerbi');
    expect(table.rows).toEqual([['=East', '1']]);
  });

  it('refuses what it cannot compare, saying what to do', () => {
    expect(() => readExport(Buffer.from('x'), 'Sales.twbx')).toThrow(ExportRefused);
    expect(() => readExport(Buffer.from('x'), 'shot.png')).toThrow('Export the worksheet');
    expect(() => readExport(Buffer.from('Region,2024,2025\nEast,1,2\n'), 'h.csv')).toThrow('across the top');
    expect(() => readExport(Buffer.from('Region,Q1 2026,Q2 2026\nEast,1,2\n'), 'i.csv')).toThrow('across the top');
    expect(() => readExport(Buffer.from(',Sales\nEast,1\n'), 'j.csv')).toThrow('several header rows');
    expect(() => readExport(Buffer.from('Sales,sales\n1,2\n'), 'k.csv')).toThrow('twice');
    expect(() => readExport(Buffer.from('\n\n'), 'l.csv')).toThrow('no rows');
  });
});

describe('reading a number as it was printed', () => {
  it('keeps the value and what was printed', () => {
    expect(parseNumberCell('$678,781.24')).toEqual({ value: 678781.24, decimals: 2, scale: 1, percent: false });
    expect(parseNumberCell('14.9%')).toMatchObject({ decimals: 1, percent: true });
    expect(parseNumberCell('14.9%')!.value).toBeCloseTo(0.149, 10);
    expect(parseNumberCell('($41,000)')).toMatchObject({ value: -41000, decimals: 0 });
    expect(parseNumberCell('(41,000)')).toMatchObject({ value: -41000 });
    expect(parseNumberCell('−1,234.5')).toMatchObject({ value: -1234.5, decimals: 1 });
    expect(parseNumberCell('-$12')).toMatchObject({ value: -12 });
    expect(parseNumberCell('12-')).toMatchObject({ value: -12 });
    expect(parseNumberCell('1.2M')).toMatchObject({ value: 1200000, decimals: 1, scale: 1e6 });
    expect(parseNumberCell('950K')).toMatchObject({ value: 950000, decimals: 0, scale: 1e3 });
    expect(parseNumberCell('€1.234,56', 'comma')).toMatchObject({ value: 1234.56, decimals: 2 });
    expect(parseNumberCell('1 234,56 €', 'comma')).toMatchObject({ value: 1234.56 });
    expect(parseNumberCell('USD 12')).toMatchObject({ value: 12 });
    expect(parseNumberCell('.5')).toMatchObject({ value: 0.5, decimals: 1 });
  });

  it('says no to text that is not a number', () => {
    for (const text of ['East', '12 apples', '1,2,3', '', '2026-01-05', '02/03/2026']) expect(parseNumberCell(text), text).toBeNull();
  });

  it('decides a decimal comma from the whole column', () => {
    expect(decimalStyleOf(['1.234,56', '12,5'])).toEqual({ style: 'comma', ambiguous: false });
    expect(decimalStyleOf(['1,234.56', '12.5'])).toEqual({ style: 'point', ambiguous: false });
    expect(decimalStyleOf(['1,234', '5,678'])).toEqual({ style: 'point', ambiguous: true });
    expect(decimalStyleOf(['1,234', '12,5'])).toEqual({ style: 'comma', ambiguous: false });
  });

  it('knows every way an empty value is written', () => {
    for (const text of ['', 'Null', '%null%', '(Blank)', 'n/a', '-', '—', null, undefined]) expect(isEmptyCell(text), String(text)).toBe(true);
    expect(isEmptyCell('0')).toBe(false);
    expect(isEmptyCell('East')).toBe(false);
  });
});

describe('reading a date as it was printed', () => {
  it('reads days and periods to the first day of the period', () => {
    expect(parseDateCell('2026-01-05')).toEqual({ date: '2026-01-05', grain: 'day' });
    expect(parseDateCell('12/31/2026 12:00:00 AM')).toEqual({ date: '2026-12-31', grain: 'day' });
    expect(parseDateCell('January 5, 2026')).toEqual({ date: '2026-01-05', grain: 'day' });
    expect(parseDateCell('5 Jan 2026')).toEqual({ date: '2026-01-05', grain: 'day' });
    expect(parseDateCell('January 2026')).toEqual({ date: '2026-01-01', grain: 'month' });
    expect(parseDateCell('Jan-26')).toEqual({ date: '2026-01-01', grain: 'month' });
    expect(parseDateCell('2026-03')).toEqual({ date: '2026-03-01', grain: 'month' });
    expect(parseDateCell('Q3 2026')).toEqual({ date: '2026-07-01', grain: 'quarter' });
    expect(parseDateCell('2026 Q1')).toEqual({ date: '2026-01-01', grain: 'quarter' });
  });

  it('says no to what is not a date, or not a real one', () => {
    for (const text of ['January', 'East', '13/13/2026', '2026-02-30', '2026']) expect(parseDateCell(text), text).toBeNull();
  });

  it('settles day or month first from the whole column', () => {
    expect(dateOrderOf(['1/2/2026', '13/2/2026'])).toEqual({ order: 'dmy', ambiguous: false });
    expect(dateOrderOf(['1/2/2026', '1/25/2026'])).toEqual({ order: 'mdy', ambiguous: false });
    expect(dateOrderOf(['1/2/2026', '3/4/2026'])).toEqual({ order: 'mdy', ambiguous: true });
    expect(parseDateCell('3/4/2026', 'dmy')).toEqual({ date: '2026-04-03', grain: 'day' });
  });
});
