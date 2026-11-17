import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlockArtifacts, openBlockStudioDocument, saveBlockStudioArtifacts } from '../local-runtime.js';
import { HistoryService } from './history-service.js';

/**
 * V4 reviewer path in the ZLens app for Snowflake, with the real save functions: Ask's "Save as saved query" with no
 * Domain, then Open in builder, a new SQL and Save draft. History read "<user> renamed <name> · Moved from
 * blocks/<name>.dql" for the builder save, and the first save also logged "<user> created Semantic layer: <name>".
 * The builder put a saved query with no Domain in `blocks/uncategorized/`, while Save as saved query had put it in
 * `blocks/`, so the second save moved the file; and Save as saved query wrote the saved query's companion YAML under
 * `semantic-layer/blocks/uncategorized/`, where nothing (History included) looks for the companion of `blocks/<name>.dql`.
 */
const roots: string[] = [];
const services: HistoryService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-history-saves-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'history', connections: { app: { driver: 'snowflake' } } }));
  return root;
}

async function open(root: string): Promise<HistoryService> {
  const service = new HistoryService({ projectRoot: root, sweepDelayMs: 0, log: { info: () => undefined, warn: () => undefined } });
  services.push(service);
  await service.start();
  return service;
}

const NAME = 'Top nations by order revenue, 1997';
const PATH = 'blocks/top-nations-by-order-revenue-1997.dql';
const COMPANION = 'semantic-layer/blocks/top-nations-by-order-revenue-1997.yaml';
const SQL_ASKED = 'SELECT n_name, SUM(o_totalprice) AS revenue FROM orders JOIN nation USING (n_nationkey) GROUP BY 1 ORDER BY 2 DESC LIMIT 5';
const SQL_EDITED = 'SELECT n_name, SUM(o_totalprice) AS revenue FROM orders JOIN nation USING (n_nationkey) GROUP BY 1 ORDER BY 2 DESC LIMIT 10';
const askContent = (sql: string) => `block "${NAME}" {\n  type = "custom"\n  status = "draft"\n  query = """\n    ${sql}\n  """\n}\n`;

/** Ask's "Save as saved query", with the Domain left at "no Domain", as /api/blocks/save-from-cell does it. */
function saveFromAsk(root: string): string {
  return createBlockArtifacts(root, { name: NAME, owner: 'TEST_ADMIN', content: askContent(SQL_ASKED) }).path;
}

/** Open in builder, replace the SQL, Save draft: the builder sends back the metadata it opened with. */
function saveFromBuilder(root: string, path: string): string {
  const opened = openBlockStudioDocument(root, path);
  return saveBlockStudioArtifacts(root, {
    currentPath: path,
    source: opened.source.replace(SQL_ASKED, SQL_EDITED),
    name: opened.metadata.name,
    domain: opened.metadata.domain,
    folderPath: opened.metadata.folderPath,
    description: opened.metadata.description,
    owner: opened.metadata.owner,
    tags: opened.metadata.tags,
  });
}

describe('a saved query saved from Ask, then from the builder', () => {
  it('stays where Ask saved it, with its companion where its file says', () => {
    const root = project();
    const path = saveFromAsk(root);
    expect(path).toBe(PATH);
    expect(existsSync(join(root, COMPANION))).toBe(true);
    expect(existsSync(join(root, 'semantic-layer/blocks/uncategorized'))).toBe(false);
    expect(openBlockStudioDocument(root, path).companionPath).toBe(COMPANION);

    const again = saveFromBuilder(root, path);
    expect(again).toBe(PATH);
    expect(readFileSync(join(root, PATH), 'utf-8')).toContain(SQL_EDITED);
    expect(existsSync(join(root, 'blocks/uncategorized'))).toBe(false);
    expect(existsSync(join(root, 'semantic-layer/blocks/uncategorized'))).toBe(false);
    expect(openBlockStudioDocument(root, again).companionPath).toBe(COMPANION);
  });

  it('is one History line per save: created, edited with "SQL changed", certified; never a rename, a path or a semantic layer line', async () => {
    const root = project();
    const history = await open(root);
    const path = saveFromAsk(root);
    const created = (await history.afterRequest({ user: 'TEST_ADMIN', method: 'POST', path: '/api/blocks/save-from-cell', status: 201 })) ?? [];
    expect(created).toHaveLength(1);
    expect(created[0]!.changes.map((change) => [change.kind, change.change, change.name])).toEqual([['saved_query', 'created', NAME]]);
    expect(created[0]!.changes[0]!.files).toEqual([PATH, COMPANION]);

    saveFromBuilder(root, path);
    const edited = (await history.afterRequest({ user: 'TEST_ADMIN', method: 'POST', path: '/api/block-studio/save', status: 200 })) ?? [];
    expect(edited).toHaveLength(1);
    expect(edited[0]!.changes).toHaveLength(1);
    expect(edited[0]!.changes[0]).toMatchObject({ item: PATH, kind: 'saved_query', change: 'edited', name: NAME, version: 2 });
    expect(edited[0]!.changes[0]!.detail).toMatch(/^SQL changed/);

    // Certify: it stays where it is, its receipt in its own companion, and History says certified.
    const opened = openBlockStudioDocument(root, path);
    const certifiedSource = opened.source.replace('status = "draft"', 'status = "certified"');
    expect(saveBlockStudioArtifacts(root, {
      currentPath: path,
      source: certifiedSource,
      name: opened.metadata.name,
      domain: opened.metadata.domain,
      owner: opened.metadata.owner,
      tags: opened.metadata.tags,
      certification: { certifiedBy: 'TEST_ADMIN', certifiedAt: '2026-11-16T10:00:00.000Z', via: 'block-studio', rules: 'oss', sourceSha256: '' },
    })).toBe(PATH);
    expect(openBlockStudioDocument(root, PATH).metadata).toMatchObject({ reviewStatus: 'certified', certification: expect.objectContaining({ certifiedBy: 'TEST_ADMIN' }) });
    const certified = (await history.afterRequest({ user: 'TEST_ADMIN', method: 'POST', path: '/api/block-studio/certifications', status: 202 })) ?? [];
    expect(certified[0]!.changes).toEqual([expect.objectContaining({ item: PATH, change: 'certified', certified: true, version: 3 })]);

    const lines = history.feed().entries.filter((entry) => entry.change !== 'started');
    expect(lines.map((line) => [line.change, line.kind, line.items.map((item) => item.name)])).toEqual([
      ['certified', 'saved_query', [NAME]],
      ['edited', 'saved_query', [NAME]],
      ['created', 'saved_query', [NAME]],
    ]);
    for (const line of lines) expect(line.detail ?? '').not.toMatch(/\.dql\b|Moved from|blocks\//);
    // The SQL view app_public.history is fed from the same changes.
    expect(history.index.commits.flatMap((commit) => commit.changes).filter((change) => change.kind === 'semantic')).toEqual([]);
    expect(existsSync(join(root, 'blocks/uncategorized'))).toBe(false);
  });
});
