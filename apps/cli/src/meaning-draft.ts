/**
 * THE AI FIRST DRAFT OF WHAT THE DATA MEANS.
 *
 * A database with no comments gives search nothing but names, and no name says
 * "revenue". This asks the project's own model what each table and column
 * holds, from names, types, keys and any comment already there. No rows leave
 * the machine; a few sample values go only where the project has opted into the
 * value profile, under its rules.
 *
 * It fills gaps only. A warehouse comment and a person's words are never
 * replaced. Tables go in a fixed order and each batch is saved as it finishes,
 * so a run that stops resumes where it stopped and a second run costs nothing.
 * Every draft is checked against the catalog, and what is dropped is listed
 * with the reason. The result is a draft: see meaning-files.ts for what a draft
 * may and may not do.
 */

import {
  readMeaningFiles,
  meaningFileStale,
  relationColumnsFingerprint,
  writeMeaningFile,
  type MeaningEntryV1,
  type MeaningFileV1,
  type MeaningTableEntryV1,
  type WarehouseCatalogRelationV1,
  type WarehouseCatalogSnapshotV1,
} from '@zlens/core';
import type { AgentProvider } from '@zlens/agent';
import type { ColumnValueProfile, ValueProfileV1 } from './value-profile.js';

const MAX_BATCH_TABLES = 12;
const MAX_BATCH_CHARS = 6_000;
const MAX_COLUMNS_SHOWN = 150;
const MAX_VIEW_SQL_CHARS = 1_500;
const MAX_DESCRIPTION_CHARS = 240;
const MAX_OTHER_NAMES = 6;
const MAX_OTHER_NAME_CHARS = 40;
const BATCH_TIMEOUT_MS = 180_000;
const BATCH_MAX_TOKENS = 8_000;
/** A hard limit on one run; `--max-tables` lowers or raises it. */
export const DEFAULT_MAX_TABLES = 2_000;
/** Roughly what a column costs in the reply, for the estimate before a run. */
const REPLY_TOKENS_PER_COLUMN = 25;
const REPLY_TOKENS_PER_TABLE = 60;

const SYSTEM_PROMPT =
  'You write the first draft of a data dictionary for a database. You see table names, column names, types and keys, and no rows. ' +
  'For each table say in plain business words what one row is, and for each column what it holds. ' +
  'For each table also give the other names a business person would use when asking about this data, such as "revenue" or "sales lines" for invoice lines. ' +
  'Say only what the names and keys support. Leave out a column whose meaning cannot be told. Never restate a column\'s name as its description. ' +
  'Keep each description to one short sentence. Respond with ONLY a JSON object, no prose and no markdown fences.';

export interface MeaningDraftPlan {
  /** What will be drafted, in the fixed order. */
  batches: WarehouseCatalogRelationV1[][];
  tables: number;
  columns: number;
  /** Tables with nothing to draft: fully described, or already drafted. */
  alreadyDone: number;
  /** Tables past the limit, left for the next run. */
  overLimit: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface MeaningDraftDropped {
  relation: string;
  column?: string;
  reason: string;
}

export interface MeaningDraftReport {
  tablesDrafted: number;
  columnsDrafted: number;
  dropped: MeaningDraftDropped[];
  /** Batches that failed; their tables are drafted by the next run. */
  failed: Array<{ tables: string[]; reason: string }>;
  /** Set when the run stopped early, with why. */
  stopped?: string;
}

/** Whether this table has something a draft could add, and hasn't been drafted against these columns. */
function needsDraft(relation: WarehouseCatalogRelationV1, file: MeaningFileV1 | undefined): boolean {
  const bare = !relation.comment || relation.columns.some((column) => !column.comment);
  if (!bare) return false;
  return !file || meaningFileStale(file, relation);
}

function tableFacts(
  relation: WarehouseCatalogRelationV1,
  referencedBy: Map<string, string[]>,
  values: Record<string, ColumnValueProfile> | undefined,
): string {
  const lines = [`Table ${relation.relation} (${relation.kind}${relation.rowCountEstimate ? `, about ${relation.rowCountEstimate} rows` : ''})`];
  if (relation.comment) lines.push(`  described already: ${relation.comment}`);
  if (relation.primaryKey?.length) lines.push(`  primary key: ${relation.primaryKey.join(', ')}`);
  for (const key of relation.foreignKeys ?? []) lines.push(`  foreign key: ${key.columns.join(', ')} -> ${key.references.relation} (${key.references.columns.join(', ')})`);
  const pointing = referencedBy.get(relation.relation.toLowerCase()) ?? [];
  if (pointing.length) lines.push(`  referenced by: ${pointing.slice(0, 8).join(', ')}`);
  lines.push('  columns:');
  for (const column of relation.columns.slice(0, MAX_COLUMNS_SHOWN)) {
    const profile = values?.[column.name];
    const sample = profile?.examples?.length ? ` e.g. ${profile.examples.slice(0, 4).join(' | ')}` : profile?.min !== undefined ? ` from ${profile.min} to ${profile.max}` : '';
    lines.push(`    ${column.name}${column.type ? ` ${column.type}` : ''}${column.comment ? ` (described already: ${column.comment})` : ''}${sample}`);
  }
  if (relation.columns.length > MAX_COLUMNS_SHOWN) lines.push(`    ... and ${relation.columns.length - MAX_COLUMNS_SHOWN} more`);
  if (relation.viewSql) lines.push(`  defined as: ${relation.viewSql.replace(/\s+/g, ' ').slice(0, MAX_VIEW_SQL_CHARS)}`);
  return lines.join('\n');
}

function referencedByMap(relations: WarehouseCatalogRelationV1[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const relation of relations) {
    for (const key of relation.foreignKeys ?? []) {
      const target = key.references.relation.toLowerCase();
      map.set(target, [...(map.get(target) ?? []), `${relation.relation} (${key.columns.join(', ')})`]);
    }
  }
  return map;
}

function userPrompt(facts: string[]): string {
  return `${facts.join('\n\n')}\n\n` +
    'Respond with JSON in exactly this shape:\n' +
    '{"tables":[{"relation":"<the table name as given>","description":"what one row is","otherNames":["..."],"columns":{"<column>":"what it holds"}}]}\n' +
    'Include every table above. Leave out anything marked "described already".';
}

/** What a run would do, with no model call. The cost shown before anyone chooses to run it. */
export function planMeaningDrafts(
  projectRoot: string,
  snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>,
  options: { maxTables?: number; valueProfile?: ValueProfileV1 } = {},
): MeaningDraftPlan {
  const files = readMeaningFiles(projectRoot);
  const ordered = [...snapshot.relations].sort((a, b) => a.id.localeCompare(b.id));
  const wanted = ordered.filter((relation) => needsDraft(relation, files.get(relation.id)));
  const chosen = wanted.slice(0, options.maxTables ?? DEFAULT_MAX_TABLES);
  const referencedBy = referencedByMap(ordered);
  const batches: WarehouseCatalogRelationV1[][] = [];
  let current: WarehouseCatalogRelationV1[] = [];
  let chars = 0;
  let inputChars = 0;
  for (const relation of chosen) {
    const size = tableFacts(relation, referencedBy, options.valueProfile?.relations[relation.relation]).length;
    if (current.length > 0 && (current.length >= MAX_BATCH_TABLES || chars + size > MAX_BATCH_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(relation);
    chars += size;
    inputChars += size;
  }
  if (current.length > 0) batches.push(current);
  const columns = chosen.reduce((total, relation) => total + relation.columns.length, 0);
  return {
    batches,
    tables: chosen.length,
    columns,
    alreadyDone: ordered.length - wanted.length,
    overLimit: wanted.length - chosen.length,
    estimatedInputTokens: Math.ceil((inputChars + batches.length * (SYSTEM_PROMPT.length + 400)) / 4),
    estimatedOutputTokens: columns * REPLY_TOKENS_PER_COLUMN + chosen.length * REPLY_TOKENS_PER_TABLE,
  };
}

/** The first balanced JSON object in a model's reply. */
function replyObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const FILLER_WORDS = new Set(['a', 'an', 'the', 'of', 'for', 'this', 'that', 'in', 'on', 'to', 'is', 'its', 'and', 'column', 'field', 'value', 'values', 'record', 'row', 'table', 'data', 'stored', 'holds']);
const wordsOf = (text: string) => text.toLowerCase().replace(/([a-z0-9])_([a-z0-9])/g, '$1 $2').split(/[^a-z0-9]+/).filter(Boolean);
const squeezed = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A description with nothing to say: every word of it is already in the
 * column's or the table's name. "Extended price" adds nothing to extendedprice.
 */
export function restatesName(description: string, column: string, table: string): boolean {
  const name = squeezed(column);
  const tableName = squeezed(table);
  const words = wordsOf(description).filter((word) => !FILLER_WORDS.has(word));
  return words.every((word) => name.includes(word) || tableName.includes(word) || tableName.includes(word.replace(/s$/, '')));
}

const cleanText = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

function checkedText(value: unknown, relation: string, column: string | undefined, dropped: MeaningDraftDropped[]): string | undefined {
  if (typeof value !== 'string' || !cleanText(value)) {
    dropped.push({ relation, ...(column ? { column } : {}), reason: 'the draft was empty' });
    return undefined;
  }
  const text = cleanText(value);
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : text;
}

/** One table's draft, checked against the catalog. What fails is listed, never hidden. */
export function checkTableDraft(
  relation: WarehouseCatalogRelationV1,
  draft: Record<string, unknown>,
  stamp: { model?: string; date: string },
): { table?: MeaningTableEntryV1; columns: Record<string, MeaningEntryV1>; dropped: MeaningDraftDropped[] } {
  const dropped: MeaningDraftDropped[] = [];
  const entry = (description: string): MeaningEntryV1 => ({ description, source: 'ai', ...(stamp.model ? { model: stamp.model } : {}), date: stamp.date });
  const known = new Map(relation.columns.map((column) => [column.name.toLowerCase(), column]));
  const columns: Record<string, MeaningEntryV1> = {};
  for (const [name, value] of Object.entries((draft.columns ?? {}) as Record<string, unknown>)) {
    const column = known.get(name.toLowerCase());
    if (!column) {
      dropped.push({ relation: relation.relation, column: name, reason: 'the table has no such column' });
      continue;
    }
    if (column.comment) continue;
    const text = checkedText(value, relation.relation, column.name, dropped);
    if (!text) continue;
    if (restatesName(text, column.name, relation.name)) {
      dropped.push({ relation: relation.relation, column: column.name, reason: `says nothing the name doesn't: "${text}"` });
      continue;
    }
    columns[column.name] = entry(text);
  }
  const description = relation.comment ? undefined : checkedText(draft.description, relation.relation, undefined, dropped);
  const otherNames = Array.isArray(draft.otherNames)
    ? [...new Set(draft.otherNames.filter((name): name is string => typeof name === 'string').map(cleanText))]
      .filter((name) => name && name.length <= MAX_OTHER_NAME_CHARS && squeezed(name) !== squeezed(relation.name))
      .slice(0, MAX_OTHER_NAMES)
    : [];
  const tableEntry: MeaningTableEntryV1 | undefined = description
    ? { ...entry(description), ...(otherNames.length ? { otherNames } : {}) }
    : undefined;
  return { ...(tableEntry ? { table: tableEntry } : {}), columns, dropped };
}

/** What a table's draft was read from, for the person reviewing it. */
export function draftEvidence(relation: WarehouseCatalogRelationV1, referencedBy: Map<string, string[]>, usedValues: boolean): string[] {
  const pointing = referencedBy.get(relation.relation.toLowerCase()) ?? [];
  return [
    `the names and types of ${relation.columns.length} columns`,
    ...(relation.primaryKey?.length ? [`primary key ${relation.primaryKey.join(', ')}`] : []),
    ...(relation.foreignKeys ?? []).map((key) => `foreign key to ${key.references.relation}`),
    ...(pointing.length ? [`referenced by ${pointing.length} other ${pointing.length === 1 ? 'table' : 'tables'}`] : []),
    ...(relation.viewSql ? ['the view definition'] : []),
    ...(usedValues ? ['sample values from the value profile'] : []),
  ];
}

/** A new draft over what the file holds: a person's words stay, an old draft goes. */
export function mergeMeaningDraft(
  existing: MeaningFileV1 | undefined,
  relation: WarehouseCatalogRelationV1,
  draft: { table?: MeaningTableEntryV1; columns: Record<string, MeaningEntryV1> },
): MeaningFileV1 {
  const columns: Record<string, MeaningEntryV1> = {};
  for (const [name, entry] of Object.entries(existing?.columns ?? {})) if (entry.source === 'person') columns[name] = entry;
  const edited = new Set(Object.keys(columns).map((name) => name.toLowerCase()));
  for (const [name, entry] of Object.entries(draft.columns)) if (!edited.has(name.toLowerCase())) columns[name] = entry;
  const table = existing?.table?.source === 'person' ? existing.table : draft.table;
  return {
    version: 1,
    id: relation.id,
    relation: relation.relation,
    columnsFingerprint: relationColumnsFingerprint(relation),
    ...(table ? { table } : {}),
    columns,
  };
}

/** A provider failure no other batch will get past: a spent quota or a lost login. */
function stopsTheRun(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  if (code === 'provider_quota' || code === 'provider_auth') return error instanceof Error ? error.message : String(error);
  return undefined;
}

/** Draft what the plan lists, saving each batch as it finishes. Always resolves. */
export async function draftMeanings(input: {
  projectRoot: string;
  snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>;
  provider: AgentProvider;
  model?: string;
  maxTables?: number;
  concurrency?: number;
  valueProfile?: ValueProfileV1;
  /** Today, `YYYY-MM-DD`. */
  date: string;
  onBatch?: (progress: { done: number; total: number }) => void;
}): Promise<MeaningDraftReport> {
  const plan = planMeaningDrafts(input.projectRoot, input.snapshot, input);
  const referencedBy = referencedByMap(input.snapshot.relations);
  const report: MeaningDraftReport = { tablesDrafted: 0, columnsDrafted: 0, dropped: [], failed: [] };
  const stamp = { ...(input.model ? { model: input.model } : {}), date: input.date };
  let cursor = 0;
  let done = 0;

  const runBatch = async (batch: WarehouseCatalogRelationV1[]): Promise<void> => {
    const facts = batch.map((relation) => tableFacts(relation, referencedBy, input.valueProfile?.relations[relation.relation]));
    const names = batch.map((relation) => relation.relation);
    let reply: Record<string, unknown> | undefined;
    let reason = 'the model did not reply with JSON';
    // One retry: a reply cut short or malformed is usually fine the second time.
    for (let attempt = 0; attempt < 2 && !reply; attempt += 1) {
      try {
        const text = await input.provider.generate(
          [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt(facts) }],
          { maxTokens: BATCH_MAX_TOKENS, temperature: 0, signal: AbortSignal.timeout(BATCH_TIMEOUT_MS) },
        );
        reply = replyObject(text);
      } catch (error) {
        const fatal = stopsTheRun(error);
        if (fatal) {
          report.stopped = fatal;
          report.failed.push({ tables: names, reason: fatal });
          return;
        }
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (!Array.isArray(reply?.tables)) {
      report.failed.push({ tables: names, reason });
      return;
    }
    // A bare name stands for a table only when one table in the batch has it.
    const bare = new Map<string, number>();
    for (const relation of batch) bare.set(relation.name.toLowerCase(), (bare.get(relation.name.toLowerCase()) ?? 0) + 1);
    const byName = new Map(batch.flatMap((relation) => [relation.relation, [relation.schema, relation.name].filter(Boolean).join('.'), ...(bare.get(relation.name.toLowerCase()) === 1 ? [relation.name] : [])].map((name) => [name.toLowerCase(), relation] as const)));
    const answered = new Set<string>();
    for (const item of reply.tables as Array<Record<string, unknown>>) {
      const relation = typeof item?.relation === 'string' ? byName.get(item.relation.toLowerCase()) : undefined;
      if (!relation) {
        report.dropped.push({ relation: String(item?.relation), reason: 'the model named a table it was not given' });
        continue;
      }
      if (answered.has(relation.id)) continue;
      answered.add(relation.id);
      const checked = checkTableDraft(relation, item, stamp);
      report.dropped.push(...checked.dropped);
      if (checked.table) checked.table.evidence = draftEvidence(relation, referencedBy, Boolean(input.valueProfile?.relations[relation.relation]));
      writeMeaningFile(input.projectRoot, mergeMeaningDraft(readMeaningFiles(input.projectRoot).get(relation.id), relation, checked));
      report.tablesDrafted += 1;
      report.columnsDrafted += Object.keys(checked.columns).length;
    }
    const missing = batch.filter((relation) => !answered.has(relation.id)).map((relation) => relation.relation);
    if (missing.length) report.failed.push({ tables: missing, reason: 'the model left these tables out' });
  };

  const worker = async (): Promise<void> => {
    while (cursor < plan.batches.length && !report.stopped) {
      const batch = plan.batches[cursor++]!;
      await runBatch(batch);
      done += 1;
      input.onBatch?.({ done, total: plan.batches.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency ?? 3, plan.batches.length) }, () => worker()));
  return report;
}

/** A table's standing, for `zlens model meanings` and the review screen. */
export interface MeaningsStatus {
  tables: number;
  /** Tables whose file holds at least one draft nobody has reviewed. */
  drafted: number;
  /** Tables a person has reviewed in full. */
  reviewed: number;
  /** Tables whose drafts no longer match the columns. */
  stale: number;
  /** Tables with no words at all. */
  undescribed: number;
}

export function meaningsStatus(projectRoot: string, snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>): MeaningsStatus {
  const files = readMeaningFiles(projectRoot);
  const status: MeaningsStatus = { tables: snapshot.relations.length, drafted: 0, reviewed: 0, stale: 0, undescribed: 0 };
  for (const relation of snapshot.relations) {
    const file = files.get(relation.id);
    const entries = file ? [...(file.table ? [file.table] : []), ...Object.values(file.columns)] : [];
    if (entries.length === 0) {
      if (!relation.comment && !relation.columns.some((column) => column.comment)) status.undescribed += 1;
      continue;
    }
    const drafts = entries.filter((entry) => entry.source === 'ai').length;
    if (drafts > 0 && meaningFileStale(file!, relation)) status.stale += 1;
    else if (drafts > 0) status.drafted += 1;
    else status.reviewed += 1;
  }
  return status;
}
