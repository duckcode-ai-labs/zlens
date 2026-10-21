import type { AppBlockRecommendation } from '../../../api/client';
import { sameNameOrigins, type SourceOrigin } from '../source-names';
import { sourceCatalogKindLabel } from './app-data';

/** Where a piece of App data comes from: a table (a Dataset), Metrics, or a saved query. */
export function appDataOrigin(item: Pick<AppBlockRecommendation, 'capabilities' | 'kind'>): SourceOrigin {
  const kind = sourceCatalogKindLabel(item);
  return kind === 'Dataset' ? 'Table' : kind;
}

/**
 * For items that share a name ("Orders" the table and "Orders" the Metrics),
 * the origin to show next to the name in lists and pickers. Unique names get
 * nothing.
 */
export function appDataSameNameOrigins(items: Array<Pick<AppBlockRecommendation, 'id' | 'name' | 'domain' | 'capabilities' | 'kind'>>): Map<string, string> {
  return sameNameOrigins(items.map((item) => ({ id: item.id, name: item.name, domain: item.domain, origin: appDataOrigin(item) })));
}
