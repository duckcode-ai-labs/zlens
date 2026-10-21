/**
 * Build the KG node + edge arrays from a compiled DQL manifest.
 *
 * Inputs:
 *   - dql-manifest.json (terms, business views, blocks, dashboards, apps, metrics, dimensions, sources)
 *   - dbt manifest (already merged into the DQL manifest's dbtImport.dbtDag)
 *   - project Skills folder (loaded separately by the Skills loader)
 *
 * The output is intentionally flat — caller passes it to `KGStore.rebuild()`.
 */

import { createHash } from "node:crypto";

import type {
  DimensionDefinition,
  DQLManifest,
  ManifestBusinessView,
  ManifestSource,
  ManifestTerm,
  MeasureDefinition,
  MetricCapabilityContract,
  MetricDefinition,
  SemanticLayer,
  SemanticModelDefinition,
  TimeDimensionDefinition,
} from "@zlens/core";
import { trustLabelIdForStatus } from "@zlens/core";
import type { KGNode, KGEdge, KGNodeKind, KGCertification } from "./types.js";
import {
  buildBlockBusinessFingerprint,
  buildBlockSqlFingerprints,
} from "../metadata/block-fingerprints.js";

export function buildKGFromManifest(manifest: DQLManifest): {
  nodes: KGNode[];
  edges: KGEdge[];
} {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];

  // Business terms
  // The manifest keys a term by name, and a same-named term from another
  // domain by `<domain>::<name>`: the node id follows the key, so two domains
  // defining the same word are two nodes, not one overwrite.
  for (const [termKey, term] of Object.entries(manifest.terms ?? {})) {
    nodes.push({
      nodeId: `term:${termKey}`,
      kind: 'term',
      name: term.name,
      domain: term.domain,
      status: term.status,
      owner: term.owner,
      description: term.description,
      tags: termTags(term),
      llmContext: renderTermContext(term),
      businessOutcome: term.businessOutcome,
      businessOwner: term.businessOwner,
      decisionUse: term.decisionUse,
      reviewCadence: term.reviewCadence,
      businessRules: term.businessRules,
      caveats: term.caveats,
      sourcePath: term.filePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(term.status),
      payload: {
        synonyms: term.synonyms ?? [],
        identifiers: term.identifiers ?? [],
        metricRefs: term.metricRefs ?? [],
      },
      provenance: 'DQL business term',
    });
    // A term can now name the governed metrics it describes, so a project's own
    // vocabulary reaches the semantic layer instead of dying in the glossary.
    for (const metricRef of term.metricRefs ?? []) {
      edges.push({ src: `term:${termKey}`, dst: `metric:${metricRef}`, kind: 'defines' });
    }
  }

  // Blocks
  for (const block of Object.values(manifest.blocks)) {
    const nodeId = `block:${block.name}`;
    const contractOutputNames = block.declaredOutputs
      ?? block.outputContract?.map((output) => output.name).filter(Boolean)
      ?? block.outputs?.map((output) => output.name).filter(Boolean);
    nodes.push({
      nodeId,
      kind: 'block',
      name: block.name,
      domain: block.domain,
      status: block.status,
      owner: block.owner,
      description: block.description,
      tags: block.tags ?? [],
      llmContext: block.llmContext,
      examples: block.examples,
      sql: block.sql,
      businessOutcome: block.businessOutcome,
      businessOwner: block.businessOwner,
      decisionUse: block.decisionUse,
      reviewCadence: block.reviewCadence,
      pattern: block.pattern,
      grain: block.grain,
      entities: block.entities,
      declaredOutputs: block.declaredOutputs,
      outputs: block.outputs,
      outputContract: block.outputContract,
      dimensions: block.dimensions,
      allowedFilters: block.allowedFilters,
      parameterPolicy: block.parameterPolicy,
      parameters: block.parameters,
      filterBindings: block.filterBindings,
      sourceSystems: block.sourceSystems,
      replacementFor: block.replacementFor,
      sqlFingerprints: buildBlockSqlFingerprints(block.sql),
      businessFingerprint: buildBlockBusinessFingerprint({
        name: block.name,
        domain: block.domain,
        pattern: block.pattern,
        grain: block.grain,
        entities: block.entities,
        terms: block.termRefs,
        outputs: contractOutputNames,
        dimensions: block.dimensions,
        filters: block.allowedFilters,
        sources: [...(block.tableDependencies ?? []), ...(block.rawTableRefs ?? [])],
        sourceSystems: block.sourceSystems,
      }),
      payload: {
        qualifiedId: `${block.domain ?? 'global'}::block::${block.name}`,
        localId: block.name,
        aliases: [block.name],
        // Question aliases from the block's Context panel: indexed for retrieval
        // (never used as an identity, so an alias cannot shadow another object's name).
        ...(block.synonyms?.length ? { synonyms: block.synonyms } : {}),
        metricRefs: [
          ...new Set([
            ...(block.metricRef ? [block.metricRef] : []),
            ...(block.metricsRef ?? []),
            ...(block.metricRefs ?? []),
          ]),
        ],
        dimensionsRef: block.dimensionsRef ?? [],
      },
      datalexContract: block.datalexContract,
      businessRules: block.businessRules ?? block.invariants,
      caveats: block.caveats,
      primaryTerms: block.primaryTerms,
      dataState: block.dataState,
      dataStateDetail: block.dataStateDetail,
      sourcePath: block.filePath,
      sourceTier: 'certified_artifact',
      certification: certificationFromStatus(block.status),
      provenance: 'DQL block',
    });
    for (const termRef of block.termRefs ?? []) {
      edges.push({ src: `term:${termRef}`, dst: nodeId, kind: 'defines' });
    }
  }

  // Business views
  for (const view of Object.values(manifest.businessViews ?? {})) {
    const nodeId = `business_view:${view.name}`;
    nodes.push({
      nodeId,
      kind: 'business_view',
      name: view.name,
      domain: view.domain,
      status: view.status,
      owner: view.owner,
      description: view.description,
      tags: view.tags ?? [],
      llmContext: renderBusinessViewContext(view),
      businessOutcome: view.businessOutcome,
      businessOwner: view.businessOwner,
      decisionUse: view.decisionUse,
      reviewCadence: view.reviewCadence,
      businessRules: view.businessRules,
      caveats: view.caveats,
      sourcePath: view.filePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(view.status),
      provenance: 'DQL business view',
    });
    for (const termRef of view.termRefs ?? []) {
      edges.push({ src: `term:${termRef}`, dst: nodeId, kind: 'defines' });
    }
    for (const blockRef of view.blockRefs ?? []) {
      edges.push({ src: `block:${blockRef}`, dst: nodeId, kind: 'composes' });
    }
    for (const viewRef of view.businessViewRefs ?? []) {
      edges.push({ src: `business_view:${viewRef}`, dst: nodeId, kind: 'composes' });
    }
  }

  // Notebooks become searchable governed workspaces. DQL cells that declare
  // blocks are also linked so app/dashboard chat can route users to the
  // analyst workbench that produced an artifact.
  for (const nb of Object.values(manifest.notebooks ?? {})) {
    const nodeId = `notebook:${nb.filePath}`;
    const cellSummary = nb.cells
      .map((cell) => [cell.title, cell.blockName, cell.source.slice(0, 160)].filter(Boolean).join(' — '))
      .filter(Boolean)
      .slice(0, 8)
      .join('\n');
    nodes.push({
      nodeId,
      kind: 'notebook',
      name: nb.title || nb.filePath,
      description: `${nb.cells.length} SQL/DQL cell${nb.cells.length === 1 ? '' : 's'}`,
      llmContext: cellSummary || undefined,
      sourcePath: nb.filePath,
      sourceTier: 'certified_artifact',
      certification: 'ai_generated',
      provenance: 'DQL notebook',
    });
    for (const cell of nb.cells) {
      if (cell.blockName) edges.push({ src: `block:${cell.blockName}`, dst: nodeId, kind: 'contains' });
      for (const ref of cell.refDependencies) edges.push({ src: `block:${ref}`, dst: nodeId, kind: 'depends_on' });
    }
  }

  // Metrics
  for (const m of Object.values(manifest.metrics)) {
    const nodeId = `metric:${m.name}`;
    nodes.push({
      nodeId,
      kind: 'metric',
      name: m.name,
      domain: m.domain,
      status: m.status,
      owner: m.owner,
      description: m.description,
      tags: m.tags ?? [],
      sourcePath: m.filePath,
      sourceTier: 'semantic_layer',
      certification: certificationFromStatus(m.status),
      provenance: 'DQL semantic metric',
    });
  }

  // Dimensions
  for (const d of Object.values(manifest.dimensions)) {
    const nodeId = `dimension:${d.name}`;
    nodes.push({
      nodeId,
      kind: 'dimension',
      name: d.name,
      domain: d.domain,
      status: d.status,
      owner: d.owner,
      description: d.description,
      tags: d.tags ?? [],
      sourcePath: d.filePath,
      sourceTier: 'semantic_layer',
      certification: certificationFromStatus(d.status),
      provenance: 'DQL semantic dimension',
    });
  }

  // Sources / dbt models
  for (const s of Object.values(manifest.sources)) {
    const isDbt = s.origin === 'dbt';
    const kind: KGNodeKind = isDbt ? 'dbt_model' : 'dbt_source';
    const nodeId = `${kind}:${s.name}`;
    nodes.push({
      nodeId,
      kind,
      name: s.name,
      description: s.dbtModel?.description,
      llmContext: renderSourceContext(s),
      sourceTier: isDbt ? 'dbt_manifest' : 'project',
      certification: 'ai_generated',
      provenance: isDbt ? 'dbt manifest.json' : 'SQL/table reference',
      referencedBy: s.referencedBy,
    });
  }

  // Dashboards
  for (const d of Object.values(manifest.dashboards ?? {})) {
    const nodeId = `dashboard:${d.qualifiedId ?? `${d.appId}/${d.id}`}`;
    nodes.push({
      nodeId,
      kind: 'dashboard',
      name: d.title,
      domain: d.domain,
      status: d.lifecycle,
      description: d.description,
      tags: d.tags ?? [],
      businessOutcome: d.businessOutcome,
      businessOwner: d.businessOwner,
      decisionUse: d.decisionUse,
      reviewCadence: d.reviewCadence,
      businessRules: d.businessRules,
      caveats: d.caveats,
      sourcePath: d.filePath,
      sourceTier: 'certified_artifact',
      certification: certificationFromStatus(d.lifecycle),
      provenance: 'DQL dashboard',
    });
    for (const blockId of d.blockIds) {
      edges.push({ src: `block:${blockId}`, dst: nodeId, kind: 'contains' });
    }
    for (const blockName of d.blockPathRefs) {
      edges.push({ src: `block:${blockName}`, dst: nodeId, kind: 'contains' });
    }
  }

  // Apps
  for (const a of Object.values(manifest.apps ?? {})) {
    const nodeId = `app:${a.id}`;
    nodes.push({
      nodeId,
      kind: 'app',
      name: a.name,
      domain: a.domain,
      status: a.lifecycle,
      owner: a.owners[0],
      description: a.description,
      tags: a.tags ?? [],
      businessOutcome: a.businessOutcome,
      businessOwner: a.businessOwner,
      decisionUse: a.decisionUse,
      reviewCadence: a.reviewCadence,
      businessRules: a.businessRules,
      caveats: a.caveats,
      sourcePath: a.filePath,
      sourceTier: 'certified_artifact',
      certification: certificationFromStatus(a.lifecycle),
      provenance: 'DQL app',
    });
    for (const dashboardId of a.dashboards) {
      edges.push({ src: `dashboard:${dashboardId}`, dst: nodeId, kind: 'contains' });
    }
  }

  // Domains: prefer first-class domain declarations, then derive nodes from
  // legacy domain strings so older projects still index cleanly.
  const domains = new Set<string>();
  for (const domain of Object.values(manifest.domains ?? {})) {
    const domainId = domain.id ?? domain.name;
    domains.add(domainId);
    nodes.push({
      nodeId: `domain:${domainId}`,
      kind: 'domain',
      name: domain.name,
      domain: domainId,
      owner: domain.owner,
      description: domain.description ?? domain.boundedContext,
      tags: domain.tags ?? [],
      businessOutcome: domain.businessOutcome,
      businessOwner: domain.businessOwner,
      reviewCadence: domain.reviewCadence,
      sourceSystems: domain.sourceSystems,
      boundedContext: domain.boundedContext,
      primaryTerms: domain.primaryTerms,
      sourcePath: domain.filePath,
      sourceTier: 'business_context',
      certification: 'ai_generated',
      provenance: 'DQL domain',
      payload: { id: domainId, parent: domain.parent, exports: domain.exports ?? [] },
    });
    if (domain.parent) edges.push({ src: `domain:${domain.parent}`, dst: `domain:${domainId}`, kind: 'parent_domain' });
  }
  for (const term of Object.values(manifest.terms ?? {})) if (term.domain) domains.add(term.domain);
  for (const view of Object.values(manifest.businessViews ?? {})) if (view.domain) domains.add(view.domain);
  for (const block of Object.values(manifest.blocks)) if (block.domain) domains.add(block.domain);
  for (const d of Object.values(manifest.dashboards ?? {})) if (d.domain) domains.add(d.domain);
  for (const a of Object.values(manifest.apps ?? {})) if (a.domain) domains.add(a.domain);
  for (const m of Object.values(manifest.metrics)) if (m.domain) domains.add(m.domain);
  for (const d of domains) {
    if (nodes.some((node) => node.nodeId === `domain:${d}`)) continue;
    nodes.push({
      nodeId: `domain:${d}`,
      kind: 'domain',
      name: d,
      domain: d,
    });
  }
  for (const [termKey, term] of Object.entries(manifest.terms ?? {})) {
    if (term.domain) edges.push({ src: `domain:${term.domain}`, dst: `term:${termKey}`, kind: 'contains' });
  }
  for (const view of Object.values(manifest.businessViews ?? {})) {
    if (view.domain) edges.push({ src: `domain:${view.domain}`, dst: `business_view:${view.name}`, kind: 'contains' });
  }
  for (const block of Object.values(manifest.blocks)) {
    if (block.domain) edges.push({ src: `domain:${block.domain}`, dst: `block:${block.name}`, kind: 'contains' });
  }
  for (const d of Object.values(manifest.dashboards ?? {})) {
    if (d.domain) edges.push({ src: `domain:${d.domain}`, dst: `dashboard:${d.qualifiedId ?? `${d.appId}/${d.id}`}`, kind: 'contains' });
  }
  for (const a of Object.values(manifest.apps ?? {})) {
    if (a.domain) edges.push({ src: `domain:${a.domain}`, dst: `app:${a.id}`, kind: 'contains' });
  }
  for (const m of Object.values(manifest.metrics)) {
    if (m.domain) edges.push({ src: `domain:${m.domain}`, dst: `metric:${m.name}`, kind: 'contains' });
  }

  appendDbtFirstModelingGraph(manifest, nodes, edges);

  return { nodes, edges };
}

function appendDbtFirstModelingGraph(manifest: DQLManifest, nodes: KGNode[], edges: KGEdge[]): void {
  const modeling = manifest.modeling;
  if (manifest.manifestVersion !== 3 || !modeling) return;
  const entityNodeId = (reference: string): string => `entity:${modeling.entities[reference]?.qualifiedId ?? modeling.entities[reference]?.id ?? reference}`;

  for (const pkg of Object.values(modeling.packages)) {
    if (!nodes.some((node) => node.nodeId === `domain:${pkg.id}`)) {
      nodes.push({
        nodeId: `domain:${pkg.id}`,
        kind: 'domain',
        name: pkg.id,
        domain: pkg.id,
        owner: pkg.owner,
        sourcePath: pkg.filePath,
        sourceTier: 'business_context',
        provenance: 'DQL Domain Package',
        payload: { parent: pkg.parent, exports: pkg.exports },
      });
    }
    if (pkg.parent) edges.push({ src: `domain:${pkg.parent}`, dst: `domain:${pkg.id}`, kind: 'parent_domain' });
  }

  for (const area of Object.values(modeling.areas)) {
    const nodeId = `model_area:${area.qualifiedId}`;
    nodes.push({
      nodeId,
      kind: 'model_area',
      name: area.name,
      domain: area.domain,
      description: area.description,
      examples: area.intentExamples.map((question) => ({ question })),
      sourcePath: area.sourcePath,
      sourceTier: 'business_context',
      provenance: 'DQL focused Model Area',
      llmContext: [
        area.description ? `scope: ${area.description}` : '',
        area.intentExamples.length ? `example questions: ${area.intentExamples.join('; ')}` : '',
      ].filter(Boolean).join('\n'),
      payload: { ...area },
    });
    edges.push({ src: `domain:${area.domain}`, dst: nodeId, kind: 'contains' });
  }

  for (const concept of Object.values(modeling.concepts ?? {})) {
    const nodeId = `concept:${concept.qualifiedId}`;
    nodes.push({
      nodeId,
      kind: 'concept',
      name: concept.name,
      domain: concept.domain,
      status: concept.status,
      description: concept.description,
      entities: concept.bindings.map((binding) => binding.entity),
      sourcePath: concept.sourcePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(concept.status),
      provenance: concept.origin === 'ai_draft' ? 'DQL business concept (AI draft)' : 'DQL business concept',
      llmContext: [
        concept.description ?? '',
        concept.synonyms.length ? `also called: ${concept.synonyms.join(', ')}` : '',
        `bindings: ${concept.bindings.map((binding) => `${binding.entity} (${binding.role}${binding.grain ? `, ${binding.grain}` : ''})`).join('; ')}`,
        concept.rule ? `rule: ${concept.rule}` : '',
      ].filter(Boolean).join('\n'),
      payload: { ...concept },
    });
    edges.push({ src: `domain:${concept.domain}`, dst: nodeId, kind: 'contains' });
    for (const binding of concept.bindings) edges.push({ src: nodeId, dst: entityNodeId(binding.entity), kind: 'binds' });
  }

  for (const entity of Object.values(modeling.entities)) {
    const nodeId = `entity:${entity.qualifiedId ?? entity.id}`;
    const dbtNode = manifest.dbtProvenance?.nodes[entity.dbtUniqueId];
    nodes.push({
      nodeId,
      kind: 'entity',
      name: entity.localId ?? entity.id,
      domain: entity.domain,
      status: entity.status,
      grain: entity.grain,
      entities: [entity.qualifiedId ?? entity.id],
      sourcePath: entity.sourcePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(entity.status),
      provenance: 'DQL analytical entity binding',
      llmContext: [
        `dbt unique id: ${entity.dbtUniqueId}`,
        entity.grain ? `grain: ${entity.grain}` : '',
        entity.keys.length ? `keys: ${entity.keys.join(', ')}` : '',
        entity.analyticalRole ? `role: ${entity.analyticalRole}` : '',
      ].filter(Boolean).join('\n'),
      payload: { ...entity, relation: dbtNode?.relation },
    });
    edges.push({ src: `domain:${entity.domain}`, dst: nodeId, kind: 'contains' });
    if (entity.areaId) edges.push({ src: `model_area:${entity.areaId}`, dst: nodeId, kind: 'contains' });
    const dbtNodeId = `dbt_model:${entity.dbtUniqueId}`;
    if (!nodes.some((node) => node.nodeId === dbtNodeId)) {
      nodes.push({
        nodeId: dbtNodeId,
        kind: 'dbt_model',
        name: dbtNode?.name ?? entity.dbtUniqueId,
        sourcePath: dbtNode?.sourcePath,
        sourceTier: 'dbt_manifest',
        provenance: 'dbt manifest.json',
        payload: dbtNode ? { ...dbtNode } : { uniqueId: entity.dbtUniqueId },
      });
    }
    edges.push({ src: nodeId, dst: dbtNodeId, kind: 'binds_to' });
  }

  for (const relationship of Object.values(modeling.relationships)) {
    const nodeId = `relationship:${relationship.qualifiedId ?? relationship.id}`;
    nodes.push({
      nodeId,
      kind: 'relationship',
      name: relationship.localId ?? relationship.id,
      domain: relationship.ownerDomain,
      status: relationship.staleCertification ? 'stale_certification' : relationship.status,
      owner: relationship.owner,
      description: relationship.description ?? relationship.rationale,
      sourcePath: relationship.sourcePath,
      sourceTier: 'business_context',
      certification: relationship.automaticJoinAllowed ? 'certified' : certificationFromStatus(relationship.status),
      provenance: 'DQL governed analytical relationship',
      llmContext: [
        `${relationship.from} -> ${relationship.to}`,
        `keys: ${relationship.keys.map((key) => `${key.from}=${key.to}`).join(', ')}`,
        `cardinality: ${relationship.cardinality}`,
        `fanout: ${relationship.fanout}`,
        `automatic join: ${relationship.automaticJoinAllowed ? 'allowed' : 'blocked'}`,
      ].join('\n'),
      payload: { ...relationship },
    });
    edges.push({ src: entityNodeId(relationship.from), dst: nodeId, kind: 'proves_join' });
    edges.push({ src: nodeId, dst: entityNodeId(relationship.to), kind: 'proves_join' });
    if (relationship.areaId) edges.push({ src: `model_area:${relationship.areaId}`, dst: nodeId, kind: 'contains' });
  }

  for (const contract of Object.values(modeling.contracts)) {
    const nodeId = `contract:${contract.qualifiedId ?? contract.id}`;
    nodes.push({
      nodeId,
      kind: 'contract',
      name: contract.localId ?? contract.id,
      domain: contract.domain,
      status: contract.status,
      owner: contract.owner,
      grain: contract.grain,
      dimensions: contract.dimensions,
      allowedFilters: contract.allowedFilters,
      sourcePath: contract.sourcePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(contract.status),
      provenance: 'DQL analytical contract',
      payload: { ...contract },
    });
    edges.push({ src: `domain:${contract.domain}`, dst: nodeId, kind: 'contains' });
    for (const entity of contract.entities) edges.push({ src: entityNodeId(entity), dst: nodeId, kind: 'governed_by' });
    for (const block of contract.blocks) edges.push({ src: nodeId, dst: `block:${block}`, kind: 'governed_by' });
  }

  for (const exported of Object.values(modeling.interfaces?.exports ?? {})) {
    const ref = `${exported.domain}.${exported.localId}@${exported.version}`;
    const nodeId = `domain_export:${ref}`;
    nodes.push({
      nodeId,
      kind: 'domain_export',
      name: ref,
      domain: exported.domain,
      status: exported.status,
      owner: exported.owner,
      sourcePath: exported.sourcePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(exported.status),
      provenance: 'DQL domain export interface',
      payload: { ...exported },
    });
    edges.push({ src: `domain:${exported.domain}`, dst: nodeId, kind: 'exports' });
    if (exported.entity) edges.push({ src: entityNodeId(exported.entity), dst: nodeId, kind: 'exports' });
  }

  for (const imported of Object.values(modeling.interfaces?.imports ?? {})) {
    const nodeId = `domain_import:${imported.qualifiedId ?? imported.id}`;
    nodes.push({
      nodeId,
      kind: 'domain_import',
      name: imported.localId ?? imported.id,
      domain: imported.domain,
      status: imported.status,
      owner: imported.owner,
      sourcePath: imported.sourcePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(imported.status),
      provenance: 'DQL domain import interface',
      payload: { ...imported },
    });
    edges.push({ src: `domain:${imported.domain}`, dst: nodeId, kind: 'imports' });
    edges.push({ src: `domain_export:${imported.exportRef}`, dst: nodeId, kind: 'imports' });
  }

  for (const declaration of Object.values(modeling.conformance)) {
    const nodeId = `conformance:${declaration.qualifiedId ?? declaration.id}`;
    nodes.push({
      nodeId,
      kind: 'conformance',
      name: declaration.localId ?? declaration.id,
      domain: declaration.domain,
      sourcePath: declaration.sourcePath,
      sourceTier: 'business_context',
      provenance: 'DQL conformance declaration',
      llmContext: declaration.rule,
      payload: { ...declaration },
    });
    for (const entity of declaration.entities) edges.push({ src: entityNodeId(entity), dst: nodeId, kind: 'conforms_with' });
  }

  for (const rule of Object.values(modeling.rules)) {
    const nodeId = `policy:${rule.qualifiedId ?? rule.id}`;
    nodes.push({
      nodeId,
      kind: 'policy',
      name: rule.localId ?? rule.id,
      domain: rule.domain,
      sourcePath: rule.sourcePath,
      sourceTier: 'business_context',
      provenance: 'DQL analytical policy',
      llmContext: rule.expression,
      payload: { ...rule },
    });
    edges.push({ src: `domain:${rule.domain}`, dst: nodeId, kind: 'contains' });
  }
}

function certificationFromStatus(status: string | undefined): KGCertification {
  const label = trustLabelIdForStatus(status);
  return !status && label === 'insufficient_context' ? 'ai_generated' : label;
}

function termTags(term: ManifestTerm): string[] {
  return Array.from(new Set([
    ...(term.tags ?? []),
    term.termType,
    ...(term.identifiers ?? []),
    ...(term.synonyms ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

function renderTermContext(term: ManifestTerm): string | undefined {
  return [
    term.termType ? `type: ${term.termType}` : '',
    term.identifiers?.length ? `identifiers: ${term.identifiers.join(', ')}` : '',
    term.synonyms?.length ? `synonyms: ${term.synonyms.join(', ')}` : '',
    term.businessRules?.length ? `business rules: ${term.businessRules.join('; ')}` : '',
    term.caveats?.length ? `caveats: ${term.caveats.join('; ')}` : '',
  ].filter(Boolean).join('\n') || undefined;
}

function renderBusinessViewContext(view: ManifestBusinessView): string | undefined {
  return [
    view.termRefs?.length ? `terms: ${view.termRefs.join(', ')}` : '',
    view.blockRefs?.length ? `blocks: ${view.blockRefs.join(', ')}` : '',
    view.businessViewRefs?.length ? `business views: ${view.businessViewRefs.join(', ')}` : '',
    view.businessRules?.length ? `business rules: ${view.businessRules.join('; ')}` : '',
    view.caveats?.length ? `caveats: ${view.caveats.join('; ')}` : '',
  ].filter(Boolean).join('\n') || undefined;
}

/**
 * Every identifier a project has actually declared a domain under.
 *
 * Deliberately generous — package ids, their trailing segment, and the legacy
 * name-keyed `manifest.domains` map. A value listed here keeps today's
 * behaviour; a value missing from it only ever loses its *filtering* authority,
 * never its retrievability. Erring wide therefore cannot hide a metric, while
 * erring narrow could.
 */
export function declaredDomainIds(manifest: DQLManifest): Set<string> {
  const ids = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) ids.add(trimmed.toLowerCase());
  };
  for (const [key, pkg] of Object.entries(manifest.modeling?.packages ?? {})) {
    add(key);
    add(pkg?.id);
    // A nested package id is dot-qualified (`growth.acquisition`); accept the
    // trailing segment too, since a dbt group or folder is usually named for
    // the sub-domain alone rather than its full path.
    add(pkg?.id?.split('.').pop());
  }
  for (const [key, domain] of Object.entries(manifest.domains ?? {})) {
    add(key);
    add(domain?.id);
    add(domain?.name);
  }
  return ids;
}

/**
 * @param declaredDomains ids of the domains declared under `domains/`. A
 * dbt-derived domain is only allowed to become the governed `domain` (the field
 * retrieval filters on) when it names one of these. Anything else is recorded as
 * `sourceDomain` and leaves `domain` unset, so an unreconciled metric stays
 * retrievable instead of silently vanishing when a domain is pinned.
 */
export function buildKGFromSemanticLayer(layer: SemanticLayer | undefined, declaredDomains?: Iterable<string>): {
  nodes: KGNode[];
  edges: KGEdge[];
} {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];
  if (!layer) return { nodes, edges };
  // An EMPTY declared set means the project declares no domains at all, so
  // there is nothing to reconcile against and nothing can be pinned. Treat that
  // as "no reconciliation" rather than "nothing is governed" — the latter would
  // strip every domain from every semantic object for the majority of projects.
  const declaredList = declaredDomains ? [...declaredDomains].map((id) => id.trim().toLowerCase()).filter(Boolean) : [];
  const declared = declaredList.length > 0 ? new Set(declaredList) : undefined;
  /** Split a dbt-derived domain into the governed field and the provenance field. */
  const governDomain = (value: string | undefined): { domain?: string; sourceDomain?: string } => {
    const derived = value?.trim() || undefined;
    if (!derived) return {};
    if (!declared) return { domain: derived, sourceDomain: derived };
    return declared.has(derived.toLowerCase())
      ? { domain: derived, sourceDomain: derived }
      : { sourceDomain: derived };
  };

  const semanticMeasures = layer.listMeasures();
  const semanticDimensions = layer.listDimensions(undefined, { includeVariants: true });
  const semanticModels = layer.listSemanticModels();
  const measuresByName = new Map<string, (typeof semanticMeasures)[number][]>();
  for (const measure of semanticMeasures) {
    for (const key of [measure.name, qualifiedSemanticName(measure.cube, measure.name)]) {
      const current = measuresByName.get(key) ?? [];
      if (!current.some((candidate) => candidate === measure)) current.push(measure);
      measuresByName.set(key, current);
    }
  }

  for (const metric of layer.listMetrics(undefined, { includeMeasures: false, includeVariants: true })) {
    const model = semanticModels.find((candidate) => candidate.name === metric.cube);
    // CONTRACT-002 / AGT-014: the agent sees the same model-qualified
    // compatibility projection as the UI. An unowned metric must never fall
    // back to every global dimension.
    const availableDimensions = (() => {
      try {
        return layer.explainCompatibleDimensions([metric.name]).compatible;
      } catch {
        return [];
      }
    })();
    // Preserve model-declared members when an adapter supplied a bounded model
    // contract but flattened dimension records are unavailable. This is still
    // model-scoped; an unowned metric never receives global dimensions.
    const modelDimensionNames = Array.from(new Set([
      ...(model?.dimensions ?? []),
      ...(model?.timeDimensions ?? []),
      ...availableDimensions.map((dimension) => dimension.name),
    ]));
    const qualifiedDimensions = modelDimensionNames.map((name) => {
      const dimension = availableDimensions.find((candidate) => candidate.name === name);
      const identity = semanticIdentityPayload('dimension', dimension ?? {
        name,
        domain: metric.domain ?? model?.domain,
        cube: metric.cube,
      });
      return stringValue(identity.registryQualifiedId)
        ?? stringValue(identity.qualifiedId)
        ?? qualifiedSemanticName(metric.cube, name);
    });
    const hasTimeDimension = (model?.timeDimensions.length ?? 0) > 0
      || availableDimensions.some((dimension) => dimension.isTimeDimension || dimension.type === 'date');
    const backingCandidates = semanticMetricBackingMeasureNames(metric)
      .flatMap((name) => measuresByName.get(name) ?? [])
      .filter((measure, index, values) => values.indexOf(measure) === index);
    const scopedBackingMeasures = metric.cube
      ? backingCandidates.filter((measure) => measure.cube === metric.cube)
      : backingCandidates;
    const backingMeasures = scopedBackingMeasures.length > 0 ? scopedBackingMeasures : backingCandidates;
    const nonAdditiveMeasures = backingMeasures
      .filter((measure) => Boolean(measure.nonAdditiveDimension))
      .map((measure) => ({
        name: measure.name,
        table: measure.table,
        expression: measure.expr,
        nonAdditiveDimension: measure.nonAdditiveDimension,
      }));
    const nonAdditiveDimensions = backingMeasures
      .map((measure) => measure.nonAdditiveDimension)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    const analyticalCapability = buildSemanticMetricCapability({
      layer,
      metric,
      model,
      backingMeasures,
    });
    const nodeId = `metric:${qualifiedSemanticName(metric.cube, metric.name)}`;
    nodes.push({
      nodeId,
      kind: 'metric',
      name: qualifiedSemanticName(metric.cube, metric.name),
      ...governDomain(metric.domain),
      status: metric.status,
      owner: metric.owner,
      description: metric.description,
      tags: metric.tags ?? [],
      ...businessMetadataFromRaw(metric.source?.extra?.raw),
      llmContext: [
        metric.label ? `label: ${metric.label}` : '',
        metric.metricType ? `metric type: ${metric.metricType}` : '',
        metric.aggregation ? `aggregation: ${metric.aggregation}` : '',
        metric.semanticModelIds?.length ? `semantic models: ${metric.semanticModelIds.join(', ')}` : '',
        // The dimensions this metric can actually be grouped by. `payload.dimensions`
        // has carried them all along but was never rendered, so the SQL-generating
        // lane saw metrics and dimensions as two unlinked lists and could pair an
        // incompatible one -- producing a WRONG NUMBER rather than the clean refusal
        // the semantic lane gives. Bounded so a wide model cannot flood the prompt.
        qualifiedDimensions.length > 0
          ? `groupable by: ${qualifiedDimensions.slice(0, 40).join(', ')}${qualifiedDimensions.length > 40 ? `, +${qualifiedDimensions.length - 40} more` : ''}`
          : '',
        metric.table ? `table: ${metric.table}` : '',
        metric.sql ? `sql: ${metric.sql}` : '',
        nonAdditiveDimensions.length > 0 ? 'non-additive: semantic runtime required' : '',
      ].filter(Boolean).join('\n') || undefined,
      payload: {
        ...semanticIdentityPayload('metric', metric),
        metricType: metric.metricType,
        aggregation: metric.aggregation,
        table: metric.table,
        formula: metric.sql,
        aggTimeDimension: metric.aggTimeDimension,
        semanticModelIds: metric.semanticModelIds ?? (metric.cube ? [metric.cube] : []),
        backingMeasureNames: backingMeasures.map((measure) => measure.name),
        nonAdditiveMeasures,
        nonAdditiveDimensions,
        dimensions: qualifiedDimensions,
        entities: model?.entities ?? [],
        timeGrains: hasTimeDimension
          ? ["day", "week", "month", "quarter", "year"]
          : [],
        analyticalCapability,
      },
      sourceTier: 'semantic_layer',
      certification: certificationFromStatus(metric.status),
      provenance: metric.source?.provider === 'dbt'
        ? `dbt ${metric.source.objectType}`
        : metric.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(metric.source?.extra),
    });
    for (const modelId of metric.semanticModelIds ?? (metric.cube ? [metric.cube] : [])) {
      edges.push({ src: nodeId, dst: `semantic_model:${modelId}`, kind: 'depends_on' });
    }
  }

  // PERF-001: dbt fallback semantics may expose every physical column as a
  // synthetic dimension. At enterprise scale the model nodes already retain
  // their bounded column lists; duplicating 300k dimensions into KG + FTS is
  // both semantically noisy and several gigabytes of local state.
  const indexedDimensions = semanticDimensions.length <= 50_000 ? semanticDimensions : [];
  for (const dimension of indexedDimensions) {
    const nodeId = `dimension:${qualifiedSemanticName(dimension.cube, dimension.name)}`;
    nodes.push({
      nodeId,
      kind: 'dimension',
      name: qualifiedSemanticName(dimension.cube, dimension.name),
      ...governDomain(dimension.domain),
      status: dimension.status,
      owner: dimension.owner,
      description: dimension.description,
      tags: dimension.tags ?? [],
      ...businessMetadataFromRaw(dimension.source?.extra?.raw),
      llmContext:
        [
          dimension.label ? `label: ${dimension.label}` : "",
          dimension.type ? `type: ${dimension.type}` : "",
          dimension.table ? `table: ${dimension.table}` : "",
          dimension.sql ? `sql: ${dimension.sql}` : "",
        ]
          .filter(Boolean)
          .join("\n") || undefined,
      payload: {
        ...semanticIdentityPayload("dimension", dimension),
        table: dimension.table,
        expression: dimension.expr ?? dimension.sql,
        dimensionType: dimension.type,
        entityLink: dimension.entityLink,
        qualifiedName: dimension.qualifiedName,
        isTimeDimension: dimension.isTimeDimension,
        ...(isTimeDimension(dimension)
          ? {
              granularities: dimension.granularities,
              primaryTime: dimension.primaryTime,
              timeRole: authoredTimeRole(dimension),
            }
          : {}),
      },
      sourceTier: "semantic_layer",
      certification: certificationFromStatus(dimension.status),
      provenance: dimension.source?.provider === 'dbt'
        ? `dbt ${dimension.source.objectType}`
        : dimension.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(dimension.source?.extra),
    });
    if (dimension.cube) edges.push({ src: nodeId, dst: `semantic_model:${dimension.cube}`, kind: 'depends_on' });
  }

  for (const measure of semanticMeasures) {
    const nodeId = `measure:${qualifiedSemanticName(measure.cube, measure.name)}`;
    nodes.push({
      nodeId,
      kind: 'measure',
      name: qualifiedSemanticName(measure.cube, measure.name),
      ...governDomain(measure.domain),
      status: semanticObjectStatus(measure),
      owner: measure.owner,
      description: measure.description,
      tags: measure.tags ?? [],
      ...businessMetadataFromRaw(measure.source?.extra?.raw),
      llmContext: [
        measure.label ? `label: ${measure.label}` : '',
        measure.agg ? `aggregation: ${measure.agg}` : '',
        measure.table ? `table: ${measure.table}` : '',
        measure.expr ? `expr: ${measure.expr}` : '',
        measure.aggTimeDimension ? `agg_time_dimension: ${measure.aggTimeDimension}` : '',
        measure.nonAdditiveDimension ? `non-additive dimension: ${JSON.stringify(measure.nonAdditiveDimension)}` : '',
      ].filter(Boolean).join('\n') || undefined,
      payload: {
        ...semanticIdentityPayload('measure', measure),
        aggregation: measure.agg,
        table: measure.table,
        expression: measure.expr,
        aggTimeDimension: measure.aggTimeDimension,
        nonAdditiveDimension: measure.nonAdditiveDimension,
      },
      sourceTier: 'semantic_layer',
      certification: certificationFromStatus(semanticObjectStatus(measure)),
      provenance: measure.source?.provider === 'dbt'
        ? `dbt ${measure.source.objectType}`
        : measure.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(measure.source?.extra),
    });
    if (measure.cube) edges.push({ src: nodeId, dst: `semantic_model:${measure.cube}`, kind: 'contains' });
  }

  for (const entity of layer.listEntities()) {
    const nodeId = `entity:${qualifiedSemanticName(entity.cube, entity.name)}`;
    nodes.push({
      nodeId,
      kind: 'entity',
      name: qualifiedSemanticName(entity.cube, entity.name),
      ...governDomain(entity.domain),
      status: semanticObjectStatus(entity),
      owner: entity.owner,
      description: entity.description,
      tags: entity.tags ?? [],
      ...businessMetadataFromRaw(entity.source?.extra?.raw),
      llmContext: [
        entity.label ? `label: ${entity.label}` : '',
        entity.type ? `type: ${entity.type}` : '',
        entity.table ? `table: ${entity.table}` : '',
        entity.expr ? `expr: ${entity.expr}` : '',
      ].filter(Boolean).join('\n') || undefined,
      payload: semanticIdentityPayload('entity', entity),
      sourceTier: 'semantic_layer',
      certification: certificationFromStatus(semanticObjectStatus(entity)),
      provenance: entity.source?.provider === 'dbt'
        ? `dbt ${entity.source.objectType}`
        : entity.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(entity.source?.extra),
    });
    if (entity.cube) edges.push({ src: nodeId, dst: `semantic_model:${entity.cube}`, kind: 'contains' });
  }

  for (const model of layer.listSemanticModels()) {
    const nodeId = `semantic_model:${model.name}`;
    nodes.push({
      nodeId,
      kind: 'semantic_model',
      name: model.name,
      ...governDomain(model.domain),
      status: semanticObjectStatus(model),
      owner: model.owner,
      description: model.description,
      tags: model.tags ?? [],
      ...businessMetadataFromRaw(model.source?.extra?.raw),
      llmContext: [
        model.label ? `label: ${model.label}` : '',
        model.table ? `table: ${model.table}` : '',
        model.model ? `model: ${model.model}` : '',
        model.entities.length ? `entities: ${model.entities.join(', ')}` : '',
        model.measures.length ? `measures: ${model.measures.join(', ')}` : '',
        model.dimensions.length ? `dimensions: ${model.dimensions.join(', ')}` : '',
        model.timeDimensions.length ? `time_dimensions: ${model.timeDimensions.join(', ')}` : '',
      ].filter(Boolean).join('\n') || undefined,
      payload: semanticIdentityPayload('model', model),
      sourceTier: 'semantic_layer',
      certification: certificationFromStatus(semanticObjectStatus(model)),
      provenance: model.source?.provider === 'dbt'
        ? `dbt ${model.source.objectType}`
        : model.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(model.source?.extra),
    });
    if (model.table) edges.push({ src: nodeId, dst: `dbt_model:${model.table}`, kind: 'depends_on' });
  }

  for (const query of layer.listSavedQueries()) {
    const nodeId = `saved_query:${query.name}`;
    nodes.push({
      nodeId,
      kind: 'saved_query',
      name: query.name,
      ...governDomain(query.domain),
      status: semanticObjectStatus(query),
      owner: query.owner,
      description: query.description,
      tags: query.tags ?? [],
      ...businessMetadataFromRaw(query.source?.extra?.raw),
      llmContext: [
        query.label ? `label: ${query.label}` : '',
        query.metrics.length ? `metrics: ${query.metrics.join(', ')}` : '',
        query.dimensions.length ? `dimensions: ${query.dimensions.join(', ')}` : '',
        query.timeDimension ? `time_dimension: ${query.timeDimension}` : '',
        query.granularity ? `granularity: ${query.granularity}` : '',
      ].filter(Boolean).join('\n') || undefined,
      payload: semanticIdentityPayload('saved_query', query),
      sourceTier: 'semantic_layer',
      certification: certificationFromStatus(semanticObjectStatus(query)),
      provenance: query.source?.provider === 'dbt'
        ? `dbt ${query.source.objectType}`
        : query.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(query.source?.extra),
    });
    for (const metric of query.metrics) edges.push({ src: nodeId, dst: `metric:${metric}`, kind: 'depends_on' });
    for (const dimension of query.dimensions) edges.push({ src: nodeId, dst: `dimension:${dimension}`, kind: 'depends_on' });
  }

  return { nodes, edges };
}

/**
 * Project one semantic metric into the execution-neutral capability contract.
 * Every admitted fact comes from the semantic registry itself. An incomplete
 * model is intentionally left without a capability instead of being completed
 * from names or descriptions.
 *
 * Acceptance: CONTRACT-002, AGT-018.
 */
function buildSemanticMetricCapability(input: {
  layer: SemanticLayer;
  metric: MetricDefinition;
  model?: SemanticModelDefinition;
  backingMeasures: MeasureDefinition[];
}): MetricCapabilityContract | undefined {
  const { layer, metric, model, backingMeasures } = input;
  if (!model || !metric.cube || model.name !== metric.cube) return undefined;
  const cube =
    typeof (layer as { getCube?: unknown }).getCube === "function"
      ? layer.getCube(metric.cube)
      : undefined;
  const registryDimensions = layer
    .listDimensions(undefined, { includeVariants: true })
    .filter((dimension) => dimension.cube === metric.cube);
  const cubeDimensions = cube
    ? [...cube.dimensions, ...cube.timeDimensions]
    : [];
  const dimensionsByName = new Map<string, DimensionDefinition>();
  for (const dimension of [...registryDimensions, ...cubeDimensions]) {
    if (!dimensionsByName.has(dimension.name))
      dimensionsByName.set(dimension.name, dimension);
  }
  const declaredDimensionNames = [
    ...new Set([...model.dimensions, ...model.timeDimensions]),
  ];
  if (declaredDimensionNames.some((name) => !dimensionsByName.has(name)))
    return undefined;

  const metricIdentity = semanticIdentityPayload("metric", metric);
  const metricId = stringValue(metricIdentity.qualifiedId);
  const modelId = stringValue(
    semanticIdentityPayload("model", model).qualifiedId,
  );
  if (!metricId || !modelId) return undefined;

  const scopedEntities = layer
    .listEntities()
    .filter(
      (entity) =>
        entity.cube === metric.cube && model.entities.includes(entity.name),
    );
  const primaryEntities = scopedEntities.filter(
    (entity) => entity.type === "primary",
  );
  if (primaryEntities.length > 1) return undefined;
  const primaryEntity = primaryEntities[0];
  const primaryEntityId = primaryEntity
    ? registrySemanticIdentity(semanticIdentityPayload("entity", primaryEntity))
    : modelId;
  if (!primaryEntityId) return undefined;
  const entityIds = new Map(
    scopedEntities.flatMap((entity) => {
      const id = registrySemanticIdentity(semanticIdentityPayload("entity", entity));
      return id ? [[entity.name, id] as const] : [];
    }),
  );

  const timeNameSet = new Set(model.timeDimensions);
  const normalDimensions: MetricCapabilityContract["dimensions"] = [];
  const timeDimensions: MetricCapabilityContract["timeDimensions"] = [];
  const authoredDefaultNames = [
    metric.aggTimeDimension,
    cube?.defaultTimeDimension,
    ...backingMeasures.map((measure) => measure.aggTimeDimension),
  ].filter((value): value is string => Boolean(value?.trim()));
  const primaryTimeFallbackNames = [...dimensionsByName.values()]
    .filter((dimension) => isTimeDimension(dimension) && dimension.primaryTime)
    .map((dimension) => dimension.name);
  // An explicit metric/model aggregate time dimension is stronger than a
  // generic primary-time marker. Combining both made two dimensions default
  // for the same scalar request and forced a false clarification.
  const explicitDefaultNames = new Set(
    authoredDefaultNames.length > 0 ? authoredDefaultNames : primaryTimeFallbackNames,
  );
  const compatibleDimensions = (() => {
    try {
      return layer.explainCompatibleDimensions([metric.name]).compatible;
    } catch {
      return [];
    }
  })();

  for (const name of declaredDimensionNames) {
    const dimension = dimensionsByName.get(name)!;
    const dimensionId = registrySemanticIdentity(
      semanticIdentityPayload("dimension", dimension),
    );
    if (!dimensionId) return undefined;
    const entityId: string | undefined = dimension.entityLink
      ? entityIds.get(dimension.entityLink)
      : primaryEntityId;
    if (!entityId) return undefined;
    const timeDimension = timeNameSet.has(name) || isTimeDimension(dimension);
    if (timeDimension) {
      const supportedGrains = isTimeDimension(dimension)
        ? [...new Set(dimension.granularities ?? [])]
        : [];
      if (supportedGrains.length === 0) return undefined;
      const defaultFor =
        explicitDefaultNames.has(name) ||
        (explicitDefaultNames.size === 0 && model.timeDimensions.length === 1)
          ? (["scalar", "trend", "comparison"] as const)
          : undefined;
      timeDimensions.push({
        dimensionId,
        role: authoredTimeRole(dimension) ?? dimensionId,
        supportedGrains,
        ...(defaultFor ? { defaultFor: [...defaultFor] } : {}),
      });
      continue;
    }
    // Dimensions declared on the metric's own semantic model remain at the
    // model's primary grain. Cross-model dimensions require a separately
    // normalized, governed relationship path and are not admitted here.
    if (entityId !== primaryEntityId) return undefined;
    const dimensionIdentity = semanticIdentityPayload("dimension", dimension);
    const nativeGrouping = compatibleDimensions.find((candidate) =>
      candidate.name === dimension.name
      && candidate.cube === dimension.cube);
    normalDimensions.push({
      dimensionId,
      entityId,
      supportedRoles: ["group_by", "filter", "display", "rank_entity"],
      ...(dimension.label ? { label: dimension.label } : {}),
      ...(Array.isArray(dimensionIdentity.aliases)
        ? { aliases: dimensionIdentity.aliases.filter((alias): alias is string => typeof alias === 'string') }
        : {}),
      ...(nativeGrouping?.qualifiedName
        ? { nativeGroupingReference: nativeGrouping.qualifiedName }
        : dimension.qualifiedName
          ? { nativeGroupingReference: dimension.qualifiedName }
          : nativeGrouping
            ? { nativeGroupingReference: dimension.name }
          : {}),
      ...(nativeGrouping?.entityPath
        ? { nativeGroupingPath: [...nativeGrouping.entityPath] }
        : {}),
    });
  }

  // Cross-model grouping authority comes only from the semantic adapter's
  // metric-relative compatibility result. Do not project the general catalog:
  // require an exact declared target-model dimension, one target entity, one
  // native grouping reference, and a non-empty entity path whose terminal
  // entity is that target. Ambiguous or merely lexical reachability is omitted.
  const compatibleReferenceCounts = new Map<string, number>();
  for (const dimension of compatibleDimensions) {
    if (!dimension.qualifiedName) continue;
    compatibleReferenceCounts.set(
      dimension.qualifiedName,
      (compatibleReferenceCounts.get(dimension.qualifiedName) ?? 0) + 1,
    );
  }
  const semanticModels = layer.listSemanticModels();
  const allEntities = layer.listEntities();
  for (const dimension of compatibleDimensions) {
    if (!dimension.cube || dimension.cube === metric.cube || isTimeDimension(dimension)) continue;
    const nativePath = dimension.entityPath;
    const nativeReference = dimension.qualifiedName;
    if (!nativeReference || !nativePath || nativePath.length === 0) continue;
    if (nativePath.some((part) => !part.trim())) continue;
    if (nativeReference !== [...nativePath, dimension.name].join('__')) continue;
    if (compatibleReferenceCounts.get(nativeReference) !== 1) continue;
    const targetModels = semanticModels.filter((candidate) =>
      candidate.name === dimension.cube
      && candidate.dimensions.includes(dimension.name));
    if (targetModels.length !== 1) continue;
    const targetEntities = allEntities.filter((entity) =>
      entity.cube === dimension.cube
      && (entity.type === 'primary' || entity.type === 'natural' || entity.type === 'unique')
      && (!dimension.entityLink || entity.name === dimension.entityLink));
    if (targetEntities.length !== 1) continue;
    const targetEntity = targetEntities[0]!;
    if (nativePath.at(-1) !== targetEntity.name) continue;
    const dimensionId = registrySemanticIdentity(semanticIdentityPayload('dimension', dimension));
    const entityId = registrySemanticIdentity(semanticIdentityPayload('entity', targetEntity));
    if (!dimensionId || !entityId) continue;
    const identity = semanticIdentityPayload('dimension', dimension);
    normalDimensions.push({
      dimensionId,
      entityId,
      supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
      ...(dimension.label ? { label: dimension.label } : {}),
      ...(Array.isArray(identity.aliases)
        ? { aliases: identity.aliases.filter((alias): alias is string => typeof alias === 'string') }
        : {}),
      nativeGroupingReference: nativeReference,
      nativeGroupingPath: [...nativePath],
    });
  }

  const nonAdditiveDimensionIds = backingMeasures.flatMap((measure) => {
    const raw = measure.nonAdditiveDimension?.name;
    if (typeof raw !== "string") return [];
    const dimension = dimensionsByName.get(raw);
    const id =
      dimension &&
      registrySemanticIdentity(semanticIdentityPayload("dimension", dimension));
    return id ? [id] : [];
  });
  const metricKind = (metric.metricType ?? metric.type ?? '').trim().toLowerCase();
  const declaredAggregation = metric.aggregation?.trim().toLowerCase();
  // dbt's `simple` describes how a semantic metric references one measure; it
  // is not an aggregation operator. Bind execution to the exact backing
  // measure operation so SUM revenue remains additive, while median and other
  // non-additive measures remain fail-closed. Derived/ratio metric kinds keep
  // their authored calculation semantics.
  const simpleMetric = metricKind === 'simple' || declaredAggregation === 'simple';
  const aggregation = simpleMetric
    ? backingMeasures.length === 1
      ? backingMeasures[0]!.agg?.trim().toLowerCase()
      : undefined
    : declaredAggregation ?? metricKind;
  if (!aggregation) return undefined;
  const completenessPolicy = authoredCompletenessPolicy(metric);
  const measureIds = backingMeasures.flatMap((measure) => {
    const id = registrySemanticIdentity(semanticIdentityPayload("measure", measure));
    return id ? [id] : [];
  });
  const additive = ["sum", "count"].includes(aggregation.toLowerCase());
  const capabilityWithoutFingerprint: Omit<
    MetricCapabilityContract,
    "sourceFingerprint"
  > = {
    metricId,
    semanticModelId: modelId,
    measureIds: measureIds.length > 0 ? [...new Set(measureIds)] : [metricId],
    primaryEntityId,
    defaultResultGrainId: primaryEntityId,
    resultGrainIds: [
      ...new Set([
        primaryEntityId,
        ...normalDimensions.map((dimension) => dimension.entityId),
      ]),
    ],
    aggregation,
    additivity: {
      entities: additive ? "additive" : "non_additive",
      time:
        nonAdditiveDimensionIds.length > 0
          ? "semi_additive"
          : additive
            ? "additive"
            : "non_additive",
      ...(nonAdditiveDimensionIds.length > 0
        ? { nonAdditiveDimensionIds: [...new Set(nonAdditiveDimensionIds)] }
        : {}),
    },
    dimensions: normalDimensions,
    timeDimensions,
    ...(completenessPolicy
      ? { freshness: { defaultCompletenessPolicy: completenessPolicy } }
      : {}),
    // Native DQL semantics can predicate an already-aggregated selected
    // metric. That is an operation capability, not an adapter fallback: the
    // App runtime still verifies that the exact active adapter advertises it
    // before compilation. MetricFlow/dbt capabilities stay withheld until
    // their provider path exposes an equivalent post-aggregate operation.
    operations: ["filter", "group", "trend", "rank", ...(metric.source?.provider === "dbt" ? [] : ["having" as const])],
    supportedOutputKinds: ["dimension", "metric_value", "rank"],
    executionCapabilities: [
      {
        route: "semantic",
        adapterId:
          // `native` is the execution-gateway adapter identity. The older
          // `semantic-native` catalog spelling was descriptive only and could
          // never match a target-bound native plan, leaving valid local DQL
          // semantic models un-runnable in App Studio.
          metric.source?.provider === "dbt" ? "metricflow" : "native",
      },
    ],
  };
  return {
    ...capabilityWithoutFingerprint,
    sourceFingerprint: `sha256:${createHash("sha256").update(stableJson(capabilityWithoutFingerprint)).digest("hex")}`,
  };
}

function isTimeDimension(
  dimension: DimensionDefinition,
): dimension is TimeDimensionDefinition {
  return Boolean(
    dimension.isTimeDimension ||
    dimension.source?.objectType === "time_dimension",
  );
}

function authoredTimeRole(dimension: DimensionDefinition): string | undefined {
  const raw = recordValue(dimension.source?.extra?.raw);
  const meta = recordValue(raw.meta);
  const dql = recordValue(meta.dql);
  return (
    stringValue(dql.time_role) ??
    stringValue(dql.timeRole) ??
    stringValue(meta.time_role) ??
    stringValue(meta.timeRole)
  );
}

function authoredCompletenessPolicy(
  metric: MetricDefinition,
): "partial_current" | "latest_complete" | "closed_period" | undefined {
  const raw = recordValue(metric.source?.extra?.raw);
  const meta = recordValue(raw.meta);
  const dql = recordValue(meta.dql);
  const value =
    stringValue(dql.completeness_policy) ??
    stringValue(dql.completenessPolicy) ??
    stringValue(meta.completeness_policy) ??
    stringValue(meta.completenessPolicy);
  return value === "partial_current" ||
    value === "latest_complete" ||
    value === "closed_period"
    ? value
    : undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function semanticMetricBackingMeasureNames(metric: {
  name: string;
  cube?: string;
  typeParams?: Record<string, unknown>;
}): string[] {
  const names = new Set<string>([metric.name, qualifiedSemanticName(metric.cube, metric.name)]);
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) names.add(value.trim());
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const name = (value as Record<string, unknown>).name;
      if (typeof name === 'string' && name.trim()) names.add(name.trim());
    }
  };
  add(metric.typeParams?.measure);
  const inputs = metric.typeParams?.input_measures;
  if (Array.isArray(inputs)) for (const input of inputs) add(input);
  return [...names];
}

function qualifiedSemanticName(cube: string | undefined, name: string): string {
  return cube ? `${cube}.${name}` : name;
}

/**
 * Canonical semantic registry identity carried into the immutable search
 * snapshot. A source-authored `meta.concept_id` wins; otherwise DQL derives a
 * deterministic domain-qualified ID while preserving native dbt IDs as exact
 * aliases. This is additive: legacy object keys remain stable during rollout.
 *
 * Acceptance: ID-001, CTX-005, AGT-013.
 */
function semanticIdentityPayload(
  kind: 'metric' | 'dimension' | 'measure' | 'entity' | 'model' | 'saved_query',
  item: {
    name: string;
    label?: string;
    domain?: string;
    cube?: string;
    isTimeDimension?: boolean;
    type?: string;
    granularities?: string[];
    source?: { objectId?: string; extra?: Record<string, unknown> };
  },
): Record<string, unknown> {
  const raw = recordValue(item.source?.extra?.raw);
  const meta = recordValue(raw.meta);
  const dqlMeta = recordValue(meta.dql);
  const authoredConceptId = stringValue(meta.concept_id)
    ?? stringValue(meta.conceptId)
    ?? stringValue(dqlMeta.concept_id)
    ?? stringValue(dqlMeta.conceptId);
  const domain = normalizeSemanticIdentityPart(item.domain ?? item.cube ?? 'uncategorized');
  const registryReference = item.cube
    ? qualifiedSemanticName(item.cube, item.name)
    : item.name;
  const localName = normalizeSemanticIdentityPart(item.name);
  const legacyDomainScopedDimensionId = `semantic:${domain}:dimension:${localName}`;
  // MetricFlow synthesizes a `metric_time` dimension for every semantic
  // model. A domain + local-name ID made all of those distinct compiler
  // capabilities collide in the retrieved Ask workspace. A time dimension
  // with a declared owning model therefore has the same model-qualified
  // canonical identity as the registry. The old domain/leaf form is retained
  // as a bounded alias below for persisted V1/V2 readers, never as a second
  // current capability.
  const declaredTimeDimension = item.isTimeDimension === true
    || item.type?.toLowerCase() === 'time'
    || item.type?.toLowerCase() === 'date'
    || (item.granularities?.length ?? 0) > 0;
  const modelQualifiedTimeDimensionId = kind === 'dimension'
    && declaredTimeDimension
    && item.cube
    ? `semantic:${domain}:dimension:${normalizeSemanticIdentityPart(registryReference)}`
    : undefined;
  // Metric IDs are execution identities carried by meaning resolution,
  // frozen plans, and MetricFlow/dbt capability receipts. Keep their
  // established `semantic:metric:<model>.<metric>` shape; rewriting them to
  // a domain-scoped shorthand breaks the handoff between retrieval and the
  // planner even though both strings describe the same metric.
  const legacyDomainScopedMetricId = `semantic:${domain}:${localName}`;
  const qualifiedId = authoredConceptId
    ?? (kind === 'metric'
      ? `semantic:metric:${normalizeSemanticIdentityPart(registryReference)}`
      : modelQualifiedTimeDimensionId
        ?? `semantic:${domain}:${kind}:${localName}`);
  const sourceNativeId = stringValue(item.source?.objectId);
  const registryQualifiedId = kind === 'metric' || kind === 'saved_query' || kind === 'model'
    ? qualifiedId
    : `semantic:${domain}:${kind}:${normalizeSemanticIdentityPart(registryReference)}`;
  const aliases = Array.from(new Set([
    item.name,
    item.label,
    item.cube ? qualifiedSemanticName(item.cube, item.name) : undefined,
    sourceNativeId,
    kind === 'metric' && legacyDomainScopedMetricId !== qualifiedId
      ? legacyDomainScopedMetricId
      : undefined,
    kind === 'dimension' && legacyDomainScopedDimensionId !== qualifiedId
      ? legacyDomainScopedDimensionId
      : undefined,
    // Upgrade bridge: prior snapshots persisted this domain-scoped identity.
    // It remains an exact alias, but only resolves when it is unique.
    registryQualifiedId !== qualifiedId ? qualifiedId : undefined,
  ].filter((value): value is string => Boolean(value?.trim()))));
  return {
    qualifiedId,
    registryQualifiedId,
    localId: item.name,
    registryReference,
    sourceNativeId,
    aliases,
  };
}

function registrySemanticIdentity(identity: Record<string, unknown>): string | undefined {
  return stringValue(identity.registryQualifiedId) ?? stringValue(identity.qualifiedId);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeSemanticIdentityPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function semanticSourcePath(extra: Record<string, unknown> | undefined): string | undefined {
  const path = extra?.path ?? (extra?.raw && typeof extra.raw === 'object' ? (extra.raw as Record<string, unknown>).original_file_path : undefined);
  return typeof path === 'string' ? path : undefined;
}

function semanticObjectStatus(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { status?: unknown };
  return typeof record.status === 'string' && record.status.trim().length > 0 ? record.status.trim() : undefined;
}

function renderColumnsContext(columns: Record<string, { name: string; description?: string; type?: string }>): string {
  const rendered = Object.values(columns)
    .slice(0, 80)
    .map((col) => `- ${col.name}${col.type ? ` (${col.type})` : ''}${col.description ? `: ${col.description}` : ''}`)
    .join('\n');
  return rendered ? `Columns:\n${rendered}` : '';
}

function renderSourceContext(source: ManifestSource): string | undefined {
  const model = source.dbtModel;
  if (!model) return undefined;
  const schemaQualified = model.schema ? `${model.schema}.${source.name}` : source.name;
  const databaseQualified = model.database && model.schema
    ? `${model.database}.${model.schema}.${source.name}`
    : undefined;
  return [
    `runtime relation: ${schemaQualified}`,
    databaseQualified && databaseQualified !== schemaQualified
      ? `dbt relation: ${databaseQualified}`
      : '',
    model.materializedAs ? `materialized as: ${model.materializedAs}` : '',
    model.columns ? renderColumnsContext(model.columns) : '',
  ].filter(Boolean).join('\n') || undefined;
}

function businessMetadataFromRaw(raw: unknown): Partial<KGNode> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const nested = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
  const value = (camel: string, snake: string): unknown => record[camel] ?? record[snake] ?? nested[camel] ?? nested[snake];
  return {
    businessOutcome: stringValue(value('businessOutcome', 'business_outcome')),
    businessOwner: stringValue(value('businessOwner', 'business_owner')),
    decisionUse: stringValue(value('decisionUse', 'decision_use')),
    reviewCadence: stringValue(value('reviewCadence', 'review_cadence')),
    businessRules: stringArrayValue(value('businessRules', 'business_rules')),
    caveats: stringArrayValue(value('caveats', 'caveats')),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : undefined;
}
