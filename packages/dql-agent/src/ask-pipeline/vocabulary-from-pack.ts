import type { EligibleContextSet, EligibleObjectRef, LocalContextPack, LocalContextSkill, MetadataObject } from '../metadata/catalog.js';
import { buildVocabularyIndex, type VocabularyDomainHeader, type VocabularySource } from './vocabulary.js';
import { tableTail } from '@zlens/core';

/**
 * THE VOCABULARY IS A VIEW OVER THE CONTEXT PACK.
 *
 * The pack is the one request-bound projection every surface reads: it
 * resolves the domain envelope, admits the complete eligible set of governed
 * objects, selects the skills for this question and the approved corrections
 * in scope, and builds the domain briefing. The host still owns the physical
 * bindings (which live in the semantic layer and the manifest, not in the
 * catalog rows), so this module does two things and nothing else:
 *
 *  1. it PROJECTS a host-built source onto the pack's eligible set — an object
 *     outside the envelope is not in the vocabulary, and a kind the catalog does
 *     not index is left untouched rather than emptied;
 *  2. it ADDS the authored context the manifest-derived source never carried:
 *     the selected skills (and only those), the approved hints, the declared
 *     relationships with their authority to join, and the domain header.
 */

export type { EligibleContextSet, EligibleObjectRef } from '../metadata/catalog.js';

/** Which catalog object types each vocabulary kind is projected from. */
const KIND_OBJECT_TYPES: Record<'metric' | 'measure' | 'dimension' | 'entity' | 'model' | 'block' | 'relation' | 'term', string[]> = {
  metric: ['semantic_metric'],
  measure: ['semantic_measure'],
  dimension: ['semantic_dimension'],
  entity: ['semantic_entity'],
  model: ['semantic_model'],
  block: ['dql_block'],
  relation: ['dbt_model', 'dbt_source', 'warehouse_table'],
  term: ['dql_term'],
};

const lower = (value: string | undefined): string => (value ?? '').toLowerCase();
const leaf = (value: string): string => value.split('.').pop() ?? value;

/** Names an eligible object answers to, lower-cased: its name, its leaf, and its payload relation. */
function objectNames(object: EligibleObjectRef): string[] {
  const names = new Set<string>([lower(object.name), lower(leaf(object.name))]);
  const relation = object.payload?.relation;
  if (typeof relation === 'string' && relation) {
    const normalized = relation.replace(/"/g, '').split('.').filter(Boolean);
    names.add(lower(normalized.slice(-2).join('.')));
    names.add(lower(normalized[normalized.length - 1] ?? ''));
  }
  return [...names].filter(Boolean);
}

export interface ProjectedVocabularySource {
  source: VocabularySource;
  /** How the projection changed the source, for the receipt. */
  admitted: Record<string, number>;
  /** Objects a DOMAIN scope excluded (pinned domain, sibling objects). */
  dropped: Record<string, number>;
  /** Objects the host binds that the catalog never indexed; kept when nothing is scoped, counted so the gap is visible. */
  unindexed: Record<string, number>;
}

/**
 * Project a host-built source onto the pack. When the pack carries no eligible
 * set (a ranked pack), the source is kept whole and only the authored context
 * is added.
 */
export interface ProjectionScope {
  /** The pinned domain, its ancestors and descendants: relations owned here are admitted whole. */
  own: string[];
  /** Import providers and, per provider, the relations its exports to this envelope carry; nothing else of that provider is physical context here. */
  imports: Array<{ providerDomain: string; relations: string[] }>;
}

export function projectVocabularySource(base: VocabularySource, pack: Pick<LocalContextPack, 'objects' | 'skills' | 'appliedHints' | 'domainBriefing'> & { eligible?: EligibleContextSet }, scope?: ProjectionScope): ProjectedVocabularySource {
  const eligible = pack.eligible;
  const admitted: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  const unindexed: Record<string, number> = {};
  // With no domain pinned every object is eligible, so an entry the catalog
  // failed to index is a catalog gap, not a scope decision: it stays in the
  // vocabulary (cutting it would make a modeled object "not modeled") and is
  // counted for the ledger. Under a pinned domain the catalog's eligible set
  // is the authority and the entry is dropped.
  const scoped = (eligible?.domains.length ?? 0) > 0;
  const byType = new Map<string, EligibleObjectRef[]>();
  for (const object of eligible?.objects ?? []) {
    const list = byType.get(object.objectType) ?? [];
    list.push(object);
    byType.set(object.objectType, list);
  }
  const namesFor = (types: string[]): Set<string> | undefined => {
    const objects = types.flatMap((type) => byType.get(type) ?? []);
    if (objects.length === 0) return undefined; // the catalog indexes nothing of this kind: nothing to judge by
    return new Set(objects.flatMap(objectNames));
  };
  const keep = <T>(kind: keyof typeof KIND_OBJECT_TYPES, items: T[] | undefined, nameOf: (item: T) => string[]): T[] | undefined => {
    if (!items) return items;
    if (!eligible) { admitted[kind] = items.length; return items; }
    const names = namesFor(KIND_OBJECT_TYPES[kind]);
    if (!names) { admitted[kind] = items.length; return items; }
    const kept = items.filter((item) => nameOf(item).some((name) => names.has(lower(name))));
    if (kept.length < items.length) {
      if (!scoped) { unindexed[kind] = items.length - kept.length; admitted[kind] = items.length; return items; }
      dropped[kind] = items.length - kept.length;
    }
    admitted[kind] = kept.length;
    return kept;
  };
  const qualified = (model: string | undefined, name: string): string[] => [model ? `${model}.${name}` : name, name];
  const source: VocabularySource = {
    ...base,
    metrics: keep('metric', base.metrics, (metric) => qualified(metric.model, metric.name)),
    measures: keep('measure', base.measures, (measure) => qualified(measure.model, measure.name)),
    dimensions: keep('dimension', base.dimensions, (dimension) => qualified(dimension.model, dimension.name)),
    entities: keep('entity', base.entities, (entity) => qualified(entity.model, entity.name)),
    models: keep('model', base.models, (model) => [model.name]),
    blocks: keep('block', base.blocks, (block) => [block.name]),
    relations: keep('relation', ownedRelations(base.relations, scope, dropped), (relation) => [relation.schema ? `${relation.schema}.${relation.name}` : relation.name, relation.name]),
    terms: keep('term', base.terms, (term) => [term.name]),
  };

  // COLUMNS THE RETRIEVAL RANKED. A question about "lost opportunities" and
  // "amount" ranks the column objects that carry those words; they must reach
  // the vocabulary with their descriptions and types, or a wide table shows
  // the model its first forty column names and nothing it asked about. Each
  // ranked column merges into its relation (an eligible relation only; a
  // column of a relation outside the scope is not admitted through the back).
  const relationByKey = new Map((source.relations ?? []).map((relation) => [lower(relation.schema ? `${relation.schema}.${relation.name}` : relation.name), relation]));
  let mergedColumns = 0;
  for (const object of pack.objects) {
    if (object.objectType !== 'dbt_column' && object.objectType !== 'warehouse_column' && object.objectType !== 'runtime_column') continue;
    const payload = (object.payload ?? {}) as { relation?: string; model?: string; type?: string };
    const relationKey = tableTail(payload.relation ?? '') || (payload.model ? lower(payload.model) : undefined);
    const relation = relationKey ? relationByKey.get(lower(relationKey)) ?? [...relationByKey.entries()].find(([key]) => key.endsWith(`.${lower(relationKey)}`))?.[1] : undefined;
    if (!relation) continue;
    const column = relation.columns.find((item) => lower(item.name) === lower(object.name));
    if (column) {
      if (!column.dataType && payload.type) column.dataType = payload.type;
      if (!column.description && object.description) column.description = object.description;
    } else {
      relation.columns.push({ name: object.name, ...(payload.type ? { dataType: payload.type } : {}), ...(object.description ? { description: object.description } : {}) });
      mergedColumns += 1;
    }
  }
  if (mergedColumns) admitted.column = (admitted.column ?? 0) + mergedColumns;

  // Declared relationships, with their authority to join. The pack's eligible
  // set carries their payload because they are few and authored.
  const relationshipObjects = byType.get('relationship') ?? (eligible ? [] : pack.objects.filter((object) => object.objectType === 'relationship'));
  source.relationships = relationshipObjects.flatMap((object) => {
    const payload = (object.payload ?? {}) as { from?: string; to?: string; keys?: Array<{ from: string; to: string }>; cardinality?: string; fanout?: string; automaticJoinAllowed?: boolean; verb?: string; crossDomain?: boolean; localId?: string };
    if (!payload.from || !payload.to) return [];
    const status = lower(object.status) || 'draft';
    const joinAuthority: 'certified' | 'draft' | 'unproven' = payload.automaticJoinAllowed ? 'certified' : status === 'draft' ? 'draft' : 'unproven';
    const id = payload.localId ?? leaf(object.name);
    return [{
      id, ...(object.domain ? { domain: object.domain } : {}), from: payload.from, to: payload.to, keys: payload.keys ?? [],
      ...(payload.cardinality ? { cardinality: payload.cardinality } : {}), ...(payload.fanout ? { fanout: payload.fanout } : {}), ...(payload.verb ? { verb: payload.verb } : {}),
      ...(object.description ? { description: object.description } : {}), status, ...(payload.crossDomain ? { crossDomain: true } : {}), joinAuthority,
    }];
  });
  admitted.relationship = source.relationships.length;

  // Two domains may define the same word; under no pin both are eligible, so
  // the second carries its domain in its name rather than shadowing the first.
  if (source.terms?.length) {
    const seen = new Map<string, number>();
    source.terms = source.terms.map((term) => {
      const key = lower(term.name);
      const count = seen.get(key) ?? 0;
      seen.set(key, count + 1);
      return count > 0 && term.domain ? { ...term, name: `${term.name} (${term.domain})` } : term;
    });
  }

  // Business concepts: one thing under several keys. A binding names a
  // modeled entity; the card offers the entity's relation so a clarification
  // can be answered with a ref the vocabulary resolves.
  const relationOfEntity = new Map<string, string>();
  for (const object of [...pack.objects, ...(eligible?.objects ?? [])]) {
    if (object.objectType !== 'dql_entity') continue;
    const payload = (object.payload ?? {}) as { qualifiedId?: string; relation?: string };
    const relation = tableTail(payload.relation ?? '') || undefined;
    const qualifiedId = payload.qualifiedId ?? object.objectKey.replace(/^[^:]+:[^:]+:/, '');
    if (relation && qualifiedId && !relationOfEntity.has(qualifiedId)) relationOfEntity.set(qualifiedId, relation);
  }
  source.concepts = [...pack.objects, ...(eligible?.objects ?? [])].filter((object) => object.objectType === 'concept').flatMap((object) => {
    const payload = (object.payload ?? {}) as { localId?: string; name?: string; description?: string; synonyms?: string[]; status?: string; bindings?: Array<{ entity: string; domain: string; role?: string; grain?: string }> };
    const id = payload.localId ?? leaf(object.name);
    return [{
      id, ...(object.domain ? { domain: object.domain } : {}), name: payload.name ?? object.name,
      ...(payload.description ?? object.description ? { description: payload.description ?? object.description } : {}),
      ...(payload.synonyms?.length ? { synonyms: payload.synonyms } : {}),
      ...(object.status ? { status: object.status } : {}),
      bindings: (payload.bindings ?? []).map((binding) => {
        const relation = relationOfEntity.get(binding.entity);
        return { entityRef: relation ? `relation:${relation}` : `entity:${binding.entity}`, domain: binding.domain, ...(binding.role ? { role: binding.role } : {}), ...(binding.grain ? { grain: binding.grain } : {}) };
      }),
    }];
  });
  // The same concept can be in the ranked objects and the eligible set: once.
  source.concepts = source.concepts.filter((concept, index, all) => all.findIndex((other) => other.id === concept.id && other.domain === concept.domain) === index);
  admitted.concept = source.concepts.length;

  // The selected skills only. Their preferred names resolve against the
  // projected source, so a preference for something outside the envelope
  // names nothing.
  const probe = buildVocabularyIndex({ ...source, skills: [], hints: [], relationships: [] });
  const resolveRefs = (names: string[], kinds: Array<'metric' | 'measure' | 'block' | 'dimension' | 'entity' | 'column'>): string[] =>
    names.flatMap((name) => { const entry = probe.resolve(name, kinds); return entry ? [entry.ref] : []; });
  source.skills = (pack.skills ?? []).map((skill: LocalContextSkill) => ({
    ref: `skill:${skill.qualifiedId ?? skill.id}`,
    id: skill.id,
    ...(skill.domain ? { domain: skill.domain } : {}),
    ...(skill.kind ? { kind: skill.kind } : {}),
    ...(skill.description ? { description: skill.description } : {}),
    triggers: skill.triggers,
    vocabulary: Object.fromEntries(Object.entries(skill.vocabulary ?? {}).flatMap(([word, ref]) => {
      const entry = probe.resolve(ref) ?? probe.resolve(ref.replace(/^term:/i, ''), ['term']);
      return entry ? [[word, entry.ref]] : [];
    })),
    preferredRefs: [
      ...resolveRefs(skill.preferredMetrics, ['metric', 'measure']),
      ...resolveRefs(skill.preferredBlocks, ['block']),
      ...resolveRefs(skill.preferredDimensions, ['dimension', 'entity', 'column']),
    ],
    requiredFilters: skill.requiredFilters,
    clarifyWhen: skill.clarifyWhen,
    ...(skill.analyticalPolicy ? { policy: skill.analyticalPolicy as unknown as Record<string, unknown> } : {}),
    ...(skill.guidance ? { guidance: skill.guidance } : {}),
  }));
  admitted.skill = source.skills.length;

  source.hints = (pack.appliedHints ?? []).map((hint) => ({ id: hint.hintId, title: hint.title, guidance: hint.guidance }));
  admitted.hint = source.hints.length;

  if (pack.domainBriefing) {
    const briefing = pack.domainBriefing;
    const header: VocabularyDomainHeader = {
      id: briefing.domainId,
      name: briefing.name,
      ...(briefing.description ? { description: briefing.description } : {}),
      ...(briefing.purpose ? { purpose: briefing.purpose } : {}),
      intentExamples: briefing.intentExamples,
      caveats: briefing.caveats,
      requiredFilters: briefing.requiredFilters,
    };
    source.domain = header;
  }
  return { source, admitted, dropped, unindexed };
}

/** The refs of the pack's ranked objects, in rank order, for the renderer. */
export function rankedRefsFromPack(objects: MetadataObject[]): string[] {
  const refs: string[] = [];
  for (const object of objects) {
    const name = object.name;
    switch (object.objectType) {
      case 'semantic_metric': refs.push(`metric:${name}`); break;
      case 'semantic_measure': refs.push(`measure:${name}`); break;
      case 'semantic_dimension': refs.push(`dimension:${name}`); break;
      case 'semantic_entity': refs.push(`entity:${name}`); break;
      case 'semantic_model': refs.push(`model:${name}`); break;
      case 'dql_block': refs.push(`block:${object.domain ?? 'global'}.${name}`); break;
      case 'dql_term': refs.push(`term:${name}`); break;
      case 'dbt_model': case 'dbt_source': case 'warehouse_table': {
        const relation = typeof object.payload?.relation === 'string' ? object.payload.relation.replace(/"/g, '').split('.').slice(-2).join('.') : name;
        refs.push(`relation:${relation}`);
        break;
      }
      case 'dbt_column': case 'warehouse_column': case 'runtime_column': {
        const payload = (object.payload ?? {}) as { relation?: string; model?: string };
        const relation = tableTail(payload.relation ?? '') || payload.model;
        if (relation) refs.push(`column:${relation}.${name}`);
        break;
      }
      default: break;
    }
  }
  return refs;
}

/**
 * PHYSICAL OWNERSHIP FOLLOWS THE ENTITY BINDING (A-003). A dbt model carries no
 * domain of its own, so under a pinned domain the eligible set would admit
 * every relation in the warehouse; the entity that binds a relation says who
 * owns it. Owned by this envelope → admitted; owned by an import provider →
 * admitted only if an export to this envelope carries it; owned elsewhere →
 * not physical context here (and counted). A relation nobody binds stays.
 */
function ownedRelations<T extends { schema?: string; name: string; domain?: string; domains?: string[] }>(relations: T[] | undefined, scope: ProjectionScope | undefined, dropped: Record<string, number>): T[] | undefined {
  if (!relations || !scope || scope.own.length === 0) return relations;
  const own = new Set(scope.own.map(lower));
  // One provider may export several interfaces to this envelope: their relations add up.
  const imported = new Map<string, Set<string>>();
  for (const item of scope.imports) {
    const set = imported.get(lower(item.providerDomain)) ?? new Set<string>();
    for (const relation of item.relations) set.add(lower(relation));
    imported.set(lower(item.providerDomain), set);
  }
  const kept = relations.filter((relation) => {
    // Ownership is a set: a relation two domains bind is physical context of
    // both, whichever entity was compiled first.
    const owners = (relation.domains?.length ? relation.domains : relation.domain ? [relation.domain] : []).map(lower);
    if (owners.length === 0) return true;
    if (owners.some((owner) => own.has(owner))) return true;
    const key = lower(relation.schema ? `${relation.schema}.${relation.name}` : relation.name);
    return owners.some((owner) => { const exported = imported.get(owner); return Boolean(exported && (exported.has(key) || exported.has(lower(relation.name)))); });
  });
  if (kept.length < relations.length) dropped.relation = (dropped.relation ?? 0) + (relations.length - kept.length);
  return kept;
}
