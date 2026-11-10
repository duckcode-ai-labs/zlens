import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildManifest } from './builder.js';
import { notebookBlockPath, readBlockSource } from './block-source.js';

/**
 * New-user test V8, item 5: a notebook DQL block used as an App source failed
 * with `ENOENT: no such file or directory, open '…/notebooks/x.dqlnb#cell'`,
 * because its manifest path names the notebook and the cell. It is read here
 * like a block file.
 */
const root = mkdtempSync(join(tmpdir(), 'dql-block-source-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const winsBlock = [
  'block "Wins by season" {',
  '  domain = "nba"',
  '  type = "custom"',
  '  owner = "tester"',
  '  query = """',
  "    SELECT SEASON, COUNT(*) AS WINS FROM LOCAL_TEAM_GAME_FACTS WHERE WL = 'W' GROUP BY SEASON",
  '  """',
  '}',
].join('\n');
const pointsBlock = winsBlock.replace('Wins by season', 'Points by season').replace("COUNT(*) AS WINS FROM LOCAL_TEAM_GAME_FACTS WHERE WL = 'W'", 'SUM(PTS) AS POINTS FROM LOCAL_TEAM_GAME_FACTS');

mkdirSync(join(root, 'notebooks'), { recursive: true });
writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'nba' }));
writeFileSync(join(root, 'notebooks', 'nba.dqlnb'), JSON.stringify({
  version: 1,
  title: 'NBA research',
  cells: [
    { id: 'intro', type: 'markdown', content: '# NBA' },
    { id: 'cell-wins', type: 'dql', name: 'Wins by season', content: winsBlock },
    // A cell with no id is named by its place among the SQL and DQL cells, as the manifest scan names it.
    { type: 'dql', source: pointsBlock },
  ],
}));
mkdirSync(join(root, 'blocks'), { recursive: true });
writeFileSync(join(root, 'blocks', 'plain.dql'), 'block "Plain" { query = """SELECT 1 AS x""" }');

describe('reading a block from its manifest path', () => {
  it('reads a notebook block from its cell, under the path the manifest gives it', () => {
    const manifest = buildManifest({ projectRoot: root });
    const wins = manifest.blocks['Wins by season'];
    const points = manifest.blocks['Points by season'];
    expect(wins?.filePath).toBe('notebooks/nba.dqlnb#cell-wins');
    expect(points?.filePath).toBe('notebooks/nba.dqlnb#cell-1');
    expect(readBlockSource(root, wins!.filePath)).toBe(winsBlock);
    expect(readBlockSource(root, points!.filePath)).toBe(pointsBlock);
    expect(notebookBlockPath(wins!.filePath)).toEqual({ notebookPath: 'notebooks/nba.dqlnb', cellId: 'cell-wins' });
  });

  it('reads a block file as it is', () => {
    expect(readBlockSource(root, 'blocks/plain.dql')).toBe('block "Plain" { query = """SELECT 1 AS x""" }');
    expect(notebookBlockPath('blocks/plain.dql')).toBeUndefined();
  });

  it('fails like a missing file when the cell or the notebook is gone', () => {
    expect(() => readBlockSource(root, 'notebooks/nba.dqlnb#gone')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(() => readBlockSource(root, 'notebooks/missing.dqlnb#cell-wins')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});
