import { createHash } from 'node:crypto';
import type { BlockContractV1 } from './block-contract.js';
import { physicalRelationBinding, physicalRelationText, type PhysicalRelationBindingV1, type PhysicalColumnCompleteness } from './physical-binding.js';

/**
 * OPEN-WORLD ADMISSION.
 *
 * The old runtime let the model reference only the ids that survived a
 * 24-card cut, so a dimension the cut missed was reported as "not admitted"
 * and read by the user as "not modeled". The vocabulary index holds EVERY
 * object the snapshot authorizes (metrics, measures, dimensions, entities,
 * certified blocks, relations, columns) with exact ids, aliases, roles and
 * join reach, and answers three questions: does this ref exist, what did the
 * user probably mean by this word (spelling-tolerant), and which cards should
 * the model see first when the whole catalogue does not fit in a prompt.
 *
 * Discovery is broad, authority is strict: a fuzzy hit PROPOSES a candidate;
 * only an exact ref that `resolve` returns can enter an intent.
 */

export type VocabularyKind = 'metric' | 'measure' | 'dimension' | 'entity' | 'block' | 'relation' | 'column' | 'model' | 'term' | 'relationship' | 'skill' | 'hint' | 'concept';
export type VocabularyRole = 'measure' | 'key' | 'label' | 'categorical' | 'time' | 'boolean' | 'numeric' | 'text' | 'certified';

export interface VocabularyEntry {
  /** Project-relative path of a block's DQL source, for hosts that compile and bind it. */
  sourcePath?: string;
  /** A block's `owner`, as its declaration records it. Absent when none is set. */
  owner?: string;
  ref: string;
  kind: VocabularyKind;
  name: string;
  label?: string;
  aliases: string[];
  description?: string;
  /** Semantic model for semantic objects; `schema.table` for columns. */
  model?: string;
  roles: VocabularyRole[];
  dataType?: string;
  aggregation?: string;
  expr?: string;
  timeGrains?: string[];
  /** Models a dimension/entity can be reached from (join reachability), for semantic objects. */
  joinReach?: string[];
  certified?: boolean;
  status?: string;
  /** Certified blocks carry their structural promise. */
  contract?: BlockContractV1;
  /** Relations list their columns; blocks list their outputs. */
  columns?: string[];
  /** Host-only: for a relation, the upstream identifiers each of its columns is computed from (dbt model SQL), so a question word is satisfied through lineage. */
  columnLineage?: Record<string, string[]>;
  /**
   * Documented columns that decide which rows a definition counts (a
   * participation flag, a soft delete). A reader who cannot see them counts
   * rows the project excludes.
   */
  columnNotes?: string[];
  examples?: string[];
  /**
   * For a block: the retired (deprecated) blocks whose `replacedBy` leads to
   * this one. Their names are aliases of this entry, so a question that names
   * a retired block reaches its replacement, and the run says so.
   */
  supersedes?: Array<{ name: string; deprecatedOn?: string }>;
  /** The id the host's existing compilers know this object by (semantic runtime name, catalog key). */
  sourceId?: string;
  /**
   * Built from a dbt model's columns because the project authored no semantic
   * layer (the dbt model inventory), not authored by anyone as semantics. Such
   * an entry is a column under another name: never governed.
   */
  inventory?: boolean;
  /** For a metric or measure: the time dimension ref it aggregates over (its time role). */
  timeRef?: string;
  /** For a metric: simple, ratio, derived, cumulative, conversion. */
  metricType?: string;
  /**
   * A derived metric over inputs on more than one relation: its formula and
   * the governed inputs, for the relational composer to aggregate each input
   * on its own relation and evaluate the formula afterwards.
   */
  derived?: { expr: string; inputs: Array<{ alias: string; ref: string }> };
  /** Why only the semantic engine may compute this metric (a prior-period offset, a cumulative window). */
  engineOnly?: string;
  /** For an entity: primary, foreign, unique, natural. */
  entityType?: string;
  /** How a value of this measure is displayed (currency, percent, count...). */
  displayFormat?: { kind: 'currency' | 'percent' | 'number' | 'count' | 'duration'; currency?: string; decimals?: number };
  /**
   * Physical binding for the relational tier: the relation a semantic object
   * reads, its column (dimensions, entities, plain measures) or aggregate
   * expression (metrics). Host-attached, never rendered to the model.
   */
  physical?: { relation: string; column?: string; expr?: string; aggregate?: string; binding?: PhysicalRelationBindingV1 };
  /** Certified block source, host-only. */
  sql?: string;
  /** The domain that owns this object, when the project declares domains. */
  domain?: string;
  /** What this thing IS to the business (a modeled entity's context), and the grain its rows carry. */
  businessContext?: string;
  grain?: string;
  /** A person marked the modeled entity this relation binds deprecated: it is shown so a question that names it is understood, never used for an answer. */
  deprecated?: boolean;
  /** A term's business rules and caveats, kept apart from its description. */
  rules?: string[];
  /**
   * A relationship's authority to join: `certified` joins silently,
   * `draft` and `unproven` are declared but never joined on declaration alone.
   */
  joinAuthority?: 'certified' | 'draft' | 'unproven';
  /** For a relationship: its endpoints and the key pairs it joins on. */
  relationship?: { from: string; to: string; keys: Array<{ from: string; to: string }>; cardinality?: string; fanout?: string; verb?: string; crossDomain?: boolean };
  /** For a skill: its typed analytical policy, host-enforced, never rendered raw. */
  policy?: Record<string, unknown>;
  /** For a skill: the refs it prefers, and the required filters and clarify-when rules it states. */
  skill?: { preferredRefs: string[]; requiredFilters: string[]; clarifyWhen: string[]; vocabulary: Record<string, string>; kind?: string; guidance?: string };
  /** Skills that prefer this object, by skill ref. */
  preferredBy?: string[];
  /** For a concept: the entities it is bound to, with their grain and domain. */
  bindings?: Array<{ entityRef: string; domain?: string; role?: string; grain?: string }>;
}

/** A domain's authored context, rendered as the first block the model reads. */
export interface VocabularyDomainHeader {
  id: string;
  name: string;
  description?: string;
  purpose?: string;
  intentExamples: string[];
  caveats: string[];
  requiredFilters: string[];
}

/** What `renderCards` showed, for the receipt: counts and characters per kind, and every truncation. */
export interface RenderedCards {
  text: string;
  /** The refs that were rendered, so a later selection can be told from an unrendered one. */
  refs: string[];
  rendered: Record<string, number>;
  chars: Record<string, number>;
  truncated: Array<{ kind: string; shown: number; total: number }>;
  totalChars: number;
}

export interface VocabularyLookupHit {
  entry: VocabularyEntry;
  score: number;
  matchedOn: 'ref' | 'name' | 'alias' | 'token' | 'fuzzy';
}

export const normalizeVocabularyText = (value: string): string =>
  value.toLowerCase().replace(/[_./:-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokensOf = (value: string): string[] => normalizeVocabularyText(value).split(' ').filter((token) => token.length > 1);
const singular = (word: string): string => word.replace(/ies$/, 'y').replace(/(ses|xes|shes|ches)$/, (m) => m.slice(0, -2)).replace(/s$/, '');

function trigrams(value: string): Set<string> {
  const padded = `  ${normalizeVocabularyText(value).replace(/ /g, '')} `;
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) grams.add(padded.slice(index, index + 3));
  return grams;
}

/** Dice coefficient over character trigrams: 'bevereage' vs 'beverage' scores about 0.7. */
export function trigramSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

const KIND_PRIORITY: Record<VocabularyKind, number> = { block: 0, metric: 1, measure: 2, dimension: 3, entity: 4, concept: 5, model: 6, relation: 7, column: 8, term: 9, relationship: 10, skill: 11, hint: 12 };

/**
 * Per-section character ceilings inside the prompt budget. Ranking decides
 * what renders INSIDE a section; it never removes an object from the index, so
 * a truncated section still reports how many entries it holds.
 */
export const DEFAULT_SECTION_CAPS: Record<VocabularyKind, number> = {
  block: 3_000, metric: 6_000, measure: 2_000, dimension: 5_000, entity: 1_500, concept: 1_200, model: 1_000,
  relation: 3_000, column: 2_000, term: 1_500, relationship: 2_000, skill: 2_400, hint: 800,
};

const SECTION_TITLES: Array<[VocabularyKind, string]> = [
  ['block', 'CERTIFIED BLOCKS (a block answers exactly the question it declares; name it as a measure ref)'],
  ['metric', 'METRICS (governed semantic layer; use as measure refs)'],
  ['measure', 'MEASURES (semantic measures; use as measure refs)'],
  ['dimension', 'DIMENSIONS (group-by, display and filter refs; the role says key, label, categorical, time, boolean)'],
  ['entity', 'ENTITY KEYS (the identity of a thing; group rankings by these and display the label beside them)'],
  ['concept', 'BUSINESS CONCEPTS (one thing known under several keys; a concept ref is a question to the reader, never a grouping — name the binding you mean)'],
  ['model', 'SEMANTIC MODELS'],
  ['relation', 'PHYSICAL RELATIONS (for governed SQL when no metric fits; columns listed)'],
  ['column', 'COLUMNS'],
  ['term', 'BUSINESS TERMS (governed definitions; a rule here is the meaning of the word)'],
  ['relationship', 'RELATIONSHIPS (declared joins between things; "joins automatically" means the host joins on it, "declared, not proven" means the host may prove or refuse it — never invent a join, never ask which join to take)'],
  ['skill', 'SKILLS (this project\'s written reporting conventions, selected for this question; advisory — never override a certified block, a metric the question names, or the user\'s grain; typed policies are enforced by the host)'],
  ['hint', 'APPROVED CORRECTIONS (reviewed lessons from earlier answers; apply the rule, never reproduce old SQL)'],
];

export class VocabularyIndex {
  readonly entries: VocabularyEntry[];
  readonly fingerprint: string;
  private readonly byRef = new Map<string, VocabularyEntry>();
  private readonly byAlias = new Map<string, VocabularyEntry[]>();
  private readonly tokenIndex = new Map<string, Set<VocabularyEntry>>();

  constructor(entries: VocabularyEntry[]) {
    this.entries = [...entries].sort((a, b) => a.ref.localeCompare(b.ref));
    // The fingerprint identifies what the model can READ, not only what exists:
    // a description, an alias, a rule, a policy or a join authority that changes
    // is a different vocabulary, and the receipt must say so.
    this.fingerprint = `sha256:${createHash('sha256').update(this.entries.map((entry) => [
      entry.ref, entry.kind, entry.roles.join(','), entry.description ?? '', entry.aliases.join(','), (entry.rules ?? []).join('|'),
      entry.joinAuthority ?? '', entry.policy ? JSON.stringify(entry.policy) : '', (entry.preferredBy ?? []).join(','), entry.grain ?? '', entry.businessContext ?? '', ...(entry.deprecated ? ['deprecated'] : []),
    ].join('\u0001')).join('\n')).digest('hex').slice(0, 24)}`;
    for (const entry of this.entries) {
      this.byRef.set(entry.ref.toLowerCase(), entry);
      const tail = entry.ref.slice(entry.ref.indexOf(':') + 1);
      const names = new Set(
        [entry.name, entry.label ?? '', ...entry.aliases, tail, tail.split('.').pop() ?? '']
          .map(normalizeVocabularyText)
          .filter(Boolean),
      );
      for (const name of names) {
        const list = this.byAlias.get(name) ?? [];
        list.push(entry);
        this.byAlias.set(name, list);
      }
      for (const token of new Set([...names].flatMap((name) => name.split(' ')).map(singular))) {
        const bucket = this.tokenIndex.get(token) ?? new Set();
        bucket.add(entry);
        this.tokenIndex.set(token, bucket);
      }
    }
  }

  get(ref: string): VocabularyEntry | undefined {
    return this.byRef.get(ref.trim().toLowerCase());
  }

  /** This index plus entries fetched on demand (a relation's columns the probe had not described); an entry with the same ref is replaced. */
  withEntries(extra: VocabularyEntry[]): VocabularyIndex {
    const override = new Map(extra.map((entry) => [entry.ref.toLowerCase(), entry]));
    return new VocabularyIndex([...this.entries.filter((entry) => !override.has(entry.ref.toLowerCase())), ...extra]);
  }

  /**
   * Turn what the model wrote into an authorized entry: an exact ref, a ref
   * missing its kind prefix (`order_item.drink_revenue`), the host's own id,
   * or a name that belongs to exactly one entry. Anything ambiguous is NOT
   * resolved.
   */
  resolve(reference: string, kinds?: VocabularyKind[]): VocabularyEntry | undefined {
    const exact = this.get(reference);
    if (exact && (!kinds || kinds.includes(exact.kind))) return exact;
    const trimmed = reference.trim().toLowerCase();
    if (!trimmed) return undefined;
    const candidates = new Set<VocabularyEntry>();
    for (const entry of this.entries) {
      if (kinds && !kinds.includes(entry.kind)) continue;
      const tail = entry.ref.slice(entry.ref.indexOf(':') + 1).toLowerCase();
      if (tail === trimmed || entry.sourceId?.toLowerCase() === trimmed) candidates.add(entry);
    }
    if (candidates.size === 1) return [...candidates][0];
    if (candidates.size > 1) return undefined;
    const named = (this.byAlias.get(normalizeVocabularyText(trimmed)) ?? []).filter((entry) => !kinds || kinds.includes(entry.kind));
    return named.length === 1 ? named[0] : undefined;
  }

  /** Spelling-tolerant discovery. Returns proposals, never authority. */
  lookup(term: string, options: { kinds?: VocabularyKind[]; limit?: number; minScore?: number } = {}): VocabularyLookupHit[] {
    const limit = options.limit ?? 8;
    const minScore = options.minScore ?? 0.42;
    const query = normalizeVocabularyText(term);
    if (!query) return [];
    const queryTokens = query.split(' ').map(singular).filter(Boolean);
    const scored = new Map<VocabularyEntry, VocabularyLookupHit>();
    const consider = (entry: VocabularyEntry, score: number, matchedOn: VocabularyLookupHit['matchedOn']) => {
      if (options.kinds && !options.kinds.includes(entry.kind)) return;
      const existing = scored.get(entry);
      if (!existing || existing.score < score) scored.set(entry, { entry, score, matchedOn });
    };
    const direct = this.get(term);
    if (direct) consider(direct, 1, 'ref');
    for (const entry of this.byAlias.get(query) ?? []) consider(entry, 0.98, normalizeVocabularyText(entry.name) === query ? 'name' : 'alias');
    for (const token of queryTokens) {
      for (const entry of this.tokenIndex.get(token) ?? []) {
        const entryTokens = new Set(tokensOf(`${entry.name} ${entry.label ?? ''} ${entry.aliases.join(' ')}`).map(singular));
        const overlap = queryTokens.filter((candidate) => entryTokens.has(candidate)).length;
        consider(entry, 0.5 + 0.45 * (overlap / Math.max(queryTokens.length, entryTokens.size)), 'token');
      }
    }
    for (const entry of this.entries) {
      if (options.kinds && !options.kinds.includes(entry.kind)) continue;
      const names = [entry.name, entry.label ?? '', ...entry.aliases].filter(Boolean);
      let best = 0;
      for (const name of names) {
        best = Math.max(best, trigramSimilarity(query, name));
        for (const token of queryTokens) if (token.length >= 4) best = Math.max(best, trigramSimilarity(token, name) * 0.95);
      }
      if (best >= minScore) consider(entry, Math.min(0.9, best), 'fuzzy');
    }
    return [...scored.values()]
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score || KIND_PRIORITY[a.entry.kind] - KIND_PRIORITY[b.entry.kind] || a.entry.ref.localeCompare(b.entry.ref))
      .slice(0, limit);
  }

  /** Nearest authorized refs for a ref that does not exist. */
  suggest(reference: string, limit = 5): VocabularyEntry[] {
    const tail = reference.includes(':') ? reference.slice(reference.indexOf(':') + 1) : reference;
    const leaf = tail.split('.').pop() ?? tail;
    const hits = this.lookup(leaf, { limit, minScore: 0.35 });
    return hits.map((hit) => hit.entry);
  }

  /**
   * Render the cards the model reads. Deterministic order so cassettes stay
   * stable: refs the retrieval ranked come first (`rankedRefs`), then the
   * entries most related to `seeds` (the question), then kind and ref. Every
   * section has a character ceiling inside `maxChars`; ranking decides what
   * renders INSIDE a section and never removes an entry from the index, so a
   * truncated section reports its full count and the reader is told that a
   * missing object is "not shown", never "not modeled".
   */
  renderCards(options: RenderCardsOptions = {}): string {
    return this.renderCardsDetailed(options).text;
  }

  renderCardsDetailed(options: RenderCardsOptions = {}): RenderedCards {
    const maxChars = options.maxChars ?? 24_000;
    const caps = { ...DEFAULT_SECTION_CAPS, ...(options.sectionCaps ?? {}) };
    const seedScore = new Map<VocabularyEntry, number>();
    for (const seed of options.seeds ?? []) {
      for (const hit of this.lookup(seed, { limit: 40, minScore: 0.35 })) {
        seedScore.set(hit.entry, Math.max(seedScore.get(hit.entry) ?? 0, hit.score));
      }
    }
    const rankedAt = new Map<string, number>();
    (options.rankedRefs ?? []).forEach((ref, index) => { if (!rankedAt.has(ref.toLowerCase())) rankedAt.set(ref.toLowerCase(), index); });
    const rank = (entry: VocabularyEntry): number => rankedAt.get(entry.ref.toLowerCase()) ?? Number.POSITIVE_INFINITY;
    // A pinned entry (a name the question matched exactly, a selected skill)
    // renders before anything ranking chose, so what the question names is
    // never cut by what the question resembles.
    const pinned = new Set((options.pinnedRefs ?? []).map((ref) => ref.toLowerCase()));
    const includeSkills = options.include?.skill ? new Set(options.include.skill.map((ref) => ref.toLowerCase())) : undefined;
    const eligible = this.entries.filter((entry) => !(entry.kind === 'skill' && includeSkills && !includeSkills.has(entry.ref.toLowerCase())));
    const ordered = [...eligible].sort((a, b) =>
      Number(pinned.has(b.ref.toLowerCase())) - Number(pinned.has(a.ref.toLowerCase()))
      || rank(a) - rank(b)
      || (seedScore.get(b) ?? 0) - (seedScore.get(a) ?? 0)
      || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]
      || a.ref.localeCompare(b.ref));
    const header = options.header ? renderDomainHeader(options.header) : '';
    const included = new Set<VocabularyEntry>();
    const charsByKind: Record<string, number> = {};
    let chars = header ? header.length + 2 : 0;
    // A ranked column may be spelled by its model name alone (`column:<model>.<col>`): match on the last two segments too.
    const tail = (ref: string) => ref.toLowerCase().replace(/^[a-z]+:/, '').split('.').slice(-2).join('.');
    const preferredTails = new Set([...rankedAt.keys(), ...pinned].filter((ref) => ref.startsWith('column:')).map(tail));
    const preferColumn = (ref: string) => pinned.has(ref.toLowerCase()) || rankedAt.has(ref.toLowerCase()) || preferredTails.has(tail(ref));
    const cardOf = new Map<VocabularyEntry, string>();
    for (const entry of ordered) {
      const line = renderCard(entry, { preferColumn });
      cardOf.set(entry, line);
      const used = charsByKind[entry.kind] ?? 0;
      if (used + line.length + 1 > caps[entry.kind]) continue;
      if (chars + line.length + 1 > maxChars) continue;
      included.add(entry);
      charsByKind[entry.kind] = used + line.length + 1;
      chars += line.length + 1;
    }
    const out: string[] = header ? [header, ''] : [];
    const rendered: Record<string, number> = {};
    const truncated: RenderedCards['truncated'] = [];
    for (const [kind, title] of SECTION_TITLES) {
      const rows = this.entries.filter((entry) => entry.kind === kind && included.has(entry));
      const total = eligible.filter((entry) => entry.kind === kind).length;
      if (total === 0) continue;
      rendered[kind] = rows.length;
      if (rows.length < total) truncated.push({ kind, shown: rows.length, total });
      const columnsNote = kind === 'column' && options.columnsFor
        ? ` (listed for ${options.columnsFor.shown} of ${options.columnsFor.total} relations; name any other column as column:<schema.table>.<name>, exact spelling)`
        : '';
      out.push(`${title}${rows.length < total ? ` (${rows.length} of ${total} shown; an entry not shown here still exists — name it exactly, or say what you were looking for and it will be looked up)` : ''}${columnsNote}`);
      for (const entry of rows) out.push(cardOf.get(entry) ?? renderCard(entry, { preferColumn }));
      out.push('');
    }
    const text = out.join('\n').trim();
    return { text, refs: [...included].map((entry) => entry.ref), rendered, chars: charsByKind, truncated, totalChars: text.length };
  }
}

export interface RenderCardsOptions {
  maxChars?: number;
  seeds?: string[];
  /** Refs in retrieval rank order; they render first. */
  rankedRefs?: string[];
  /** Refs the question named outright; they render before ranking. */
  pinnedRefs?: string[];
  /** Skills to render (the selected ones); others stay in the index but off the page. */
  include?: { skill?: string[] };
  sectionCaps?: Partial<Record<VocabularyKind, number>>;
  header?: VocabularyDomainHeader;
  /** How many relations had their columns hydrated, of how many eligible. */
  columnsFor?: { shown: number; total: number };
}

function renderDomainHeader(header: VocabularyDomainHeader): string {
  const clip = (value: string, max: number) => value.replace(/\s+/g, ' ').slice(0, max);
  const parts = [
    `DOMAIN ${header.id}${header.name && header.name !== header.id ? ` (${header.name})` : ''} — the business context this question is read in; required filters and caveats here are enforced by the host, never by you.${header.description ? ` ${clip(header.description, 200)}` : ''}`,
    header.purpose ? `Purpose: ${clip(header.purpose, 120)}` : '',
    header.intentExamples.length ? `Typical questions: ${header.intentExamples.slice(0, 3).map((example) => `"${clip(example, 90)}"`).join('; ')}` : '',
    header.caveats.length ? `Caveats: ${header.caveats.slice(0, 3).map((caveat) => clip(caveat, 120)).join('; ')}` : '',
    header.requiredFilters.length ? `Required filters: ${header.requiredFilters.slice(0, 4).map((filter) => clip(filter, 80)).join('; ')}` : '',
  ].filter(Boolean);
  return parts.join('\n').slice(0, 900);
}

export function renderCard(entry: VocabularyEntry, options: { preferColumn?: (columnRef: string) => boolean } = {}): string {
  if (entry.kind === 'relationship') return renderRelationshipCard(entry);
  if (entry.kind === 'skill') return renderSkillCard(entry);
  if (entry.kind === 'hint') return renderHintCard(entry);
  if (entry.kind === 'concept') return renderConceptCard(entry);
  const bits: string[] = [];
  if (entry.roles.length) bits.push(entry.roles.join('/'));
  if (entry.model && entry.kind !== 'relation') bits.push(`model ${entry.model}`);
  if (entry.aggregation) bits.push(entry.aggregation);
  if (entry.dataType) bits.push(entry.dataType);
  if (entry.timeGrains?.length) bits.push(`grains ${entry.timeGrains.join(',')}`);
  // The time role: which dimension a measure aggregates over. Two measures
  // under one window must agree on it.
  if (entry.timeRef) bits.push(`time ${entry.timeRef.split('.').pop()}`);
  if (entry.certified) bits.push('certified');
  if (entry.deprecated) bits.push('deprecated: do not use for answers');
  // A derived or ratio metric shows its formula: what it divides decides
  // whether it is a period ratio or a lifetime one.
  const formula = (entry.metricType === 'derived' || entry.metricType === 'ratio') && entry.expr ? ` = ${entry.expr.replace(/\s+/g, ' ').slice(0, 120)}` : '';
  const description = entry.description ? ` ${entry.description.replace(/\s+/g, ' ').slice(0, entry.kind === 'term' || entry.kind === 'block' ? 400 : entry.kind === 'relation' ? 300 : 160)}` : '';
  // The columns the question ranked or named come first on a relation card,
  // so a wide table shows what was asked about, not its first forty names.
  const orderedColumns = entry.columns?.length && options.preferColumn
    ? [...entry.columns].sort((a, b) => Number(options.preferColumn!(`column:${entry.model ?? ''}.${b}`)) - Number(options.preferColumn!(`column:${entry.model ?? ''}.${a}`)))
    : entry.columns ?? [];
  const columns = orderedColumns.length ? ` columns: ${orderedColumns.slice(0, 40).join(', ')}${orderedColumns.length > 40 ? ', ...' : ''}` : '';
  const notes = entry.columnNotes?.length ? ` which rows count: ${entry.columnNotes.join('; ')}` : '';
  const scope = entry.contract?.staticScope.length
    ? ` scope: ${entry.contract.staticScope.map((p) => `${p.column} ${p.op}${p.values.length ? ` ${p.values.join('/')}` : ''}`).join(' and ')}`
    : '';
  const groupBy = entry.contract?.groupBy.length ? ` grouped by: ${entry.contract.groupBy.join(', ')}` : '';
  const limit = entry.contract?.limit ? ` limit ${entry.contract.limit}` : '';
  const examples = entry.examples?.length ? ` e.g. "${entry.examples[0]}"` : '';
  const retiredNames = new Set((entry.supersedes ?? []).map((retired) => normalizeVocabularyText(retired.name)));
  const aliases = entry.aliases.filter((alias) => normalizeVocabularyText(alias) !== normalizeVocabularyText(entry.name) && !retiredNames.has(normalizeVocabularyText(alias))).slice(0, 4);
  const aka = aliases.length ? ` aka ${aliases.join(', ')}` : '';
  // A question that still names a retired block reads this block instead.
  const replaces = entry.supersedes?.length ? ` replaces retired ${entry.supersedes.slice(0, 4).map((retired) => `"${retired.name}"`).join(', ')}` : '';
  // What a modeled thing IS, and the grain its rows carry: authored context
  // the raw column list cannot say.
  const meaning = entry.businessContext ? ` is: ${clipText(entry.businessContext, ENTITY_CONTEXT_CHARS)}` : '';
  const grain = entry.grain ? ` one row per ${grainText(entry.grain)}` : '';
  const rules = entry.rules?.length ? ` rules: ${entry.rules.join(' ').replace(/\s+/g, ' ').slice(0, 220)}` : '';
  const preferred = entry.preferredBy?.length ? ` preferred by ${entry.preferredBy.slice(0, 2).join(', ')}` : '';
  return `- ${entry.ref} [${bits.join('; ')}]${formula}${description}${meaning}${grain}${rules}${aka}${replaces}${preferred}${columns}${notes}${groupBy}${scope}${limit}${examples}`;
}

function renderRelationshipCard(entry: VocabularyEntry): string {
  const rel = entry.relationship;
  const authority = entry.joinAuthority === 'certified' ? 'certified; joins automatically' : entry.joinAuthority === 'draft' ? 'draft; declared, not proven' : 'declared, not proven';
  const bits = [rel ? `${rel.from} -> ${rel.to}` : '', rel?.verb ?? '', rel?.cardinality ?? '', rel?.fanout ? `${rel.fanout} fanout` : '', rel?.crossDomain ? 'cross-domain' : '', authority].filter(Boolean);
  const keys = rel?.keys.length ? ` on ${rel.keys.map((key) => `${key.from} = ${key.to}`).join(' and ')}` : '';
  const description = entry.description ? ` ${entry.description.replace(/\s+/g, ' ').slice(0, 160)}` : '';
  return `- ${entry.ref} [${bits.join('; ')}]${keys}${description}`;
}

function renderSkillCard(entry: VocabularyEntry): string {
  const skill = entry.skill;
  const bits = [skill?.kind ?? 'skill', entry.domain ?? ''].filter(Boolean);
  const description = entry.description ? ` ${entry.description.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  const prefers = skill?.preferredRefs.length ? ` prefers: ${skill.preferredRefs.slice(0, 6).join(', ')}` : '';
  const required = skill?.requiredFilters.length ? ` required filters (host-enforced): ${skill.requiredFilters.slice(0, 3).join('; ')}` : '';
  const clarify = skill?.clarifyWhen.length ? ` clarify when: ${skill.clarifyWhen.slice(0, 2).join('; ')}` : '';
  const words = skill ? Object.entries(skill.vocabulary).slice(0, 6).map(([word, ref]) => `"${word}" → ${ref}`).join(', ') : '';
  const vocabulary = words ? ` words: ${words}` : '';
  const policy = entry.policy ? ` policy: ${describePolicy(entry.policy)}` : '';
  const guidance = skill?.guidance ? ` notes: ${skill.guidance.replace(/\s+/g, ' ').slice(0, 300)}` : '';
  return `- ${entry.ref} [${bits.join('; ')}]${description}${prefers}${required}${clarify}${vocabulary}${policy}${guidance}`;
}

function describePolicy(policy: Record<string, unknown>): string {
  const parts: string[] = [];
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const timeRole = text(policy.timeRole) ?? text(policy.time_role);
  const calendar = text(policy.calendarId) ?? text(policy.calendar_id);
  const timezone = text(policy.timezone);
  const completeness = text(policy.completenessPolicy) ?? text(policy.completeness_policy);
  const alignment = text(policy.comparisonAlignment) ?? text(policy.comparison_alignment);
  const ranking = text(policy.defaultRankingPeriod) ?? text(policy.default_ranking_period);
  if (timeRole) parts.push(`time role ${timeRole}`);
  if (calendar) parts.push(`calendar ${calendar}`);
  if (timezone) parts.push(`timezone ${timezone}`);
  if (completeness) parts.push(`periods ${completeness.replace(/_/g, ' ')}`);
  if (alignment) parts.push(`comparisons ${alignment.replace(/_/g, ' ')}`);
  if (ranking) parts.push(`rank by the ${ranking} period`);
  return parts.join(', ') || 'declared';
}

function renderHintCard(entry: VocabularyEntry): string {
  const bits = ['approved', entry.domain ? `scope ${entry.domain}` : ''].filter(Boolean);
  const description = entry.description ? ` ${entry.description.replace(/\s+/g, ' ').slice(0, 240)}` : '';
  return `- ${entry.ref} [${bits.join('; ')}]${description}`;
}

function renderConceptCard(entry: VocabularyEntry): string {
  const bits = ['concept', entry.status ?? '', entry.domain ?? ''].filter(Boolean);
  const description = entry.description ? ` ${clipText(entry.description, CONCEPT_DESCRIPTION_CHARS)}` : '';
  const bindings = entry.bindings?.length ? ` bound to: ${entry.bindings.slice(0, 6).map((binding) => `${binding.entityRef}${binding.domain ? ` (${binding.domain}${binding.role ? `, ${binding.role}` : ''})` : ''}${binding.grain ? ` one row per ${grainText(binding.grain)}` : ''}`).join('; ')}` : '';
  const aliases = entry.aliases.filter((alias) => normalizeVocabularyText(alias) !== normalizeVocabularyText(entry.name)).slice(0, 4);
  const aka = aliases.length ? ` aka ${aliases.join(', ')}` : '';
  return `- ${entry.ref} [${bits.join('; ')}]${description}${bindings}${aka}`;
}

// Building from host-neutral sources.

export interface VocabularySource {
  metrics?: Array<{ name: string; model?: string; label?: string; description?: string; aggregation?: string; type?: string; expr?: string; sourceId?: string; aliases?: string[]; status?: string; timeGrains?: string[]; physical?: VocabularyEntry['physical']; aggTimeDimension?: string; displayFormat?: VocabularyEntry['displayFormat']; derived?: VocabularyEntry['derived']; engineOnly?: string }>;
  measures?: Array<{ name: string; model: string; label?: string; description?: string; aggregation?: string; expr?: string; sourceId?: string; physical?: VocabularyEntry['physical']; aggTimeDimension?: string; displayFormat?: VocabularyEntry['displayFormat'] }>;
  dimensions?: Array<{ name: string; model: string; label?: string; description?: string; dataType?: string; isTime?: boolean; timeGrains?: string[]; sourceId?: string; aliases?: string[]; reachableFrom?: string[]; physical?: VocabularyEntry['physical']; inventory?: boolean }>;
  entities?: Array<{ name: string; model: string; type: string; label?: string; description?: string; sourceId?: string; reachableFrom?: string[]; physical?: VocabularyEntry['physical']; inventory?: boolean }>;
  models?: Array<{ name: string; label?: string; description?: string; relation?: string }>;
  blocks?: Array<{ name: string; domain?: string; description?: string; certified: boolean; status?: string; contract: BlockContractV1; examples?: string[]; tags?: string[]; sourceId?: string; sql?: string; sourcePath?: string; owner?: string; supersedes?: Array<{ name: string; deprecatedOn?: string }> }>;
  relations?: Array<{ database?: string; schema?: string; name: string; description?: string; columns: Array<{ name: string; dataType?: string; description?: string }>; /** Bounded dbt-manifest metadata used to choose a relation before its physical columns are hydrated. It never becomes individual vocabulary entries on its own. */ embeddedColumns?: Array<{ name: string; dataType?: string; description?: string }>; sourceId?: string; /** The domain whose entity binds this relation, when one does (physical ownership). */ domain?: string; /** Every domain with an entity bound to this relation — ownership is a set, never the first entity seen. */ domains?: string[]; /** What each column is computed from, by column name (lowercased), from the model's SQL. */ columnLineage?: Record<string, string[]>; /** Exact runtime/dbt identity shared by discovery, drafting, validation and execution. */ binding?: PhysicalRelationBindingV1; /** Manifest descriptions are partial unless a catalog/runtime observation proves otherwise. */ columnCompleteness?: PhysicalColumnCompleteness; observedAt?: string; truncated?: boolean }>;
  terms?: Array<{ name: string; synonyms?: string[]; description?: string; metricRefs?: string[]; rules?: string[]; domain?: string }>;
  /** Declared relationships between modeled things, with their authority to join. */
  relationships?: Array<{ id: string; domain?: string; from: string; to: string; keys: Array<{ from: string; to: string }>; cardinality?: string; fanout?: string; verb?: string; description?: string; status?: string; crossDomain?: boolean; joinAuthority: 'certified' | 'draft' | 'unproven' }>;
  /** The skills selected for this request (already eligible), never every skill of the project. */
  skills?: Array<{ ref: string; id: string; domain?: string; kind?: string; description?: string; triggers?: string[]; vocabulary?: Record<string, string>; preferredRefs?: string[]; requiredFilters?: string[]; clarifyWhen?: string[]; policy?: Record<string, unknown>; guidance?: string }>;
  /** Approved, fresh corrections in scope; guidance only, never SQL. */
  hints?: Array<{ id: string; title?: string; guidance: string; domain?: string; tags?: string[] }>;
  /** Business concepts: one thing under several keys. */
  concepts?: Array<{ id: string; domain?: string; name: string; description?: string; synonyms?: string[]; status?: string; bindings: Array<{ entityRef: string; domain?: string; role?: string; grain?: string }> }>;
  /** The domain header rendered first, when the request resolved one. */
  domain?: VocabularyDomainHeader;
  /** Authored meaning for physical relations (a modeled entity's business context and grain), keyed by `schema.table`. */
  relationMeaning?: Record<string, { businessName?: string; businessContext?: string; grain?: string; domain?: string; deprecated?: boolean }>;
}

/**
 * A modeled entity's business context is authored to be read whole: where its
 * rows stop, which rows count, what a code means. It is cut at a sentence
 * end, never mid-sentence ("Use"), and few relations carry one.
 */
const ENTITY_CONTEXT_CHARS = 600;
const CONCEPT_DESCRIPTION_CHARS = 400;

/** Text on one line, cut at the last sentence end that fits, else at a word with an ellipsis. */
export function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (sentenceEnd >= max / 2) return head.slice(0, sentenceEnd + 1);
  const wordEnd = head.lastIndexOf(' ');
  return `${(wordEnd > 0 ? head.slice(0, wordEnd) : head).replace(/[,;:]$/, '')}…`;
}

/** A grain as authored, read after "one row per": "one row per player per season" and "player_id, season" alike. */
export function grainText(grain: string): string {
  return grain.replace(/\s+/g, ' ').trim().replace(/^(?:one|1|a single)\s+row\s+(?:per|for each|for)\s+/i, '');
}

const LABEL_WORD = /(^|_)(name|label|title|description|display)(_|$)/i;
const KEY_WORD = /(^|_)(id|key|uuid|code|number)$/i;
const TIME_TYPE = /(date|time|timestamp)/i;
const NUMERIC_TYPE = /(int|decimal|float|double|numeric|number|real)/i;

function columnRoles(name: string, dataType: string | undefined, isTime?: boolean): VocabularyRole[] {
  if (isTime || TIME_TYPE.test(dataType ?? '')) return ['time'];
  if (/bool/i.test(dataType ?? '') || /^is_|^has_/.test(name)) return ['boolean'];
  if (LABEL_WORD.test(name)) return ['label'];
  if (KEY_WORD.test(name)) return ['key'];
  if (NUMERIC_TYPE.test(dataType ?? '')) return ['numeric'];
  return ['categorical'];
}

const STEM_STOP = new Set(['total', 'sum', 'count', 'avg', 'average', 'num', 'number', 'of', 'per', 'the', 'all', 'distinct', 'played']);
const stems = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STEM_STOP.has(word)).map((word) => word.replace(/s$/, ''));

/**
 * The same fact at another grain. A metric defined on a season table has no
 * join to the game table that carries the calendar date, but the game table
 * usually holds the column the metric sums. Each measure is matched to the
 * target relation's columns by word stem (total_points -> points,
 * games_played -> game_id counted distinct) so a correction can say exactly
 * what to aggregate instead of asking the reader to guess.
 */
export function suggestSameGrainColumns(vocabulary: VocabularyIndex, measureRefs: string[], relation: string): Array<{ from: string; to: string; aggregation: string }> {
  const columns = vocabulary.entries.filter((entry) => entry.kind === 'column' && (entry.physical?.relation ?? entry.model) === relation);
  const out: Array<{ from: string; to: string; aggregation: string }> = [];
  for (const ref of measureRefs) {
    const entry = vocabulary.get(ref);
    if (!entry) continue;
    const words = stems(entry.name);
    if (words.length === 0) continue;
    const scored = columns
      .map((column) => ({ column, score: stems(column.name).filter((stem) => words.some((word) => stem === word || stem.startsWith(word) || word.startsWith(stem))).length }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.column.name.length - right.column.name.length);
    const best = scored[0]?.column;
    if (!best) continue;
    const counted = best.roles.includes('key') || /(^|_)(id|key)$/i.test(best.name);
    out.push({ from: ref, to: best.ref, aggregation: counted ? 'count_distinct' : (entry.aggregation === 'count_distinct' || entry.aggregation === 'count' ? 'count_distinct' : 'sum') });
  }
  return out;
}

/**
 * The documented boolean columns of a relation: the ones that say which rows a
 * definition counts. Named without a description they teach nothing, so only
 * documented ones are carried.
 */
function eligibilityNotes(columns: Array<{ name: string; dataType?: string; description?: string }>): string[] {
  return columns
    .filter((column) => column.description && columnRoles(column.name, column.dataType).includes('boolean'))
    .slice(0, 4)
    .map((column) => `${column.name} ${column.description!.replace(/\s+/g, ' ').slice(0, 120)}`);
}

/**
 * The same FIELD on another relation. A name filter bound to the season table
 * cannot restrict a metric read from the game table, but that table names its
 * players too: the repair needs to be told which column carries the same value,
 * or it will keep proposing a join nobody declared.
 */
export function suggestSameRelationFields(vocabulary: VocabularyIndex, refs: string[], relation: string): Array<{ from: string; to: string }> {
  const columns = vocabulary.entries.filter((entry) => (entry.kind === 'column' || entry.kind === 'dimension') && (entry.physical?.relation ?? entry.model) === relation);
  const out: Array<{ from: string; to: string }> = [];
  for (const ref of refs) {
    const entry = vocabulary.get(ref);
    if (!entry || entry.roles.includes('measure')) continue;
    const words = stems(entry.physical?.column ?? entry.name);
    if (words.length === 0) continue;
    const scored = columns
      .filter((column) => column.ref !== ref)
      .map((column) => ({ column, score: stems(column.physical?.column ?? column.name).filter((stem) => words.some((word) => stem === word || stem.startsWith(word) || word.startsWith(stem))).length }))
      .filter((item) => item.score > 0)
      // A label matches a label: a player NAME filter belongs on the name
      // column, never on the id that shares its stem.
      .sort((left, right) => right.score - left.score
        || Number(right.column.roles.includes('label') === entry.roles.includes('label')) - Number(left.column.roles.includes('label') === entry.roles.includes('label'))
        || left.column.name.length - right.column.name.length);
    const best = scored[0]?.column;
    if (best) out.push({ from: ref, to: best.ref });
  }
  return out;
}

export function buildVocabularyIndex(source: VocabularySource): VocabularyIndex {
  const entries: VocabularyEntry[] = [];
  for (const metric of source.metrics ?? []) {
    entries.push({
      ref: `metric:${metric.model ? `${metric.model}.` : ''}${metric.name}`,
      kind: 'metric',
      name: metric.name,
      ...(metric.label ? { label: metric.label } : {}),
      aliases: [...new Set([metric.label ?? '', ...(metric.aliases ?? [])].filter(Boolean))],
      ...(metric.description ? { description: metric.description } : {}),
      ...(metric.model ? { model: metric.model } : {}),
      roles: ['measure'],
      ...(metric.aggregation ? { aggregation: metric.aggregation } : {}),
      ...(metric.expr ? { expr: metric.expr } : {}),
      ...(metric.timeGrains?.length ? { timeGrains: metric.timeGrains } : {}),
      ...(metric.status ? { status: metric.status } : {}),
      ...(metric.sourceId ? { sourceId: metric.sourceId } : {}),
      ...(metric.physical ? { physical: metric.physical } : {}),
      ...(metric.aggTimeDimension && metric.model ? { timeRef: `dimension:${metric.model}.${metric.aggTimeDimension}` } : {}),
      ...(metric.type ? { metricType: metric.type } : {}),
      ...(metric.displayFormat ? { displayFormat: metric.displayFormat } : {}),
      ...(metric.derived ? { derived: metric.derived } : {}),
      ...(metric.engineOnly ? { engineOnly: metric.engineOnly } : {}),
    });
  }
  for (const measure of source.measures ?? []) {
    entries.push({
      ref: `measure:${measure.model}.${measure.name}`,
      kind: 'measure',
      name: measure.name,
      ...(measure.label ? { label: measure.label } : {}),
      aliases: [measure.label ?? ''].filter(Boolean),
      ...(measure.description ? { description: measure.description } : {}),
      model: measure.model,
      roles: ['measure'],
      ...(measure.aggregation ? { aggregation: measure.aggregation } : {}),
      ...(measure.expr ? { expr: measure.expr } : {}),
      ...(measure.sourceId ? { sourceId: measure.sourceId } : {}),
      ...(measure.physical ? { physical: measure.physical } : {}),
      ...(measure.aggTimeDimension ? { timeRef: `dimension:${measure.model}.${measure.aggTimeDimension}` } : {}),
      ...(measure.displayFormat ? { displayFormat: measure.displayFormat } : {}),
    });
  }
  for (const dimension of source.dimensions ?? []) {
    entries.push({
      ref: `dimension:${dimension.model}.${dimension.name}`,
      kind: 'dimension',
      name: dimension.name,
      ...(dimension.label ? { label: dimension.label } : {}),
      aliases: [...new Set([dimension.label ?? '', ...(dimension.aliases ?? [])].filter(Boolean))],
      ...(dimension.description ? { description: dimension.description } : {}),
      model: dimension.model,
      roles: columnRoles(dimension.name, dimension.dataType, dimension.isTime),
      ...(dimension.dataType ? { dataType: dimension.dataType } : {}),
      ...(dimension.timeGrains?.length ? { timeGrains: dimension.timeGrains } : {}),
      ...(dimension.reachableFrom?.length ? { joinReach: dimension.reachableFrom } : {}),
      ...(dimension.sourceId ? { sourceId: dimension.sourceId } : {}),
      ...(dimension.inventory ? { inventory: true } : {}),
      ...(dimension.physical ? { physical: dimension.physical } : {}),
    });
  }
  for (const entity of source.entities ?? []) {
    entries.push({
      ref: `entity:${entity.model}.${entity.name}`,
      kind: 'entity',
      name: entity.name,
      ...(entity.label ? { label: entity.label } : {}),
      aliases: [entity.label ?? '', `${entity.name} id`, `${entity.name}_id`].filter(Boolean),
      description: `${entity.type} entity${entity.description ? `: ${entity.description}` : ''}`,
      model: entity.model,
      roles: ['key'],
      entityType: entity.type,
      ...(entity.reachableFrom?.length ? { joinReach: entity.reachableFrom } : {}),
      ...(entity.sourceId ? { sourceId: entity.sourceId } : {}),
      ...(entity.inventory ? { inventory: true } : {}),
      ...(entity.physical ? { physical: entity.physical } : {}),
    });
  }
  for (const model of source.models ?? []) {
    entries.push({
      ref: `model:${model.name}`,
      kind: 'model',
      name: model.name,
      ...(model.label ? { label: model.label } : {}),
      aliases: [model.label ?? ''].filter(Boolean),
      ...(model.description ? { description: model.description } : {}),
      roles: [],
      ...(model.relation ? { model: model.relation } : {}),
    });
  }
  for (const block of source.blocks ?? []) {
    entries.push({
      ref: `block:${block.domain ?? 'global'}.${block.name}`,
      kind: 'block',
      name: block.name,
      aliases: [block.name.replace(/_/g, ' '), ...(block.tags ?? []), ...(block.supersedes ?? []).map((retired) => retired.name)],
      ...(block.description ? { description: block.description } : {}),
      ...(block.domain ? { model: block.domain } : {}),
      roles: block.certified ? ['certified'] : [],
      certified: block.certified,
      ...(block.status ? { status: block.status } : {}),
      contract: block.contract,
      columns: block.contract.outputs,
      ...(block.examples?.length ? { examples: block.examples } : {}),
      ...(block.sourceId ? { sourceId: block.sourceId } : {}),
      ...(block.sql ? { sql: block.sql } : {}),
      ...(block.sourcePath ? { sourcePath: block.sourcePath } : {}),
      ...(block.owner ? { owner: block.owner } : {}),
      ...(block.supersedes?.length ? { supersedes: block.supersedes } : {}),
    });
  }
  // A legacy two-part alias is safe only when one physical binding owns it in
  // this snapshot. DB_A.PUBLIC.EVENTS and DB_B.PUBLIC.EVENTS therefore retain
  // their exact identities instead of sharing the unsafe PUBLIC.EVENTS alias.
  const logicalBindingCounts = new Map<string, number>();
  for (const relation of source.relations ?? []) {
    const binding = relation.binding;
    if (!binding) continue;
    const logical = binding.logicalRelation.toLowerCase();
    logicalBindingCounts.set(logical, (logicalBindingCounts.get(logical) ?? 0) + 1);
  }
  const relationQualifiedName = (relation: NonNullable<VocabularySource['relations']>[number]): string => {
    const logical = relation.schema ? `${relation.schema}.${relation.name}` : relation.name;
    const binding = relation.binding;
    // Keep existing two-part refs when there is only one target object. When
    // the same logical relation occurs in multiple databases, make the full
    // exact physical spelling the canonical ref and leave the short alias out.
    return binding && (logicalBindingCounts.get(binding.logicalRelation.toLowerCase()) ?? 0) > 1
      ? physicalRelationText(binding)
      : logical;
  };
  const relationAliasCounts = new Map<string, number>();
  for (const relation of source.relations ?? []) {
    const qualified = relationQualifiedName(relation);
    for (const alias of new Set([qualified, ...(relation.binding?.aliases ?? [])])) {
      const key = alias.toLowerCase();
      relationAliasCounts.set(key, (relationAliasCounts.get(key) ?? 0) + 1);
    }
  }
  for (const relation of source.relations ?? []) {
    const qualified = relationQualifiedName(relation);
    const binding = relation.binding ?? physicalRelationBinding({
      logicalRelation: qualified,
      columns: relation.columns.map((column) => ({ name: column.name, ...(column.dataType ? { type: column.dataType } : {}), ...(column.description ? { description: column.description } : {}) })),
      columnCompleteness: relation.columnCompleteness ?? 'partial',
      source: 'dbt_manifest',
    });
    entries.push({
      ref: `relation:${qualified}`,
      kind: 'relation',
      name: relation.name,
      aliases: [...new Set([qualified, ...(binding.aliases ?? []).filter((alias) => relationAliasCounts.get(alias.toLowerCase()) === 1)])],
      ...(relation.description ? { description: relation.description } : {}),
      model: qualified,
      roles: [],
      columns: relation.columns.map((column) => column.name),
      ...(eligibilityNotes(relation.columns).length ? { columnNotes: eligibilityNotes(relation.columns) } : {}),
      ...(relation.sourceId ? { sourceId: relation.sourceId } : {}),
      // The owning domain (first of the sorted set), so a ref outside an envelope can be explained by who owns it.
      ...(relation.domains?.[0] ?? relation.domain ? { domain: relation.domains?.[0] ?? relation.domain } : {}),
      ...(relation.columnLineage && Object.keys(relation.columnLineage).length ? { columnLineage: relation.columnLineage } : {}),
      // Keep the historical logical relation in `relation`; every executable
      // consumer uses the binding when it needs the database-qualified name.
      physical: { relation: qualified, binding },
    });
    for (const column of relation.columns) {
      entries.push({
        ref: `column:${qualified}.${column.name}`,
        kind: 'column',
        name: column.name,
        aliases: [],
        ...(column.description ? { description: column.description } : {}),
        model: qualified,
        roles: columnRoles(column.name, column.dataType).map((role) => (role === 'categorical' ? 'text' : role)),
        ...(column.dataType ? { dataType: column.dataType } : {}),
        physical: { relation: qualified, column: column.name, binding },
      });
    }
  }
  for (const term of source.terms ?? []) {
    entries.push({
      ref: `term:${term.name}`,
      kind: 'term',
      name: term.name,
      aliases: term.synonyms ?? [],
      ...(term.description ? { description: term.description } : {}),
      roles: [],
      ...(term.metricRefs?.length ? { columns: term.metricRefs } : {}),
      ...(term.rules?.length ? { rules: term.rules } : {}),
      ...(term.domain ? { domain: term.domain } : {}),
    });
  }
  // Authored meaning for a relation: what the modeled thing is, and its grain.
  for (const [relation, meaning] of Object.entries(source.relationMeaning ?? {})) {
    const entry = entries.find((candidate) => candidate.kind === 'relation' && candidate.model === relation);
    if (!entry) continue;
    if (meaning.businessName && !entry.aliases.includes(meaning.businessName)) entry.aliases.push(meaning.businessName);
    if (meaning.businessContext) entry.businessContext = meaning.businessContext;
    if (meaning.grain) entry.grain = meaning.grain;
    if (meaning.domain) entry.domain = meaning.domain;
    if (meaning.deprecated) entry.deprecated = true;
  }
  for (const relationship of source.relationships ?? []) {
    entries.push({
      ref: `relationship:${relationship.domain ? `${relationship.domain}.` : ''}${relationship.id}`,
      kind: 'relationship',
      name: relationship.id,
      aliases: [relationship.id.replace(/_/g, ' '), relationship.from, relationship.to].filter(Boolean),
      ...(relationship.description ? { description: relationship.description } : {}),
      roles: [],
      ...(relationship.status ? { status: relationship.status } : {}),
      ...(relationship.domain ? { domain: relationship.domain } : {}),
      joinAuthority: relationship.joinAuthority,
      relationship: { from: relationship.from, to: relationship.to, keys: relationship.keys, ...(relationship.cardinality ? { cardinality: relationship.cardinality } : {}), ...(relationship.fanout ? { fanout: relationship.fanout } : {}), ...(relationship.verb ? { verb: relationship.verb } : {}), ...(relationship.crossDomain ? { crossDomain: true } : {}) },
      columns: relationship.keys.flatMap((key) => [key.from, key.to]),
    });
  }
  for (const skill of source.skills ?? []) {
    const preferredRefs = skill.preferredRefs ?? [];
    entries.push({
      ref: skill.ref,
      kind: 'skill',
      name: skill.id,
      aliases: [skill.id.replace(/[-_]/g, ' '), ...(skill.triggers ?? [])],
      ...(skill.description ? { description: skill.description } : {}),
      roles: [],
      ...(skill.domain ? { domain: skill.domain } : {}),
      ...(skill.policy ? { policy: skill.policy } : {}),
      skill: { preferredRefs, requiredFilters: skill.requiredFilters ?? [], clarifyWhen: skill.clarifyWhen ?? [], vocabulary: skill.vocabulary ?? {}, ...(skill.kind ? { kind: skill.kind } : {}), ...(skill.guidance ? { guidance: skill.guidance } : {}) },
    });
    // The skill's own words become aliases of the entries they name, and the
    // entries it prefers know it: both are request-scoped, because only the
    // selected skills reach this source.
    for (const [word, ref] of Object.entries(skill.vocabulary ?? {})) {
      const target = entries.find((candidate) => candidate.ref.toLowerCase() === ref.toLowerCase());
      if (target && !target.aliases.some((alias) => normalizeVocabularyText(alias) === normalizeVocabularyText(word))) target.aliases.push(word);
    }
    for (const ref of preferredRefs) {
      const target = entries.find((candidate) => candidate.ref.toLowerCase() === ref.toLowerCase());
      if (target) target.preferredBy = [...new Set([...(target.preferredBy ?? []), skill.ref])];
    }
  }
  for (const hint of source.hints ?? []) {
    entries.push({
      ref: `hint:${hint.id}`,
      kind: 'hint',
      name: hint.title ?? hint.id,
      aliases: hint.tags ?? [],
      description: hint.guidance,
      roles: [],
      ...(hint.domain ? { domain: hint.domain } : {}),
    });
  }
  for (const concept of source.concepts ?? []) {
    entries.push({
      ref: `concept:${concept.domain ? `${concept.domain}.` : ''}${concept.id}`,
      kind: 'concept',
      name: concept.name,
      aliases: [concept.id.replace(/[-_]/g, ' '), ...(concept.synonyms ?? [])],
      ...(concept.description ? { description: concept.description } : {}),
      roles: [],
      ...(concept.status ? { status: concept.status } : {}),
      ...(concept.domain ? { domain: concept.domain } : {}),
      bindings: concept.bindings,
    });
  }
  return new VocabularyIndex(entries);
}
