import { groupedColumns, mentionsColumn, sameTable, tableName } from '@zlens/agent';
import type { ModelingRelationshipEdge } from './join-relationships.js';

/**
 * NAMES, NOT KEYS.
 *
 * "What is the average order value at each store?" is answered by stores a
 * person can read: Brooklyn, Philadelphia. The order facts carry only the
 * store's key (`orders.location_id`, a UUID); the name lives on the table the
 * key points at (`locations.location_name`). An AI drafting SQL over the
 * facts alone groups by the key, and the answer lists UUIDs.
 *
 * Which table names a key's rows is project metadata, never a guess about one
 * word: a relationship on the Modeling map (dbt `relationships` tests feed it),
 * a semantic model's foreign entity and the model where that entity is
 * primary, or — last — the column names themselves (`location_id` on the
 * facts, a `locations` table that carries `location_id` and a name column).
 * The draft is shown that table and that join before it is written, and a
 * statement that still groups by a bare key whose name is reachable is sent
 * back once to join it.
 */

/** A key column the answer groups by. */
export interface KeyReference { relation: string; column: string }

/** A semantic-model entity: its name, its kind (primary, foreign, unique, natural) and the column it is on. */
export interface EntityKey { name: string; type: string; relation: string; column: string }

/** The table that names the rows of a key, and how the two join. */
export interface KeyLabel {
  keyRelation: string;
  key: string;
  labelRelation: string;
  /** The column of `labelRelation` the key joins on. */
  labelKey: string;
  /** The column of `labelRelation` that names its rows. */
  label: string;
  /** What says so, for the reader and the run views. */
  via: string;
}

const LABEL_NAME = /(^|_)(name|title|label|display_name)$/i;
const KEY_NAME = /^(.+?)_(id|key|uuid)$/i;
const bare = (name: string) => name.replace(/["`[\]]/g, '');
const tableOf = (relation: string) => bare((tableName(relation) || relation)).toLowerCase();
const singular = (word: string) => word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('ses') ? word.slice(0, -2) : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
const sameColumn = (left: string, right: string) => bare(left).toLowerCase() === bare(right).toLowerCase();

/**
 * The column that names a table's rows: `<thing>_name` for the thing the table
 * holds, else its one name-like column. Several unrelated name columns and no
 * `<thing>_name` is ambiguous, and nothing is chosen.
 */
export function labelColumnOf(columns: string[], things: string[], exclude: string[] = []): string | undefined {
  const candidates = columns.filter((column) => LABEL_NAME.test(bare(column)) && !exclude.some((item) => sameColumn(item, column)));
  if (candidates.length === 0) return undefined;
  const stems = [...new Set(things.map((thing) => singular(bare(thing).toLowerCase())).filter(Boolean))];
  for (const stem of stems) {
    const exact = candidates.find((column) => [`${stem}_name`, `${stem}_title`, `${stem}_label`, `${stem}_display_name`].includes(bare(column).toLowerCase()));
    if (exact) return exact;
  }
  const plain = candidates.find((column) => ['name', 'title', 'label', 'display_name'].includes(bare(column).toLowerCase()));
  if (plain) return plain;
  const named = candidates.filter((column) => stems.some((stem) => bare(column).toLowerCase().split('_').includes(stem)));
  if (named.length === 1) return named[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * For each key, the table that names its rows and the join to it, from the
 * Modeling map, then the semantic entities, then the column names. A key whose
 * own table already names its rows (`customers.customer_id` beside
 * `customers.customer_name`) is named there. `resolve` maps a relation as the
 * metadata spells it to the one the draft reads (a semantic model's `locations`
 * to the warehouse's `"jaffle_shop"."dev"."locations"`); a table it cannot
 * resolve, or whose columns are unknown, names nothing.
 */
export function keyLabels(keys: KeyReference[], input: {
  edges: ModelingRelationshipEdge[];
  entities?: EntityKey[];
  /** Tables the draft may read, for the column-name fallback. */
  relations: string[];
  columnsOf: (relation: string) => string[];
  resolve?: (relation: string) => string | undefined;
}): KeyLabel[] {
  const resolve = input.resolve ?? ((relation: string) => relation);
  const found: KeyLabel[] = [];
  const named = (key: KeyReference, target: string, targetKey: string, via: string, things: string[]): KeyLabel | undefined => {
    const physical = resolve(target);
    if (!physical) return undefined;
    const columns = input.columnsOf(physical);
    if (!columns.some((column) => sameColumn(column, targetKey))) return undefined;
    const label = labelColumnOf(columns, [tableOf(physical), ...things], [targetKey]);
    return label ? { keyRelation: key.relation, key: key.column, labelRelation: physical, labelKey: columns.find((column) => sameColumn(column, targetKey))!, label, via } : undefined;
  };
  for (const key of keys) {
    if (found.some((item) => sameTable(item.keyRelation, key.relation, 'tail') && sameColumn(item.key, key.column))) continue;
    const stem = KEY_NAME.exec(bare(key.column))?.[1]?.toLowerCase();
    const entity = (input.entities ?? []).find((item) => sameTable(item.relation, key.relation, 'tail') && sameColumn(item.column, key.column));
    const candidates: Array<() => KeyLabel | undefined> = [
      // The key of the table itself: its own name column names its rows.
      () => (entity && entity.type !== 'foreign') || (stem && singular(tableOf(key.relation)) === singular(stem))
        ? named(key, key.relation, key.column, 'its own table', [entity?.name ?? stem ?? ''])
        : undefined,
      // A relationship on the Modeling map from this key to the "one" side.
      ...input.edges.flatMap((edge) => {
        const forward = sameTable(edge.fromRelation, key.relation, 'tail') && (edge.cardinality === 'many_to_one' || edge.cardinality === 'one_to_one');
        const backward = sameTable(edge.toRelation, key.relation, 'tail') && (edge.cardinality === 'one_to_many' || edge.cardinality === 'one_to_one');
        const pair = forward ? edge.keys.find((item) => sameColumn(item.from, key.column)) : backward ? edge.keys.find((item) => sameColumn(item.to, key.column)) : undefined;
        if (!pair || edge.keys.length !== 1) return [];
        const target = forward ? edge.toRelation : edge.fromRelation;
        return [() => named(key, target, forward ? pair.to : pair.from, `the ${edge.level} relationship ${edge.name}`, [edge.name.split('_to_').pop() ?? ''])];
      }),
      // A foreign entity of a semantic model, and the model where that entity is primary.
      ...(entity && entity.type === 'foreign'
        ? (input.entities ?? [])
          .filter((item) => item.name.toLowerCase() === entity.name.toLowerCase() && item.type !== 'foreign' && !sameTable(item.relation, key.relation, 'tail'))
          .map((item) => () => named(key, item.relation, item.column, `the semantic entity ${entity.name}`, [entity.name]))
        : []),
      // The column names: `location_id` on the facts, a `locations` table that carries it.
      ...(stem
        ? input.relations
          .filter((relation) => !sameTable(relation, key.relation, 'tail') && singular(tableOf(relation)) === singular(stem))
          .map((relation) => () => named(key, relation, key.column, 'the column names', [stem]))
        : []),
    ];
    for (const candidate of candidates) {
      const label = candidate();
      if (label) { found.push(label); break; }
    }
  }
  return found;
}

/**
 * The keys a statement groups by whose rows have a reachable name it does not
 * show. Only keys on tables the statement reads are judged, and a question
 * that asks for ids is answered by ids.
 */
export function unnamedGroupingKeys(sql: string, question: string, label: (keys: KeyReference[]) => KeyLabel[], columnsOf: (relation: string) => string[]): KeyLabel[] {
  return groupingKeyLabels(sql, question, label, columnsOf).filter((item) => !mentionsColumn(sql, item.label));
}

/** Every key a statement groups by whose rows have a reachable name, shown or not. */
export function groupingKeyLabels(sql: string, question: string, label: (keys: KeyReference[]) => KeyLabel[], columnsOf: (relation: string) => string[]): KeyLabel[] {
  if (/\b(ids?|identifiers?|keys?|uuids?)\b/i.test(question)) return [];
  const grouped = groupedColumns(sql).flatMap((item) => {
    if (item.relation) return [{ relation: item.relation, column: item.column }];
    // A bare column of a statement over several tables: the one table that has it.
    const relations = [...new Set([...sql.matchAll(/\b(?:from|join)\s+((?:"[^"]+"|[A-Za-z_$][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_$][\w$]*)){0,2})/gi)].map((match) => match[1]!))];
    const owners = relations.filter((relation) => columnsOf(relation).some((column) => sameColumn(column, item.column)));
    return owners.length === 1 ? [{ relation: owners[0]!, column: item.column }] : [];
  }).filter((item) => !new RegExp(`\\b${bare(item.column).replace(/_/g, '[_ ]')}\\b`, 'i').test(question));
  return grouped.length === 0 ? [] : label(grouped);
}

/** The line the drafting AI reads for one key and the table that names it. */
export function keyLabelLine(item: KeyLabel): string {
  return `- ${item.keyRelation}.${item.key} is a key, not a name: ${item.labelRelation}.${item.label} names those rows (${item.via}). When the answer groups or lists by ${item.key}, join ${item.labelRelation} ON ${item.keyRelation}.${item.key} = ${item.labelRelation}.${item.labelKey} and show ${item.label} beside ${item.key}.`;
}

/** What a statement that groups by a bare key is told when it is sent back. */
export function unnamedKeyFailure(item: KeyLabel): string {
  return `it groups by ${item.keyRelation}.${item.key}, a key a reader cannot read, and shows no name for it, although ${item.labelRelation}.${item.label} names those rows (${item.via}); join ${item.labelRelation} ON ${item.keyRelation}.${item.key} = ${item.labelRelation}.${item.labelKey} and select ${item.label} beside ${item.key}`;
}
