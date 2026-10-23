import { NOT_CERTIFIED_YET } from '@zlens/core/apps/reader-trust';
import type { AppBlockRecommendation, WarehouseTableSummary } from '../../../api/client';
import { sameNameOrigins, type SourceOrigin } from '../source-names';
import { sourceOriginLabel } from './app-data';

/**
 * Where a piece of App data comes from (design D1): a table (a Dataset made
 * from one), Metrics, or a saved query (with fields from its result, or made
 * row-level).
 */
export function appDataOrigin(item: Pick<AppBlockRecommendation, 'capabilities' | 'kind'> & { tags?: string[] }): SourceOrigin {
  return sourceOriginLabel(item);
}

/**
 * For items that share a name ("Orders" the table and "Orders" the Metrics),
 * the origin to show next to the name in lists and pickers. Unique names get
 * nothing.
 */
export function appDataSameNameOrigins(items: Array<Pick<AppBlockRecommendation, 'id' | 'name' | 'domain' | 'capabilities' | 'kind'> & { tags?: string[] }>): Map<string, string> {
  return sameNameOrigins(items.map((item) => ({ id: item.id, name: item.name, domain: item.domain, origin: appDataOrigin(item) })));
}

/**
 * A database table's words in the Data list and pickers (round 3, trust
 * design T1): the trust label is always "Not certified yet" — a table is not
 * certified data until it is added and certified — with one plain hint when
 * it helps ("added", "drafted — review in Modeling"). How the project's model
 * knows the table is detail for a tooltip, never another status word
 * ("Modeled", "Drafted", "Not checked yet", "Checked", "Governed").
 */
export function tableTrustWords(
  table: Pick<WarehouseTableSummary, 'modeled'>,
  options: { added?: boolean } = {},
): { label: string; hint?: string; detail: string } {
  const drafted = table.modeled?.state === 'drafted';
  const hint = options.added ? 'added' : drafted ? 'drafted — review in Modeling' : undefined;
  const detail = options.added
    ? 'Already in this App. Certify it when you are ready; until then readers see “Not certified yet” on its tiles.'
    : table.modeled?.state === 'modeled'
      ? 'Your model already knows this table: Check and add reuses its row key and joins.'
      : drafted
        ? 'Setup drafted its row key and joins. Review them in Modeling, or Check and add it now.'
        : 'Check and add reads what one row is and which numbers add up, then adds it with fields.';
  return { label: NOT_CERTIFIED_YET, ...(hint ? { hint } : {}), detail };
}

/** The table's words as one line: "Not certified yet" or "Not certified yet · drafted — review in Modeling". */
export function tableTrustLine(table: Pick<WarehouseTableSummary, 'modeled'>, options: { added?: boolean } = {}): string {
  const words = tableTrustWords(table, options);
  return [words.label, words.hint].filter(Boolean).join(' · ');
}

/**
 * A table already made into App data (round 3, problem 7), in the same two
 * trust words: "Certified" or "Not certified yet", with "added" when it is
 * in this App. Whether it was checked or saved as a draft is tooltip detail.
 */
export function madeTableTrustWords(state: 'certified' | 'checked' | 'draft' | string, options: { added?: boolean; certifiedLabel?: string } = {}): { label: string; detail: string } {
  const certified = state === 'certified';
  // Who certified it and when, the same words as the data made from it (R02): "Certified by you · 23 Oct".
  const label = [certified ? options.certifiedLabel || 'Certified' : NOT_CERTIFIED_YET, options.added ? 'added' : ''].filter(Boolean).join(' · ');
  const detail = certified
    ? 'Certified: someone vouched for these numbers.'
    : state === 'checked'
      ? 'Checked, not certified yet. Certify it when you are ready.'
      : 'Saved as a draft: it did not pass its checks yet.';
  return { label, detail };
}
