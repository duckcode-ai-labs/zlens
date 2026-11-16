import type { HistoryAuthor, HistoryFeedEntry, HistoryFeedItem, HistoryItem, HistoryItemKind, HistoryVersionRow } from '../../api/history';

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

/**
 * Who, as History says it: the Snowflake user, "AI (Ask) for <person>" for an automatic Ask draft (the label the SQL
 * view uses too), "ZLens" for ZLens itself. `short` ("AI") is for the round avatar only.
 */
export function authorLabel(by: HistoryAuthor, short = false): string {
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
    case 'started': return 'History starts here:';
    case 'created':
      // What ZLens found when it started was not made then: it started keeping its versions (V3: "ZLens created 5 apps").
      if (entry.action === 'found' && entry.by.kind === 'zlens') return 'started keeping versions of';
      return entry.by.kind === 'ai' ? 'drafted' : 'created';
    case 'removed':
      if (entry.action === 'clear-drafts') return 'cleared';
      if (entry.action === 'upgrade') return 'moved to the trash:';
      if (entry.action === 'trash') return 'found in the trash:';
      return 'removed';
    case 'published': return 'published';
    case 'drafted': return 'drafted';
    case 'edited': return 'edited';
    case 'renamed': return 'renamed';
    case 'certified': return 'certified';
    case 'restored': return 'restored';
    default: return 'changed';
  }
}

/** The item a line names: its name, or "45 automatic Ask drafts" for a group; the first line counts its items. */
export function itemLabel(entry: Pick<HistoryFeedEntry, 'items' | 'count' | 'kind' | 'action'> & { change?: HistoryFeedEntry['change'] }): string {
  if (entry.change === 'started') return `${entry.count} item${entry.count === 1 ? '' : 's'}`;
  if (entry.count === 1) return entry.items[0]?.name ?? '';
  if (entry.action === 'clear-drafts') return `${entry.count} automatic Ask drafts`;
  const kinds = new Set(entry.items.map((item) => item.kind));
  if (kinds.size > 1) return `${entry.count} items`;
  // "13 Apps" keeps its capital, as everywhere; "4 saved queries".
  const words = kindLabel(entry.kind, entry.count);
  return `${entry.count} ${entry.kind === 'app' ? words : words.toLowerCase()}`;
}

/** What a group of items holds, kind by kind: "2 saved queries, 1 App, 3 model files". */
export function kindsLabel(items: Array<Pick<HistoryFeedItem, 'kind'>>): string {
  const order: HistoryItemKind[] = ['saved_query', 'app', 'notebook', 'semantic', 'model'];
  const counts = new Map<HistoryItemKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return order.filter((kind) => counts.has(kind)).map((kind) => {
    const count = counts.get(kind)!;
    const words = kindLabel(kind, count);
    return `${count} ${kind === 'app' ? words : words.toLowerCase()}`;
  }).join(', ');
}

/** The amber banner of an item's History: a draft on a certified version, or a restored copy of one. */
export function bannerText(banner: NonNullable<HistoryItem['banner']>): string {
  if (banner.restored !== undefined) {
    return `v${banner.draft} restores certified v${banner.restored} as a draft. Certify v${banner.draft} or keep using v${banner.certified}.`;
  }
  return `v${banner.draft} is an edit of certified v${banner.certified} and is not certified yet. Compare the two, then certify v${banner.draft} or restore v${banner.certified}.`;
}

/** What a restore did, said once: "Restored v1 as v3, as a draft." */
export function restoredNotice(message: string, name?: string): string {
  const said = /draft/i.test(message) ? `${message}.` : `${message}, as a draft.`;
  return name ? `${name}: ${said}` : said;
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

/**
 * The button on a line that stands for several items (V4 tester: "ZLens found in the trash: 13 Apps" had a Restore
 * that did not say what it did). It restores nothing itself: it lists the items, each with its own Restore.
 */
export function groupRestoreLabel(entry: Pick<HistoryFeedEntry, 'kind' | 'items'>, expanded: boolean): string {
  if (expanded) return 'Hide the list';
  const what = new Set(entry.items.map((item) => item.kind)).size > 1
    ? 'items'
    : entry.kind === 'app' ? kindLabel(entry.kind, 2) : kindLabel(entry.kind, 2).toLowerCase();
  return `Choose ${what} to restore`;
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
