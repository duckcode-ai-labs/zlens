import { describe, expect, it } from 'vitest';
import { formatChartValue, formatDisplayValue, inferDisplayValueKind } from './value-format';

describe('semantic value formatting', () => {
  it('renders monetary measures consistently', () => {
    expect(inferDisplayValueKind('lifetime_spend', [3089.8])).toBe('currency');
    expect(formatDisplayValue('lifetime_spend', 3089.8)).toBe('$3,089.80');
    expect(formatChartValue('total_revenue', 2_800_000)).toBe('$2.8M');
  });

  it('distinguishes counts, general decimals, and percentages', () => {
    expect(formatDisplayValue('order_count', 231)).toBe('231');
    expect(formatDisplayValue('average_items', 2.3456)).toBe('2.35');
    expect(formatDisplayValue('conversion_rate_pct', 0.082)).toBe('8.2%');
    expect(formatDisplayValue('market_share', 8.2)).toBe('8.2%');
    expect(formatDisplayValue('gross_margin', 1269392.42)).toBe('$1,269,392.42');
    expect(formatDisplayValue('margin_pct', 86.3)).toBe('86.3%');
  });

  // V11: seasons read "2,014" in App tiles and tables, and in the Ask and notebook grids.
  it('shows a season or year column as years, whatever number format the column carries', () => {
    expect(inferDisplayValueKind('SEASON', [2014, 2015])).toBe('year');
    expect(formatDisplayValue('SEASON', 2014, [2014, 2018])).toBe('2014');
    expect(formatDisplayValue('season', '2018')).toBe('2018');
    expect(formatDisplayValue('FISCAL_YEAR', 2018, [], { compact: true })).toBe('2018');
    expect(formatChartValue('SEASON', 2016)).toBe('2016');
    // A Dataset field's number contract does not make a year "2,014".
    expect(formatDisplayValue('SEASON', 2014, [], { meta: { kind: 'number' } })).toBe('2014');
    expect(formatDisplayValue('SEASON', 2014, [], { meta: { kind: 'count' } })).toBe('2014');
    // Money, shares and other numbers are unchanged.
    expect(formatDisplayValue('SEASON', 2014, [], { meta: { kind: 'currency' } })).toBe('$2,014.00');
    expect(formatDisplayValue('WINS', 2014)).toBe('2,014');
    expect(formatDisplayValue('POINTS_PER_SEASON', 2014)).toBe('2,014');
  });

  it('formats years, months, dates, and timestamps by their semantic role', () => {
    expect(formatDisplayValue('fiscal_year', 2006)).toBe('2006');
    expect(formatDisplayValue('fiscal_year', '2006')).toBe('2006');
    expect(formatDisplayValue('order_year', '2016-01-01T00:00:00.000Z')).toBe('2016');
    expect(formatDisplayValue('reporting_month', 1)).toBe('Jan');
    expect(formatDisplayValue('reporting_month', '2026-01')).toBe('Jan 2026');
    expect(formatDisplayValue('order_date', '2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDisplayValue('ordered_at', '2026-01-01T00:00:00.000Z')).toBe('Jan 1, 2026');
    expect(formatDisplayValue('event_time', '2026-01-01T14:30:00Z')).toBe('Jan 1, 2026, 2:30 PM');
    expect(formatDisplayValue('monthly', '2016-09-01T00:00:00.000Z')).toBe('Sep 2016');
    expect(formatDisplayValue('cohort_month', '2017-03-01T00:00:00.000Z')).toBe('Mar 2017');
    expect(formatDisplayValue('snapshot', '2016-09-01T00:00:00.000Z', ['2016-09-01T00:00:00.000Z'])).toBe('Sep 1, 2016');
    expect(formatDisplayValue('event_time', '14:30:00')).toBe('2:30 PM');
    expect(formatDisplayValue('event_time', '2026-01-01T14:30:00')).toBe('Jan 1, 2026, 2:30 PM');
  });

  it('lets authored formatting override a neutral column name', () => {
    expect(formatDisplayValue('result', 42.5, [42.5], { format: 'currency' })).toBe('$42.50');
  });
});

describe('a declared units contract wins over the column name', () => {
  it('formats fractions, percentage points, counts, currency and grains by the meta', () => {
    expect(formatDisplayValue('drink_revenue_pct', 0.6263, [], { meta: { kind: 'percent', unit: 'fraction' } })).toBe('62.63%');
    expect(formatDisplayValue('revenue_growth_mom', 10.84, [], { meta: { kind: 'percent', unit: 'percentage_points', decimals: 1 } })).toBe('10.8 pp');
    expect(formatDisplayValue('orders', 2085, [], { meta: { kind: 'count' } })).toBe('2,085');
    expect(formatDisplayValue('aov', 10.7364, [], { meta: { kind: 'currency', unit: 'USD' } })).toBe('$10.74');
    expect(formatDisplayValue('eu_revenue', 10.7364, [], { meta: { kind: 'currency', unit: 'EUR' } })).toMatch(/€10\.74/);
    expect(formatDisplayValue('total_value', 42, [], { meta: { kind: 'count' } })).toBe('42');
    // Without meta the name heuristic still applies, exactly as before.
    expect(formatDisplayValue('total_value', 42, [])).toBe('$42.00');
  });
});
