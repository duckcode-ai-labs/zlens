/**
 * Retrieval-health status (P0 architecture-review follow-through).
 *
 * The agent stack fails soft everywhere — value grounding silently disables
 * itself without an allowlist, embeddings silently fall back to hashed tokens,
 * caches grow without GC. Failing soft is right for availability and wrong for
 * diagnosability: "why is the agent dumb today" should be one glance, not a
 * debugging session. This module assembles a cheap, read-only report for
 * `zlens doctor` and `/api/health`. It never throws and never blocks.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultAgentRunSqlitePath,
  defaultMetadataPath,
  projectEmbeddingProvider,
  indexedVectorProviderId,
  readAgentRunStoreHealth,
  readMetadataCatalogHealth,
  type AgentRunStoreHealth,
  type MetadataCatalogHealth,
} from '@zlens/agent';

export interface DqlRetrievalHealthStatus {
  valueGrounding: {
    mode: 'safe_automatic' | 'disabled';
    searchSafeColumns: number;
    /** Present when disabled: what to configure to turn it on. */
    reason?: string;
  };
  embeddings: {
    providerId: string;
    semantic: boolean;
    /**
     * Present when the machine can do better than the lexical fallback but is
     * not doing so. "Why is retrieval dumb today" should be answerable at a
     * glance, and a hashed index on a machine with a real embedder installed
     * is the most common answer.
     */
    upgradeAvailable?: string;
  };
  catalog: MetadataCatalogHealth;
  runStore: AgentRunStoreHealth & { legacyJsonBytes?: number };
  snapshots: { count: number; totalBytes: number };
  warnings: string[];
}

export function resolveRetrievalHealthStatus(input: {
  projectRoot: string;
  valueGroundingMode: 'safe_automatic' | 'disabled';
  searchSafeColumnCount: number;
}): DqlRetrievalHealthStatus {
  const warnings: string[] = [];

  const valueGrounding: DqlRetrievalHealthStatus['valueGrounding'] = {
    mode: input.valueGroundingMode,
    searchSafeColumns: input.searchSafeColumnCount,
    ...(input.valueGroundingMode === 'disabled'
      ? { reason: 'Set agent.runtimeValueGrounding.mode to "safe_automatic" with an explicit searchSafeColumns allowlist (schema.table.column, no wildcards) in dql.config.json.' }
      : {}),
  };
  if (input.valueGroundingMode === 'disabled') {
    warnings.push('Runtime value grounding is DISABLED: member values (e.g. a customer name) cannot be probed against real column values, so typed filters lean on prior results only.');
  }

  let providerId = 'hashed-token-v1';
  try {
    // Report the provider the INDEX was built with, falling back to the one
    // the project resolves to.
    //
    // Two earlier versions of this line were each wrong in a way that made the
    // report actively misleading: the env-only resolver claimed "hashed
    // fallback" on projects configured for real embeddings, and the project
    // resolver claimed the same on a project whose index had ALREADY been
    // re-embedded by the background upgrade. Retrieval reads the index, so the
    // index is what doctor should describe.
    providerId = indexedVectorProviderId(input.projectRoot) ?? projectEmbeddingProvider(input.projectRoot).id;
  } catch { /* keep the deterministic default */ }
  const semantic = !providerId.startsWith('hashed-token');
  let embeddingUpgrade: string | undefined;
  if (!semantic) {
    warnings.push('Embeddings are the deterministic hashed fallback: paraphrase matching is lexical-only. Run a local Ollama embedding model or set an OpenAI key for semantic recall.');
    embeddingUpgrade = 'Turn on local Ollama embeddings in Settings → AI provider → Search (it pulls nomic-embed-text and re-embeds'
      + ' the index; nothing leaves this computer), or set ai.embeddings in dql.config.json. ZLens never switches by itself;'
      + ' ZLENS_EMBEDDINGS_AUTODETECT=on lets a server adopt a local model it finds.';
  }

  const catalog = readMetadataCatalogHealth(defaultMetadataPath(input.projectRoot));
  if (!catalog.exists) {
    warnings.push('Metadata catalog is missing — run zlens compile (or ask once) to build the agent index.');
  } else if ((catalog.contextPackBytes ?? 0) > 100 * 1024 * 1024) {
    warnings.push(`Cached context packs occupy ${formatBytes(catalog.contextPackBytes ?? 0)} — consider clearing .dql/cache/metadata.sqlite (it rebuilds automatically).`);
  }

  const runStorePath = defaultAgentRunSqlitePath(input.projectRoot);
  const runStore: DqlRetrievalHealthStatus['runStore'] = readAgentRunStoreHealth(runStorePath);
  const legacyJson = join(input.projectRoot, '.dql', 'local', 'agent-runs.json');
  if (existsSync(legacyJson)) {
    try {
      runStore.legacyJsonBytes = statSync(legacyJson).size;
    } catch { /* advisory */ }
    warnings.push('Legacy agent-runs.json still present — it migrates to SQLite on the next server start.');
  }

  const snapshots = snapshotStoreStats(join(input.projectRoot, '.dql', 'cache', 'snapshots'));
  if (snapshots.totalBytes > 500 * 1024 * 1024) {
    warnings.push(`Immutable metadata snapshots occupy ${formatBytes(snapshots.totalBytes)} (${snapshots.count} files) — old snapshots are never garbage-collected yet; safe to delete .dql/cache/snapshots.`);
  }

  return {
    valueGrounding,
    embeddings: { providerId, semantic, ...(embeddingUpgrade ? { upgradeAvailable: embeddingUpgrade } : {}) },
    catalog,
    runStore,
    snapshots,
    warnings,
  };
}

function snapshotStoreStats(dir: string): { count: number; totalBytes: number } {
  try {
    if (!existsSync(dir)) return { count: 0, totalBytes: 0 };
    let count = 0;
    let totalBytes = 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.sqlite')) continue;
      count += 1;
      try {
        totalBytes += statSync(join(dir, entry)).size;
      } catch { /* advisory */ }
    }
    return { count, totalBytes };
  } catch {
    return { count: 0, totalBytes: 0 };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
