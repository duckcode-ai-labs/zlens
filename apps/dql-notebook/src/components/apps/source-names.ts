/**
 * Names a person reads for a source of App data. Internal identities such as
 * `General::Block::Customers::8f7fac5d8eae716e39ba` or
 * `commerce::block::monthly_revenue::88e1…` never reach the screen: they read
 * "Customers" and "Monthly Revenue".
 */

const IDENTITY_KINDS = new Set(['block', 'semantic', 'dataset', 'metric', 'metrics', 'model']);

/** "top_customers" reads "Top Customers"; a name with spaces is kept as written. */
export function readableSourceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return /\s/.test(trimmed) ? trimmed : trimmed.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * The display name of a source from its label (when it has one) or from its
 * qualified identity. `domain::block::name::hash` reads as `name`; any other
 * `a::b::c` identity reads as its last readable part.
 */
export function sourceDisplayName(identity: string | null | undefined, label?: string | null): string {
  const named = label?.trim();
  if (named) return readableSourceName(named);
  const value = String(identity ?? '').trim();
  if (!value) return 'this data';
  const parts = value.split('::').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3 && IDENTITY_KINDS.has(parts[1]!.toLowerCase())) return readableSourceName(parts[2]!);
  if (parts.length > 1) {
    // The last part is often a hash; the one before it is the name.
    const readable = [...parts].reverse().find((part) => !/^[0-9a-f]{8,}$/i.test(part));
    return readableSourceName(readable ?? parts[parts.length - 1]!);
  }
  return readableSourceName(value);
}

/** A qualified identity anywhere inside a sentence (an older stored reason, a banner). */
const IDENTITY_IN_TEXT = /\b[\w-]+(?:::[\w-]+){2,}\b/g;

/**
 * Replaces every internal identity in a sentence with its display name and
 * rewrites the engineering phrasings older Apps stored ("is not exposed by",
 * "approved physical field") into plain words.
 */
export function plainSourceText(text: string | null | undefined): string {
  const value = String(text ?? '');
  if (!value) return value;
  const named = value.replace(IDENTITY_IN_TEXT, (identity) => sourceDisplayName(identity));
  // "customer name is not exposed by Monthly Revenue." → "Monthly Revenue has no Customer Name field."
  const exposed = named.match(/^\s*(.+?) is not exposed by (.+?)\.?\s*$/i);
  if (exposed) return missingFieldReason(exposed[2]!, exposed[1]!);
  const physical = named.match(/^\s*(.+?) is not an approved physical field on this Dataset source\.?\s*$/i);
  if (physical) return missingFieldReason('This data', physical[1]!);
  // "Ordered At is not mapped to beverage_revenue_by_product." names the data, never its id (new-user round 2, problem 9).
  const unmapped = named.match(/^\s*(.+?) is not mapped to ([A-Za-z][\w-]*)\.?\s*$/);
  if (unmapped && /[_-]/.test(unmapped[2]!)) return `${unmapped[1]} is not mapped to ${sourceDisplayName(unmapped[2])}.`;
  return named;
}

/** "Monthly Revenue has no Customer Name field." */
export function missingFieldReason(sourceName: string, field: string): string {
  const fieldLabel = field.trim().replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return `${sourceDisplayName(sourceName)} has no ${fieldLabel} field.`;
}

/**
 * Search text that ignores case, spaces, underscores and dashes, so
 * "customer name", "Customer_Name" and "customername" all match `customer_name`.
 */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[\s_\-.:]+/g, '');
}

/** Whether any of the texts matches the typed search, ignoring spaces, underscores and case. */
export function searchMatches(search: string, texts: Array<string | null | undefined>): boolean {
  const needle = normalizeSearchText(search.trim());
  if (!needle) return true;
  return texts.some((text) => text && normalizeSearchText(text).includes(needle));
}

/** Where a piece of App data comes from, said in the App glossary. */
export type SourceOrigin = 'Table' | 'Metrics' | 'Saved query';

export interface NamedSource {
  id: string;
  name: string;
  domain?: string | null;
  origin: SourceOrigin;
}

/**
 * The words that tell apart items with the same name ("Orders · Table" and
 * "Orders · Metrics"). Items whose names are unique get no entry. When two
 * items share both name and origin, their domain is added.
 */
export function sameNameOrigins(items: NamedSource[]): Map<string, string> {
  const byName = new Map<string, NamedSource[]>();
  for (const item of items) {
    const key = normalizeSearchText(readableSourceName(item.name));
    byName.set(key, [...(byName.get(key) ?? []), item]);
  }
  const out = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const item of group) {
      const twins = group.filter((other) => other.origin === item.origin).length > 1;
      const domain = item.domain && item.domain !== 'Unassigned' ? readableSourceName(item.domain) : '';
      out.set(item.id, twins && domain ? `${item.origin} · ${domain}` : item.origin);
    }
  }
  return out;
}
