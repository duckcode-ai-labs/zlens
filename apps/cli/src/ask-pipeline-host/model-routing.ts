import { sameTable, tableName } from '@zlens/agent';
import type { DQLManifest } from '@zlens/core';

/**
 * Ask picks the question's subject areas before it shows tables (model-at-
 * scale design S6). A model of up to 30 tables is shown whole (RFC 0012, F1);
 * a larger one, at 4,000-model scale, is shown one area at a time: the areas
 * the question belongs to, and the Shared tables they join, within the same
 * budget. An area is chosen by the tables search already found for the
 * question (the strongest sign) and by the question's words in its name,
 * description, example questions and table names. Tables with no area group
 * by their Domain.
 */

export interface ModelGroup {
  /** `area:<qualified id>`, or `domain:<id>` for tables in no area. */
  key: string;
  name: string;
  shared: boolean;
  words: Set<string>;
  /** The tables it answers from, as the drafter sees them. */
  relations: string[];
  /**
   * Its look-alikes (a staging copy a drafted pick says to skip): never shown,
   * but search finding one says the question is about this group.
   */
  lookAlikes: string[];
}

export interface ModelRoute {
  /** The groups chosen, best first. */
  groups: ModelGroup[];
  /** Every table to show: the groups' tables, then the Shared tables they join. */
  relations: string[];
  /** The Shared tables added because a chosen table joins them. */
  shared: string[];
}

type Entity = NonNullable<DQLManifest['modeling']>['entities'][string];

const STOP = new Set([
  'the', 'and', 'for', 'with', 'per', 'each', 'all', 'any', 'how', 'many', 'much', 'what', 'which', 'who', 'whom', 'when', 'where', 'why',
  'are', 'was', 'were', 'has', 'have', 'had', 'did', 'does', 'from', 'into', 'over', 'that', 'this', 'these', 'those', 'than', 'then',
  'show', 'list', 'give', 'top', 'most', 'least', 'total', 'number', 'count', 'average', 'sum', 'by', 'of', 'in', 'on', 'to', 'a', 'an',
  'table', 'tables', 'one', 'row', 'rows', 'model', 'data', 'last', 'first', 'between', 'during', 'their', 'its',
]);

/** Content words, singular: "Invoices by customer segment" → invoice, customer, segment. */
export function routingWords(text: string | undefined): string[] {
  return (text ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word))
    .map((word) => (word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

/**
 * The model's answer tables, grouped by area, or by Domain for tables in no
 * area. A group's words are its name, description and example questions, and
 * its tables' names and column names: "the Rockets' general manager" belongs
 * where a table has a `general_manager` column.
 */
export function modelAnswerGroups(manifest: DQLManifest | undefined, relationOf: (entity: Entity) => string | undefined, columnsOf: (relation: string) => readonly string[] = () => []): ModelGroup[] {
  const modeling = manifest?.modeling;
  if (!modeling) return [];
  const groups = new Map<string, ModelGroup>();
  for (const entity of Object.values(modeling.entities)) {
    if (entity.status === 'deprecated') continue;
    const relation = relationOf(entity);
    if (!relation) continue;
    const area = entity.areaId ? modeling.areas[entity.areaId] : undefined;
    // The default area a new model lands in (`core`) is no subject area of its own.
    const inArea = area && area.localId !== 'core';
    const domain = entity.domain ?? '';
    const key = inArea ? `area:${area.qualifiedId}` : `domain:${domain}`;
    const pkg = (modeling.packages?.[domain] as { name?: string } | undefined)?.name;
    const group = groups.get(key) ?? {
      key,
      name: inArea ? area.name : pkg ?? domain.replace(/[_-]+/g, ' '),
      shared: inArea ? area.shared === true : domain === 'shared',
      words: new Set([
        ...routingWords(inArea ? `${area.name} ${area.description ?? ''} ${area.intentExamples.join(' ')}` : ''),
        ...routingWords(`${domain} ${pkg ?? ''}`),
      ]),
      relations: [],
      lookAlikes: [],
    };
    if (entity.useInstead) {
      if (!group.lookAlikes.includes(relation)) group.lookAlikes.push(relation);
      groups.set(key, group);
      continue;
    }
    for (const word of routingWords(`${entity.localId ?? entity.id} ${entity.businessName ?? ''} ${tableName(relation)} ${columnsOf(relation).join(' ')}`)) group.words.add(word);
    if (!group.relations.includes(relation)) group.relations.push(relation);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.relations.length > 0);
}

/**
 * The groups a question belongs to and the tables to show, within `budget`
 * tables. Empty when nothing matches: the drafter then chooses tables by
 * search, as for a model too large to show.
 */
export function routeQuestionToAreas(input: {
  groups: ModelGroup[];
  question: string;
  /** Tables search already chose for the question. */
  anchors: string[];
  /** The model's joins, as pairs of tables. */
  joins: Array<[string, string]>;
  budget: number;
  /** Compares two spellings of one table. */
  same?: (a: string, b: string) => boolean;
}): ModelRoute {
  const same = input.same ?? ((a: string, b: string) => sameTable(a, b, 'object'));
  // One area or Domain is nothing to choose between: search chooses its tables, as before.
  if (input.groups.filter((group) => !group.shared).length < 2) return { groups: [], relations: [], shared: [] };
  const asked = new Set(routingWords(input.question));
  const anchorsIn = (group: ModelGroup) => [...group.relations, ...(group.lookAlikes ?? [])].filter((relation) => input.anchors.some((anchor) => same(anchor, relation))).length;
  // A Shared group answers a question only when nothing else does: it is
  // read by the areas, not chosen over them. Among the rest, the higher score
  // wins, and the smaller group on a tie.
  const ranked = input.groups.map((group) => ({ group, score: 3 * anchorsIn(group) + [...asked].filter((word) => group.words.has(word)).length }))
    .filter((item) => item.score > 0)
    .sort((a, b) => Number(a.group.shared) - Number(b.group.shared) || b.score - a.score || a.group.relations.length - b.group.relations.length);
  if (ranked.length === 0) return { groups: [], relations: [], shared: [] };
  const best = ranked[0]!;
  const chosen: ModelGroup[] = [best.group];
  for (const item of ranked.slice(1)) {
    if (item.group.shared || item.score * 2 < best.score) continue;
    if (chosen.reduce((total, group) => total + group.relations.length, 0) + item.group.relations.length > input.budget) continue;
    chosen.push(item.group);
  }
  const anchored = (relation: string) => input.anchors.some((anchor) => same(anchor, relation));
  const joinedTo = (relation: string, set: string[]) => input.joins.some(([a, b]) => (same(a, relation) && set.some((item) => same(item, b))) || (same(b, relation) && set.some((item) => same(item, a))));
  // One group over the budget: the tables search found first, then the ones they join, then the rest.
  let relations = chosen.flatMap((group) => group.relations).filter((relation, index, all) => all.findIndex((other) => same(other, relation)) === index);
  if (relations.length > input.budget) {
    const anchors = relations.filter(anchored);
    relations = [...anchors, ...relations.filter((relation) => !anchored(relation) && joinedTo(relation, anchors)), ...relations.filter((relation) => !anchored(relation) && !joinedTo(relation, anchors))].slice(0, input.budget);
  }
  const shared: string[] = [];
  if (!best.group.shared) {
    for (const group of input.groups.filter((item) => item.shared)) {
      for (const relation of group.relations) {
        if (relations.length + shared.length >= input.budget) break;
        if (relations.some((item) => same(item, relation)) || shared.some((item) => same(item, relation))) continue;
        if (anchored(relation) || joinedTo(relation, relations)) shared.push(relation);
      }
    }
  }
  return { groups: chosen, relations: [...relations, ...shared], shared };
}
