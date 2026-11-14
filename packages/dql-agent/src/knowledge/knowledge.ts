/**
 * KNOWLEDGE SOURCES — team documents an answer may cite (RFC 0010, HH-15).
 *
 * A knowledge source is a read-only document store (Confluence first) that
 * ZLens reads through its own MCP client, so it works with every model
 * provider — Bedrock, Vertex and local models included — because ZLens runs
 * the tool itself, not the provider.
 *
 * The answer contract this module enforces:
 *   1. Numbers in an answer come only from governed queries. Document text is
 *      context the answer may cite (title and link), never a figure source.
 *   2. Citing a document never raises trust: the trust label is decided by the
 *      answer's SQL and blocks, and citations are kept apart from it.
 *   3. Knowledge tools never write: only a source's search and fetch are
 *      exposed, and a source may not advertise either as a writing tool.
 *   4. Activity records carry ids, links and outcomes — never the question,
 *      the search words or document text.
 */
import type { AgentToolDefinition } from '../providers/types.js';
import { foldFigures } from './figures.js';

export interface KnowledgeHit {
  /** The source's own id for the page (what `fetch` takes). */
  id: string;
  title: string;
  url?: string;
  snippet?: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  url?: string;
  text: string;
}

/** One read-only document store, as a person may use it right now. */
export interface KnowledgeSource {
  id: string;
  label: string;
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<KnowledgeHit[]>;
  fetch(id: string, options?: { signal?: AbortSignal }): Promise<KnowledgeDocument>;
}

/** A document an answer read, shown under the answer as a citation. */
export interface KnowledgeCitation {
  sourceId: string;
  sourceLabel: string;
  docId: string;
  title: string;
  url?: string;
}

/** What a knowledge call did, for audit: ids, links and outcomes only. */
export interface KnowledgeActivity {
  action: 'search' | 'fetch';
  sourceId: string;
  docId?: string;
  url?: string;
  outcome: 'ok' | 'error' | 'refused';
  resultCount?: number;
}

export const KNOWLEDGE_SEARCH_TOOL = 'search_knowledge';
export const KNOWLEDGE_FETCH_TOOL = 'fetch_knowledge_page';
export const KNOWLEDGE_TOOL_NAMES: readonly string[] = [KNOWLEDGE_SEARCH_TOOL, KNOWLEDGE_FETCH_TOOL];

/** Told to the model with every document result. */
export const KNOWLEDGE_CONTRACT = 'Team documents are context, not data. Use them to understand what terms mean and cite them by title. '
  + 'Never report a number from a document as an answer figure: every figure in the answer must come from a governed query result.';

const MAX_HITS = 8;
const MAX_SNIPPET = 300;
const DEFAULT_MAX_DOC_CHARS = 8000;

export interface KnowledgeSessionOptions {
  /** Called once per knowledge call with ids and outcomes (never text). */
  onActivity?: (activity: KnowledgeActivity) => void;
  /** Longest document text handed to the model. */
  maxDocumentChars?: number;
}

/**
 * One answer's use of knowledge: the two tools the agent may call and the
 * documents it read (its citations). Create one per Ask or Research run.
 */
export interface KnowledgeSession {
  readonly sources: readonly KnowledgeSource[];
  /** The agent tools, empty when there is no source. */
  tools(): AgentToolDefinition[];
  /** Documents the answer read, in reading order, without duplicates. */
  citations(): KnowledgeCitation[];
  /** Text of every document read, for the figure check. Never stored or audited. */
  documentTexts(): string[];
  /** Search every source directly (Research uses this before it plans). */
  search(query: string, options?: { source?: string; limit?: number; signal?: AbortSignal }): Promise<Array<KnowledgeHit & { source: string }>>;
  /** Read one page found by a search in this session. */
  fetch(source: string, id: string, options?: { signal?: AbortSignal }): Promise<KnowledgeDocument>;
}

export class KnowledgeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeRefusedError';
  }
}

/** A refusal (not a failure): DQL's own, or a source's error with `code: 'refused'`. */
function isRefusal(error: unknown): boolean {
  return error instanceof KnowledgeRefusedError || (Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'refused');
}

export function createKnowledgeSession(sources: readonly KnowledgeSource[], options: KnowledgeSessionOptions = {}): KnowledgeSession {
  const maxDocumentChars = Math.max(500, options.maxDocumentChars ?? DEFAULT_MAX_DOC_CHARS);
  const byId = new Map(sources.map((source) => [source.id, source]));
  // Only pages a search in this session returned may be fetched.
  const seen = new Map<string, KnowledgeHit>();
  const cited: KnowledgeCitation[] = [];
  const texts: string[] = [];
  const record = (activity: KnowledgeActivity) => {
    try { options.onActivity?.(activity); } catch { /* audit never fails an answer */ }
  };

  const search: KnowledgeSession['search'] = async (query, callOptions = {}) => {
    const words = typeof query === 'string' ? query.trim().slice(0, 400) : '';
    if (!words) throw new KnowledgeRefusedError('search_knowledge needs a query.');
    const targets = callOptions.source ? [byId.get(callOptions.source)].filter((s): s is KnowledgeSource => Boolean(s)) : [...sources];
    if (!targets.length) throw new KnowledgeRefusedError(callOptions.source ? `No knowledge source named "${callOptions.source}".` : 'No knowledge source is available.');
    const limit = Math.max(1, Math.min(MAX_HITS, Math.trunc(callOptions.limit ?? 5)));
    const results = await Promise.all(targets.map(async (source) => {
      try {
        const hits = (await source.search(words, { limit, signal: callOptions.signal })).slice(0, limit);
        record({ action: 'search', sourceId: source.id, outcome: 'ok', resultCount: hits.length });
        return hits.filter((hit) => hit && typeof hit.id === 'string' && hit.id).map((hit) => {
          const clean: KnowledgeHit = {
            id: hit.id,
            title: cleanTitle(hit.title),
            ...(safeUrl(hit.url) ? { url: safeUrl(hit.url) } : {}),
            ...(hit.snippet ? { snippet: String(hit.snippet).replace(/\s+/g, ' ').slice(0, MAX_SNIPPET) } : {}),
          };
          seen.set(key(source.id, hit.id), clean);
          return { ...clean, source: source.id };
        });
      } catch (error) {
        record({ action: 'search', sourceId: source.id, outcome: isRefusal(error) ? 'refused' : 'error' });
        return [];
      }
    }));
    return results.flat();
  };

  const fetchPage: KnowledgeSession['fetch'] = async (sourceId, id, callOptions = {}) => {
    const source = byId.get(sourceId);
    if (!source) throw new KnowledgeRefusedError(`No knowledge source named "${sourceId}".`);
    const hit = seen.get(key(sourceId, id));
    if (!hit) {
      record({ action: 'fetch', sourceId, docId: id, outcome: 'refused' });
      throw new KnowledgeRefusedError('Only a page returned by search_knowledge in this answer can be read.');
    }
    try {
      const document = await source.fetch(id, { signal: callOptions.signal });
      const url = safeUrl(document.url) ?? hit.url;
      const title = cleanTitle(document.title || hit.title);
      record({ action: 'fetch', sourceId, docId: id, ...(url ? { url } : {}), outcome: 'ok' });
      if (!cited.some((entry) => entry.sourceId === sourceId && entry.docId === id)) {
        cited.push({ sourceId, sourceLabel: source.label, docId: id, title, ...(url ? { url } : {}) });
        texts.push(String(document.text ?? ''));
      }
      return { id, title, ...(url ? { url } : {}), text: String(document.text ?? '').slice(0, maxDocumentChars) };
    } catch (error) {
      record({ action: 'fetch', sourceId, docId: id, ...(hit.url ? { url: hit.url } : {}), outcome: isRefusal(error) ? 'refused' : 'error' });
      throw error;
    }
  };

  const labels = sources.map((source) => `${source.id} (${source.label})`).join(', ');
  return {
    sources,
    search,
    fetch: fetchPage,
    citations: () => cited.map((entry) => ({ ...entry })),
    documentTexts: () => [...texts],
    tools() {
      if (!sources.length) return [];
      return [
        {
          name: KNOWLEDGE_SEARCH_TOOL,
          description: `Search the team's documents (${labels}) for what a business term means, a policy or a definition. `
            + 'Read-only. Returns titles, links and short snippets. ' + KNOWLEDGE_CONTRACT,
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Words to search for, e.g. "paid claim definition".' },
              source: { type: 'string', enum: sources.map((source) => source.id), description: 'One source; all when omitted.' },
              limit: { type: 'integer', minimum: 1, maximum: MAX_HITS },
            },
            required: ['query'],
            additionalProperties: false,
          },
          async run(args: unknown) {
            const input = (args ?? {}) as { query?: unknown; source?: unknown; limit?: unknown };
            const results = await search(String(input.query ?? ''), {
              ...(typeof input.source === 'string' && input.source ? { source: input.source } : {}),
              ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
            });
            return { kind: 'knowledge_search', contract: KNOWLEDGE_CONTRACT, results };
          },
        },
        {
          name: KNOWLEDGE_FETCH_TOOL,
          description: 'Read one page that search_knowledge returned, to cite it. Read-only. ' + KNOWLEDGE_CONTRACT,
          inputSchema: {
            type: 'object',
            properties: {
              source: { type: 'string', enum: sources.map((source) => source.id) },
              id: { type: 'string', description: 'The page id from search_knowledge.' },
            },
            required: ['source', 'id'],
            additionalProperties: false,
          },
          async run(args: unknown) {
            const input = (args ?? {}) as { source?: unknown; id?: unknown };
            const document = await fetchPage(String(input.source ?? ''), String(input.id ?? ''));
            return { kind: 'knowledge_document', contract: KNOWLEDGE_CONTRACT, document };
          },
        },
      ];
    },
  };
}

/** What the governed answer said about itself: its reading ("I read this as: …"), as the interpreter wrote it. */
export interface GovernedAnswerOwn {
  reading?: string;
}

const READING_LEAD = 'I read this as: ';

/**
 * Where the governed answer's own reading sits in its text: the line
 * `I read this as: <reading>.` that the answer opens with. With the reading
 * known, exactly that line (a reading may hold full stops); without it, the
 * first sentence after the lead. Its numbers (a week's dates, a top-N) are
 * the answer's own, never a document's.
 */
function readingSpan(answerText: string, own: GovernedAnswerOwn): { start: number; end: number } | undefined {
  const reading = own.reading?.trim().replace(/[.\s]+$/, '');
  if (reading) {
    // A reading written as a question ends with its own question mark (no "?.").
    const line = `${READING_LEAD}${reading}`;
    const start = answerText.indexOf(line);
    if (start >= 0) return { start, end: start + line.length + (/[?!]$/.test(reading) ? 0 : answerText.charAt(start + line.length) === '.' ? 1 : 0) };
  }
  // The answer says its figures first and its reading after them (V13).
  const lead = answerText.indexOf(READING_LEAD);
  if (lead < 0) return undefined;
  const end = /[.!?](?=\s|$)/.exec(answerText.slice(lead + READING_LEAD.length));
  return { start: lead, end: end ? lead + READING_LEAD.length + end.index + 1 : answerText.length };
}

/** The answer's text without its own reading (the part a document could ever have reached). */
function beyondReading(answerText: string, own: GovernedAnswerOwn): string {
  const span = readingSpan(answerText, own);
  return span ? `${answerText.slice(0, span.start)} ${answerText.slice(span.end)}` : answerText;
}

/**
 * NUMBERS COME ONLY FROM GOVERNED QUERIES. Returns the numbers an answer
 * states that appear in a document it read but in none of the governed
 * values (result cells, row counts, SQL literals the caller passes). Years
 * and one-digit counts are ignored — "2026" or "3 regions" are not figures a
 * document can smuggle in. The governed answer's own reading is never read
 * for them: its dates and counts are its own, whatever a document happens to
 * say. An empty list means the answer keeps its text.
 */
export function knowledgeOnlyFigures(answerText: string, documentTexts: readonly string[], governedValues: Iterable<unknown>, own: GovernedAnswerOwn = {}): string[] {
  if (!answerText || !documentTexts.length) return [];
  const governed = new Set<string>();
  for (const value of governedValues) {
    for (const token of numberTokens(typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '')) governed.add(token);
  }
  const inDocuments = new Set<string>();
  for (const text of documentTexts) for (const token of numberTokens(text)) inDocuments.add(token);
  const out: string[] = [];
  for (const token of numberTokens(beyondReading(answerText, own))) {
    if (!inDocuments.has(token) || governed.has(token)) continue;
    if (isIncidental(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Remove sentences that state a document-only figure, and say why. The rest
 * of the answer — its own reading, the governed figures and the citation —
 * stays; the note is added only when a sentence was removed.
 */
export function withoutKnowledgeOnlyFigures(answerText: string, figures: readonly string[], own: GovernedAnswerOwn = {}): string {
  if (!figures.length) return answerText;
  const span = readingSpan(answerText, own);
  const reading = span ? answerText.slice(span.start, span.end) : '';
  const rest = span ? `${answerText.slice(0, span.start)} ${answerText.slice(span.end)}`.trim() : answerText;
  const sentences = rest ? rest.split(/(?<=[.!?])\s+/) : [];
  const kept = sentences.filter((sentence) => !numberTokens(sentence).some((token) => figures.includes(token)));
  if (kept.length === sentences.length) return answerText;
  const note = 'A figure taken from a document was left out: answer figures come only from governed queries.';
  return [...(reading ? [reading] : []), ...kept, note].join(' ').trim();
}

function numberTokens(text: string): string[] {
  const matches = foldFigures(String(text)).match(/-?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g) ?? [];
  return matches.map((raw) => {
    const percent = raw.endsWith('%');
    const plain = raw.replace(/[,%]/g, '');
    const value = Number(plain);
    if (!Number.isFinite(value)) return '';
    return `${Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))}${percent ? '%' : ''}`;
  }).filter(Boolean);
}

function isIncidental(token: string): boolean {
  if (token.endsWith('%')) return false;
  const value = Number(token);
  if (Number.isInteger(value) && Math.abs(value) < 10) return true;
  return Number.isInteger(value) && value >= 1900 && value <= 2100;
}

function key(sourceId: string, id: string): string {
  return `${sourceId}\u0000${id}`;
}

function cleanTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (title || 'Untitled page').slice(0, 200);
}

/** Only http(s) links are kept for citations. */
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
