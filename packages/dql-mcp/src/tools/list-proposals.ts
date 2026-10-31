import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { DQLContext } from '../context.js';
import { loadSemanticMetricDraftsFromDir, type DimensionDefinition, type MetricDefinition, type SemanticLayer } from '@zlens/core';
import { zodInputShapeForTool } from '../tool-schema.js';

export const listProposalsInput = zodInputShapeForTool('list_proposals');

export interface ProposalSummary {
  kind: 'block_draft' | 'semantic_metric_draft' | 'semantic_recertification';
  artifactType: 'block' | 'metric' | 'dimension';
  draftPath: string;
  slug: string;
  question: string;
  askedTimes: number;
  firstAsked: string;
  lastAsked: string;
  proposedContractId: string;
  proposedDomain: string;
  proposedEntity: string;
  upstreamRefs: string[];
  sourceDqlArtifact?: ProposalSourceDqlArtifact;
  status?: string;
  certifyHint: string;
}

export interface ProposalSourceDqlArtifact {
  kind?: string;
  name?: string;
  path?: string;
  hash?: string;
  metrics: string[];
  dimensions: string[];
}

/**
 * The OSS-side review queue for the Tier-2 promotion loop. Reads
 * local draft queues from the project, parses Tier-2 proposal metadata fields
 * out of each, and returns a list ranked by `askedTimes`
 * descending — questions that get asked repeatedly are the strongest
 * candidates for certification.
 *
 * Multi-user team queues (RBAC, assignments, deadlines, audit logs) are
 * commercial-overlay features. This OSS tool reads files from disk and
 * commits to git when humans certify them. That's the shared store.
 */
export function listProposals(
  ctx: DQLContext,
  args: { askedAtLeastTimes?: number; since?: string } = {},
): { proposals: ProposalSummary[] } {
  const draftFiles = collectProposalDraftFiles(ctx.projectRoot);
  const minTimes = args.askedAtLeastTimes ?? 1;
  const sinceMs = args.since ? Date.parse(args.since) : null;

  const proposals: ProposalSummary[] = [];
  for (const draft of draftFiles) {
    const summary = parseProposal(readFileSync(draft.absPath, 'utf-8'), draft.filename, draft.relativePath);
    if (!summary) continue;
    if (summary.askedTimes < minTimes) continue;
    if (sinceMs !== null && Date.parse(summary.lastAsked) < sinceMs) continue;
    proposals.push(summary);
  }
  for (const summary of collectSemanticRecertificationProposals(ctx)) {
    if (summary.askedTimes < minTimes) continue;
    if (sinceMs !== null && (!Number.isFinite(Date.parse(summary.lastAsked)) || Date.parse(summary.lastAsked) < sinceMs)) continue;
    proposals.push(summary);
  }
  for (const summary of collectSemanticMetricDraftProposals(ctx)) {
    if (summary.askedTimes < minTimes) continue;
    if (sinceMs !== null && (!Number.isFinite(Date.parse(summary.lastAsked)) || Date.parse(summary.lastAsked) < sinceMs)) continue;
    proposals.push(summary);
  }

  proposals.sort((a, b) => {
    if (b.askedTimes !== a.askedTimes) return b.askedTimes - a.askedTimes;
    return dateSortValue(b.lastAsked) - dateSortValue(a.lastAsked);
  });

  return { proposals };
}

function collectProposalDraftFiles(projectRoot: string): Array<{ absPath: string; relativePath: string; filename: string }> {
  const files: Array<{ absPath: string; relativePath: string; filename: string }> = [];
  const addDraftDir = (relativeDir: string) => {
    const absDir = join(projectRoot, relativeDir);
    if (!existsSync(absDir)) return;
    for (const entry of safeReaddir(absDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.dql')) continue;
      files.push({
        absPath: join(absDir, entry.name),
        relativePath: `${relativeDir}/${entry.name}`,
        filename: entry.name,
      });
    }
  };

  addDraftDir('blocks/_drafts');
  const domainsDir = join(projectRoot, 'domains');
  if (existsSync(domainsDir)) {
    for (const entry of safeReaddir(domainsDir)) {
      if (!entry.isDirectory()) continue;
      addDraftDir(`domains/${entry.name}/blocks/_drafts`);
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function parseProposal(
  content: string,
  filename: string,
  draftPath: string,
): ProposalSummary | null {
  const slug = filename.replace(/\.dql$/, '');
  const question = pickStringField(content, 'description') ?? slug;
  const askedTimes = pickIntField(content, 'asked_times', 1);
  const firstAsked = pickStringField(content, 'first_asked') ?? '';
  const lastAsked = pickStringField(content, 'last_asked') ?? '';
  const proposedContractId = pickStringField(content, 'proposed_contract_id') ?? '';
  const proposedDomain = pickStringField(content, 'proposed_domain') ?? '';
  const proposedEntity = pickStringField(content, 'proposed_entity') ?? '';
  const upstreamRefs = pickArrayField(content, 'upstream_refs');
  const sourceDqlArtifact = parseSourceDqlArtifact(content);
  const certifyHint = `zlens certify --from-draft ${draftPath} --domain ${proposedDomain || '<domain>'} --contract ${proposedContractId || '<id>'}@1 --owner <you@example.com>`;
  return {
    kind: 'block_draft',
    artifactType: 'block',
    draftPath,
    slug,
    question,
    askedTimes,
    firstAsked,
    lastAsked,
    proposedContractId,
    proposedDomain,
    proposedEntity,
    upstreamRefs,
    ...(sourceDqlArtifact ? { sourceDqlArtifact } : {}),
    certifyHint,
  };
}

function collectSemanticRecertificationProposals(ctx: DQLContext): ProposalSummary[] {
  const layer = safeSemanticLayer(ctx);
  if (!layer) return [];
  const proposals: ProposalSummary[] = [];
  for (const metric of layer.listMetrics()) {
    if (metric.status !== 'pending_recertification') continue;
    proposals.push(semanticRecertificationProposal('metric', metric));
  }
  for (const dimension of layer.listDimensions()) {
    if (dimension.status !== 'pending_recertification') continue;
    proposals.push(semanticRecertificationProposal('dimension', dimension));
  }
  return proposals;
}

/** Metric drafts are never loaded into the layer (they answer nothing), so they are read from their folder. */
function collectSemanticMetricDraftProposals(ctx: DQLContext): ProposalSummary[] {
  const proposals: ProposalSummary[] = [];
  for (const metric of loadSemanticMetricDraftsFromDir(join(ctx.projectRoot, 'semantic-layer'))) {
    const path = semanticDefinitionPath(metric, 'metric');
    if (!isSemanticMetricDraftPath(path)) continue;
    proposals.push(semanticMetricDraftProposal(metric, path));
  }
  return proposals;
}

function safeSemanticLayer(ctx: DQLContext): SemanticLayer | null {
  try {
    return ctx.semanticLayer;
  } catch {
    return null;
  }
}

function semanticRecertificationProposal(
  kind: 'metric' | 'dimension',
  definition: MetricDefinition | DimensionDefinition,
): ProposalSummary {
  const path = semanticDefinitionPath(definition, kind);
  const label = kind === 'metric' ? 'metric' : 'dimension';
  const domain = kind === 'metric' ? (definition as MetricDefinition).domain : definition.domain;
  return {
    kind: 'semantic_recertification',
    artifactType: kind,
    draftPath: path,
    slug: definition.name,
    question: `Recertify semantic ${label} "${definition.name}" after upstream lineage or definition drift.`,
    askedTimes: 1,
    firstAsked: '',
    lastAsked: semanticImportedAt(definition) ?? '',
    proposedContractId: `semantic.${kind}.${definition.name}`,
    proposedDomain: domain ?? '',
    proposedEntity: definition.name,
    upstreamRefs: [definition.table].filter(Boolean),
    status: definition.status,
    certifyHint: `Review ${path}, rerun semantic validation, then set status to "certified" after human recertification.`,
  };
}

function semanticMetricDraftProposal(metric: MetricDefinition, path: string): ProposalSummary {
  const support = semanticSupportCount(metric);
  const lastAsked = semanticImportedAt(metric) ?? '';
  const donorBlocks = semanticStringArrayExtra(metric, 'donorBlocks');
  const donorPaths = semanticStringArrayExtra(metric, 'donorPaths');
  return {
    kind: 'semantic_metric_draft',
    artifactType: 'metric',
    draftPath: path,
    slug: metric.name,
    question: metric.description || `Review draft semantic metric "${metric.name}" for certification.`,
    askedTimes: support,
    firstAsked: lastAsked,
    lastAsked,
    proposedContractId: `semantic.metric.${metric.name}`,
    proposedDomain: metric.domain ?? '',
    proposedEntity: metric.name,
    upstreamRefs: [metric.table, ...donorPaths, ...donorBlocks].filter(Boolean),
    status: metric.status,
    // Approving is a person's act: an agent lists drafts but never approves them.
    certifyHint: `A person reviews ${path} (its expression, filter and value over all rows), then approves it with: zlens semantic approve ${metric.name}`,
  };
}

function semanticDefinitionPath(definition: MetricDefinition | DimensionDefinition, kind: 'metric' | 'dimension'): string {
  const path = definition.source?.extra?.path;
  if (typeof path === 'string' && path.trim().length > 0) {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    return normalized.startsWith('semantic-layer/') ? normalized : `semantic-layer/${normalized}`;
  }
  return `semantic-layer/${kind === 'metric' ? 'metrics' : 'dimensions'}/${definition.name}.yaml`;
}

function isSemanticMetricDraftPath(path: string): boolean {
  return /(^|\/)semantic-layer\/metrics\/_drafts\//.test(path.replace(/\\/g, '/'));
}

function semanticImportedAt(definition: MetricDefinition | DimensionDefinition): string | undefined {
  return typeof definition.source?.importedAt === 'string' ? definition.source.importedAt : undefined;
}

function semanticSupportCount(definition: MetricDefinition | DimensionDefinition): number {
  const support = definition.source?.extra?.support;
  if (typeof support === 'number' && Number.isFinite(support) && support > 0) return Math.floor(support);
  const donors = semanticStringArrayExtra(definition, 'donorBlocks');
  return Math.max(1, donors.length);
}

function semanticStringArrayExtra(definition: MetricDefinition | DimensionDefinition, key: string): string[] {
  const value = definition.source?.extra?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function dateSortValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSourceDqlArtifact(content: string): ProposalSourceDqlArtifact | undefined {
  const kind = pickStringField(content, 'source_dql_kind');
  const name = pickStringField(content, 'source_dql_name');
  const path = pickStringField(content, 'source_dql_path');
  const hash = pickStringField(content, 'source_dql_hash');
  const metrics = pickArrayField(content, 'source_dql_metrics');
  const dimensions = pickArrayField(content, 'source_dql_dimensions');
  if (!kind && !name && !path && !hash && metrics.length === 0 && dimensions.length === 0) {
    return undefined;
  }
  return {
    ...(kind ? { kind } : {}),
    ...(name ? { name } : {}),
    ...(path ? { path } : {}),
    ...(hash ? { hash } : {}),
    metrics,
    dimensions,
  };
}

function pickStringField(content: string, key: string): string | undefined {
  const m =
    content.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)) ||
    content.match(new RegExp(`${key}\\s*=\\s*"""([\\s\\S]*?)"""`));
  return m?.[1]?.trim();
}

function pickIntField(content: string, key: string, defaultValue: number): number {
  const m = content.match(new RegExp(`${key}\\s*=\\s*(\\d+)`));
  return m ? Number.parseInt(m[1], 10) : defaultValue;
}

function pickArrayField(content: string, key: string): string[] {
  const m = content.match(new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => s.length > 0);
}
