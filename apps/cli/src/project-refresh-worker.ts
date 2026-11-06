import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { buildManifest, collectInputFiles } from '@zlens/core';
import { defaultKgPath, reindexProject } from '@zlens/agent';

export interface ProjectRefreshWorkerInput {
  projectRoot: string;
  dbtManifestPath?: string;
  writeManifest: boolean;
}

export interface ProjectRefreshWorkerResult {
  snapshotId: string;
  objectCount: number;
  edgeCount: number;
  metadataFingerprint: string;
  kgFingerprint: string;
  /**
   * True when a project file changed while this refresh ran. Its snapshot was
   * built from the files as they were and was not activated; the coordinator
   * runs another refresh.
   */
  superseded?: boolean;
}

/** Every input file with its size and modification time: what changes when the project does. */
function projectInputSignature(input: Pick<ProjectRefreshWorkerInput, 'projectRoot' | 'dbtManifestPath'>): string {
  const hash = createHash('sha256');
  for (const file of collectInputFiles({ projectRoot: input.projectRoot, dbtManifestPath: input.dbtManifestPath })) {
    try {
      const stats = statSync(file);
      hash.update(`${file}\0${stats.size}\0${stats.mtimeMs}\n`);
    } catch {
      hash.update(`${file}\0missing\n`);
    }
  }
  return hash.digest('hex');
}

async function run(input: ProjectRefreshWorkerInput): Promise<ProjectRefreshWorkerResult> {
  parentPort?.postMessage({ type: 'progress', phase: 'compiling', progress: 15, message: 'Compiling project snapshot.' });
  // Read before the files are: a change after this point makes the snapshot older than the project.
  const readSignature = projectInputSignature(input);
  const manifest = buildManifest({
    projectRoot: input.projectRoot,
    dqlVersion: 'notebook',
    dbtManifestPath: input.dbtManifestPath,
  });
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const snapshotId = createHash('sha256').update(serializedManifest).digest('hex');

  if (input.writeManifest) await writeManifestAtomically(input.projectRoot, serializedManifest);

  parentPort?.postMessage({ type: 'progress', phase: 'indexing', progress: 55, message: 'Updating governed search indexes.' });
  const indexed = await reindexProject(input.projectRoot, {
    manifest,
    kgPath: defaultKgPath(input.projectRoot),
    forceMetadataCatalog: true,
    forceKgIndex: true,
    stillCurrent: () => projectInputSignature(input) === readSignature,
  });

  return {
    snapshotId,
    objectCount: indexed.nodes,
    edgeCount: indexed.edges,
    metadataFingerprint: indexed.metadataFingerprint,
    kgFingerprint: indexed.kgFingerprint,
    ...(indexed.superseded ? { superseded: true } : {}),
  };
}

async function writeManifestAtomically(projectRoot: string, manifest: string): Promise<void> {
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  const tempPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, manifest, 'utf8');
    await rename(tempPath, manifestPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

void run(workerData as ProjectRefreshWorkerInput)
  .then((result) => parentPort?.postMessage({ type: 'complete', result }))
  .catch((error: unknown) => {
    parentPort?.postMessage({
      type: 'error',
      error: {
        code: error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? 'PROJECT_REFRESH_FAILED')
          : 'PROJECT_REFRESH_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  });
