import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, loadSemanticLayerFromDir } from '@zlens/core';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@zlens/agent';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { createAskPipelineHost, resetRelationEvidence } from './host.js';
import { withHostQueryHooks, type DqlCredentialsHook } from '../host/row-policy.js';
import { SHARED_EXECUTION_SCOPE, executionScopeFor } from '../host/execution-scope.js';
import { withRequestContext, type DqlPrincipal } from '../host/request-context.js';

/**
 * A host signs each person in to the warehouse with their own short-lived token, so the warehouse shows each of
 * them their own rows and their own tables. Everything Ask remembers from a statement (a table's columns, when each
 * kind of row falls, whether a name differs from its key, a table that is missing) was seen through one person's
 * connection: with every cache warm, two people who ask the same question each get what their own connection
 * shows, and work on the configured connection keeps sharing as before.
 */
const GAMES = 'dev.team_game_facts';
const TEAMS = 'dev.teams';
const VAULT = 'dev.vault_facts';
const BASE_COLUMNS: Record<string, string[]> = {
  [GAMES]: ['game_id', 'game_date', 'season', 'team_id', 'team_won'],
  [TEAMS]: ['team_id', 'team_nickname'],
  [VAULT]: ['team_id', 'vault_total'],
};
/** What only one person's role shows: a column of their own on the games table. */
const OWN_COLUMN: Record<string, string> = { alice: 'alice_only_margin', carol: 'alice_only_margin', bob: 'bob_only_margin', service: 'service_only_margin' };
const ROWS: Record<string, number> = { alice: 11, bob: 22, service: 33, carol: 44 };
/** Each person's rows fall on other days. */
const KIND_DAYS: Record<string, [string, string]> = { alice: ['2023-01-11', '2023-02-11'], carol: ['2023-01-11', '2023-02-11'], bob: ['2023-03-22', '2023-04-22'], service: ['2023-05-03', '2023-06-03'] };

const person = (id: string): DqlPrincipal => ({ id, kind: 'person', source: 'host' });

interface Seen { who: string; sql: string; token?: string }

function setup(options: { identity: boolean }) {
  const seen: Seen[] = [];
  /** Who may not see the vault table (their role lacks the grant: the warehouse says it does not exist). */
  const vaultHidden = new Set<string>(['alice']);
  let renewals = 0;
  // The token renews on every statement; `identity` (when the host gives one) says whose it is.
  const credentials: DqlCredentialsHook = ({ principal }) => {
    if (!principal || principal.id === 'service') return { connection: {} };
    renewals += 1;
    return { connection: { token: `${principal.id}.token-${renewals}` }, ...(options.identity ? { identity: `warehouse-user:${principal.id}` } : {}) };
  };
  const raw = {
    async executeQuery(this: { executePositional: QueryExecutor['executePositional'] }, sql: string, _params: unknown, _variables: unknown, config: ConnectionConfig, queryOptions?: unknown) {
      return this.executePositional(sql, [], config, queryOptions as never);
    },
    async executePositional(sql: string, _params: unknown[], config: ConnectionConfig) {
      const who = config.token ? config.token.split('.')[0]! : 'service';
      seen.push({ who, sql, ...(config.token ? { token: config.token } : {}) });
      const answer = (rows: Array<Record<string, unknown>>) => ({ columns: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: 'unknown', driverType: '' })), rows, rowCount: rows.length, executionTimeMs: 1 });
      if (/HAVING COUNT\(\*\) > 1/.test(sql)) return answer([]);
      if (sql.includes('information_schema.columns')) {
        return answer(Object.keys(BASE_COLUMNS).filter((table) => sql.includes(`'${table.split('.').pop()}'`)).flatMap((table) => {
          const names = table === GAMES ? [...BASE_COLUMNS[table]!, OWN_COLUMN[who]!] : BASE_COLUMNS[table]!;
          return names.map((column) => ({ table_schema: 'dev', table_name: table.split('.').pop(), column_name: column, data_type: /_id$|season|margin|total/.test(column) ? 'BIGINT' : 'VARCHAR', dql_column_total: names.length }));
        }));
      }
      // When each kind's rows fall (kindDatesSql).
      if (/AS first_day/.test(sql)) {
        const [from, to] = KIND_DAYS[who]!;
        return answer([{ kind: '2', period: 2023, first_day: from, last_day: from }, { kind: '4', period: 2023, first_day: to, last_day: to }]);
      }
      // Whether a team's name ever differs from its key: for Bob the warehouse masks the name, so it never does.
      if (/^SELECT 1 FROM/.test(sql)) return answer(who === 'bob' ? [] : [{ hit: 1 }]);
      if (sql.includes('vault_facts')) {
        if (vaultHidden.has(who)) throw new Error('Catalog Error: Table with name vault_facts does not exist!');
        return answer([{ vault_total: ROWS[who]! * 100 }]);
      }
      return answer([{ games_won: ROWS[who]! }]);
    },
  };
  const executor = withHostQueryHooks(raw as unknown as QueryExecutor, { credentials });
  const connection = { driver: 'duckdb', filepath: ':memory:' } as ConnectionConfig;
  const manifest = {
    sources: Object.fromEntries(Object.keys(BASE_COLUMNS).map((table) => {
      const name = table.split('.').pop()!;
      // dbt documents no columns: the warehouse tells each person which ones the table has for them.
      return [name, { name, origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: `model.nba.${name}`, schema: 'dev', columns: {} } }];
    })),
    modeling: { rules: { game_kinds: { expression: `Every game_id in ${GAMES} has 10 characters, and the first one takes 2 values: 2 (1,000 rows), 4 (100 rows).` } } },
  };
  const prompts: Array<{ who: string; prompt: string }> = [];
  const namings: Array<{ who: string; prompt: string }> = [];
  const drafts = { sql: `SELECT COUNT(*) AS games_won FROM ${GAMES} f WHERE f.team_won` };
  let asking = '';
  const host = createAskPipelineHost({
    projectRoot: '/tmp/ask-per-person-scope',
    executor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: 'snapshot:per-person', manifest: manifest as never }),
    selectProvider: async () => ({
      name: 'ollama', available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        const text = messages.map((message) => message.content).join('\n');
        if (messages[0]!.content.startsWith('You name the kinds of')) { namings.push({ who: asking, prompt: text }); return 'no names'; }
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return 'I cannot read that.';
        prompts.push({ who: asking, prompt: text });
        return drafts.sql;
      },
    }) as AgentProvider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
  let runs = 0;
  const ask = (who: string, question: string) => withRequestContext({ principal: person(who), requestId: `request-${++runs}` }, async () => {
    asking = who;
    const before = { seen: seen.length, prompts: prompts.length };
    const result = await host.execute({ runId: `run:${runs}`, request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {} });
    // The kinds are named beside the run; let that settle before the next person asks.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { result, statements: seen.slice(before.seen), prompts: prompts.slice(before.prompts).map((item) => item.prompt) };
  });
  const scopeOf = (who: string) => withRequestContext({ principal: person(who), requestId: `scope-${who}` }, () => executionScopeFor(executor, connection));
  return { ask, seen, prompts, namings, drafts, host, vaultHidden, scopeOf };
}

const WON = 'How many games did teams win?';
const VAULT_QUESTION = 'What is the vault total?';

beforeEach(() => resetRelationEvidence());
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe.each([{ identity: true, name: 'a host that names the identity' }, { identity: false, name: 'a host that names no identity (one scope per credential)' }])('per-person warehouse sign-in on the Ask host: $name', ({ identity }) => {
  const probes = (statements: Seen[]) => statements.filter((item) => item.sql.includes('information_schema.columns'));
  const kindDates = (statements: Seen[]) => statements.filter((item) => /AS first_day/.test(item.sql));

  it('with every cache warm, each person gets their own rows, columns and dates; the configured connection still shares', async () => {
    const world = setup({ identity });
    const alice = await world.ask('alice', WON);
    const bob = await world.ask('bob', WON);
    // Each person's rows.
    expect(alice.result.answer).toContain('Games won: 11.');
    expect(bob.result.answer).toContain('Games won: 22.');
    // Probed columns: Bob's draft is written from the columns his own connection shows, never Alice's.
    expect(alice.prompts[0]).toContain('alice_only_margin');
    expect(bob.prompts[0]).toContain('bob_only_margin');
    expect(bob.prompts[0]).not.toContain('alice_only_margin');
    expect(probes(bob.statements).length).toBeGreaterThan(0);
    expect(probes(bob.statements).every((item) => item.who === 'bob')).toBe(true);
    // Kind dates: measured on Bob's own rows.
    expect(alice.prompts[0]).toContain('2 from 2023-01-11');
    expect(bob.prompts[0]).toContain('2 from 2023-03-22');
    expect(bob.prompts[0]).not.toContain('2023-01-11');
    expect(kindDates(bob.statements)).toHaveLength(1);
    // Kind names: named from each person's own dates, never from another's.
    expect(world.namings.map((item) => item.who)).toEqual(['alice', 'bob']);
    expect(world.namings[1]!.prompt).toContain('2023-03-22');
    expect(world.namings[1]!.prompt).not.toContain('2023-01-11');
    // Nothing ran for one person on another's connection.
    expect(alice.statements.every((item) => item.who === 'alice')).toBe(true);
    expect(bob.statements.every((item) => item.who === 'bob')).toBe(true);

    // Alice again, with a token renewed many times since: with a named identity her scope is the same, so what
    // she already saw is reused; without one each credential is a scope of its own, and nothing is.
    const again = await world.ask('alice', WON);
    expect(again.result.answer).toContain('Games won: 11.');
    expect(again.prompts[0]).toContain('alice_only_margin');
    expect(again.prompts[0]).not.toContain('bob_only_margin');
    expect(again.prompts[0]).toContain('2 from 2023-01-11');
    expect(new Set(world.seen.filter((item) => item.who === 'alice').map((item) => item.token)).size).toBeGreaterThan(2);
    if (identity) {
      expect(probes(again.statements)).toHaveLength(0);
      expect(kindDates(again.statements)).toHaveLength(0);
    } else {
      expect(probes(again.statements).length).toBeGreaterThan(0);
    }

    // The configured connection (no overlay): the shared scope, cached once for everyone on it, as without a host.
    expect(await world.scopeOf('service')).toBe(SHARED_EXECUTION_SCOPE);
    expect(await world.scopeOf('alice')).not.toBe(SHARED_EXECUTION_SCOPE);
    expect(await world.scopeOf('alice')).not.toBe(await world.scopeOf('bob'));
    const service = await world.ask('service', WON);
    expect(service.result.answer).toContain('Games won: 33.');
    expect(service.prompts[0]).toContain('service_only_margin');
    expect(service.prompts[0]).not.toMatch(/alice_only_margin|bob_only_margin/);
    expect(service.prompts[0]).toContain('2 from 2023-05-03');
    expect(probes(service.statements).length).toBeGreaterThan(0);
    const serviceAgain = await world.ask('service', WON);
    expect(probes(serviceAgain.statements)).toHaveLength(0);
    expect(kindDates(serviceAgain.statements)).toHaveLength(0);
    expect(serviceAgain.prompts[0]).toContain('service_only_margin');

    // The names a trace reviewer may read: the project's, the shared connection's and their own, nobody else's.
    const shared = world.host.catalogNames();
    expect(shared.has('service_only_margin')).toBe(true);
    expect(shared.has('alice_only_margin')).toBe(false);
    expect(shared.has('bob_only_margin')).toBe(false);
    const bobs = world.host.catalogNames(await world.scopeOf('bob'));
    expect(bobs.has('alice_only_margin')).toBe(false);
    if (identity) expect(bobs.has('bob_only_margin')).toBe(true);
  });

  it('a table one person may not read is refused for that person only', async () => {
    const world = setup({ identity });
    world.drafts.sql = `SELECT SUM(v.vault_total) AS vault_total FROM ${VAULT} v`;
    const reads = (statements: Seen[]) => statements.filter((item) => item.sql.includes('vault_total FROM'));
    const alice = await world.ask('alice', VAULT_QUESTION);
    expect(alice.result.status).toBe('blocked');
    expect(reads(alice.statements)).toHaveLength(1);
    // Bob's role reads it: his statement runs, within the minute Alice's refusal is remembered.
    const bob = await world.ask('bob', VAULT_QUESTION);
    expect(bob.result.status).toBe('completed');
    expect(bob.result.answer).toContain('Vault total: 2,200.');
    expect(bob.result.answer).not.toContain('known to be missing');
    expect(reads(bob.statements)).toHaveLength(1);
    // So does the configured connection's.
    const service = await world.ask('service', VAULT_QUESTION);
    expect(service.result.answer).toContain('Vault total: 3,300.');
    // Alice's own refusal is remembered for her (with a named identity, across her renewed tokens).
    const again = await world.ask('alice', VAULT_QUESTION);
    expect(again.result.status).toBe('blocked');
    if (identity) {
      expect(reads(again.statements)).toHaveLength(0);
      expect(again.result.answer).toContain('already known to be missing');
    }
    // The shared scope still remembers a missing table for everyone on the configured connection, and only them.
    world.vaultHidden.add('service');
    resetRelationEvidence();
    expect((await world.ask('service', VAULT_QUESTION)).result.status).toBe('blocked');
    const sharedAgain = await world.ask('service', VAULT_QUESTION);
    expect(reads(sharedAgain.statements)).toHaveLength(0);
    expect(sharedAgain.result.answer).toContain('already known to be missing');
    expect((await world.ask('bob', VAULT_QUESTION)).result.answer).toContain('Vault total: 2,200.');
  });

  it('whether a name differs from its key is asked of each person\'s own rows', async () => {
    const world = setup({ identity });
    world.drafts.sql = `SELECT f.team_id, COUNT(*) AS games_won FROM ${GAMES} f WHERE f.team_won GROUP BY f.team_id`;
    const question = 'Which teams won the most games?';
    const differs = (statements: Seen[]) => statements.filter((item) => /^SELECT 1 FROM/.test(item.sql));
    // Alice reads team names: the draft is sent back to list the teams by name.
    const alice = await world.ask('alice', question);
    expect(differs(alice.statements)).toHaveLength(1);
    expect(alice.prompts.join('\n')).toContain('list each team by dev.teams.team_nickname');
    // For Bob the warehouse masks the name: it never differs from the key, so it names nothing. His own
    // connection is asked; Alice's answer is not his.
    const bob = await world.ask('bob', question);
    expect(differs(bob.statements)).toHaveLength(1);
    expect(differs(bob.statements)[0]!.who).toBe('bob');
    expect(bob.prompts.join('\n')).not.toContain('list each team by dev.teams.team_nickname');
    if (identity) expect(differs((await world.ask('alice', question)).statements)).toHaveLength(0);
  });
});

describe('a prepared statement is reused within one execution scope only', () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/harbor-claims');
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  it('the second person prepares their own; the same person, and the configured connection, reuse theirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-per-person-preparation-'));
    roots.push(root);
    cpSync(fixture, root, { recursive: true });
    const manifest = buildManifest({ projectRoot: root });
    const semanticLayer = loadSemanticLayerFromDir(join(root, 'semantic-layer'));
    const reading = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Count of open claims by region.',
      measures: [{ ref: 'metric:claims.claim_count' }],
      groupBy: [{ ref: 'dimension:claims.region', role: 'categorical' }],
      filters: [{ ref: 'dimension:claims.status', op: 'eq', values: ['open'], source: 'question' }],
      display: [], unresolved: [], provenance: { 'metric:claims.claim_count': 'q:claims' }, expectedShape: 'breakdown',
    });
    let renewals = 0;
    const raw = {
      async executeQuery(this: { executePositional: QueryExecutor['executePositional'] }, sql: string, _params: unknown, _variables: unknown, config: ConnectionConfig) { return this.executePositional(sql, [], config); },
      async executePositional(sql: string) {
        if (sql.includes('information_schema.columns')) return { columns: [], rowCount: 3, executionTimeMs: 1, rows: ['claim_id', 'region', 'status'].map((column) => ({ table_schema: 'main', table_name: 'claims', column_name: column, data_type: 'VARCHAR' })) };
        return { columns: ['region', 'open_claims'], rowCount: 1, executionTimeMs: 1, rows: [{ region: 'West', open_claims: 3 }] };
      },
    };
    const executor = withHostQueryHooks(raw as unknown as QueryExecutor, {
      credentials: ({ principal }) => (!principal || principal.id === 'service' ? { connection: {} } : { connection: { token: `${principal.id}.token-${++renewals}` }, identity: principal.id }),
    });
    const host = createAskPipelineHost({
      projectRoot: root,
      executor,
      resolveConnection: async () => ({ driver: 'duckdb', filepath: ':memory:' } as ConnectionConfig),
      getSemanticLayer: () => semanticLayer,
      getManifest: () => ({ snapshotId: 'snapshot:harbor', manifest }),
      selectProvider: async () => ({ name: 'ollama', available: async () => true, generate: async () => reading }) as AgentProvider,
      semanticEngine: async () => 'native',
      compileSemantic: async () => ({ sql: "SELECT region, COUNT(DISTINCT claim_id) AS claim_count FROM claims WHERE status = 'open' GROUP BY region", engine: 'native' }),
      priorIntent: () => undefined,
    });
    let runs = 0;
    const reuse = (who: string) => withRequestContext({ principal: person(who), requestId: `prepare-${++runs}` }, async () => {
      const result = await host.execute({ runId: `run:prepare-${runs}`, request: { question: 'How many open claims are there by region?', requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => undefined });
      return result.askPipelineReceipt?.reuse;
    });
    expect(await reuse('alice')).toBe('none');
    // Bob sees the same columns, so only the scope keeps Alice's prepared statement from being his.
    expect(await reuse('bob')).toBe('none');
    expect(await reuse('alice')).toBe('preparation');
    expect(await reuse('service')).toBe('none');
    expect(await reuse('service')).toBe('preparation');
  });
});
