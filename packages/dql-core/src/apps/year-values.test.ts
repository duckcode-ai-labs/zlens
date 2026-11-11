import { describe, expect, it } from 'vitest';
import { formatYearValue, isYearLikeColumn, yearOf } from './year-values.js';

// V11: seasons read "2,014" / "2,018" in App tiles and tables, and in the Ask and notebook result grids.
describe('years shown as years', () => {
  it('knows a column of years by its name', () => {
    for (const column of ['SEASON', 'season', 'YEAR', 'FISCAL_YEAR', 'fiscal_year', 'ORDER_YEAR', 'fiscalYear', 'Fiscal Year', 'FY', 'SEASON_ID', 'year_start']) {
      expect(isYearLikeColumn(column), column).toBe(true);
    }
    for (const column of ['WINS', 'YEARS_ACTIVE', 'POINTS_PER_SEASON', 'games_per_year', 'SEASON_WINS', 'revenue', 'month_of_year_total']) {
      expect(isYearLikeColumn(column), column).toBe(false);
    }
  });

  it('shows whole numbers in 1800–2200 of such a column with no thousands separator, and nothing else', () => {
    expect(formatYearValue('SEASON', 2014)).toBe('2014');
    expect(formatYearValue('FISCAL_YEAR', '2018')).toBe('2018');
    expect(formatYearValue('SEASON', BigInt(2015))).toBe('2015');
    expect(formatYearValue('SEASON', 22015)).toBeUndefined();
    expect(formatYearValue('SEASON', 2014.5)).toBeUndefined();
    expect(formatYearValue('SEASON', '2014-15')).toBeUndefined();
    expect(formatYearValue('WINS', 2014)).toBeUndefined();
    expect([yearOf(1799), yearOf(1800), yearOf(2200), yearOf(2201)]).toEqual([undefined, 1800, 2200, undefined]);
  });
});
