import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsYaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelingChanges, dumpYaml, previewModelingChanges } from './dbt-first-authoring.js';
import { yamlKeepingComments } from './yaml-keep-comments.js';

const fresh = (value: unknown) => `FRESH\n${jsYaml.dump(value)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MODEL = `# NBA model: reviewed by Kranthi
entities:
  # The fact every player stat comes from.
  - id: player_game
    dbt_model: model.nba.local_player_game_facts
    grain: one row per game, team and player # deduplicated
    status: certified
  - id: legacy
    dbt_model: model.nba.fct_player_journey
    status: deprecated # 2009-2019 only
relationships:
  # Composite key: never join on game_id alone.
  - id: player_game_to_team_game
    from: player_game
    to: team_game
    keys:
      - { from: game_id, to: game_id }
      - { from: team_id, to: team_id }
    status: draft
`;

describe('yamlKeepingComments', () => {
  it('keeps every comment when an entry gains fields and changes status', () => {
    const next = jsYaml.load(MODEL) as Record<string, any>;
    next.relationships[0].status = 'certified';
    next.relationships[0].validation = { status: 'passed', joinedRows: 668339 };
    const text = yamlKeepingComments(MODEL, next, fresh);
    expect(text).toContain('# NBA model: reviewed by Kranthi');
    expect(text).toContain('# The fact every player stat comes from.');
    expect(text).toContain('# deduplicated');
    expect(text).toContain('# 2009-2019 only');
    expect(text).toContain('# Composite key: never join on game_id alone.');
    expect(text).toContain('{ from: game_id, to: game_id }');
    expect(jsYaml.load(text)).toEqual(next);
  });

  it('follows list entries by id: a removed one goes, a moved one keeps its comments, a new one is added', () => {
    const next = jsYaml.load(MODEL) as Record<string, any>;
    next.entities = [next.entities[1], { id: 'team_game', dbt_model: 'model.nba.local_team_game_facts', status: 'draft' }];
    const text = yamlKeepingComments(MODEL, next, fresh);
    expect(text).toContain('# 2009-2019 only');
    expect(text).not.toContain('player_game\n    dbt_model');
    // A comment above a list's first entry belongs to the list, so it stays where it was.
    expect(text).toContain('model.nba.local_team_game_facts');
    expect(jsYaml.load(text)).toEqual(next);
  });

  it('removes a key the value no longer has', () => {
    const next = jsYaml.load(MODEL) as Record<string, any>;
    delete next.entities[0].grain;
    const text = yamlKeepingComments(MODEL, next, fresh);
    expect(text).not.toContain('grain:');
    expect(text).toContain('# The fact every player stat comes from.');
    expect(jsYaml.load(text)).toEqual(next);
  });

  it('writes fresh when the file is empty, not a mapping, or not readable', () => {
    expect(yamlKeepingComments('', { a: 1 }, fresh)).toMatch(/^FRESH/);
    expect(yamlKeepingComments('- a\n- b\n', { a: 1 }, fresh)).toMatch(/^FRESH/);
    expect(yamlKeepingComments('a: [1, 2\n', { a: 1 }, fresh)).toMatch(/^FRESH/);
  });

  it('dumpYaml writes fresh without the file as it was', () => {
    expect(dumpYaml({ a: 1 })).toBe('a: 1\n');
    expect(dumpYaml({ a: 2 }, '# kept\na: 1\n')).toBe('# kept\na: 2\n');
  });
});

describe('a modeling write keeps the file\'s comments', () => {
  it('recording a relationship check and certifying it keeps what the author wrote', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-yaml-comments-'));
    roots.push(root);
    mkdirSync(join(root, 'domains', 'nba', 'modeling'), { recursive: true });
    writeFileSync(join(root, 'domains', 'nba', 'domain.dql'), 'domain "NBA" {\n  id = "nba"\n  reviewCadence = "quarterly"\n}\n');
    const path = join(root, 'domains', 'nba', 'modeling', 'model.dql.yaml');
    writeFileSync(path, MODEL);
    const changes = [{
      operation: 'record_relationship_validation' as const,
      value: {
        id: 'player_game_to_team_game',
        domain: 'nba',
        sourcePath: 'domains/nba/modeling/model.dql.yaml',
        validation: { status: 'passed', checkedAt: '2026-11-04T12:00:00.000Z', fromRows: 668339, joinedRows: 668339, maxToPerKey: 1 } as never,
        certifiedAgainst: { from: { grain: 'game_id, team_id, player_id', keys: ['game_id', 'team_id', 'player_id'] }, to: { grain: 'game_id, team_id', keys: ['game_id', 'team_id'] } },
      },
    }];
    const preview = previewModelingChanges(root, changes);
    applyModelingChanges(root, changes, preview.fingerprint);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('# Composite key: never join on game_id alone.');
    expect(written).toContain('# 2009-2019 only');
    expect(written).toContain('status: certified');
    expect(written).toContain('joined_rows: 668339');
  });
});
