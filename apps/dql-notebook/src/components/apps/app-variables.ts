import { formatDashboardFilterValue } from './dashboard-filter-words';

/**
 * Formatting for dashboard variable values, shared by the App shell and the
 * analysis surface.
 */

export function formatVariableValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'All';
  if (Array.isArray(value)) return value.map(formatVariableValue).join(', ');
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return value.toLocaleString();
  // A date or number range reads in words ("From 1 Jan 2025"), never as JSON.
  if (typeof value === 'object') return formatDashboardFilterValue(value) ?? 'All';
  return String(value);
}

export function formatVariableEntryValue(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => formatVariableEntryValue(key, item)).join(', ');
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (/(season|year)/i.test(key) && Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2200) {
    return String(numeric);
  }
  return formatVariableValue(value);
}
