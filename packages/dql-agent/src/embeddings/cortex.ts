/**
 * Meaning search through Snowflake Cortex (approved design S1–S5, 2026-11-09).
 *
 * `AI_EMBED` turns the descriptions of tables, columns, metrics and saved queries into vectors inside the
 * customer's own Snowflake account, so "customers who left" can find a column documented as "cancelled".
 * It is the one embedder the ZLens app for Snowflake can use (the app reaches no other service), and a
 * choice for any project whose connection is Snowflake.
 *
 * This package never reaches a warehouse itself: the server hands over a SQL runner on its one query
 * path (`useCortexEmbeddingSql`). Without one, embedding fails and retrieval stays word-based.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { EmbeddingProvider } from './provider.js';

/** Runs one statement with positional binds on the project's Snowflake connection. */
export type CortexEmbeddingSql = (statement: string, binds: unknown[]) => Promise<Array<Record<string, unknown>>>;

/**
 * The models ZLens accepts. Snowflake takes the model name only as a literal in the SQL text, never as a
 * bound value, so only these names are ever written into a statement. Each model was trained with an
 * instruction in front of search questions (and none in front of the texts searched).
 */
export const CORTEX_EMBEDDING_MODELS = {
  'snowflake-arctic-embed-m-v1.5': { dimensions: 768, queryPrefix: 'Represent this sentence for searching relevant passages: ' },
  'snowflake-arctic-embed-l-v2.0': { dimensions: 1024, queryPrefix: 'query: ' },
} as const;

export type CortexEmbeddingModel = keyof typeof CORTEX_EMBEDDING_MODELS;

/**
 * The larger model: on the GitLab blind questions (442 tables) it found a right table in the top 8 for 37 of 40
 * as written and 25 of 40 reworded, against 34 and 21 for the smaller one, and 21 against 9 when tables have no
 * descriptions (search gate S4, 2026-11-09). 0.05 AI credits per million tokens: about a cent per catalog.
 */
export const CORTEX_DEFAULT_EMBEDDING_MODEL: CortexEmbeddingModel = 'snowflake-arctic-embed-l-v2.0';

export function isCortexEmbeddingModel(model: unknown): model is CortexEmbeddingModel {
  return typeof model === 'string' && Object.prototype.hasOwnProperty.call(CORTEX_EMBEDDING_MODELS, model);
}

/**
 * Texts per statement: one bound JSON list. Each statement costs about a second and a half however few texts
 * it holds, so the catalog's index rebuild sends this many at a time (`preferredBatchSize`).
 */
const BATCH_SIZE = 500;
/** The models read 512 tokens; Snowflake refuses longer input rather than cutting it. */
const MAX_CHARS = 1800;

let registeredSql: CortexEmbeddingSql | undefined;

/** The server's SQL runner for Cortex embeddings, or undefined to withdraw it. */
export function useCortexEmbeddingSql(sql: CortexEmbeddingSql | undefined): void {
  registeredSql = sql;
}

function parseVector(value: unknown): number[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error('Snowflake Cortex returned no vector.');
  return parsed.map((item) => Number(item));
}

/**
 * Vectors already paid for, kept on disk per project (`.dql/cache`): a text Cortex embedded once is never sent
 * again. The catalog rebuilds its whole vector index whenever the project changes; without this every rebuild
 * re-embedded every table, column and metric (54,338 texts on the GitLab project).
 */
class VectorCache {
  private readonly db: Database.Database;
  private readonly read: Database.Statement;
  private readonly write: Database.Statement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS vectors (model TEXT NOT NULL, text_hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (model, text_hash))');
    this.read = this.db.prepare('SELECT vector FROM vectors WHERE model = ? AND text_hash = ?');
    this.write = this.db.prepare('INSERT OR REPLACE INTO vectors (model, text_hash, vector) VALUES (?, ?, ?)');
  }

  get(model: string, hash: string): number[] | undefined {
    const row = this.read.get(model, hash) as { vector: Buffer } | undefined;
    if (!row) return undefined;
    return Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
  }

  putAll(model: string, entries: Array<{ hash: string; vector: number[] }>): void {
    this.db.transaction(() => {
      for (const entry of entries) this.write.run(model, entry.hash, Buffer.from(new Float32Array(entry.vector).buffer));
    })();
  }
}

const caches = new Map<string, VectorCache>();
function vectorCache(path: string): VectorCache {
  let cache = caches.get(path);
  if (!cache) {
    cache = new VectorCache(path);
    caches.set(path, cache);
  }
  return cache;
}

const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

export class CortexEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly model: CortexEmbeddingModel;
  readonly preferredBatchSize = BATCH_SIZE;
  private readonly sql?: CortexEmbeddingSql;
  private readonly cachePath?: string;

  constructor(options: { model?: string; sql?: CortexEmbeddingSql; cachePath?: string } = {}) {
    const model = options.model ?? CORTEX_DEFAULT_EMBEDDING_MODEL;
    if (!isCortexEmbeddingModel(model)) {
      throw new Error(`ZLens does not use the Cortex embedding model "${model}". Choose ${Object.keys(CORTEX_EMBEDDING_MODELS).join(' or ')}.`);
    }
    this.model = model;
    this.id = `cortex:${model}`;
    this.dimensions = CORTEX_EMBEDDING_MODELS[model].dimensions;
    this.sql = options.sql;
    this.cachePath = options.cachePath;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const cache = this.cachePath ? vectorCache(this.cachePath) : undefined;
    const prepared = texts.map((text) => (text.trim() ? text.slice(0, MAX_CHARS) : ' '));
    const hashes = prepared.map(textHash);
    const vectors: Array<number[] | undefined> = hashes.map((hash) => cache?.get(this.model, hash));
    const missing = [...new Set(prepared.filter((_, index) => !vectors[index]))];
    const embedded = new Map<string, number[]>();
    for (let start = 0; start < missing.length; start += BATCH_SIZE) {
      const batch = missing.slice(start, start + BATCH_SIZE);
      const batchVectors = await this.batch(batch);
      batch.forEach((text, index) => embedded.set(text, batchVectors[index]!));
      cache?.putAll(this.model, batch.map((text, index) => ({ hash: textHash(text), vector: batchVectors[index]! })));
    }
    return prepared.map((text, index) => vectors[index] ?? embedded.get(text)!);
  }

  /** A search question, with the instruction the model was trained to see in front of one. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.batch([`${CORTEX_EMBEDDING_MODELS[this.model].queryPrefix}${text}`]);
    return vector ?? [];
  }

  private async batch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const sql = this.sql ?? registeredSql;
    if (!sql) throw new Error('Snowflake Cortex search runs inside the ZLens server, on its Snowflake connection.');
    // The model is one of CORTEX_EMBEDDING_MODELS (checked in the constructor): safe to write into the text.
    const statement = `SELECT f.index AS I, AI_EMBED('${this.model}', f.value::STRING)::ARRAY AS V `
      + 'FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f';
    const input = texts.map((text) => (text.trim() ? text.slice(0, MAX_CHARS) : ' '));
    const rows = await sql(statement, [JSON.stringify(input)]);
    const vectors: number[][] = new Array(texts.length);
    for (const row of rows) {
      const index = Number(row.I ?? row.i);
      if (!Number.isInteger(index) || index < 0 || index >= texts.length) continue;
      const vector = parseVector(row.V ?? row.v);
      if (vector.length !== this.dimensions) {
        throw new Error(`Snowflake Cortex returned ${vector.length} numbers for ${this.model}; ZLens expected ${this.dimensions}.`);
      }
      vectors[index] = vector;
    }
    for (let index = 0; index < texts.length; index += 1) {
      if (!vectors[index]) throw new Error('Snowflake Cortex returned fewer vectors than texts.');
    }
    return vectors;
  }
}
