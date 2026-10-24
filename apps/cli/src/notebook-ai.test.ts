import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createScriptedAnalystProvider } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

const here = dirname(fileURLToPath(import.meta.url));

const CELL_SQL = 'SELECT location_nme FROM dev.locations';
const CELL_ERROR = 'Binder Error: Referenced column "location_nme" not found in FROM clause!';

describe('Notebook AI', () => {
  let root: string;
  let server: Server | undefined;
  let base: string;
  const prompts: string[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dql-nb-cell-ai-'));
    cpSync(resolve(here, '../test/fixtures', 'jaffle-semantic'), root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const executor = {
      executeQuery: async (sql: string) => ({ columns: ['value'], rows: [{ value: 1 }], rowCount: 1, sql }),
    } as unknown as QueryExecutor;
    const port = await startLocalServer({
      rootDir: root,
      projectRoot: root,
      executor,
      connection: { driver: 'file' },
      askAnalyticalPlannerProviderFactory: () => {
        const scripted = createScriptedAnalystProvider('cooperative');
        return {
          ...scripted,
          generate: (messages: Parameters<typeof scripted.generate>[0], options?: Parameters<typeof scripted.generate>[1]) => {
            prompts.push(messages.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n'));
            return scripted.generate(messages, options);
          },
        };
      },
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    base = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    rmSync(root, { recursive: true, force: true });
  });

  // Opened from a cell's Ask AI button, the model must be handed the cell's SQL
  // (and its error), or "Fix this query" has nothing to fix.
  it.each([
    ['Fix this query', 'sql_cell'],
    ['Explain this cell', 'generated_answer'],
  ])('hands the model the cell SQL and its error for "%s" (%s)', async (question, route) => {
    prompts.length = 0;
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        requestedMode: 'auto',
        selectedObject: { kind: 'cell', id: 'cell-1', title: 'store_names', path: 'notebooks/stores.dqlnb' },
        workspaceContext: {
          cellSql: CELL_SQL,
          cellError: CELL_ERROR,
          notebookPath: 'notebooks/stores.dqlnb',
          sourceCellId: 'cell-1',
          sourceCellName: 'store_names',
          sourceCellType: 'sql',
        },
      }),
    });
    expect(response.status).toBe(201);
    const { run } = await response.json() as { run: { route: string; question: string } };
    expect(run.route).toBe(route);
    // The run keeps the question as asked; only the model's copy carries the cell.
    expect(run.question).toBe(question);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((prompt) => prompt.includes(CELL_SQL))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes(CELL_ERROR))).toBe(true);
  }, 120_000);

  it('leaves a whole-notebook question as asked', async () => {
    prompts.length = 0;
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Fix this query',
        requestedMode: 'auto',
        selectedObject: { kind: 'notebook', path: 'notebooks/stores.dqlnb' },
        workspaceContext: { notebookPath: 'notebooks/stores.dqlnb' },
      }),
    });
    expect(response.status).toBe(201);
    expect(prompts.some((prompt) => prompt.includes('selected notebook'))).toBe(false);
  }, 120_000);

  // Notebook AI's History lists the conversations held in this notebook.
  it("lists one notebook's conversations", async () => {
    const create = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/agent/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(201);
      return (await response.json() as { thread: { id: string } }).thread.id;
    };
    const here = await create({ surface: 'notebook', title: 'Fix this query', notebookPath: 'notebooks/history.dqlnb' });
    await create({ surface: 'notebook', title: 'Elsewhere', notebookPath: 'notebooks/other.dqlnb' });
    await create({ surface: 'ask', title: 'An Ask chat' });
    const response = await fetch(`${base}/api/agent/threads?notebookPath=${encodeURIComponent('notebooks/history.dqlnb')}`);
    expect(response.status).toBe(200);
    const { threads } = await response.json() as { threads: Array<{ id: string; title?: string }> };
    expect(threads.map((thread) => thread.id)).toEqual([here]);
  });
});
