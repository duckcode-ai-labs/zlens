/**
 * AI DRAFTS OF THE WORDS PEOPLE USE. Descriptions say what a table holds; a term
 * says what a word means here ("revenue", "backorder"). Those can't be read off
 * a schema with certainty, so this only proposes: each term is an ordinary term
 * file with `status = "draft"` and the `ai-draft` tag, which reaches the drafter
 * as labelled context and answers nothing. A person gives it an owner and
 * certifies it (zlens certify, or Modeling → Terms & concepts), which is the
 * only way a term counts.
 *
 * The model sees the table descriptions and columns, never rows. Every table
 * and column a term names must exist, or the term is dropped and listed. A word
 * the project already defines is left alone.
 */

import {
  readMeaningFiles,
  relationMeaning,
  writeTermDeclaration,
  type ManifestTerm,
  type WarehouseCatalogRelationV1,
  type WarehouseCatalogSnapshotV1,
} from '@zlens/core';
import type { AgentProvider } from '@zlens/agent';

export const AI_DRAFT_TAG = 'ai-draft';

const MAX_TERMS = 40;
const MAX_TABLE_CHARS = 60_000;
const MAX_NAME_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 400;
const MAX_SYNONYMS = 8;
const CALL_TIMEOUT_MS = 180_000;

const SYSTEM_PROMPT =
  'You draft a business glossary for a database. You see each table\'s description and columns, and no rows. ' +
  'List the words people at this business would use in questions that the table names do not say: what they call their measures, statuses and groups. ' +
  'For each word say in one sentence what it means here, which tables and columns it comes from, and how it is worked out. ' +
  'Only list a word the tables can support. A definition you cannot tie to columns is not a term. Never invent a column. ' +
  'Respond with ONLY a JSON object, no prose and no markdown fences.';

export interface TermDraftDropped {
  term: string;
  reason: string;
}

export interface TermDraftReport {
  drafted: Array<{ name: string; path: string }>;
  dropped: TermDraftDropped[];
  /** Set when the model call failed. */
  failed?: string;
}

function tableLine(relation: WarehouseCatalogRelationV1, description: string | undefined, describe: (column: string) => string | undefined): string {
  const columns = relation.columns.map((column) => {
    const words = column.comment ?? describe(column.name);
    return `${column.name}${column.type ? ` ${column.type}` : ''}${words ? ` (${words})` : ''}`;
  });
  return `Table ${relation.relation}${description ? `: ${description}` : ''}\n  ${columns.join('; ')}`;
}

/**
 * The described tables as the model reads them, the ones people use first: a
 * table with rows before an empty one, and a table that joins others before
 * one nothing points at. An empty copy defines no word, and the budget would
 * otherwise go to whatever sorts first.
 */
export function termDraftFacts(projectRoot: string, snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>): string {
  const files = readMeaningFiles(projectRoot);
  const links = new Map<string, number>();
  for (const relation of snapshot.relations) {
    for (const key of relation.foreignKeys ?? []) {
      const target = key.references.relation.toLowerCase().split('.').slice(-2).join('.');
      links.set(relation.id, (links.get(relation.id) ?? 0) + 1);
      const pointed = snapshot.relations.find((item) => [item.schema, item.name].filter(Boolean).join('.').toLowerCase() === target);
      if (pointed) links.set(pointed.id, (links.get(pointed.id) ?? 0) + 1);
    }
  }
  const empty = (relation: WarehouseCatalogRelationV1) => relation.rowCountEstimate === 0;
  const described = snapshot.relations
    .map((relation) => {
      const meaning = relationMeaning(files.get(relation.id), relation);
      const description = meaning?.description?.text ?? relation.comment;
      return { relation, description, line: tableLine(relation, description, (column) => meaning?.columns.get(column.toLowerCase())?.text) };
    })
    .filter((item) => item.description)
    .sort((a, b) => Number(empty(a.relation)) - Number(empty(b.relation))
      || (links.get(b.relation.id) ?? 0) - (links.get(a.relation.id) ?? 0)
      || a.relation.id.localeCompare(b.relation.id));
  const lines: string[] = [];
  let chars = 0;
  for (const item of described) {
    if (chars + item.line.length > MAX_TABLE_CHARS) break;
    lines.push(item.line);
    chars += item.line.length + 2;
  }
  return lines.join('\n\n');
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '');

interface DraftedTerm {
  name: string;
  termType?: string;
  description: string;
  synonyms: string[];
  columns: string[];
}

/** One term, checked against the catalog and the project's own words. What fails is listed. */
export function checkTermDraft(
  raw: Record<string, unknown>,
  snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>,
  taken: Set<string>,
): { term?: DraftedTerm; dropped?: TermDraftDropped } {
  const name = clean(raw.name);
  if (!name) return { dropped: { term: '(no name)', reason: 'the draft had no name' } };
  if (name.length > MAX_NAME_CHARS) return { dropped: { term: name.slice(0, MAX_NAME_CHARS), reason: 'the name is too long to be a word people use' } };
  if (taken.has(name.toLowerCase())) return { dropped: { term: name, reason: 'the project already defines this word' } };
  const description = clean(raw.description);
  if (!description) return { dropped: { term: name, reason: 'the draft had no definition' } };
  const named = Array.isArray(raw.columns) ? raw.columns.map(clean).filter(Boolean) : [];
  if (named.length === 0) return { dropped: { term: name, reason: 'it names no column, so nothing ties it to the data' } };
  const columns: string[] = [];
  for (const reference of named) {
    const parts = reference.split('.');
    const column = parts.pop()!.toLowerCase();
    const table = parts.join('.').toLowerCase();
    const relation = snapshot.relations.find((item) => [item.relation, [item.schema, item.name].filter(Boolean).join('.'), item.name].some((spelling) => spelling.toLowerCase() === table));
    if (!relation) return { dropped: { term: name, reason: `names a table that does not exist: ${parts.join('.') || reference}` } };
    const found = relation.columns.find((item) => item.name.toLowerCase() === column);
    if (!found) return { dropped: { term: name, reason: `names a column that does not exist: ${reference}` } };
    columns.push(`${[relation.schema, relation.name].filter(Boolean).join('.')}.${found.name}`);
  }
  const synonyms = Array.isArray(raw.synonyms)
    ? [...new Set(raw.synonyms.map(clean).filter((word) => word && word.length <= MAX_NAME_CHARS && !taken.has(word.toLowerCase()) && word.toLowerCase() !== name.toLowerCase()))].slice(0, MAX_SYNONYMS)
    : [];
  const termType = ['metric', 'dimension', 'entity', 'concept'].includes(clean(raw.termType).toLowerCase()) ? clean(raw.termType).toLowerCase() : undefined;
  return { term: { name, ...(termType ? { termType } : {}), description: description.slice(0, MAX_DESCRIPTION_CHARS), synonyms, columns: [...new Set(columns)] } };
}

function replyObject(text: string): { terms?: unknown } | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { terms?: unknown };
  } catch {
    return undefined;
  }
}

/** Draft terms from what the project's tables mean. Always resolves. */
export async function draftTerms(input: {
  projectRoot: string;
  snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>;
  terms: ManifestTerm[];
  provider: AgentProvider;
  domain?: string;
  /** Where term files live for that domain. */
  directory: string;
  maxTerms?: number;
}): Promise<TermDraftReport> {
  const report: TermDraftReport = { drafted: [], dropped: [] };
  const facts = termDraftFacts(input.projectRoot, input.snapshot);
  if (!facts) {
    report.failed = 'No table has a description yet. Draft the meanings first.';
    return report;
  }
  const taken = new Set(input.terms.flatMap((term) => [term.name, ...(term.synonyms ?? [])]).map((word) => word.toLowerCase()));
  const limit = Math.min(input.maxTerms ?? MAX_TERMS, MAX_TERMS);
  let parsed: { terms?: unknown } | undefined;
  try {
    const reply = await input.provider.generate(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${facts}\n\nRespond with JSON in exactly this shape, at most ${limit} terms:\n{"terms":[{"name":"the word","termType":"metric|dimension|entity|concept","description":"what it means here and how it is worked out","synonyms":["other words"],"columns":["schema.table.column"]}]}` },
      ],
      { maxTokens: 8_000, temperature: 0, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    parsed = replyObject(reply);
  } catch (error) {
    report.failed = error instanceof Error ? error.message : String(error);
    return report;
  }
  if (!Array.isArray(parsed?.terms)) {
    report.failed = 'the model did not reply with JSON';
    return report;
  }
  for (const raw of (parsed.terms as Array<Record<string, unknown>>).slice(0, limit)) {
    const { term, dropped } = checkTermDraft(raw, input.snapshot, taken);
    if (dropped) {
      report.dropped.push(dropped);
      continue;
    }
    try {
      const written = writeTermDeclaration(input.projectRoot, {
        name: term!.name,
        ...(input.domain ? { domain: input.domain } : {}),
        ...(term!.termType ? { termType: term!.termType } : {}),
        status: 'draft',
        description: `${term!.description} Reads ${term!.columns.join(', ')}.`,
        tags: [AI_DRAFT_TAG],
        ...(term!.synonyms.length ? { synonyms: term!.synonyms } : {}),
      }, { directory: input.directory });
      report.drafted.push({ name: term!.name, path: written.path });
      taken.add(term!.name.toLowerCase());
      for (const word of term!.synonyms) taken.add(word.toLowerCase());
    } catch (error) {
      report.dropped.push({ term: term!.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
