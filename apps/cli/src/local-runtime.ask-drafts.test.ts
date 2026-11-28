import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import { upsertReviewRequiredAnswerDraft } from '@zlens/agent';
import { startLocalServer } from './local-runtime.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-ask-drafts-route-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), '{}\n');
  return dir;
}

async function withServer<T>(projectRoot: string, run: (base: string) => Promise<T>): Promise<T> {
  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
  }
}

type LibraryEntry = { name: string; path: string; status: string; automaticDraft?: boolean };

describe('automatic Ask drafts: marked in the library, cleared on request', () => {
  it('marks only the drafts Ask saved and nobody changed, and "Clear drafts" removes only those', async () => {
    const project = tempProject();
    const untouched = upsertReviewRequiredAnswerDraft(project, { question: 'How many teams are there?', sql: 'SELECT COUNT(*) FROM teams' });
    const edited = upsertReviewRequiredAnswerDraft(project, { question: 'How many games are in our data?', sql: 'SELECT COUNT(*) FROM games' });
    const editedFile = join(project, edited.path);
    writeFileSync(editedFile, readFileSync(editedFile, 'utf-8').replace('COUNT(*) FROM games', 'COUNT(DISTINCT game_id) FROM games'));
    mkdirSync(join(project, 'blocks'), { recursive: true });
    writeFileSync(join(project, 'blocks', 'team_count.dql'), 'block "team_count" {\n  type = "custom"\n  status = "draft"\n  query = """\n    SELECT COUNT(*) FROM teams\n  """\n}\n');

    await withServer(project, async (base) => {
      const library = await fetch(`${base}/api/blocks/library`).then((response) => response.json()) as { blocks: LibraryEntry[] };
      const flagged = library.blocks.filter((block) => block.automaticDraft).map((block) => block.path);
      expect(flagged).toEqual([untouched.path]);
      expect(library.blocks.map((block) => block.path).sort()).toEqual([edited.path, untouched.path, 'blocks/team_count.dql'].sort());

      const cleared = await fetch(`${base}/api/blocks/ask-drafts/clear`, { method: 'POST' });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ ok: true, removed: 1, paths: [untouched.path], kept: 1 });
      expect(existsSync(join(project, untouched.path))).toBe(false);
      expect(existsSync(editedFile)).toBe(true);
      expect(existsSync(join(project, 'blocks', 'team_count.dql'))).toBe(true);

      const again = await fetch(`${base}/api/blocks/ask-drafts/clear`, { method: 'POST' }).then((response) => response.json());
      expect(again).toMatchObject({ ok: true, removed: 0, kept: 1 });
    });
  });
});

describe('the library says where each saved query came from (the trust flow approved 2026-11-27)', () => {
  it('lists the question an Ask answer was saved from, an old automatic draft\'s count, and the file an import read', async () => {
    const project = tempProject();
    const block = (name: string, extra = '') => `block "${name}" {\n${extra}  type = "custom"\n  status = "draft"\n  owner = "TEST_ADMIN"\n  query = """\n    SELECT 1\n  """\n}\n`;
    mkdirSync(join(project, 'blocks'), { recursive: true });
    writeFileSync(join(project, 'blocks', 'playoff_wins_2015.dql'), block('playoff_wins_2015', '  source_question = "How many playoff games did the \\"Warriors\\" win in 2015?"\n'));
    writeFileSync(join(project, 'blocks', 'team_stats.dql'), block('team_stats'));
    mkdirSync(join(project, 'semantic-layer', 'blocks'), { recursive: true });
    writeFileSync(join(project, 'semantic-layer', 'blocks', 'team_stats.yaml'), 'name: team_stats\nblock: team_stats\nimport:\n  importId: imp_1\n  sourceKind: powerbi-project\n  sourcePath: "Team stats.pbit#Team stats"\nreviewStatus: draft\n');
    // As Ask kept them before 2026-11-27 (review-draft-capture passes the asked words).
    const asked = { question: 'How many teams are there?', askedQuestion: 'How many teams are there?', sql: 'SELECT COUNT(*) FROM teams' };
    const automatic = upsertReviewRequiredAnswerDraft(project, asked);
    upsertReviewRequiredAnswerDraft(project, asked);

    await withServer(project, async (base) => {
      const library = await fetch(`${base}/api/blocks/library`).then((response) => response.json()) as { blocks: Array<LibraryEntry & { sourceQuestion?: string; askedTimes?: number; importedFrom?: { kind: string; path?: string } }> };
      const byPath = new Map(library.blocks.map((entry) => [entry.path, entry]));
      expect(byPath.get('blocks/playoff_wins_2015.dql')).toMatchObject({ sourceQuestion: 'How many playoff games did the "Warriors" win in 2015?' });
      expect(byPath.get('blocks/playoff_wins_2015.dql')?.importedFrom).toBeUndefined();
      expect(byPath.get('blocks/team_stats.dql')).toMatchObject({ importedFrom: { kind: 'powerbi-project', path: 'Team stats.pbit#Team stats' } });
      expect(byPath.get('blocks/team_stats.dql')?.sourceQuestion).toBeUndefined();
      expect(byPath.get(automatic.path)).toMatchObject({ sourceQuestion: 'How many teams are there?', askedTimes: 2, automaticDraft: true });
    });
  });
});
