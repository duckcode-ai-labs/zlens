import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadDomainPackageRegistry, type DomainPackageRecord } from './domain-package-registry.js';

type UnknownRecord = Record<string, unknown>;

export type DomainDiscoveryEvidenceKind =
  | 'explicit_meta'
  | 'dbt_group'
  | 'metricflow_semantic_domain'
  | 'exposure_owner_scope'
  | 'dbt_tag'
  | 'configured_selector'
  | 'model_path'
  | 'lineage'
  | 'dbt_project';

export interface DomainDiscoveryEvidence {
  kind: DomainDiscoveryEvidenceKind;
  domain: string;
  /** The subject area inside the domain, when the evidence names one (`common_mart_sales` in a project with `sales_and_marketing`). */
  area?: string;
  value: string;
  rank: number;
  confidence: number;
  sourceUniqueId: string;
  sourcePath?: string;
  owner?: string;
  selector?: string;
}

export interface DomainMembershipProposal {
  dbtUniqueId: string;
  modelName: string;
  sourcePath?: string;
  proposedDomain: string | null;
  /** The subject area inside the proposed domain, when the winning evidence names one. */
  proposedArea?: string;
  /** The source system a staging or raw model belongs to (`zuora`, `sfdc`): never a domain (design S-D12). */
  sourceSystem?: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  owner?: string;
  evidence: DomainDiscoveryEvidence[];
  conflicts: string[];
  requiresReview: boolean;
}

export interface DomainProposal {
  id: string;
  name: string;
  owner?: string;
  proposedParent?: string;
  matchedDbtUniqueIds: string[];
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  evidence: DomainDiscoveryEvidence[];
  requiresReview: boolean;
}

export interface UnassignedDbtModel {
  dbtUniqueId: string;
  modelName: string;
  sourcePath?: string;
  reason: 'no_evidence' | 'ambiguous_membership';
  candidateDomains: string[];
  evidence: DomainDiscoveryEvidence[];
  /** A staging or raw model of this source system: it belongs on the Sources shelf, not in a domain. */
  sourceSystem?: string;
}

export interface RelationshipDraftCandidate {
  id: string;
  lifecycle: 'draft';
  requiresReview: true;
  automaticJoinAllowed: false;
  fromDbtUniqueId: string;
  toDbtUniqueId: string;
  fromDomain: string;
  toDomain: string;
  keys: Array<{ from: string; to: string }>;
  evidence: Array<{ dbtUniqueId: string; sourcePath?: string; kind: 'dbt_relationship_test' }>;
}

export interface SkillDraftCandidate {
  id: string;
  domain: string;
  lifecycle: 'draft';
  requiresReview: true;
  certificationAllowed: false;
  suggestedScope: string;
  evidenceDbtUniqueIds: string[];
}

export interface DomainDiscoveryReport {
  version: 1;
  sourceFingerprint: string;
  generator: 'deterministic';
  proposals: DomainProposal[];
  memberships: DomainMembershipProposal[];
  unassignedModels: UnassignedDbtModel[];
  /** Subject areas inside the proposed domains (design S1), for a person to review before any is written. */
  areaProposals?: AreaProposal[];
  relationshipDraftCandidates: RelationshipDraftCandidate[];
  skillDraftCandidates: SkillDraftCandidate[];
}

export interface AreaProposal {
  /** `<domain>.<area>`. */
  id: string;
  domain: string;
  area: string;
  name: string;
  matchedDbtUniqueIds: string[];
}

export interface DiscoverDbtDomainsOptions {
  projectRoot: string;
  dbtManifestPath: string;
  semanticManifestPath?: string;
}

interface ModelRecord {
  uniqueId: string;
  name: string;
  sourcePath?: string;
  packageName?: string;
  raw: UnknownRecord;
}

interface EvidenceIndex {
  semantic: Map<string, DomainDiscoveryEvidence[]>;
  exposures: Map<string, DomainDiscoveryEvidence[]>;
  semanticDomains: Map<string, string[]>;
  semanticTags: Map<string, string[]>;
}

/**
 * AGT-002 / API-001 — evidence-bounded, deterministic dbt domain discovery.
 *
 * Resolve dbt model membership without writes or AI inference.
 *
 * Evidence is evaluated in the locked order below. If the strongest available
 * evidence names more than one domain, the model remains unassigned. Lower
 * ranked disagreement is retained as a review conflict but cannot silently
 * override stronger evidence.
 */
export function discoverDbtDomains(options: DiscoverDbtDomainsOptions): DomainDiscoveryReport {
  const rawSource = readFileSync(options.dbtManifestPath, 'utf8');
  const manifest = asRecord(JSON.parse(rawSource));
  const semanticPath = options.semanticManifestPath
    ?? siblingIfPresent(options.dbtManifestPath, 'semantic_manifest.json');
  const semanticSource = semanticPath ? readFileSync(semanticPath, 'utf8') : '';
  const semanticManifest = semanticSource ? asRecord(JSON.parse(semanticSource)) : {};
  const registry = loadDomainPackageRegistry(options.projectRoot);
  const packages = registry.values();
  const models = collectModels(manifest);
  const indexes = buildEvidenceIndexes(manifest, semanticManifest, models);
  const groupOwners = collectGroupOwners(manifest);
  const projectName = stringValue(asRecord(manifest.metadata).project_name) ?? models[0]?.packageName;
  const words: BusinessWords = { sourceSystems: collectSourceSystems(manifest), compounds: new Map(), rootPackage: projectName };
  words.compounds = compoundParts(models.flatMap((model) => inferredPhrases(model, words)));

  let memberships = models.map((model) => resolveMembership(
    model,
    packages,
    indexes,
    groupOwners,
    words,
  ));
  // Nothing names a business area (no meta, group, tag or business folder):
  // the project is one Domain, named after it (RFC 0012). Layer folders such
  // as `dim/` and `stg/` never become Domains.
  const projectDomain = projectName ? normalizeDomainId(projectName) : undefined;
  if (projectDomain && memberships.length > 0 && memberships.every((membership) => membership.evidence.length === 0)) {
    memberships = models.map((model) => resolveMembership(model, packages, indexes, groupOwners, words, [evidence('dbt_project', projectDomain, projectName!, 9, 0.4, model)]));
  } else {
    memberships = placeByLineage(models, memberships, words);
  }
  const assigned = new Map(memberships
    .filter((membership): membership is DomainMembershipProposal & { proposedDomain: string } => Boolean(membership.proposedDomain))
    .map((membership) => [membership.dbtUniqueId, membership]));

  const proposals = buildDomainProposals(memberships, packages);
  const unassignedModels = memberships
    .filter((membership) => !membership.proposedDomain)
    .map((membership): UnassignedDbtModel => ({
      dbtUniqueId: membership.dbtUniqueId,
      modelName: membership.modelName,
      sourcePath: membership.sourcePath,
      reason: membership.evidence.length === 0 ? 'no_evidence' : 'ambiguous_membership',
      candidateDomains: unique(membership.evidence.map((item) => item.domain)),
      evidence: membership.evidence,
      ...(membership.sourceSystem ? { sourceSystem: membership.sourceSystem } : {}),
    }));

  return {
    version: 1,
    sourceFingerprint: discoveryFingerprint(rawSource, semanticSource, packages),
    generator: 'deterministic',
    proposals,
    memberships,
    unassignedModels,
    areaProposals: buildAreaProposals(memberships),
    relationshipDraftCandidates: collectRelationshipDrafts(manifest, assigned),
    skillDraftCandidates: proposals.map((proposal) => ({
      id: `${proposal.id.replace(/\./g, '_')}_analyst`,
      domain: proposal.id,
      lifecycle: 'draft',
      requiresReview: true,
      certificationAllowed: false,
      suggestedScope: `Use reviewed ${proposal.name} vocabulary, policies, and certified assets only.`,
      evidenceDbtUniqueIds: proposal.matchedDbtUniqueIds,
    })),
  };
}

function discoveryFingerprint(
  manifestSource: string,
  semanticSource: string,
  packages: DomainPackageRecord[],
): string {
  const selectors = packages.map((pkg) => ({
    id: pkg.id,
    parent: pkg.parent,
    owner: pkg.owner,
    dbtGroups: pkg.domain.dbtGroups ?? [],
    dbtPaths: pkg.domain.dbtPaths ?? [],
    dbtTags: pkg.domain.dbtTags ?? [],
    semanticDomains: pkg.domain.semanticDomains ?? [],
    semanticTags: pkg.domain.semanticTags ?? [],
  }));
  return createHash('sha256')
    .update(manifestSource)
    .update('\0')
    .update(semanticSource)
    .update('\0')
    .update(JSON.stringify(selectors))
    .digest('hex');
}

function resolveMembership(
  model: ModelRecord,
  packages: DomainPackageRecord[],
  indexes: EvidenceIndex,
  groupOwners: Map<string, string>,
  words: BusinessWords,
  extra: DomainDiscoveryEvidence[] = [],
): DomainMembershipProposal {
  const evidence = [...collectModelEvidence(model, packages, indexes, groupOwners, words), ...extra];
  return membershipFrom(model, evidence, sourceSystemOf(model, words));
}

function membershipFrom(model: ModelRecord, evidence: DomainDiscoveryEvidence[], sourceSystem?: string): DomainMembershipProposal {
  const strongestRank = evidence[0]?.rank;
  const strongest = strongestRank === undefined
    ? []
    : evidence.filter((item) => item.rank === strongestRank);
  const strongestDomains = unique(strongest.map((item) => item.domain));
  const proposedDomain = strongestDomains.length === 1 ? strongestDomains[0] : null;
  const winningEvidence = proposedDomain
    ? strongest.filter((item) => item.domain === proposedDomain)
    : [];
  const confidenceScore = winningEvidence.length > 0
    ? Math.max(...winningEvidence.map((item) => item.confidence))
    : 0;
  const conflicts = proposedDomain
    ? unique(evidence.filter((item) => item.domain !== proposedDomain).map((item) => item.domain))
    : strongestDomains;
  const owners = unique(winningEvidence.map((item) => item.owner).filter(isString));
  const areas = unique(winningEvidence.map((item) => item.area).filter(isString));

  return {
    dbtUniqueId: model.uniqueId,
    modelName: model.name,
    sourcePath: model.sourcePath,
    proposedDomain,
    ...(areas.length === 1 ? { proposedArea: areas[0] } : {}),
    ...(!proposedDomain && sourceSystem ? { sourceSystem } : {}),
    confidence: confidenceLabel(confidenceScore),
    confidenceScore,
    owner: owners.length === 1 ? owners[0] : undefined,
    evidence,
    conflicts,
    requiresReview: !proposedDomain || conflicts.length > 0,
  };
}

function collectModelEvidence(
  model: ModelRecord,
  packages: DomainPackageRecord[],
  indexes: EvidenceIndex,
  groupOwners: Map<string, string>,
  words: BusinessWords,
): DomainDiscoveryEvidence[] {
  const output: DomainDiscoveryEvidence[] = [];
  const raw = model.raw;
  const dqlMeta = asRecord(asRecord(raw.meta).dql);
  const explicitDomains = domainValues(dqlMeta.domain);
  for (const domain of explicitDomains) {
    output.push(evidence('explicit_meta', domain, String(dqlMeta.domain), 1, 1, model));
  }

  const group = stringValue(raw.group) ?? stringValue(asRecord(raw.config).group);
  if (group) {
    const domain = normalizeDomainId(group);
    if (domain) output.push(evidence('dbt_group', domain, group, 2, 0.95, model, groupOwners.get(group)));
  }

  output.push(...(indexes.semantic.get(model.uniqueId) ?? []));
  output.push(...(indexes.exposures.get(model.uniqueId) ?? []));

  const tags = unique([
    ...stringArray(raw.tags),
    ...stringArray(asRecord(raw.config).tags),
  ]);
  // A model of a dbt package, or a staging model of a source system, takes no
  // domain from its tags or folders: those name the package or the source.
  const inferable = inferableModel(model, words);
  for (const tag of tags) {
    const found = domainFromTag(tag, packages, words, inferable);
    if (found) output.push({ ...evidence('dbt_tag', found.domain, tag, 5, 0.72, model), ...(found.area ? { area: found.area } : {}) });
  }

  for (const pkg of packages) {
    for (const match of matchingSelectors(model, raw, tags, pkg, indexes)) {
      output.push(evidence('configured_selector', pkg.id, match.value, 6, 0.68, model, pkg.owner, match.selector));
    }
  }

  const pathDomain = inferable ? domainFromPath(model, words) : undefined;
  if (pathDomain) output.push({ ...evidence('model_path', pathDomain.domain, model.sourcePath ?? '', 7, 0.55, model), ...(pathDomain.area ? { area: pathDomain.area } : {}) });

  return dedupeEvidence(output).sort(compareEvidence);
}

/**
 * Place a model nothing else places by the models around it (design S2): one
 * that models in three or more domains read is shared; otherwise it takes the
 * domain two thirds of the models it reads share, or failing that, of the
 * models that read it. A model of a source system stays on the Sources shelf.
 * Runs a few rounds, so a chain of unplaced models fills in from either end.
 */
function placeByLineage(models: ModelRecord[], memberships: DomainMembershipProposal[], words: BusinessWords): DomainMembershipProposal[] {
  const byId = new Map(memberships.map((membership) => [membership.dbtUniqueId, membership]));
  const modelIds = new Set(models.map((model) => model.uniqueId));
  const parents = new Map(models.map((model) => [model.uniqueId, stringArray(asRecord(model.raw.depends_on).nodes).filter((id) => modelIds.has(id) && id !== model.uniqueId)]));
  const children = new Map<string, string[]>();
  for (const [child, ids] of parents) for (const parent of ids) children.set(parent, [...(children.get(parent) ?? []), child]);
  const top = (id: string): string | undefined => byId.get(id)?.proposedDomain?.split('.')[0];
  const modelById = new Map(models.map((model) => [model.uniqueId, model]));

  for (let round = 0; round < 3; round += 1) {
    let changed = false;
    for (const membership of [...byId.values()]) {
      if (membership.proposedDomain || membership.evidence.length > 0 || membership.sourceSystem) continue;
      const model = modelById.get(membership.dbtUniqueId)!;
      if (!inferableModel(model, words)) continue;
      const readers = unique((children.get(model.uniqueId) ?? []).map(top).filter(isString).filter((domain) => domain !== SHARED_DOMAIN));
      let found: { domain: string; area?: string; value: string } | undefined;
      if (readers.length >= 3) {
        found = { domain: SHARED_DOMAIN, value: `read by models in ${readers.length} domains: ${readers.join(', ')}` };
      } else {
        found = lineageMajority(parents.get(model.uniqueId) ?? [], byId, 'reads')
          ?? lineageMajority(children.get(model.uniqueId) ?? [], byId, 'is read by');
      }
      if (!found) continue;
      const item = { ...evidence('lineage', found.domain, found.value, 8, 0.45, model), ...(found.area ? { area: found.area } : {}) };
      // A placement read from the neighbours is a guess a person confirms.
      byId.set(model.uniqueId, { ...membershipFrom(model, [item]), requiresReview: true });
      changed = true;
    }
    if (!changed) break;
  }
  return memberships.map((membership) => byId.get(membership.dbtUniqueId)!);
}

function lineageMajority(
  ids: string[],
  byId: Map<string, DomainMembershipProposal>,
  verb: string,
): { domain: string; area?: string; value: string } | undefined {
  const placed = ids.map((id) => byId.get(id)).filter((item): item is DomainMembershipProposal & { proposedDomain: string } => Boolean(item?.proposedDomain));
  if (placed.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const item of placed) counts.set(item.proposedDomain, (counts.get(item.proposedDomain) ?? 0) + 1);
  const [domain, count] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  if (count * 3 < placed.length * 2) return undefined;
  const areas = unique(placed.filter((item) => item.proposedDomain === domain).map((item) => item.proposedArea).filter(isString));
  return { domain, ...(areas.length === 1 ? { area: areas[0] } : {}), value: `${verb} ${count} of ${placed.length} placed models in ${domain}` };
}

function buildAreaProposals(memberships: DomainMembershipProposal[]): AreaProposal[] {
  const byArea = new Map<string, AreaProposal>();
  for (const membership of memberships) {
    if (!membership.proposedDomain || !membership.proposedArea) continue;
    const id = `${membership.proposedDomain}.${membership.proposedArea}`;
    const current = byArea.get(id) ?? { id, domain: membership.proposedDomain, area: membership.proposedArea, name: displayName(membership.proposedArea), matchedDbtUniqueIds: [] };
    current.matchedDbtUniqueIds.push(membership.dbtUniqueId);
    byArea.set(id, current);
  }
  return [...byArea.values()].map((area) => ({ ...area, matchedDbtUniqueIds: area.matchedDbtUniqueIds.sort() })).sort((a, b) => a.id.localeCompare(b.id));
}

function buildEvidenceIndexes(
  manifest: UnknownRecord,
  semanticManifest: UnknownRecord,
  models: ModelRecord[],
): EvidenceIndex {
  const modelIds = new Set(models.map((model) => model.uniqueId));
  const semantic = new Map<string, DomainDiscoveryEvidence[]>();
  const semanticDomains = new Map<string, string[]>();
  const semanticTags = new Map<string, string[]>();
  const semanticModelDependencies = new Map<string, string[]>();
  const semanticRecords = [
    ...recordEntries(manifest.semantic_models, 'semantic_model.manifest'),
    ...recordEntries(semanticManifest.semantic_models, 'semantic_model.semantic_manifest'),
  ].sort(([a], [b]) => a.localeCompare(b));
  for (const [uniqueId, value] of semanticRecords) {
    const raw = asRecord(value);
    const dqlMeta = asRecord(asRecord(raw.meta).dql);
    const config = asRecord(raw.config);
    const configDql = asRecord(asRecord(config.meta).dql);
    const domains = unique([
      ...domainValues(dqlMeta.domain),
      ...domainValues(configDql.domain),
      ...domainValues(raw.domain),
      ...domainValues(config.domain),
    ]);
    const tags = unique([...stringArray(raw.tags), ...stringArray(config.tags)]);
    const dependencies = dependentModelIds(raw, modelIds, models);
    const semanticName = stringValue(raw.name) ?? uniqueId;
    semanticModelDependencies.set(semanticName, dependencies);
    for (const modelId of dependencies) {
      const target = models.find((model) => model.uniqueId === modelId);
      if (!target) continue;
      appendStrings(semanticDomains, modelId, domains);
      appendStrings(semanticTags, modelId, tags);
      for (const domain of domains) appendEvidence(semantic, modelId, evidence(
        'metricflow_semantic_domain', domain, semanticName,
        3, 0.88, target, stringValue(asRecord(raw.owner).email) ?? stringValue(asRecord(raw.owner).name), uniqueId,
      ));
    }
  }

  const metricRecords = [
    ...recordEntries(manifest.metrics, 'metric.manifest'),
    ...recordEntries(semanticManifest.metrics, 'metric.semantic_manifest'),
  ].sort(([a], [b]) => a.localeCompare(b));
  for (const [uniqueId, value] of metricRecords) {
    const raw = asRecord(value);
    const config = asRecord(raw.config);
    const dqlMeta = asRecord(asRecord(raw.meta).dql);
    const configDql = asRecord(asRecord(config.meta).dql);
    const domains = unique([
      ...domainValues(dqlMeta.domain),
      ...domainValues(configDql.domain),
      ...domainValues(raw.domain),
      ...domainValues(config.domain),
    ]);
    if (domains.length === 0) continue;
    const semanticName = stringValue(raw.semantic_model)
      ?? stringValue(raw.semantic_model_name)
      ?? stringValue(asRecord(raw.type_params).semantic_model);
    if (!semanticName) continue;
    for (const modelId of semanticModelDependencies.get(semanticName) ?? []) {
      const target = models.find((model) => model.uniqueId === modelId);
      if (!target) continue;
      appendStrings(semanticDomains, modelId, domains);
      for (const domain of domains) appendEvidence(semantic, modelId, evidence(
        'metricflow_semantic_domain', domain, stringValue(raw.name) ?? uniqueId,
        3, 0.88, target, stringValue(asRecord(raw.owner).email) ?? stringValue(asRecord(raw.owner).name), uniqueId,
      ));
    }
  }

  const exposures = new Map<string, DomainDiscoveryEvidence[]>();
  for (const [uniqueId, value] of Object.entries(asRecord(manifest.exposures)).sort(([a], [b]) => a.localeCompare(b))) {
    const raw = asRecord(value);
    const meta = asRecord(raw.meta);
    const dqlMeta = asRecord(meta.dql);
    const domains = unique([
      ...domainValues(dqlMeta.domain),
      ...domainValues(dqlMeta.scope),
      ...domainValues(meta.domain),
      ...domainValues(meta.scope),
      ...domainValues(raw.domain),
      ...domainValues(raw.group),
    ]);
    if (domains.length === 0) continue;
    const ownerRaw = asRecord(raw.owner);
    const owner = stringValue(ownerRaw.email) ?? stringValue(ownerRaw.name);
    for (const modelId of dependentModelIds(raw, modelIds, models)) {
      const target = models.find((model) => model.uniqueId === modelId);
      if (!target) continue;
      for (const domain of domains) appendEvidence(exposures, modelId, evidence(
        'exposure_owner_scope', domain, stringValue(raw.name) ?? uniqueId,
        4, 0.8, target, owner, uniqueId,
      ));
    }
  }

  return { semantic, exposures, semanticDomains, semanticTags };
}

function buildDomainProposals(
  memberships: DomainMembershipProposal[],
  packages: DomainPackageRecord[],
): DomainProposal[] {
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const byDomain = new Map<string, DomainMembershipProposal[]>();
  for (const membership of memberships) {
    if (!membership.proposedDomain) continue;
    const values = byDomain.get(membership.proposedDomain) ?? [];
    values.push(membership);
    byDomain.set(membership.proposedDomain, values);
  }
  return [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, values]) => {
    const existing = packageById.get(id);
    const owners = unique([
      ...(existing?.owner ? [existing.owner] : []),
      ...values.map((value) => value.owner).filter(isString),
    ]);
    const confidenceScore = Math.min(...values.map((value) => value.confidenceScore));
    return {
      id,
      name: existing?.name ?? displayName(id),
      owner: owners.length === 1 ? owners[0] : undefined,
      proposedParent: existing?.parent ?? parentDomain(id),
      matchedDbtUniqueIds: values.map((value) => value.dbtUniqueId).sort(),
      confidence: confidenceLabel(confidenceScore),
      confidenceScore,
      evidence: dedupeEvidence(values.flatMap((value) => value.evidence.filter((item) => item.domain === id))).sort(compareEvidence),
      requiresReview: values.some((value) => value.requiresReview) || !existing,
    };
  });
}

/** One `relationships` test in a dbt manifest, resolved to an exact key pair. */
export interface DbtRelationshipTestEdge {
  /** The dbt test node this edge was read from. */
  testUniqueId: string;
  fromDbtUniqueId: string;
  toDbtUniqueId: string;
  /** `'unknown'` when dbt did not record the column on either side. */
  fromColumn: string;
  toColumn: string;
  sourcePath?: string;
}

/**
 * Read every `relationships` test out of a dbt manifest. dbt already declares
 * the exact from/to key pair and enforces it with `dbt test`, so these are the
 * highest-quality relationship candidates a project has.
 *
 * REL-001 still applies: a dbt test is evidence, never join authorization.
 * Callers must keep the resulting relationship a reviewable draft.
 *
 * `include` restricts both endpoints to a known set of dbt unique ids; pass
 * `undefined` to accept any endpoint the manifest resolves.
 */
export function collectDbtRelationshipTests(
  manifest: UnknownRecord,
  include?: ReadonlySet<string>,
): DbtRelationshipTestEdge[] {
  const known = (id: string): boolean => !include || include.has(id);
  const output: DbtRelationshipTestEdge[] = [];
  for (const [testUniqueId, value] of Object.entries(asRecord(manifest.nodes)).sort(([a], [b]) => a.localeCompare(b))) {
    const raw = asRecord(value);
    if (raw.resource_type !== 'test') continue;
    const metadata = asRecord(raw.test_metadata);
    const testName = stringValue(metadata.name) ?? stringValue(raw.name);
    if (!testName || !testName.toLowerCase().includes('relationship')) continue;
    const dependencies = stringArray(asRecord(raw.depends_on).nodes).filter(known);
    const attached = stringValue(raw.attached_node);
    const from = attached && known(attached) ? attached : dependencies[0];
    const to = dependencies.find((id) => id !== from);
    if (!from || !to) continue;
    const kwargs = asRecord(metadata.kwargs);
    output.push({
      testUniqueId,
      fromDbtUniqueId: from,
      toDbtUniqueId: to,
      fromColumn: stringValue(raw.column_name) ?? stringValue(kwargs.column_name) ?? 'unknown',
      toColumn: stringValue(kwargs.field) ?? stringValue(kwargs.to_field) ?? 'unknown',
      sourcePath: stringValue(raw.original_file_path) ?? stringValue(raw.path),
    });
  }
  return output;
}

function collectRelationshipDrafts(
  manifest: UnknownRecord,
  assigned: Map<string, DomainMembershipProposal & { proposedDomain: string }>,
): RelationshipDraftCandidate[] {
  return collectDbtRelationshipTests(manifest, new Set(assigned.keys()))
    .map((edge): RelationshipDraftCandidate => ({
      id: `${safeId(edge.fromDbtUniqueId)}_to_${safeId(edge.toDbtUniqueId)}_${safeId(edge.fromColumn)}`,
      lifecycle: 'draft',
      requiresReview: true,
      automaticJoinAllowed: false,
      fromDbtUniqueId: edge.fromDbtUniqueId,
      toDbtUniqueId: edge.toDbtUniqueId,
      fromDomain: assigned.get(edge.fromDbtUniqueId)!.proposedDomain,
      toDomain: assigned.get(edge.toDbtUniqueId)!.proposedDomain,
      keys: [{ from: edge.fromColumn, to: edge.toColumn }],
      evidence: [{ dbtUniqueId: edge.testUniqueId, sourcePath: edge.sourcePath, kind: 'dbt_relationship_test' }],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function matchingSelectors(
  model: ModelRecord,
  raw: UnknownRecord,
  tags: string[],
  pkg: DomainPackageRecord,
  indexes: EvidenceIndex,
): Array<{ selector: string; value: string }> {
  const output: Array<{ selector: string; value: string }> = [];
  const group = stringValue(raw.group) ?? stringValue(asRecord(raw.config).group);
  if (group && (pkg.domain.dbtGroups ?? []).includes(group)) output.push({ selector: 'dbt_group', value: group });
  for (const tag of tags) {
    if ((pkg.domain.dbtTags ?? []).includes(tag)) output.push({ selector: 'dbt_tag', value: tag });
  }
  for (const domain of indexes.semanticDomains.get(model.uniqueId) ?? []) {
    if ((pkg.domain.semanticDomains ?? []).map(normalizeDomainId).includes(domain)) {
      output.push({ selector: 'semantic_domain', value: domain });
    }
  }
  for (const tag of indexes.semanticTags.get(model.uniqueId) ?? []) {
    if ((pkg.domain.semanticTags ?? []).includes(tag)) output.push({ selector: 'semantic_tag', value: tag });
  }
  for (const pattern of pkg.domain.dbtPaths ?? []) {
    if (model.sourcePath && globMatches(model.sourcePath, pattern)) output.push({ selector: 'dbt_path', value: pattern });
  }
  return output;
}

function collectModels(manifest: UnknownRecord): ModelRecord[] {
  return Object.entries(asRecord(manifest.nodes))
    .filter(([, value]) => asRecord(value).resource_type === 'model')
    .map(([uniqueId, value]) => {
      const raw = asRecord(value);
      return {
        uniqueId,
        name: stringValue(raw.alias) ?? stringValue(raw.name) ?? uniqueId,
        sourcePath: stringValue(raw.original_file_path) ?? stringValue(raw.path),
        packageName: stringValue(raw.package_name),
        raw,
      };
    })
    .sort((a, b) => a.uniqueId.localeCompare(b.uniqueId));
}

function collectGroupOwners(manifest: UnknownRecord): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [, value] of Object.entries(asRecord(manifest.groups)).sort(([a], [b]) => a.localeCompare(b))) {
    const group = asRecord(value);
    const name = stringValue(group.name);
    const owner = stringValue(asRecord(group.owner).email) ?? stringValue(asRecord(group.owner).name);
    if (name && owner) owners.set(name, owner);
  }
  return owners;
}

function dependentModelIds(raw: UnknownRecord, modelIds: Set<string>, models: ModelRecord[]): string[] {
  const direct = stringArray(asRecord(raw.depends_on).nodes).filter((id) => modelIds.has(id));
  const model = stringValue(raw.model);
  if (model && modelIds.has(model)) direct.push(model);
  const refName = model?.match(/ref\(['"]([^'"]+)['"]\)/)?.[1]
    ?? stringValue(asRecord(raw.node_relation).alias)
    ?? stringValue(asRecord(raw.node_relation).name);
  if (refName) {
    const matches = models.filter((candidate) => candidate.name === refName);
    if (matches.length === 1) direct.push(matches[0].uniqueId);
  }
  return unique(direct);
}

function domainFromTag(tag: string, packages: DomainPackageRecord[], words: BusinessWords, inferable: boolean): { domain: string; area?: string } | undefined {
  const explicit = tag.match(/^domain[:/_-](.+)$/i)?.[1];
  if (explicit) {
    const domain = normalizeDomainId(explicit);
    return domain ? { domain } : undefined;
  }
  if (!inferable) return undefined;
  // An access, schedule or layer tag (`safe`, `mnpi_exception`, `six_hourly`,
  // `sources`) or one naming a source system (`zuora`) says who may read a
  // model or when it runs, not what it is about (design S-D4).
  const phrase = businessPhrase(tag);
  if (!phrase || isSourceSystem(phrase, words.sourceSystems)) return undefined;
  const existing = packages.find((pkg) => pkg.id === phrase || normalizeDomainId(pkg.name) === phrase);
  return existing ? { domain: existing.id } : inCompound(phrase, words);
}

function domainFromPath(model: ModelRecord, words: BusinessWords): { domain: string; area?: string } | undefined {
  const phrases = pathPhrases(model, words);
  if (phrases.length === 0) return undefined;
  const [first, ...rest] = phrases;
  const grouped = inCompound(first!, words);
  // A compound folder (`sales_and_marketing`) is the domain; a folder naming
  // one of its parts (`common_mart_sales`) is a subject area inside it.
  if (grouped.area) return grouped;
  return { domain: [first!, ...rest].slice(0, 3).join('.') };
}

/** The business phrases a model's folders name, outermost first, with layer words and source systems left out. */
function pathPhrases(model: ModelRecord, words: BusinessWords): string[] {
  if (!model.sourcePath) return [];
  const parts = model.sourcePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const modelsAt = parts.lastIndexOf('models');
  const folders = parts.slice(modelsAt >= 0 ? modelsAt + 1 : 0, -1).map(normalizeDomainId).filter(isString);
  const staging = inSourceLayer(model, folders);
  const phrases: string[] = [];
  for (const folder of folders) {
    // A folder whose models carry its name as a prefix (`local/local_player_game_facts`) names a layer.
    if (model.name.toLowerCase().startsWith(`${folder}_`)) continue;
    const phrase = businessPhrase(folder);
    if (!phrase) continue;
    // Below the first business folder, a folder named for a source system
    // (`workspace_people/level_up`) groups that system's copies, not a
    // subject area. The first one is kept: a source can share a business
    // word's name (`engineering`).
    if ((staging || phrases.length > 0) && isSourceSystem(phrase, words.sourceSystems)) continue;
    phrases.push(phrase);
  }
  return phrases;
}

function sourceSystemOf(model: ModelRecord, words: BusinessWords): string | undefined {
  if (!model.sourcePath) return undefined;
  const parts = model.sourcePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const modelsAt = parts.lastIndexOf('models');
  const folders = parts.slice(modelsAt >= 0 ? modelsAt + 1 : 0, -1).map(normalizeDomainId).filter(isString);
  if (!inSourceLayer(model, folders)) return undefined;
  return folders.map((folder) => businessPhrase(folder)).find((phrase): phrase is string => Boolean(phrase && isSourceSystem(phrase, words.sourceSystems)));
}

function inferableModel(model: ModelRecord, words: BusinessWords): boolean {
  if (words.rootPackage && model.packageName && model.packageName !== words.rootPackage) return false;
  return !sourceSystemOf(model, words);
}

/** Staging and raw models sit in a source folder or carry a staging name; their folders name source systems. */
function inSourceLayer(model: ModelRecord, folders: string[]): boolean {
  return folders.some((folder) => SOURCE_LAYER_FOLDERS.has(folder)) || /(_source|_src|_raw)$/i.test(model.name) || /^(stg|src|raw|base)_/i.test(model.name);
}

/** Every phrase a tag or folder could make a domain of, for finding compound domains across the project. */
function inferredPhrases(model: ModelRecord, words: BusinessWords): string[] {
  const tags = [...stringArray(model.raw.tags), ...stringArray(asRecord(model.raw.config).tags)];
  return [
    ...tags.map((tag) => businessPhrase(tag)).filter((phrase): phrase is string => Boolean(phrase && !isSourceSystem(phrase, words.sourceSystems))),
    ...pathPhrases(model, words).slice(0, 1),
  ];
}

/**
 * Compound domains (`sales_and_marketing`, `product_and_engineering`) and the
 * parts they hold: a phrase that is one part of exactly one compound becomes a
 * subject area of it.
 */
function compoundParts(phrases: string[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const phrase of new Set(phrases)) {
    const head = phrase.split('.')[0]!;
    if (!head.includes('_and_')) continue;
    for (const part of head.split('_and_')) {
      if (!part) continue;
      owners.set(part, new Set([...(owners.get(part) ?? []), head]));
    }
  }
  return new Map([...owners].filter(([, heads]) => heads.size === 1).map(([part, heads]) => [part, [...heads][0]!]));
}

function inCompound(phrase: string, words: BusinessWords): { domain: string; area?: string } {
  const head = phrase.split('.')[0]!;
  const compound = words.compounds.get(head);
  return compound ? { domain: compound, area: head } : { domain: phrase };
}

function collectSourceSystems(manifest: UnknownRecord): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(asRecord(manifest.sources))) {
    const name = stringValue(asRecord(value).source_name);
    const id = name ? normalizeDomainId(name) : undefined;
    if (!id) continue;
    names.add(id.replace(/\./g, '_'));
    // `zip_sandbox` and `google_analytics_360` are named `zip` and `google_analytics` once layer words and digits go.
    const phrase = businessPhrase(id);
    if (phrase) names.add(phrase.replace(/\./g, '_'));
  }
  return names;
}

function isSourceSystem(phrase: string, sourceSystems: ReadonlySet<string>): boolean {
  if (sourceSystems.has(phrase)) return true;
  for (const source of sourceSystems) if (phrase.startsWith(`${source}_`)) return true;
  return false;
}

/**
 * What a folder, tag or schema name says about the business, with the words
 * that only say where a table sits, who may read it or when it runs left out
 * (design S2, W2): `common_mart_sales` → `sales`, `facts_sales_and_marketing`
 * → `sales_and_marketing`, `restricted_safe` → nothing. Undefined when no
 * business word is left.
 */
export function businessPhrase(value: string): string | undefined {
  const normalized = normalizeDomainId(value);
  if (!normalized) return undefined;
  const segments = normalized.split('.').map((segment) => {
    const tokens = segment.split('_').filter((token) => token && !NON_BUSINESS_WORDS.has(token) && !/^v?\d+$/.test(token));
    while (tokens[0] === 'and') tokens.shift();
    while (tokens.at(-1) === 'and') tokens.pop();
    const phrase = tokens.filter((token, index) => !(token === 'and' && tokens[index - 1] === 'and')).map((token) => WORD_FORMS[token] ?? token).join('_');
    return phrase;
  }).filter(Boolean);
  return segments.length > 0 ? segments.join('.') : undefined;
}

function domainValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return unique(values.map((item) => normalizeDomainId(String(item))).filter(isString));
}

function normalizeDomainId(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
    .replace(/[\\/]+/g, '.')
    .replace(/[^a-z0-9.]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[_\.]+|[_\.]+$/g, '');
  return normalized || undefined;
}

function evidence(
  kind: DomainDiscoveryEvidenceKind,
  domain: string,
  value: string,
  rank: number,
  confidence: number,
  model: ModelRecord,
  owner?: string,
  selector?: string,
): DomainDiscoveryEvidence {
  return {
    kind,
    domain,
    value,
    rank,
    confidence,
    sourceUniqueId: model.uniqueId,
    sourcePath: model.sourcePath,
    owner,
    selector,
  };
}

function appendEvidence(
  index: Map<string, DomainDiscoveryEvidence[]>,
  uniqueId: string,
  item: DomainDiscoveryEvidence,
): void {
  const values = index.get(uniqueId) ?? [];
  values.push(item);
  index.set(uniqueId, values);
}

function appendStrings(index: Map<string, string[]>, uniqueId: string, items: string[]): void {
  index.set(uniqueId, unique([...(index.get(uniqueId) ?? []), ...items]));
}

function recordEntries(value: unknown, prefix: string): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.map((item, index): [string, unknown] => {
      const raw = asRecord(item);
      return [stringValue(raw.unique_id) ?? stringValue(raw.name) ?? `${prefix}.${index}`, item];
    });
  }
  return Object.entries(asRecord(value));
}

function dedupeEvidence(values: DomainDiscoveryEvidence[]): DomainDiscoveryEvidence[] {
  const output = new Map<string, DomainDiscoveryEvidence>();
  for (const value of values) {
    const key = [value.kind, value.domain, value.value, value.sourceUniqueId, value.selector ?? ''].join('|');
    if (!output.has(key)) output.set(key, value);
  }
  return [...output.values()];
}

function compareEvidence(a: DomainDiscoveryEvidence, b: DomainDiscoveryEvidence): number {
  return a.rank - b.rank
    || a.domain.localeCompare(b.domain)
    || a.sourceUniqueId.localeCompare(b.sourceUniqueId)
    || a.value.localeCompare(b.value);
}

function confidenceLabel(value: number): 'high' | 'medium' | 'low' {
  if (value >= 0.85) return 'high';
  if (value >= 0.65) return 'medium';
  return 'low';
}

function displayName(id: string): string {
  const local = id.split('.').at(-1) ?? id;
  return local.split('_').filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');
}

function parentDomain(id: string): string | undefined {
  const parts = id.split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function globMatches(value: string, pattern: string): boolean {
  const normalizedValue = value.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const marker = '\u0000';
  const source = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, marker)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(marker, 'g'), '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`).test(normalizedValue);
}

function siblingIfPresent(manifestPath: string, name: string): string | undefined {
  const candidate = join(dirname(manifestPath), name);
  return existsSync(candidate) ? candidate : undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface BusinessWords {
  /** The project's dbt source names (`zuora`, `sfdc`): a source system, never a domain. */
  sourceSystems: ReadonlySet<string>;
  /** A part of a compound domain → the compound (`sales` → `sales_and_marketing`). */
  compounds: Map<string, string>;
  /** The dbt project's own package; models of other packages take no domain from their folders or tags. */
  rootPackage?: string;
}


/** The domain for tables several domains read and none owns (design S1). */
export const SHARED_DOMAIN = 'shared';

/** Folders staging and raw models sit in: the folders below them name source systems. */
const SOURCE_LAYER_FOLDERS = new Set(['sources', 'source', 'src', 'staging', 'stage', 'stg', 'raw', 'landing', 'base', 'legacy', 'snapshots']);

/**
 * Words that say where a table sits in the pipeline, who may read it or when
 * it runs, never what it is about (RFC 0012, design S-D4). Matched as whole
 * words inside a folder, tag or schema name.
 */
const NON_BUSINESS_WORDS = new Set([
  // Layers.
  'staging', 'stage', 'stg', 'marts', 'mart', 'intermediate', 'int', 'base', 'core', 'common', 'sources', 'source', 'src', 'raw',
  'landing', 'dim', 'dims', 'dimension', 'dimensions', 'fct', 'fcts', 'fact', 'facts', 'snapshot', 'snapshots', 'seed', 'seeds',
  'reporting', 'report', 'reports', 'rpt', 'presentation', 'bronze', 'silver', 'gold', 'prep', 'preparation', 'local', 'global',
  'bridge', 'bridges', 'bdg', 'map', 'maps', 'mapping', 'mappings', 'xref', 'xf', 'transformed', 'curated', 'cleansed', 'conformed',
  'modeled', 'modelled', 'refined', 'analytics', 'edm', 'edw', 'dw', 'dwh', 'workspace', 'workspaces', 'wk', 'legacy', 'deprecated', 'archive', 'archived',
  'tmp', 'temp', 'scratch', 'sandbox', 'dev', 'prod', 'test', 'tests', 'specific', 'no', 'transformation', 'view', 'views', 'ephemeral',
  'published', 'dedupe', 'deduped', 'incremental', 'partition', 'partitions', 'month', 'daily', 'hourly', 'weekly', 'monthly',
  'nightly', 'quarterly', 'yearly', 'six', 'twelve', 'full', 'refresh', 'dbt',
  // Access.
  'safe', 'restricted', 'sensitive', 'secure', 'confidential', 'private', 'public', 'internal', 'pii', 'phi', 'mnpi', 'exception',
  'exceptions',
  // Connecting words, and copies.
  'on', 'of', 'the', 'for', 'to', 'by', 'copy', 'copies', 'clone', 'clones',
]);

/** Adjective and plural forms of the same business word. */
const WORD_FORMS: Record<string, string> = { financial: 'finance', finances: 'finance', operational: 'operations' };
