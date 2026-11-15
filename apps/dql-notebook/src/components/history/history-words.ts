import type { HistoryAuthor, HistoryFeedEntry, HistoryItemKind, HistoryVersionRow } from '../../api/history';

/** The words History uses (V15 screens: History page, History tab, Compare). Plain functions, tested on their own. */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayName(date: Date, now: Date): string {
  const base = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

/** A day heading: "Today · Sat 14 Nov", "Yesterday · Fri 13 Nov", "Wed 11 Nov". */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, now)) return `Today · ${dayName(date, now)}`;
  if (sameDay(date, yesterday)) return `Yesterday · ${dayName(date, now)}`;
  return dayName(date, now);
}

/** "16:13", in the viewer's time. */
export function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "Today 10:42", "11 Nov 14:20", "11 Nov 2025 14:20". */
export function whenLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = timeLabel(iso);
  if (sameDay(date, now)) return `Today ${time}`;
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}${date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`}`;
  return `${day} ${time}`;
}

/** Changes grouped by day, newest first (the feed already is). */
export function groupByDay<T extends { at: string }>(entries: T[], now = new Date()): Array<{ label: string; entries: T[] }> {
  const groups: Array<{ label: string; entries: T[] }> = [];
  for (const entry of entries) {
    const label = dayLabel(entry.at, now);
    const last = groups.at(-1);
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

const KIND_WORDS: Record<HistoryItemKind, [string, string]> = {
  saved_query: ['Saved query', 'Saved queries'],
  app: ['App', 'Apps'],
  notebook: ['Notebook', 'Notebooks'],
  semantic: ['Semantic layer file', 'Semantic layer files'],
  model: ['Model file', 'Model files'],
};

export function kindLabel(kind: HistoryItemKind, count = 1): string {
  const words = KIND_WORDS[kind] ?? ['Item', 'Items'];
  return count === 1 ? words[0] : words[1];
}

/** Who, as a line says it: the Snowflake user, "AI" for an Ask draft, "ZLens" for ZLens itself. */
export function authorLabel(by: HistoryAuthor, short = true): string {
  if (by.kind === 'ai') return short ? 'AI' : by.askedBy ? `AI (Ask) for ${by.askedBy}` : 'AI (Ask)';
  return by.name;
}

/** "TEST_ADMIN" → "TA", "jsmith" → "JS". */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s_.@-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (parts[0] ?? '?').slice(0, 2).toUpperCase();
}

/** The verb of a line in the project's History. */
export function actionLabel(entry: Pick<HistoryFeedEntry, 'change' | 'action' | 'by' | 'count'>): string {
  switch (entry.change) {
    case 'started': return 'started History with';
    case 'removed':
      if (entry.action === 'clear-drafts') return 'cleared';
      if (entry.action === 'upgrade') return 'moved to the trash, in an upgrade:';
      return 'removed';
    case 'drafted': return 'drafted';
    case 'created': return entry.by.kind === 'ai' ? 'drafted' : 'created';
    case 'edited': return 'edited';
    case 'renamed': return 'renamed';
    case 'certified': return 'certified';
    case 'restored': return 'restored';
    default: return 'changed';
  }
}

/** The item a line names: its name, or "45 automatic Ask drafts" for a group. */
export function itemLabel(entry: Pick<HistoryFeedEntry, 'items' | 'count' | 'kind' | 'action'>): string {
  if (entry.count === 1) return entry.items[0]?.name ?? '';
  if (entry.action === 'clear-drafts') return `${entry.count} automatic Ask drafts`;
  const kinds = new Set(entry.items.map((item) => item.kind));
  return kinds.size <= 1 ? `${entry.count} ${kindLabel(entry.kind, entry.count).toLowerCase()}` : `${entry.count} items`;
}

/** The state a version is in, as the versions table says it. */
export function stateLabel(state: HistoryVersionRow['state']): string {
  switch (state) {
    case 'certified': return 'Certified';
    case 'draft': return 'Draft';
    case 'removed': return 'Removed';
    default: return 'Saved';
  }
}

/** "312 KB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The version a Restore button on a line brings back: the one before a removal, else the line's own. */
export function restorableVersion(entry: Pick<HistoryFeedEntry, 'change' | 'version'>): number | undefined {
  if (entry.version === undefined) return undefined;
  return entry.change === 'removed' ? entry.version - 1 : entry.version;
}

/** The SQL the side card shows: the change log, read in Snowflake. */
export function historySql(appName: string): string {
  return `SELECT changed_at, changed_by,\n       item, version, change\nFROM ${appName}.app_public.history\nORDER BY changed_at DESC;`;
}
