import { DATE_RANGE_PRESETS, dateRangePresetValue, matchingDateRangePreset, todayForDateFilter } from '@zlens/core/apps/filter-dates';

/**
 * Quick choices beside a date range control (new-user round 3, problem 9):
 * Last 7 days, Last 30 days, This month, This quarter, This year, Custom.
 * A choice fills the range's two dates, so the inputs always show what the
 * tiles are filtered by; Custom keeps the dates as they are.
 */
export function DateRangePresetSelect({
  label,
  value,
  timezone,
  className,
  onChange,
}: {
  label: string;
  value: unknown;
  timezone?: string;
  className?: string;
  onChange: (range: { start: string; end: string } | undefined) => void;
}): JSX.Element {
  const today = todayForDateFilter(timezone);
  const chosen = matchingDateRangePreset(value, today);
  return (
    <select
      className={className ?? 'date-range-presets'}
      aria-label={`${label} quick range`}
      value={chosen || 'any'}
      onChange={(event) => {
        const next = event.target.value;
        if (next === 'custom') return;
        onChange(next === 'any' ? undefined : dateRangePresetValue(next, today));
      }}
    >
      <option value="any">Any date</option>
      {DATE_RANGE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
      <option value="custom">Custom</option>
    </select>
  );
}

/** A date filter's timezone, when its document names one ("today" is taken there). */
export function filterTimezone(filter: unknown): string | undefined {
  const value = filter && typeof filter === 'object' ? (filter as { timezone?: unknown }).timezone : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
