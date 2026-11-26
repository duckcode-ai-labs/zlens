/**
 * The draft budget on the warehouse path (onboarding design, "Reuse": the
 * 150-table draft budget of `draft-scope.ts`, extended from the dbt path).
 *
 * The background checks read every table chosen, but the drafts a person
 * reviews hold at most the budget's tables: past it, building the review
 * (one change per model, join and rule) would keep ZLens busy for minutes
 * and the review itself would be too long to read. Over the budget, the most
 * important tables are drafted and the rest are listed, never dropped
 * silently: final tables before staging and raw ones, then the tables most
 * joins touch, then those with a key shown on the data. Ask reads every table
 * the setup read either way.
 *
 * With `checkedJoinsOnly`, a join the checks never got to (over their per-run
 * limit) is left out of the drafts too: the review offers joins the data was
 * asked about, and the Setup page counts the others.
 */
import { DEFAULT_DRAFT_BUDGET } from './draft-scope.js';
import type { WarehouseDiscoveryReport } from './warehouse-model-discovery.js';

const LAYER_ORDER: Record<string, number> = { final: 0, intermediate: 1, snapshot: 2, staging: 3, raw: 4 };

export function budgetWarehouseDraft(report: WarehouseDiscoveryReport, budget = DEFAULT_DRAFT_BUDGET, options: { checkedJoinsOnly?: boolean } = {}): WarehouseDiscoveryReport {
  const unchecked = (relationship: WarehouseDiscoveryReport['relationships'][number]) => /^not validated: discovery validates at most/.test(relationship.validationError ?? '');
  if (report.entities.length <= budget) {
    if (!options.checkedJoinsOnly || !report.relationships.some(unchecked)) return report;
    return { ...report, relationships: report.relationships.filter((relationship) => !unchecked(relationship)), uncheckedJoins: report.relationships.filter(unchecked).length };
  }
  const key = (domain: string, id: string) => `${domain}::${id}`;
  const degree = new Map<string, number>();
  for (const relationship of report.relationships) {
    for (const end of [key(relationship.fromDomain ?? relationship.domain, relationship.from), key(relationship.toDomain ?? relationship.domain, relationship.to)]) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
    }
  }
  const ranked = report.entities
    .map((entity, index) => ({ entity, index }))
    .sort((a, b) => (LAYER_ORDER[a.entity.layer ?? 'final'] ?? 0) - (LAYER_ORDER[b.entity.layer ?? 'final'] ?? 0)
      || (degree.get(key(b.entity.domain, b.entity.id)) ?? 0) - (degree.get(key(a.entity.domain, a.entity.id)) ?? 0)
      || Number(Boolean(b.entity.grain)) - Number(Boolean(a.entity.grain))
      || a.entity.relation.localeCompare(b.entity.relation));
  const keptKeys = new Set(ranked.slice(0, budget).map(({ entity }) => key(entity.domain, entity.id)));
  const kept = (domain: string, id: string) => keptKeys.has(id.includes('::') ? id : key(domain, id));
  const leftOut = ranked.slice(budget).map(({ entity }) => ({ uniqueId: entity.relationId, relation: entity.relation, layer: entity.layer ?? 'final' }));
  const among = report.relationships.filter((relationship) => kept(relationship.fromDomain ?? relationship.domain, relationship.from) && kept(relationship.toDomain ?? relationship.domain, relationship.to));
  return {
    ...report,
    entities: report.entities.filter((entity) => kept(entity.domain, entity.id)),
    relationships: options.checkedJoinsOnly ? among.filter((relationship) => !unchecked(relationship)) : among,
    ...(options.checkedJoinsOnly ? { uncheckedJoins: report.relationships.filter(unchecked).length } : {}),
    ...(report.withheld ? { withheld: report.withheld.filter((relationship) => kept(relationship.fromDomain ?? relationship.domain, relationship.from) && kept(relationship.toDomain ?? relationship.domain, relationship.to)) } : {}),
    ...(report.rules ? { rules: report.rules.filter((rule) => rule.entities.every((id) => kept(rule.domain, id))) } : {}),
    ...(report.concepts ? { concepts: report.concepts.filter((concept) => concept.bindings.every((binding) => kept(concept.domain, binding.entity))) } : {}),
    scope: {
      description: 'the tables setup read',
      asked: report.entities.length,
      drafted: budget,
      budget,
      leftOut,
      areas: [],
    },
  };
}
