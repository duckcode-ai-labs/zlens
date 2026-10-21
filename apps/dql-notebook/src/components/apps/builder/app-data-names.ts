import type { AppBlockRecommendation } from '../../../api/client';
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
