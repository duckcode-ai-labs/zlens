import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@zlens/agent';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { relationColumnsFingerprint, writeMeaningFile, type MeaningFileV1 } from '@zlens/core';
import { certifiedBlocksForDraft, createAskPipelineRouteExecutor } from './host.js';

/**
 * A warehouse-first project (no dbt): the synced catalog is the whole account
 * of the data. The drafter reads every table of it when it fits, with the keys
 * the warehouse declares; where nothing is governed it drafts from the
 * question itself; and on DuckDB a statement may leave the default database
 * out of a table's name.
 */
type Table = { columns: string[]; comment?: string; primaryKey?: string[]; foreignKeys?: Array<{ columns: string[]; references: { relation: string; columns: string[] } }> };

// Six tables; the question names one. A plain text-to-SQL prompt shows all
// six with their keys, and so must the drafter when they fit.
const TABLES: Record<string, Table> = {
  customers: { columns: ['customer_id', 'name', 'country'], primaryKey: ['customer_id'] },
  invoices: { columns: ['invoice_id', 'customer_id', 'total'], primaryKey: ['invoice_id'], foreignKeys: [{ columns: ['customer_id'], references: { relation: 'main.customers', columns: ['customer_id'] } }] },
  invoice_lines: { columns: ['invoice_id', 'line_no', 'track_id', 'unit_price'], primaryKey: ['invoice_id', 'line_no'], foreignKeys: [{ columns: ['invoice_id'], references: { relation: 'main.invoices', columns: ['invoice_id'] } }] },
  tracks: { columns: ['track_id', 'album_id', 'title'], primaryKey: ['track_id'] },
  albums: { columns: ['album_id', 'artist_id', 'title'], primaryKey: ['album_id'] },
  artists: { columns: ['artist_id', 'name'], primaryKey: ['artist_id'] },
};

interface Setup {
  tables?: Record<string, Table>;
  /** `dbt`: a dbt manifest beside the catalog; `hybrid`: modeling.mode hybrid with no readable dbt manifest. */
  project?: 'warehouse-first' | 'dbt' | 'hybrid';
  database?: string;
  driver?: string;
  blocks?: Array<{ name: string; description: string; sql: string; certified: boolean }>;
  /** A value profile in the project's cache (what a sync with agent.valueProfile writes), and whether the project allows it now. */
  valueProfile?: { written: boolean; allowed?: boolean; fingerprint?: string };
  /** What the result review answers (default: it answers). */
  review?: (prompt: string, system: string) => string;
  /** The project's `agent.resultReview` setting as the host reports it (absent: the dep is not given). */
  resultReview?: boolean;
  /** Every text column may be searched for a stated value. */
  probeAllowed?: boolean;
  /** Served through a host. */
  hosted?: boolean;
  /** What the model answers when it is asked to choose tables from the index. */
  pick?: (prompt: string) => string;
  /** Terms in the manifest. */
  terms?: Array<{ name: string; description: string; status?: string; tags?: string[]; synonyms?: string[] }>;
  /** Meaning files, by table name. */
  meanings?: Record<string, Pick<MeaningFileV1, 'table' | 'columns'> & { stale?: boolean }>;
}

function project(setup: Setup) {
  const tables = setup.tables ?? TABLES;
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-warehouse-first-'));
  mkdirSync(join(projectRoot, '.dql'), { recursive: true });
  const prefix = setup.database ? `${setup.database}.main` : 'main';
  const relations = Object.entries(tables).map(([name, table]) => ({
    id: `warehouse.main.${name}`, ...(setup.database ? { database: setup.database } : {}), schema: 'main', name, relation: `${prefix}.${name}`, kind: 'table',
    columns: table.columns.map((column) => ({ name: column, type: column.endsWith('_id') || column === 'line_no' ? 'INTEGER' : 'TEXT' })),
    ...(table.primaryKey ? { primaryKey: table.primaryKey } : {}), ...(table.foreignKeys ? { foreignKeys: table.foreignKeys } : {}),
    ...(table.comment ? { comment: table.comment } : {}),
  }));
  writeFileSync(join(projectRoot, '.dql', 'warehouse-catalog.json'), JSON.stringify({ version: 1, driver: setup.driver ?? 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: setup.database ?? 'main', schemas: ['main'] }], relations, capturedAt: '2026-09-22T00:00:00.000Z', fingerprint: 'sha256:test' }));
  for (const [name, meaning] of Object.entries(setup.meanings ?? {})) {
    const relation = relations.find((item) => item.name === name)!;
    writeMeaningFile(projectRoot, { version: 1, id: relation.id, relation: relation.relation, columnsFingerprint: meaning.stale ? 'old' : relationColumnsFingerprint(relation), ...(meaning.table ? { table: meaning.table } : {}), columns: meaning.columns });
  }
  if (setup.valueProfile?.written) {
    // What the columns hold, as a sync with agent.valueProfile writes it.
    mkdirSync(join(projectRoot, '.dql', 'cache'), { recursive: true });
    writeFileSync(join(projectRoot, '.dql', 'cache', 'value-profile.json'), JSON.stringify({ version: 1, catalogFingerprint: setup.valueProfile.fingerprint ?? 'sha256:test', capturedAt: '2026-09-22T00:00:00.000Z', skippedSensitive: 0, relations: { [`${prefix}.customers`]: { country: { examples: ['Brazil', 'Canada'] } }, [`${prefix}.invoices`]: { total: { min: '0.99', max: '25.86' } } } }));
  }
  const blocks = Object.fromEntries((setup.blocks ?? []).map((block) => [block.name, {
    name: block.name, description: block.description, sql: block.sql, filePath: `blocks/${block.name}.dql`, domain: 'shop', owner: 'analytics@shop.test',
    status: block.certified ? 'certified' : 'draft', tags: [], certification: block.certified ? { status: 'certified' } : undefined,
  }]));
  const manifest = {
    sources: {},
    ...(setup.terms ? { terms: Object.fromEntries(setup.terms.map((term) => [term.name, { ...term, filePath: `terms/${term.name}.dql` }])) } : {}),
    ...(setup.blocks ? { blocks } : {}),
    ...(setup.project === 'hybrid' ? { modeling: { mode: 'hybrid', packages: {}, areas: {} } } : {}),
    dbtProvenance: {
      // A dbt project has a dbt manifest beside the catalog: dbt owns its
      // prompts, so the warehouse keys are not added to them.
      manifestPath: setup.project === 'dbt' ? 'target/manifest.json' : '', manifestFingerprint: 'none', metricFlow: {},
      warehouseCatalogPath: '.dql/warehouse-catalog.json', warehouseCatalogFingerprint: 'sha256:test',
      nodes: Object.fromEntries(relations.map((relation) => [relation.id, { uniqueId: relation.id, resourceType: 'warehouse', name: relation.name, relation: relation.relation, identityFingerprint: relation.id, available: { description: false, columns: true, tests: false, catalogTypes: true, dqlMeta: false } }])),
    },
  };
  return { projectRoot, manifest };
}

const READING = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Invoice totals by country.', measures: [{ ref: 'metric:shop.invoice_total' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });
const isDraft = (messages: AgentMessage[]) => messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement');
const isReview = (messages: AgentMessage[]) => messages[0]!.content.startsWith('You check one query result');

async function ask(setup: Setup, question: string, draft: (prompt: string) => string, rows: Array<Record<string, unknown>> = []) {
  const { projectRoot, manifest } = project(setup);
  const prompts: string[] = [];
  const reviews: string[] = [];
  const indexPrompts: string[] = [];
  let readings = 0;
  const executed: string[] = [];
  const route = createAskPipelineRouteExecutor({
    projectRoot,
    executor: { executeQuery: vi.fn(async (sql: string) => {
      executed.push(sql);
      // Key probes (GROUP BY … HAVING COUNT(*) > 1) find no repeats.
      if (/HAVING COUNT\(\*\) > 1/.test(sql)) return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      return { columns: Object.keys(rows[0] ?? {}), rowCount: rows.length, executionTimeMs: 1, rows };
    }) } as unknown as QueryExecutor,
    ...(setup.valueProfile?.allowed !== undefined ? { valueProfileAllowed: () => setup.valueProfile!.allowed! } : {}),
    ...(setup.resultReview !== undefined ? { resultReviewConfigured: () => setup.resultReview! } : {}),
    ...(setup.probeAllowed ? { literalProbeAllowed: () => true } : {}),
    ...(setup.hosted ? { unreadableSqlRefused: true } : {}),
    resolveConnection: async () => ({ driver: setup.driver ?? 'sqlite' } as ConnectionConfig),
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: `snapshot:${projectRoot}`, manifest: manifest as never }),
    selectProvider: async () => ({
      name: 'ollama', available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        if (messages[0]!.content.startsWith('You choose which database tables')) {
          indexPrompts.push(messages[1]!.content);
          return setup.pick?.(messages[1]!.content) ?? 'not JSON';
        }
        if (isReview(messages)) { reviews.push(messages[1]!.content); return setup.review?.(messages[1]!.content, messages[0]!.content) ?? '{"answers": true}'; }
        if (!isDraft(messages)) { readings += 1; return READING; }
        const prompt = messages.map((message) => message.content).join('\n');
        prompts.push(prompt);
        return draft(prompt);
      },
    }) as AgentProvider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
  try {
    const result = await route({ runId: `run:${question}`, request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {} });
    return { result, prompts, readings, executed, reviews, indexPrompts };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

const declined = () => 'NO_SQL: nothing to draft in this test.';

// Every provider and executor here answers at once, so without this the whole
// file runs as one chain of promises and never lets the worker read Vitest's
// own messages; past 60 s on a slow runner the worker's report then times out.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe('a warehouse-first draft reads the whole schema with its declared keys', () => {
  it('shows every table once, the primary keys and the foreign keys the warehouse declares', async () => {
    const { prompts } = await ask({}, 'Total invoice amount for each customer country', declined);
    expect(prompts.length).toBeGreaterThan(0);
    const prompt = prompts[0]!;
    for (const name of Object.keys(TABLES)) expect(prompt.match(new RegExp(`executable relation:[^\\n]*\\b${name}\\b`, 'g'))).toHaveLength(1);
    expect(prompt).toContain('primary key (invoice_id, line_no): one row per invoice_id, line_no');
    expect(prompt).toContain('foreign key (customer_id) references main.customers (customer_id)');
    expect(prompt).toContain('DIALECT NOTES (sqlite): there is no MEDIAN');
  });

  it('an engine without notes gets none; a dbt or hybrid project gets no warehouse keys and is not shown whole', async () => {
    expect((await ask({ driver: 'duckdb' }, 'Total invoice amount for each customer country', declined)).prompts[0]).not.toContain('DIALECT NOTES');
    for (const kind of ['dbt', 'hybrid'] as const) {
      const prompt = (await ask({ project: kind }, 'Total invoice amount for each customer country', declined)).prompts[0] ?? '';
      expect(prompt).not.toContain('primary key (');
      expect(prompt).not.toContain('foreign key (');
      expect(prompt).not.toContain('DIALECT NOTES');
      expect(prompt).not.toContain('executable relation:main.artists');
    }
  });

  it('a schema too large for the budget is chosen from as before', async () => {
    const wide: Record<string, Table> = {};
    for (let index = 0; index < 60; index += 1) wide[`ledger_${index}`] = { columns: Array.from({ length: 40 }, (_, column) => `measure_${column}_of_a_long_ledger_column_name`), primaryKey: ['measure_0_of_a_long_ledger_column_name'] };
    wide.customers = TABLES.customers!;
    const { prompts } = await ask({ tables: wide }, 'How many customers are there in each country', declined);
    const prompt = prompts[0] ?? '';
    expect((prompt.match(/executable relation:/g) ?? []).length).toBeLessThanOrEqual(8);
    expect(prompt).toContain('executable relation:main.customers');
  }, 20_000);
});

describe('a schema too large to show: the model chooses from an index', () => {
  // Just past the whole-schema budget: enough to need the index, no more.
  const large: Record<string, Table> = { ...TABLES };
  for (let index = 0; index < 22; index += 1) large[`ledger_${index}`] = { columns: Array.from({ length: 40 }, (_, column) => `measure_${column}_of_a_long_ledger_column_name`), primaryKey: ['measure_0_of_a_long_ledger_column_name'] };

  it('offers every table one line each, and shows full cards for what it chose', async () => {
    const { prompts, indexPrompts } = await ask({ tables: large, pick: () => '{"tables":["main.invoice_lines","main.imagined"]}' }, 'What was revenue last spring', declined);
    expect(indexPrompts).toHaveLength(1);
    expect((indexPrompts[0]!.match(/^- main\./gm) ?? []).length).toBe(28);
    expect(prompts[0]).toContain('column:main.invoice_lines.unit_price');
    expect(prompts[0]).not.toContain('main.imagined');
  }, 20_000);

  it('an index line says what a table holds, from its meaning file', async () => {
    const meanings = { invoice_lines: { table: { description: 'One row per product sold.', source: 'ai' as const, otherNames: ['revenue lines'] }, columns: {} } };
    const { indexPrompts } = await ask({ tables: large, meanings, pick: () => '{"tables":["main.invoice_lines"]}' }, 'What was revenue last spring', declined);
    expect(indexPrompts[0]).toContain('- main.invoice_lines: One row per product sold. Also called: revenue lines.');
  }, 20_000);

  it('a reply it cannot read falls back to the words of the question', async () => {
    const { prompts, indexPrompts } = await ask({ tables: large }, 'How many customers are there in each country', declined);
    expect(indexPrompts).toHaveLength(1);
    expect(prompts[0]).toContain('executable relation:main.customers');
  }, 20_000);

  it('a call that fails falls back the same way', async () => {
    const { prompts } = await ask({ tables: large, pick: () => { throw new Error('model unavailable'); } }, 'How many customers are there in each country', declined);
    expect(prompts[0]).toContain('executable relation:main.customers');
  }, 20_000);

  it('a schema that fits is shown whole and no index call is made', async () => {
    const { indexPrompts } = await ask({ pick: () => '{"tables":[]}' }, 'What was revenue last spring', declined);
    expect(indexPrompts).toHaveLength(0);
  });

  it('a dbt or hybrid project gets no index call, however large', async () => {
    for (const kind of ['dbt', 'hybrid'] as const) {
      expect((await ask({ tables: large, project: kind, pick: () => '{"tables":[]}' }, 'How many customers are there', declined)).indexPrompts).toHaveLength(0);
    }
  }, 20_000);
});

describe('what the data means, as drafted by AI', () => {
  const draft = { table: { description: 'One row per product on an invoice.', source: 'ai' as const, otherNames: ['revenue lines'] }, columns: { unit_price: { description: 'Price of one unit before tax', source: 'ai' as const } } };

  it('reaches the drafter labelled as a draft, with its other names', async () => {
    const { prompts } = await ask({ meanings: { invoice_lines: draft } }, 'Total invoice amount for each customer country', declined);
    expect(prompts[0]).toContain('AI draft: One row per product on an invoice. Also called: revenue lines.');
    expect(prompts[0]).toContain('AI draft: Price of one unit before tax');
  });

  it('a project with no meaning files keeps the prompt it had, warehouse comments and all', async () => {
    const commented = { ...TABLES, invoice_lines: { ...TABLES.invoice_lines!, comment: 'DBA_COMMENT_MARKER' } };
    const { prompts } = await ask({ tables: commented }, 'Total invoice amount for each customer country', declined);
    expect(prompts[0]).not.toContain('DBA_COMMENT_MARKER');
  });

  it("a person's words reach the drafter with no label", async () => {
    const reviewed = { table: { description: 'One row per product on an invoice.', source: 'person' as const }, columns: {} };
    const { prompts } = await ask({ meanings: { invoice_lines: reviewed } }, 'Total invoice amount for each customer country', declined);
    expect(prompts[0]).toContain('One row per product on an invoice.');
    expect(prompts[0]).not.toContain('AI draft');
  });

  it('a stale draft is not used', async () => {
    const { prompts } = await ask({ meanings: { invoice_lines: { ...draft, stale: true } } }, 'Total invoice amount for each customer country', declined);
    expect(prompts[0]).not.toContain('One row per product');
  });

  it('an answer that read a drafted table says so, and stays an AI-drafted answer', async () => {
    const { result } = await ask({ meanings: { invoice_lines: draft } }, 'What is the total price of all invoice lines', () => 'SELECT SUM(unit_price) AS total FROM main.invoice_lines', [{ total: 12 }]);
    const answer = (result as { answerMarkdown?: string; outcome?: { text?: string } });
    const text = JSON.stringify(answer);
    expect(text).toContain('used AI-drafted descriptions of main.invoice_lines');
    expect(text).not.toMatch(/"trustLabel":\s*"(certified|from_metrics)"/i);
  });

  it('an AI-drafted term reaches the drafter labelled, and the answer says it was used', async () => {
    const terms = [{ name: 'revenue', description: 'Line totals net of tax.', status: 'draft', tags: ['ai-draft'] }];
    const { prompts, result } = await ask({ terms }, 'What is our revenue', () => 'SELECT SUM(unit_price) AS total FROM main.invoice_lines', [{ total: 12 }]);
    expect(prompts[0]).toContain('- business term revenue: AI draft: Line totals net of tax.');
    expect(JSON.stringify(result)).toContain('used AI-drafted term revenue');
  });

  it('a certified term loses the label', async () => {
    const terms = [{ name: 'revenue', description: 'Line totals net of tax.', status: 'certified', tags: ['ai-draft'] }];
    const { prompts, result } = await ask({ terms }, 'What is our revenue', () => 'SELECT SUM(unit_price) AS total FROM main.invoice_lines', [{ total: 12 }]);
    expect(prompts[0]).toContain('- business term revenue: Line totals net of tax.');
    expect(JSON.stringify(result)).not.toContain('AI-drafted term');
  });

  it('an answer that read other tables does not mention the draft', async () => {
    const { result } = await ask({ meanings: { invoice_lines: draft } }, 'How many customers are there', () => 'SELECT COUNT(*) AS customers FROM main.customers', [{ customers: 3 }]);
    expect(JSON.stringify(result)).not.toContain('AI-drafted descriptions');
  });
});

describe('a table the question\'s words miss is still shown', () => {
  // Wide enough that full cards are over the budget, narrow enough that one line a table is not.
  const ledgers = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`ledger_${index}`, {
    columns: Array.from({ length: 30 }, (_, column) => `amount_${column}`),
    primaryKey: ['amount_0'],
    foreignKeys: [{ columns: ['amount_1'], references: { relation: 'main.customers', columns: ['customer_id'] } }],
  } satisfies Table]));

  it('a question that names no table reaches every table when the schema fits, not "no table matches"', async () => {
    const { prompts, result } = await ask({}, 'How much did we earn last spring', declined);
    expect(prompts).not.toHaveLength(0);
    for (const name of Object.keys(TABLES)) expect(prompts[0]).toContain(`executable relation:main.${name}`);
    expect(JSON.stringify(result)).not.toContain('could be chosen from the words');
  });

  it('above the budget the chosen tables keep their detail and every other table comes in brief, with its keys', async () => {
    const tables = { customers: TABLES.customers!, ...ledgers(40) };
    const { prompts } = await ask({ tables }, 'How many customers are there in each country', declined);
    const prompt = prompts[0]!;
    expect(prompt).toContain('executable relation:main.customers [');
    expect(prompt).toMatch(/executable relation:main\.customers \[(?!in brief)/);
    expect(prompt).toContain('executable relation:main.ledger_39 [in brief]: amount_0 ');
    expect(prompt).toMatch(/amount_29/);
    expect(prompt).toContain('primary key (amount_0)');
    expect(prompt).toContain('foreign key (amount_1) references main.customers (customer_id)');
  });

  it('wide chosen tables never push a table off the list: past their budget they go in brief too', async () => {
    const wideName = (index: number) => `invoice_${index}`;
    const tables: Record<string, Table> = {};
    for (let index = 0; index < 5; index += 1) tables[wideName(index)] = { columns: Array.from({ length: 90 }, (_, column) => `invoice_measure_${column}`) };
    for (let index = 0; index < 100; index += 1) tables[`ref_${index}`] = { columns: ['ref_id', 'label'] };
    tables.ref_99 = { columns: ['ref_id', 'discount_rate'] };
    const { prompts, result } = await ask({ tables }, 'invoice discount rate', declined);
    for (const name of [...Object.keys(tables)]) expect(prompts[0]).toContain(`executable relation:main.${name} `);
    expect(prompts[0]).toContain('discount_rate');
    expect(JSON.stringify(result)).not.toContain('no table in this project matches');
  });

  it('a decline looks past the detailed tables: the table in the brief list that has the field moves up, and the draft runs again', async () => {
    const tables: Record<string, Table> = { invoices: TABLES.invoices!, ...ledgers(40), ledger_7: { columns: [...Array.from({ length: 30 }, (_, column) => `amount_${column}`), 'discount_rate'] } };
    let calls = 0;
    const { prompts, result } = await ask({ tables }, 'invoices total', () => (calls++ === 0 ? 'NO_SQL: no column holds the discount rate.' : 'SELECT AVG(discount_rate) AS rate FROM main.ledger_7'), [{ rate: 1 }]);
    expect(calls).toBeGreaterThan(1);
    expect(prompts.at(-1)).toMatch(/executable relation:main\.ledger_7 \[(?!in brief)/);
    expect(result.status).toBe('completed');
  });

  it('a decline nothing can answer says every table was searched only because every table was', async () => {
    const tables = { invoices: TABLES.invoices!, ...ledgers(40) };
    const { prompts, result } = await ask({ tables }, 'invoices total', () => 'NO_SQL: no column holds the discount rate.');
    for (const name of Object.keys(tables)) expect(prompts[0]).toContain(`executable relation:main.${name} `);
    expect(JSON.stringify(result)).toContain('Ask looked through every table it can read, and no other table has a column for it');
  });

  it('the value search still starts from the chosen tables', async () => {
    const tables: Record<string, Table> = { vendors: { columns: ['vendor_id', 'name', 'country'] }, ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`archive_${index}`, { columns: Array.from({ length: 30 }, (_, column) => `note_${column}`) }])) };
    const { executed } = await ask({ tables, probeAllowed: true }, 'How many vendors are named Contoso', declined);
    const probes = executed.filter((sql) => /LIKE '%contoso%'/.test(sql));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.some((sql) => /vendors/.test(sql) && /"name"/.test(sql))).toBe(true);
  });

  it('a table shown in brief can be drafted over', async () => {
    const tables = { customers: TABLES.customers!, ...ledgers(40) };
    const { result, executed } = await ask({ tables }, 'How many customers are there in each country', () => 'SELECT SUM(amount_3) AS total FROM main.ledger_39', [{ total: 1 }]);
    expect(result.status).toBe('completed');
    expect(executed.some((sql) => sql.includes('main.ledger_39'))).toBe(true);
  });

  it('with no words to go on and a schema too large even in brief, it says so without claiming no table exists', async () => {
    const wide: Record<string, Table> = {};
    for (let index = 0; index < 120; index += 1) wide[`t_${index}`] = { columns: Array.from({ length: 60 }, (_, column) => `c_${column}`) };
    const { result, prompts } = await ask({ tables: wide }, 'How much did we earn last spring', declined);
    expect(prompts).toHaveLength(0);
    expect(JSON.stringify(result)).toContain('none of the 120 tables this project lists could be chosen from the words of the question');
  }, 20_000);
});

describe('a drafted statement that reads a value with FROM', () => {
  it('EXTRACT(YEAR FROM i.invoice_date) is a column, not a table the request did not inspect', async () => {
    const tables = { ...TABLES, invoices: { ...TABLES.invoices!, columns: [...TABLES.invoices!.columns, 'invoice_date'] } };
    const { result, executed } = await ask({ tables }, 'Invoice total by year', () => 'SELECT EXTRACT(YEAR FROM i.invoice_date) AS y, SUM(i.total) AS total FROM main.invoices i GROUP BY 1', [{ y: 2026, total: 1 }]);
    expect(result.status).toBe('completed');
    expect(executed.some((sql) => sql.includes('EXTRACT'))).toBe(true);
  });
});

describe('a drafted statement can only read what the request inspected', () => {
  const read = (statement: string) => ask({ driver: 'duckdb' }, 'Total invoice amount for each customer country', () => statement, [{ total: 1 }]);
  const ran = (executed: string[], table: string) => executed.some((sql) => sql.includes(table));

  it.each([
    ['a comma join', 'SELECT 1 AS total FROM main.invoices i, main.secret_salaries s'],
    ['a comma join one grammar cannot read', 'SELECT i.total FROM main.invoices i, main.secret_salaries s QUALIFY ROW_NUMBER() OVER (ORDER BY i.total) = 1'],
    ['a fully quoted comma join', 'SELECT 1 AS total FROM "main"."invoices" i, "main"."secret_salaries" s'],
    ['a bare name beside a qualified one', 'SELECT 1 AS total FROM main.invoices i JOIN secret_salaries s ON s.id = i.invoice_id'],
    ['an alias spelled like a schema', 'SELECT 1 AS total FROM main.invoices hr JOIN hr.salaries x ON x.id = hr.invoice_id'],
    ['a string that hides nothing', "SELECT 'trim(' AS tag, s.pay AS total FROM main.secret_salaries s"],
    ['a statement no grammar can read', 'SELECT 1 AS total FROM main.invoices i JOIN main.secret_salaries s ON TRUE WHERE (('],
  ])('%s is not run', async (_, statement) => {
    const { executed, result } = await read(statement);
    expect(ran(executed, 'secret_salaries')).toBe(false);
    expect(result.status).not.toBe('completed');
  });

  // Dialect only one engine knows: no grammar reads it, and it reads inspected tables.
  const unreadable = 'SELECT i.total FROM main.invoices i ASOF JOIN main.customers c ON c.customer_id = i.customer_id WHERE ((1 = 1) AND TRUE) QUALIFY 1 = 1 SAMPLE 10';

  it('without a host, a statement no grammar can read is proved by the tables it names', async () => {
    const { result } = await read(unreadable);
    expect(result.status).toBe('completed');
  });

  it('with a host, it is sent back once and then not run', async () => {
    const { result, prompts, executed } = await ask({ driver: 'duckdb', hosted: true }, 'Total invoice amount for each customer country', () => unreadable, [{ total: 1 }]);
    expect(prompts.length).toBeGreaterThan(1);
    expect(result.status).not.toBe('completed');
    expect(executed.some((sql) => sql.includes('ASOF'))).toBe(false);
  });

  it('a comma join of inspected tables still runs', async () => {
    const { executed, result } = await read('SELECT SUM(i.total) AS total FROM main.invoices i, main.customers c WHERE c.customer_id = i.customer_id');
    expect(result.status).toBe('completed');
    expect(ran(executed, 'main.customers')).toBe(true);
  });
});

describe('a capitalised word in a question', () => {
  const sql = 'SELECT c.country, SUM(i.total) AS total FROM main.invoices i JOIN main.customers c ON c.customer_id = i.customer_id GROUP BY c.country';
  const rows = [{ country: 'NO', total: 10 }];

  it('an instruction is not a value: the answer runs, and the drafter is not asked twice', async () => {
    let calls = 0;
    const { result } = await ask({}, 'Total invoice amount for each customer country Return only those fields', () => { calls += 1; return sql; }, rows);
    expect(calls).toBe(1);
    expect(result.status).toBe('completed');
  });

  it.each(['Total invoice amount for Contoso by customer country', 'Total invoice amount excluding Contoso by customer country', 'How many Contoso invoices by customer country'])('a real value stays required: %s', async (question) => {
    const { result, executed } = await ask({}, question, () => sql, rows);
    expect(result.status).not.toBe('completed');
    expect(executed.filter((statement) => /SUM\(i\.total\)/.test(statement))).toHaveLength(0);
    expect(JSON.stringify(result)).toContain('Contoso');
  });
});

describe('a list longer than ZLens shows', () => {
  it('a LIMIT 500 the question did not ask for comes off, so the host\'s guard can see there is more', async () => {
    const { executed } = await ask({}, 'List every customer', () => 'SELECT customer_id, name FROM main.customers ORDER BY customer_id LIMIT 500', [{ customer_id: 1, name: 'a' }]);
    const statement = executed.find((sql) => sql.includes('main.customers') && !/HAVING/.test(sql))!;
    expect(statement).toMatch(/LIMIT 501\s*$/);
    expect(statement).not.toContain('LIMIT 500');
  });

  it('a question that asks for 500 keeps them', async () => {
    const { executed } = await ask({}, 'List the first 500 customers', () => 'SELECT customer_id, name FROM main.customers ORDER BY customer_id LIMIT 500', [{ customer_id: 1, name: 'a' }]);
    expect(executed.find((sql) => sql.includes('main.customers') && !/HAVING/.test(sql))).toMatch(/LIMIT 500\s*$/);
  });
});

describe('where nothing is governed, the SQL is drafted from the question itself', () => {
  const sql = 'SELECT c.country, SUM(i.total) AS total FROM main.invoices i JOIN main.customers c ON c.customer_id = i.customer_id GROUP BY c.country';
  const rows = [{ country: 'NO', total: 10 }];

  it('a warehouse-first project with no block, metric or measure drafts without the reading call', async () => {
    const { result, prompts, readings } = await ask({}, 'Total invoice amount for each customer country', () => sql, rows);
    expect(readings).toBe(0);
    expect(prompts[0]).toContain('QUESTION: Total invoice amount for each customer country');
    expect(prompts[0]).not.toContain('READING:');
    expect(result.status).toBe('completed');
    expect(result.trustState).toBe('review_required');
  });

  it('a question the drafter declines is read first, as before', async () => {
    let calls = 0;
    const { readings } = await ask({}, 'Total invoice amount for each customer country', () => (calls++ === 0 ? 'NO_SQL: no column holds it.' : sql), rows);
    expect(readings).toBeGreaterThan(0);
  });

  it('ZLENS_ASK_DRAFT_FIRST=0 keeps the reading first', async () => {
    vi.stubEnv('ZLENS_ASK_DRAFT_FIRST', '0');
    try {
      const { readings } = await ask({}, 'Total invoice amount for each customer country', () => sql, rows);
      expect(readings).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a project with a certified block is read first', async () => {
    const { readings } = await ask({ blocks: [{ name: 'invoice_totals', description: 'Invoice totals by country.', sql: 'SELECT c.country, SUM(i.total) AS total FROM main.invoices i JOIN main.customers c ON c.customer_id = i.customer_id GROUP BY 1', certified: true }] }, 'Total invoice amount for each customer country', () => sql, rows);
    expect(readings).toBeGreaterThan(0);
  });
});

describe('on DuckDB a statement may leave the default database out', () => {
  it('a drafted statement reading main.invoices for the inspected shop.main.invoices runs, through both the drafted- and the frozen-SQL check', async () => {
    const sql = 'SELECT c.country, SUM(i.total) AS total FROM main.invoices i JOIN main.customers c ON c.customer_id = i.customer_id GROUP BY c.country';
    const { result, executed } = await ask({ driver: 'duckdb', database: 'shop' }, 'Total invoice amount for each customer country', () => sql, [{ country: 'NO', total: 10 }]);
    expect(result.status).toBe('completed');
    expect(result.trustState).toBe('review_required');
    expect(executed.some((statement) => statement.includes('FROM main.invoices i'))).toBe(true);
  });

  it('on SQLite the same spelling stays exact', async () => {
    const sql = 'SELECT c.country, SUM(i.total) AS total FROM other.invoices i JOIN other.customers c ON c.customer_id = i.customer_id GROUP BY c.country';
    const { result, executed } = await ask({}, 'Total invoice amount for each customer country', () => sql, [{ country: 'NO', total: 10 }]);
    expect(result.status).not.toBe('completed');
    expect(executed.some((statement) => statement.includes('FROM other.invoices'))).toBe(false);
  });
});

describe('the certified blocks an AI-written statement reads', () => {
  const block = (name: string, description: string, sql: string, certified = true) => ({ kind: 'block', ref: `block:${name}`, name, aliases: [], roles: [], description, sql, certified, contract: { outputs: [], measures: [], staticScope: [], acceptedFilters: [] } }) as unknown as Parameters<typeof certifiedBlocksForDraft>[0][number];
  const entries = [
    block('loss_ratio_by_policy', 'Loss ratio per policy: losses paid over written premium.', 'SELECT p.policy_number, SUM(lp.amount) / SUM(pa.amount) FROM main.policy p JOIN main.policy_amount pa ON pa.policy_id = p.policy_id JOIN main.loss_payment lp ON lp.policy_id = p.policy_id GROUP BY 1'),
    block('claims_register', 'Every claim with its open and close dates.', 'SELECT * FROM main.claim'),
    block('draft_premium', 'Premium by agent.', 'SELECT 1 FROM main.policy_amount', false),
  ];

  it('keeps certified blocks that share words with the question and read a chosen table, best first; a draft block is never shown', () => {
    expect(certifiedBlocksForDraft(entries, 'loss ratio for each policy holder', ['"acme"."main"."policy"']).map((entry) => entry.name)).toEqual(['loss_ratio_by_policy']);
    // The draft "premium by agent" block is not shown; the certified block that computes premium is.
    expect(certifiedBlocksForDraft(entries, 'premium by agent', ['main.policy_amount']).map((entry) => entry.name)).toEqual(['loss_ratio_by_policy']);
    expect(certifiedBlocksForDraft(entries, 'how many orders', ['main.orders'])).toEqual([]);
  });

  it('the drafter reads the certified block near the question, and the run receipt names it', async () => {
    const blocks = [
      { name: 'invoice_totals', description: 'Invoice totals by customer country.', sql: 'SELECT c.country, SUM(i.total) AS total FROM main.invoices i JOIN main.customers c ON c.customer_id = i.customer_id GROUP BY 1', certified: true },
      { name: 'invoice_drafts', description: 'Invoice totals by customer country, a draft.', sql: 'SELECT 1 FROM main.invoices', certified: false },
    ];
    const { prompts, result } = await ask({ blocks }, 'Total invoice amount for each customer city', declined);
    expect(prompts[0]).toContain('- certified block invoice_totals (how the team joins these tables');
    expect(prompts[0]).toContain('Its certified SQL: SELECT c.country, SUM(i.total)');
    expect(prompts[0]).not.toContain('invoice_drafts');
    const receipt = (result as { askPipelineReceipt?: { dispatches: Array<{ label?: string; blocks?: string[] }> } }).askPipelineReceipt;
    expect(receipt?.dispatches.find((dispatch) => dispatch.blocks)?.blocks).toEqual(['block:shop.invoice_totals']);
  });
});

describe('the value profile reaches the drafter only when the project allows it', () => {
  const question = 'Total invoice amount for each customer country';

  it('opted in: the stored values and ranges sit beside their columns', async () => {
    const prompt = (await ask({ valueProfile: { written: true, allowed: true } }, question, declined)).prompts[0]!;
    expect(prompt).toMatch(/column:main\.customers\.country[^\n]* holds 'Brazil', 'Canada'/);
    expect(prompt).toMatch(/column:main\.invoices\.total[^\n]* ranges 0\.99 to 25\.86/);
  });

  it('not allowed (off, switched off since the sync, or under a host), absent, or of another catalog: no value is shown', async () => {
    for (const valueProfile of [
      { written: true, allowed: false },
      { written: true, allowed: true, fingerprint: 'sha256:another-catalog' },
      // On disk, but the host never said it may be used: the default is no.
      { written: true },
      { written: false, allowed: true },
    ]) {
      const prompt = (await ask({ valueProfile }, question, declined)).prompts[0]!;
      expect(prompt).toContain('executable relation:main.customers');
      expect(prompt).not.toContain(" holds 'Brazil'");
      expect(prompt).not.toContain('ranges 0.99');
    }
  });

  it('a dbt or hybrid project never shows it', async () => {
    for (const kind of ['dbt', 'hybrid'] as const) {
      const prompt = (await ask({ project: kind, valueProfile: { written: true, allowed: true } }, question, declined)).prompts[0] ?? '';
      expect(prompt).not.toContain(" holds 'Brazil'");
    }
  });
});

describe('where the project turns it on, every AI-drafted answer gets a review of its result, which sees its shape and never its values', () => {
  const question = 'The median of the invoice totals per customer country';
  const perCountry = 'SELECT c.country, SUM(i.total) AS total FROM main.invoices i JOIN main.customers c ON c.customer_id = i.customer_id GROUP BY c.country';
  const median = 'WITH t AS (SELECT c.country, SUM(i.total) AS total FROM main.invoices i JOIN main.customers c ON c.customer_id = i.customer_id GROUP BY c.country) SELECT AVG(total) AS median_total FROM t';
  const rows = [{ country: 'Brazil', total: 10 }, { country: 'Canada', total: 14 }];

  it('a named defect is revised once with the reason in words, and the revision is the answer', async () => {
    let drafts = 0;
    const { result, prompts, reviews } = await ask(
      { resultReview: true, valueProfile: { written: true, allowed: true }, review: () => JSON.stringify({ answers: false, problem: 'it returns one row per country; the question asks for the median of those totals' }) },
      question, () => (drafts++ === 0 ? perCountry : median), rows,
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain('rows: 2');
    expect(reviews[0]).toContain('- country: 2 distinct');
    // The value profile is allowed here, and still no value from the result reaches the review.
    expect(reviews[0]).not.toContain('Brazil');
    expect(reviews[0]).not.toContain('first rows');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('PREVIOUS SQL (it ran; this is why it needs another look)');
    expect(prompts[1]).toContain('WHAT TO CHANGE: the statement ran and returned 2 rows, but the result does not answer the question as asked: it returns one row per country');
    expect(result.status).toBe('completed');
    const dispatches = (result as { askPipelineReceipt?: { dispatches: Array<{ label?: string; outcome?: string }> } }).askPipelineReceipt?.dispatches ?? [];
    expect(dispatches.filter((dispatch) => dispatch.label === 'review').map((dispatch) => dispatch.outcome)).toEqual(['revise']);
    expect(dispatches.filter((dispatch) => dispatch.label === 'revise').map((dispatch) => dispatch.outcome)).toEqual(['sql']);
  });

  it('an empty result is redrafted as a statement that ran, not one the warehouse rejected; a dbt project keeps its recorded wording', async () => {
    const warehouse = await ask({ resultReview: true }, question, () => perCountry, []);
    expect(warehouse.prompts[1]).toContain('PREVIOUS SQL (it ran; this is why it needs another look)');
    expect(warehouse.prompts[1]).toContain('WHAT TO CHANGE: the statement ran and returned no rows');
    // Nothing came back, so there was nothing to review.
    expect(warehouse.reviews).toHaveLength(0);
    const dbt = await ask({ resultReview: true, project: 'dbt' }, question, () => perCountry, []);
    expect(dbt.prompts[1]).toContain('PREVIOUS SQL (the warehouse rejected it; fix it)');
  });

  it('a review that accepts, or cannot be read, leaves the first answer', async () => {
    for (const reply of ['{"answers": true}', 'not json at all']) {
      const { result, prompts, reviews } = await ask({ resultReview: true, review: () => reply }, question, () => perCountry, rows);
      expect(reviews).toHaveLength(1);
      expect(prompts).toHaveLength(1);
      expect(result.status).toBe('completed');
    }
  });

  it('a dbt project\'s AI-drafted answer is reviewed too', async () => {
    const { reviews, readings, result } = await ask({ resultReview: true, project: 'dbt' }, question, () => perCountry, rows);
    expect(readings).toBeGreaterThan(0);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(`QUESTION: ${question}`);
    expect(result.status).toBe('completed');
  });

  it('the reviewer is told it cannot see the data: a breakdown lists what has data, and only a stated count is checked', async () => {
    let system = '';
    await ask({ resultReview: true, review: (_prompt, told) => { system = told; return '{"answers": true}'; } }, question, () => perCountry, rows);
    expect(system).toContain('You cannot see the data, so never assume how many rows it holds');
    expect(system).toContain('a row count that contradicts a number the question itself states');
    expect(system).not.toContain('more or fewer rows than the question asks for');
  });

  it('is off by default: no setting, or the setting off, means no review call', async () => {
    for (const setup of [{}, { resultReview: false }] as Setup[]) {
      const { reviews, prompts, result } = await ask(setup, question, () => perCountry, rows);
      expect(reviews).toHaveLength(0);
      expect(prompts).toHaveLength(1);
      expect(result.status).toBe('completed');
      const dispatches = (result as { askPipelineReceipt?: { dispatches: Array<{ label?: string }> } }).askPipelineReceipt?.dispatches ?? [];
      expect(dispatches.some((dispatch) => dispatch.label === 'review')).toBe(false);
    }
  });

  it('ZLENS_ASK_RESULT_REVIEW overrides the project either way', async () => {
    try {
      vi.stubEnv('ZLENS_ASK_RESULT_REVIEW', '1');
      expect((await ask({}, question, () => perCountry, rows)).reviews).toHaveLength(1);
      expect((await ask({ resultReview: false }, question, () => perCountry, rows)).reviews).toHaveLength(1);
      vi.stubEnv('ZLENS_ASK_RESULT_REVIEW', '0');
      expect((await ask({ resultReview: true }, question, () => perCountry, rows)).reviews).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is read at every question: turning it on applies to the next question on the same running host', async () => {
    const { projectRoot, manifest } = project({});
    let on = false;
    let reviews = 0;
    const route = createAskPipelineRouteExecutor({
      projectRoot,
      executor: { executeQuery: vi.fn(async (sql: string) => (/HAVING COUNT\(\*\) > 1/.test(sql) ? { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] } : { columns: ['country', 'total'], rowCount: rows.length, executionTimeMs: 1, rows })) } as unknown as QueryExecutor,
      resolveConnection: async () => ({ driver: 'sqlite' } as ConnectionConfig),
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: `snapshot:${projectRoot}`, manifest: manifest as never }),
      resultReviewConfigured: () => on,
      selectProvider: async () => ({
        name: 'ollama', available: async () => true,
        generate: async (messages: AgentMessage[]) => {
          if (isReview(messages)) { reviews += 1; return '{"answers": true}'; }
          return isDraft(messages) ? perCountry : READING;
        },
      }) as AgentProvider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
    });
    const askOnce = (runId: string) => route({ runId, request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {} });
    try {
      await askOnce('run:off');
      expect(reviews).toBe(0);
      on = true;
      await askOnce('run:on');
      expect(reviews).toBe(1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
