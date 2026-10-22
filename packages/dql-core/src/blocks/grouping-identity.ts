/**
 * Label and key knowledge for a block's grouping.
 *
 * Ask serves a block as a certified answer only when its grouping carries an
 * identity key: a block that groups by labels alone (`adjuster_name`, no
 * `adjuster_id`) cannot prove which entity is which, because two entities can
 * share a label. The matcher (dql-agent `entails`), the certifier warning and
 * the "Build it in DQL" prefill all read these definitions, so they cannot
 * disagree about the same SQL.
 */

/** A column that identifies an entity (`adjuster_id`, `policy_number`, `sku_code`). */
export const isKeyColumn = (column: string): boolean => /(^|_)(id|key|uuid|code|number)$/i.test(column);

/** A column that only names an entity (`adjuster_name`, `status_label`). */
export const isLabelColumn = (column: string): boolean => /(^|_)(name|label|title)(_|$)/i.test(column);

/** True when every grouping column is a label and none is a key. */
export function groupsByLabelsOnly(grouping: readonly string[]): boolean {
  return grouping.length > 0 && grouping.every(isLabelColumn) && !grouping.some(isKeyColumn);
}

export interface RelationKeyKnowledge {
  /** Relation as queried or as named in the catalog; matched on its last segment. */
  relation: string;
  columns?: string[];
  primaryKey?: string[];
}

export interface GroupingIdentityGap {
  /** The label columns the block groups by. */
  labels: string[];
  /** The identity key to add, when the table's key is known. */
  key?: string;
  /** Creator-facing sentence; names the key when it is known. */
  message: string;
}

const stem = (column: string) => column.toLowerCase().replace(/(^|_)(name|label|title)(_|$)/g, '_').replace(/^_+|_+$/g, '');
const lastSegment = (relation: string) => (relation.replace(/["`\[\]]/g, '').split('.').pop() ?? relation).toLowerCase();

/**
 * The key to suggest for a label: a key column the tables are known to have
 * whose name starts with the label's stem (`adjuster_name` -> `adjuster_id`),
 * else the single declared primary key. Undefined when the key is not known.
 */
export function identityKeyForLabels(labels: readonly string[], relations: readonly RelationKeyKnowledge[]): string | undefined {
  const keys = relations.flatMap((relation) => [...(relation.primaryKey ?? []), ...(relation.columns ?? []).filter(isKeyColumn)]);
  const stems = labels.map(stem).filter(Boolean);
  const byStem = keys.find((key) => stems.some((s) => key.toLowerCase().startsWith(`${s}_`)));
  if (byStem) return byStem;
  const declared = relations.flatMap((relation) => relation.primaryKey ?? []);
  return new Set(declared).size === 1 ? declared[0] : undefined;
}

/**
 * Whether a grouping is labels only, and what to add if so. `grouping` is the
 * block's GROUP BY columns ([] when they cannot be read, which is never a gap);
 * `tables` are the tables its SQL reads, used to pick the keys that apply.
 */
export function groupingIdentityGap(grouping: readonly string[], tables: readonly string[], known: readonly RelationKeyKnowledge[] = []): GroupingIdentityGap | undefined {
  if (!groupsByLabelsOnly(grouping)) return undefined;
  const read = tables.map(lastSegment);
  const relations = known.filter((relation) => read.includes(lastSegment(relation.relation)));
  const key = identityKeyForLabels(grouping, relations);
  const groups = grouping.join(', ');
  const message = key
    ? `Ask can't use this saved query as a certified answer: it groups by ${groups} only. Add ${key} (the key) to SELECT and GROUP BY.`
    : `Ask can't use this saved query as a certified answer: it groups by ${groups} only, and two entities can share a name. Add the entity's identifier column to SELECT and GROUP BY.`;
  return { labels: [...grouping], ...(key ? { key } : {}), message };
}
