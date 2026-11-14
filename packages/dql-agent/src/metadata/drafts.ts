import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { extractTablesFromSql, loadDomainPackageRegistry, type DqlArtifactFilter, type DqlArtifactOrderBy, type DqlArtifactReference } from '@zlens/core';
import { resolveLocalOwner } from './identity.js';
import { withoutTrailing } from '../text-ends.js';

export type GeneratedDraftSourceDqlArtifact = DqlArtifactReference;

export interface GeneratedDqlArtifactDraftRecord {
  slug: string;
  question: string;
  proposedContractId: string;
  /** Accountable owner; defaults to the resolved local owner so a draft is never owner-less. */
  owner?: string;
  proposedDomain?: string;
  dqlArtifact: GeneratedDraftSourceDqlArtifact;
  sourceQuestion?: string;
  sourceBlock?: string;
  followupKind?: string;
  contextPackId?: string;
  routeIntent?: string;
  validationWarnings?: string[];
  outputs?: string[];
}

export interface GeneratedDraftRecord {
  slug: string;
  question: string;
  proposedSql: string;
  proposedContractId: string;
  /** Accountable owner; defaults to the resolved local owner so a draft is never owner-less. */
  owner?: string;
  proposedDomain?: string;
  proposedEntity?: string;
  upstreamRefs?: string[];
  sourceDqlArtifact?: GeneratedDraftSourceDqlArtifact;
  sourceQuestion?: string;
  sourceBlock?: string;
  followupKind?: string;
  requestedFilters?: string[];
  requestedDimensions?: string[];
  outputs?: string[];
  contextPackId?: string;
  routeIntent?: string;
  validationWarnings?: string[];
}

export interface GeneratedDraftBlock {
  path: string;
  askedTimes: number;
  proposedContractId: string;
}

export interface GeneratedSqlDqlArtifactInput extends GeneratedDraftRecord {
  draftPath?: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'much', 'my', 'of',
  'on', 'or', 'our', 'so', 'that', 'the', 'their', 'then', 'there', 'this',
  'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'you', 'your',
]);

export function deriveGeneratedDraftSlug(question: string): string {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
  const slug = tokens.join('_').slice(0, 60).replace(/_+$/, '');
  return slug || 'untitled_proposal';
}

/** Words a review draft's name drops: STOPWORDS, plus helper verbs and pronouns that say nothing about the data. */
const REVIEW_DRAFT_FILLER = new Set([...STOPWORDS, 'did', 'does', 'he', 'she', 'they', 'them', 'him', 'his', 'her', 'its', 'been', 'being']);
const REVIEW_DRAFT_SLUG_MAX = 80;

/**
 * The name of an Ask review draft, from the question it answers. It keeps
 * "how" before many/much/often/long ("how_many_teams", never "many_teams":
 * new-user test V7), and it is cut only between words, never inside one.
 */
export function deriveReviewDraftSlug(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const tokens = words.filter((word, index) => (word === 'how' && /^(many|much|often|long)$/.test(words[index + 1] ?? '')) || !REVIEW_DRAFT_FILLER.has(word));
  let slug = '';
  for (const token of tokens) {
    const next = slug ? `${slug}_${token}` : token;
    if (next.length > REVIEW_DRAFT_SLUG_MAX) break;
    slug = next;
  }
  if (!slug && tokens[0]) slug = tokens[0].slice(0, REVIEW_DRAFT_SLUG_MAX);
  return (slug || 'untitled_proposal').replace(/^(\d)/, 'q_$1');
}

/**
 * Writes a draft in one step: the content goes to a new file beside it, created exclusively (it cannot already
 * exist, and nothing else can have opened it), then that file is renamed over the draft. A reader sees the old
 * draft or the new one, never half of one, and no check of the draft's path can go stale before the write.
 */
function writeDraftFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const staged = join(dirname(filePath), `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(staged, 'wx', 0o600);
  try {
    writeSync(fd, content);
    // A draft is project source, readable like the files beside it.
    fchmodSync(fd, 0o644);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(staged, filePath);
  } catch (error) {
    try { unlinkSync(staged); } catch { /* already gone */ }
    throw error;
  }
}

/** A question as compared for "the same question": case, spacing, quotes and closing punctuation ignored. */
export function normalizeDraftQuestion(question: string): string {
  const folded = question
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ');
  return withoutTrailing(folded, '?.!;:,').trim();
}

/** Snake_case identifier rule the namer enforces: `^[a-z][a-z0-9_]*$`. */
const SEMANTIC_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Words that hint at the metric/entity being asked about. Kept tiny and
 * convention-agnostic — this is a deterministic fallback, not an NLP model.
 */
const GRAIN_HINTS: Array<{ re: RegExp; grain: string }> = [
  { re: /\b(daily|per day|by day|each day)\b/i, grain: 'daily' },
  { re: /\b(weekly|per week|by week|each week)\b/i, grain: 'weekly' },
  { re: /\b(monthly|per month|by month|each month)\b/i, grain: 'monthly' },
  { re: /\b(quarterly|per quarter|by quarter)\b/i, grain: 'quarterly' },
  { re: /\b(yearly|annual|annually|per year|by year)\b/i, grain: 'yearly' },
];

/** Common analytic entities/measures we recognize for the rule-based fallback. */
const ENTITY_HINTS = [
  'orders', 'order', 'revenue', 'sales', 'customers', 'customer', 'users', 'user',
  'sessions', 'session', 'payments', 'payment', 'subscriptions', 'subscription',
  'churn', 'retention', 'signups', 'signup', 'spend', 'cost', 'profit', 'margin',
  'shipments', 'shipment', 'products', 'product', 'accounts', 'account', 'leads',
  'lead', 'tickets', 'ticket', 'visits', 'visit', 'transactions', 'transaction',
];

/** A "by <dimension>" phrase points at the key dimension of the question. */
const DIMENSION_RE = /\bby\s+([a-z][a-z0-9 ]{1,30}?)(?:\s+(?:at|per|for|in|over|grouped|broken)\b|[?.,]|$)/i;

function snakeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function toSnake(value: string): string {
  return snakeTokens(value).join('_').replace(/^_+|_+$/g, '');
}

/**
 * Validate + normalize a provider-suggested block name. Returns a clean
 * snake_case slug (deduped against `existing`) or undefined when the suggestion
 * is unusable.
 */
function sanitizeProviderName(suggested: string | undefined, existing: Set<string>): string | undefined {
  if (typeof suggested !== 'string') return undefined;
  let candidate = suggested.trim().toLowerCase();
  if (!candidate) return undefined;
  // Coerce light formatting (spaces / dashes / camelCase) into snake_case before
  // validating, so a well-meaning but loosely-formatted suggestion still passes.
  if (!SEMANTIC_NAME_RE.test(candidate)) {
    candidate = candidate
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
  if (!SEMANTIC_NAME_RE.test(candidate)) return undefined;
  return dedupeSlug(candidate.slice(0, 60).replace(/_+$/, ''), existing);
}

/**
 * Rule-based semantic extraction: entity (+ key dimension + grain) from the
 * question, e.g. "total orders by geography at the daily level" →
 * `orders_by_geography_daily`. Returns undefined when no entity is recognizable.
 */
function ruleBasedName(question: string): string | undefined {
  const lower = question.toLowerCase();
  const tokens = snakeTokens(question);

  // Entity: first recognized analytic noun, singular/plural insensitive.
  const entity = ENTITY_HINTS.find((hint) => tokens.includes(hint));
  if (!entity) return undefined;

  const parts: string[] = [entity];

  // Key dimension: a "by <dimension>" phrase, reduced to its head noun.
  const dimMatch = lower.match(DIMENSION_RE);
  if (dimMatch) {
    const dim = toSnake(dimMatch[1]);
    if (dim && dim !== entity) parts.push('by', dim);
  }

  // Grain: an explicit time grain hint.
  const grainHint = GRAIN_HINTS.find((hint) => hint.re.test(lower));
  if (grainHint) parts.push(grainHint.grain);

  const slug = parts.join('_').replace(/^_+|_+$/g, '');
  return slug || undefined;
}

/** Append `_2`, `_3`, … until the slug is unused. */
function dedupeSlug(slug: string, existing: Set<string>): string {
  if (!existing.has(slug)) return slug;
  let n = 2;
  while (existing.has(`${slug}_${n}`)) n += 1;
  return `${slug}_${n}`;
}

export interface SemanticDraftNameInput {
  /** The user prompt / question that motivated the block. */
  question: string;
  /** A short snake_case name the provider suggested, if any. Preferred when valid. */
  providerName?: string;
  /** Existing block/draft slugs to dedupe against. */
  existingSlugs?: Iterable<string>;
}

/**
 * Pick a SEMANTIC snake_case name for a builder-generated block.
 *
 * Priority:
 *   1. A valid provider-suggested name (`^[a-z][a-z0-9_]*$`), deduped.
 *   2. A rule-based extraction (entity + key dimension + grain), deduped.
 *   3. The legacy question tokenizer (`deriveGeneratedDraftSlug`) — LAST resort.
 *
 * This deliberately avoids the old behavior of naming a block after the literal
 * question (e.g. `can_you_build_the_total_orders_by_geography_at_the_level`).
 */
export function deriveSemanticDraftName(input: SemanticDraftNameInput): string {
  const existing = new Set<string>(input.existingSlugs ?? []);

  const fromProvider = sanitizeProviderName(input.providerName, existing);
  if (fromProvider) return fromProvider;

  const fromRule = ruleBasedName(input.question);
  if (fromRule) return dedupeSlug(fromRule.slice(0, 60).replace(/_+$/, ''), existing);

  // Last resort: the legacy tokenizer, still deduped so re-asks don't collide.
  return dedupeSlug(deriveGeneratedDraftSlug(input.question), existing);
}

export function upsertGeneratedDraft(
  projectRoot: string,
  rec: GeneratedDraftRecord,
): GeneratedDraftBlock {
  const { filePath, relativePath } = resolveGeneratedDraftPath(projectRoot, rec);
  // Owner is the one field a human must confirm to certify — never let a captured
  // draft be born owner-less (it would hard-block certification for no reason).
  const owner = rec.owner?.trim() || resolveLocalOwner(projectRoot);
  // The same answer SQL asked in other words reuses its draft (Ask and MCP
  // share this fingerprint), so repeats never spam the drafts folder.
  const fingerprint = reviewAnswerFingerprint(rec.proposedSql);
  const sameAnswer = existsSync(filePath) ? undefined : findReviewDraftByFingerprint(projectRoot, fingerprint);
  if (sameAnswer) {
    return { path: sameAnswer, askedTimes: bumpAskedTimes(projectRoot, sameAnswer, owner), proposedContractId: rec.proposedContractId };
  }

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    const m = existing.match(/asked_times\s*=\s*(\d+)/);
    const prev = m ? Number.parseInt(m[1], 10) : 1;
    const next = Number.isFinite(prev) ? prev + 1 : 2;
    let updated = m
      ? existing.replace(/asked_times\s*=\s*\d+/, `asked_times = ${next}`)
      : existing.replace(/\n\s*query\s*=/, `\n    asked_times = ${next}\n\n    query =`);
    // Backfill owner on older owner-less drafts so re-asking makes them certifiable.
    if (!/\n\s*owner\s*=/.test(updated)) {
      updated = updated.replace(/(\n\s*status\s*=\s*"draft")/, `$1\n    owner = "${escapeDqlString(owner)}"`);
    }
    writeFileSync(filePath, stampLastAsked(updated));
    return {
      path: relativePath,
      askedTimes: next,
      proposedContractId: rec.proposedContractId,
    };
  }

  writeDraftFile(filePath, withAutoDraftMark(renderGeneratedDraft({ ...rec, owner, answerFingerprint: fingerprint }, relativePath)));
  return {
    path: relativePath,
    askedTimes: 1,
    proposedContractId: rec.proposedContractId,
  };
}

export function upsertGeneratedDqlArtifactDraft(
  projectRoot: string,
  rec: GeneratedDqlArtifactDraftRecord,
): GeneratedDraftBlock {
  const { filePath, relativePath } = resolveGeneratedDraftPath(projectRoot, rec);
  const owner = rec.owner?.trim() || resolveLocalOwner(projectRoot);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    const m = existing.match(/asked_times\s*=\s*(\d+)/);
    const prev = m ? Number.parseInt(m[1], 10) : 1;
    const next = Number.isFinite(prev) ? prev + 1 : 2;
    let updated = m
      ? existing.replace(/asked_times\s*=\s*\d+/, `asked_times = ${next}`)
      : insertBeforeFinalBrace(existing, `\n  asked_times = ${next}`);
    if (!/\n\s*owner\s*=/.test(updated)) {
      updated = insertOwner(updated, owner);
    }
    writeFileSync(filePath, stampLastAsked(updated));
    return {
      path: relativePath,
      askedTimes: next,
      proposedContractId: rec.proposedContractId,
    };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, stampGeneratedDqlArtifactDraft(rec, relativePath, owner));
  return {
    path: relativePath,
    askedTimes: 1,
    proposedContractId: rec.proposedContractId,
  };
}

/**
 * A review-required (Tier-2) answer, captured so a person can review it and
 * certify it later. Never certified: the draft's status is always `draft`.
 */
export interface ReviewRequiredAnswerDraftRecord {
  question: string;
  /** The SQL that produced the answer (compiled SQL of the DQL artifact when there is one). */
  sql: string;
  /** The transient DQL artifact the answer ran; its source is saved as the draft body. */
  dqlArtifact?: { source: string; name?: string; kind?: string } | null;
  proposedDomain?: string;
  owner?: string;
  /** The run that produced the answer, recorded for traceability. */
  runId?: string;
}

export interface ReviewRequiredAnswerDraft extends GeneratedDraftBlock {
  /** False when an existing draft for the same answer was found and its counter bumped. */
  created: boolean;
  /** sha256 of the normalized SQL: the de-duplication key across re-asks. */
  fingerprint: string;
}

/** sha256 of the answer's SQL with comments, case and whitespace normalized. */
export function reviewAnswerFingerprint(sql: string): string {
  const normalized = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=<>;])\s*/g, '$1')
    .replace(/;+\s*$/, '')
    .trim()
    .toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

/** The draft already holding this answer fingerprint, searched across every drafts folder. */
export function findReviewDraftByFingerprint(projectRoot: string, fingerprint: string): string | undefined {
  const needle = `answer_fingerprint = "${fingerprint}"`;
  const roots: string[] = [join(projectRoot, 'blocks', '_drafts')];
  const domainsRoot = join(projectRoot, 'domains');
  if (existsSync(domainsRoot)) {
    for (const entry of readdirSync(domainsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(domainsRoot, entry.name, 'blocks', '_drafts'));
    }
  }
  const visit = (dir: string, depth: number): string | undefined => {
    if (depth > 4 || !existsSync(dir)) return undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = visit(child, depth + 1);
        if (found) return found;
      } else if (entry.name.endsWith('.dql') && readFileSync(child, 'utf-8').includes(needle)) {
        return relative(projectRoot, child).replaceAll('\\', '/');
      }
    }
    return undefined;
  };
  for (const root of roots) {
    const found = visit(root, 0);
    if (found) return found;
  }
  return undefined;
}

function bumpAskedTimes(projectRoot: string, relativePath: string, owner: string): number {
  const filePath = join(projectRoot, relativePath);
  const existing = readFileSync(filePath, 'utf-8');
  const m = existing.match(/asked_times\s*=\s*(\d+)/);
  const prev = m ? Number.parseInt(m[1], 10) : 1;
  const next = Number.isFinite(prev) ? prev + 1 : 2;
  let updated = m
    ? existing.replace(/asked_times\s*=\s*\d+/, `asked_times = ${next}`)
    : insertBeforeFinalBrace(existing, `\n  asked_times = ${next}`);
  if (!/\n\s*owner\s*=/.test(updated)) updated = insertOwner(updated, owner);
  writeFileSync(filePath, stampLastAsked(updated));
  return next;
}

/**
 * Leave a durable, findable draft for a review-required answer.
 *
 * De-duplicated so repeats do not spam the drafts folder: the same answer SQL
 * (by fingerprint) or the same question (by slug) bumps `asked_times` on the
 * existing draft instead of writing another file. The draft lands in
 * `domains/<domain>/blocks/_drafts/` or `blocks/_drafts/`, always with
 * `status = "draft"`; certifying it is a separate, explicit action
 * (`zlens certify --from-draft` or Block Studio's Certify).
 */
export function upsertReviewRequiredAnswerDraft(
  projectRoot: string,
  rec: ReviewRequiredAnswerDraftRecord,
): ReviewRequiredAnswerDraft {
  const fingerprint = reviewAnswerFingerprint(rec.sql);
  const owner = rec.owner?.trim() || resolveLocalOwner(projectRoot, { persist: false });
  const slug = deriveReviewDraftSlug(rec.question);
  const proposedContractId = slug;
  const byFingerprint = findReviewDraftByFingerprint(projectRoot, fingerprint);
  if (byFingerprint) {
    return { path: byFingerprint, askedTimes: bumpAskedTimes(projectRoot, byFingerprint, owner), proposedContractId, created: false, fingerprint };
  }
  const proposedDomain = rec.proposedDomain?.trim() || proposeAnswerDomain(projectRoot, rec.sql);
  const { filePath, relativePath } = resolveGeneratedDraftPath(projectRoot, { slug, proposedDomain });
  // THE SAME QUESTION KEEPS ONE DRAFT, wherever it was filed: a repeat whose
  // tables propose another Domain, or a draft named before V13 changed the
  // names, is the same question (new-user test V12: the same question saved
  // twice). A draft nobody changed takes the newer answer; one a person
  // edited keeps their work and only counts the ask.
  // A saved query a person wrote under the same name is never taken over: the draft gets the next free name.
  const atSlug = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : undefined;
  const slugIsAskDraft = atSlug !== undefined && automaticAskDraftState(atSlug) !== undefined;
  const sameQuestion = slugIsAskDraft ? relativePath : findReviewDraftByQuestion(projectRoot, rec.question);
  if (sameQuestion) {
    const existingPath = join(projectRoot, sameQuestion);
    const existing = readFileSync(existingPath, 'utf-8');
    if (automaticAskDraftState(existing, statSync(existingPath).mtimeMs) === 'untouched') {
      const asked = existing.match(/asked_times\s*=\s*(\d+)/);
      const previous = asked ? Number.parseInt(asked[1]!, 10) : 1;
      const askedTimes = Number.isFinite(previous) ? previous + 1 : 2;
      const firstAsked = existing.match(/first_asked\s*=\s*"([^"]*)"/)?.[1];
      const keptSlug = sameQuestion.split('/').pop()!.replace(/\.dql$/, '');
      const keptDomain = /^domains\/([^/]+)\//.exec(sameQuestion)?.[1] ?? proposedDomain;
      let body = reviewDraftBody(rec, { slug: keptSlug, proposedContractId: keptSlug, proposedDomain: keptDomain, owner, fingerprint }, sameQuestion)
        .replace(/asked_times\s*=\s*\d+/, `asked_times = ${askedTimes}`);
      if (firstAsked) body = body.replace(/first_asked\s*=\s*"[^"]*"/, `first_asked = "${firstAsked}"`);
      writeDraftFile(existingPath, withAutoDraftMark(body));
      return { path: sameQuestion, askedTimes, proposedContractId: keptSlug, created: false, fingerprint };
    }
    return { path: sameQuestion, askedTimes: bumpAskedTimes(projectRoot, sameQuestion, owner), proposedContractId, created: false, fingerprint };
  }
  let freeSlug = slug;
  let target = { filePath, relativePath };
  for (let n = 2; existsSync(target.filePath); n += 1) {
    freeSlug = `${slug}_${n}`;
    target = resolveGeneratedDraftPath(projectRoot, { slug: freeSlug, proposedDomain });
  }
  const body = reviewDraftBody(rec, { slug: freeSlug, proposedContractId: freeSlug, proposedDomain, owner, fingerprint }, target.relativePath);
  writeDraftFile(target.filePath, withAutoDraftMark(body));
  return { path: target.relativePath, askedTimes: 1, proposedContractId: freeSlug, created: true, fingerprint };
}

function reviewDraftBody(
  rec: ReviewRequiredAnswerDraftRecord,
  draft: { slug: string; proposedContractId: string; proposedDomain?: string; owner: string; fingerprint: string },
  relativePath: string,
): string {
  const artifactSource = rec.dqlArtifact?.source?.trim();
  // The draft is named after its own id (the file name), not after the AI's
  // restatement of the question that named the transient artifact.
  return artifactSource
    ? stampGeneratedDqlArtifactDraft({
        slug: draft.slug,
        question: rec.question,
        proposedContractId: draft.proposedContractId,
        proposedDomain: draft.proposedDomain,
        sourceQuestion: rec.question,
        dqlArtifact: {
          kind: (rec.dqlArtifact?.kind ?? 'sql_block'),
          source: withProposedDomain(renameDraftBlock(forceDraftStatus(artifactSource), draft.slug), draft.proposedDomain),
          ...(rec.dqlArtifact?.name ? { name: rec.dqlArtifact.name } : {}),
        } as GeneratedDraftSourceDqlArtifact,
      }, relativePath, draft.owner, { answerFingerprint: draft.fingerprint, sourceRunId: rec.runId })
    : renderGeneratedDraft({ slug: draft.slug, question: rec.question, proposedSql: rec.sql, proposedContractId: draft.proposedContractId, proposedDomain: draft.proposedDomain, owner: draft.owner, answerFingerprint: draft.fingerprint, sourceRunId: rec.runId }, relativePath);
}

// ── Automatic Ask drafts: which ones Ask wrote, and which nobody has changed ──

/** The comment an automatic draft carries: a check over everything a person could change. */
const AUTO_DRAFT_MARK = /^[ \t]*\/\/ Saved by Ask\. "Clear drafts" removes it while it is unchanged \(check ([0-9a-f]{16})\)\.[ \t]*\r?\n?/m;
/** Lines Ask itself changes on a repeat, left out of the check. */
const ASK_COUNTER_LINE = /^[ \t]*(?:asked_times|first_asked|last_asked)[ \t]*=.*\r?\n?/gm;

function autoDraftCheck(content: string): string {
  const stable = content
    .replace(new RegExp(AUTO_DRAFT_MARK.source, 'gm'), '')
    .replace(ASK_COUNTER_LINE, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/** The draft with its check, as Ask wrote it. */
function withAutoDraftMark(content: string): string {
  const without = content.replace(new RegExp(AUTO_DRAFT_MARK.source, 'gm'), '');
  return `${insertBeforeFinalBrace(without, `\n  // Saved by Ask. "Clear drafts" removes it while it is unchanged (check ${autoDraftCheck(without)}).`)}\n`;
}

/**
 * Whether a saved query is an automatic Ask draft, and whether anyone changed
 * it since Ask last wrote it. `untouched`: Ask wrote it, it is still a draft,
 * and nothing but Ask's own counters changed. `edited`: Ask wrote it and a
 * person changed it since (their work, never cleared). Undefined: not an
 * automatic Ask draft at all. A draft written before the check existed counts
 * as unchanged only when its file was last written when Ask last stamped it.
 */
export function automaticAskDraftState(content: string, mtimeMs?: number): 'untouched' | 'edited' | undefined {
  const askWritten = /^\s*answer_fingerprint\s*=\s*"/m.test(content) || (/^\s*asked_times\s*=/m.test(content) && /^\s*last_asked\s*=/m.test(content));
  if (!askWritten) return undefined;
  const status = /^\s*status\s*=\s*"([^"]+)"/m.exec(content)?.[1] ?? 'draft';
  if (status !== 'draft') return 'edited';
  const mark = AUTO_DRAFT_MARK.exec(content);
  if (mark) return mark[1] === autoDraftCheck(content) ? 'untouched' : 'edited';
  const lastAsked = Date.parse(/last_asked\s*=\s*"([^"]*)"/.exec(content)?.[1] ?? '');
  if (mtimeMs === undefined || !Number.isFinite(lastAsked)) return 'edited';
  return Math.abs(mtimeMs - lastAsked) <= 10_000 ? 'untouched' : 'edited';
}

export interface AutomaticAskDraft {
  /** Project-relative path. */
  path: string;
  name: string;
  askedTimes: number;
  state: 'untouched' | 'edited';
}

function draftRoots(projectRoot: string): string[] {
  const roots: string[] = [join(projectRoot, 'blocks', '_drafts')];
  const domainsRoot = join(projectRoot, 'domains');
  if (existsSync(domainsRoot)) {
    for (const entry of readdirSync(domainsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(domainsRoot, entry.name, 'blocks', '_drafts'));
    }
  }
  return roots;
}

function visitDraftFiles(projectRoot: string, visit: (relativePath: string, filePath: string) => boolean | void): void {
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 4 || !existsSync(dir)) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(child, depth + 1)) return true;
      } else if (entry.name.endsWith('.dql') && visit(relative(projectRoot, child).replaceAll('\\', '/'), child) === true) {
        return true;
      }
    }
    return false;
  };
  for (const root of draftRoots(projectRoot)) if (walk(root, 0)) return;
}

/** Every automatic Ask draft in the project's drafts folders, with whether a person changed it. */
export function listAutomaticAskDrafts(projectRoot: string): AutomaticAskDraft[] {
  const drafts: AutomaticAskDraft[] = [];
  visitDraftFiles(projectRoot, (relativePath, filePath) => {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const state = automaticAskDraftState(content, statSync(filePath).mtimeMs);
      if (!state) return;
      const asked = Number.parseInt(/asked_times\s*=\s*(\d+)/.exec(content)?.[1] ?? '1', 10);
      drafts.push({ path: relativePath, name: /^\s*block\s+"([^"]+)"/m.exec(content)?.[1] ?? relativePath.split('/').pop()!.replace(/\.dql$/, ''), askedTimes: Number.isFinite(asked) ? asked : 1, state });
    } catch { /* an unreadable file is not an automatic draft */ }
  });
  return drafts;
}

/**
 * "Clear drafts": removes the automatic Ask drafts nobody changed, and only
 * those. A draft a person edited or certified, and every saved query a person
 * wrote, stays. Returns what was removed and how many Ask drafts were kept.
 */
export function clearAutomaticAskDrafts(projectRoot: string): { removed: string[]; kept: number } {
  const removed: string[] = [];
  let kept = 0;
  for (const draft of listAutomaticAskDrafts(projectRoot)) {
    if (draft.state !== 'untouched') { kept += 1; continue; }
    try {
      unlinkSync(join(projectRoot, draft.path));
      removed.push(draft.path);
    } catch { kept += 1; }
  }
  return { removed, kept };
}

/** The automatic draft already saved for this question (by its words, case and closing punctuation ignored). */
export function findReviewDraftByQuestion(projectRoot: string, question: string): string | undefined {
  const wanted = normalizeDraftQuestion(question);
  if (!wanted) return undefined;
  let found: string | undefined;
  visitDraftFiles(projectRoot, (relativePath, filePath) => {
    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return; }
    if (!automaticAskDraftState(content)) return;
    const asked = [
      /^\s*source_question\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(content)?.[1],
      /\bexamples\s*=\s*\[\s*\{\s*question\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(content)?.[1],
    ].filter((value): value is string => Boolean(value)).map((value) => normalizeDraftQuestion(value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')));
    if (asked.includes(wanted)) { found = relativePath; return true; }
  });
  return found;
}

/**
 * The Domain an answer's tables belong to, when there is exactly one: every
 * table the SQL reads is listed in the `sourceSystems` of one Domain and of no
 * other (`dbt:orders`, `orders` and `analytics.orders` all name `orders`).
 * Undefined otherwise, and the reviewer picks the Domain before certifying.
 */
export function proposeAnswerDomain(projectRoot: string, sql: string): string | undefined {
  let tables: string[];
  try {
    tables = Array.from(new Set(extractTablesFromSql(sql).tables.map(relationLeaf).filter(Boolean)));
  } catch {
    return undefined;
  }
  if (tables.length === 0) return undefined;
  let domains: Array<{ id: string; sourceSystems: string[] }>;
  try {
    domains = loadDomainPackageRegistry(projectRoot).values().map((pkg) => ({ id: pkg.id, sourceSystems: pkg.domain.sourceSystems ?? [] }));
  } catch {
    return undefined;
  }
  const owners = tables.map((table) => domains.filter((domain) => domain.sourceSystems.some((system) => relationLeaf(system) === table)));
  if (owners.some((claimed) => claimed.length !== 1)) return undefined;
  const ids = new Set(owners.map((claimed) => claimed[0]!.id));
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** `dbt:orders`, `"db"."dev"."orders"`, `model.shop.orders` → `orders`. */
function relationLeaf(value: string): string {
  const withoutSystem = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
  return (withoutSystem.split('.').pop() ?? '').replace(/["'`\[\]]/g, '').trim().toLowerCase();
}

function renameDraftBlock(source: string, name: string): string {
  return source.replace(/(\bblock\s+)"(?:[^"\\]|\\.)*"/, `$1"${escapeDqlString(name)}"`);
}

/** Writes the proposed Domain as the block's own `domain`, unless it declares one. */
function withProposedDomain(source: string, domain: string | undefined): string {
  if (!domain || /^\s*domain\s*=/m.test(source)) return source;
  return source.replace(/(\bblock\s+"[^"]*"\s*\{)/, `$1\n  domain = "${escapeDqlString(domain)}"`);
}

/** A captured answer is never certified, whatever status its source claims. */
function forceDraftStatus(source: string): string {
  if (/\bstatus\s*=\s*"[^"]*"/.test(source)) return source.replace(/(\bstatus\s*=\s*)"[^"]*"/, '$1"draft"');
  return source.replace(/(\bblock\s+"[^"]+"\s*\{)/, '$1\n  status = "draft"');
}

export function renderGeneratedSqlDqlArtifact(rec: GeneratedSqlDqlArtifactInput): string {
  const draftPath = rec.draftPath ?? `blocks/_drafts/${rec.slug}.dql`;
  return renderGeneratedDraft(rec, draftPath);
}

function resolveGeneratedDraftPath(
  projectRoot: string,
  rec: Pick<GeneratedDraftRecord, 'slug' | 'proposedDomain'>,
): { filePath: string; relativePath: string } {
  const safeDomain = (rec.proposedDomain ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '');
  const relativePath = safeDomain && existsSync(join(projectRoot, 'domains', safeDomain))
    ? `domains/${safeDomain}/blocks/_drafts/${rec.slug}.dql`
    : `blocks/_drafts/${rec.slug}.dql`;
  return {
    filePath: join(projectRoot, relativePath),
    relativePath,
  };
}

function renderGeneratedDraft(rec: GeneratedDraftRecord & { answerFingerprint?: string; sourceRunId?: string }, draftPath: string): string {
  const now = new Date().toISOString();
  const upstream = arrayField('upstream_refs', rec.upstreamRefs ?? []);
  const sourceDql = renderSourceDqlMetadata(rec.sourceDqlArtifact);
  const requestedFilters = arrayField('requested_filters', rec.requestedFilters ?? []);
  const requestedDimensions = arrayField('requested_dimensions', rec.requestedDimensions ?? []);
  const outputs = arrayField('outputs', rec.outputs ?? []);
  const warnings = arrayField('validation_warnings', rec.validationWarnings ?? []);
  const safeSql = rec.proposedSql.replace(/"""/g, '\\"\\"\\"');
  return `block "${escapeDqlString(rec.slug)}" {
    domain = "${escapeDqlString(rec.proposedDomain ?? 'misc')}"
    type = "custom"
    status = "draft"
    owner = "${escapeDqlString(rec.owner ?? '')}"
    description = """${rec.question.replace(/"""/g, '\\"\\"\\"')}"""
    examples = [{ question = "${escapeDqlString(rec.question.replace(/\s+/g, ' ').trim())}" }]${outputs}

    // Tier-2 generated proposal. This block is NOT certified.
    // Reviewer must validate filters, joins, grain, metric definition, lineage,
    // and contract ownership before promotion.
    //
    // Promotion path:
    //   zlens certify --from-draft ${draftPath} \\
    //               --domain ${rec.proposedDomain ?? 'misc'} \\
    //               --contract ${rec.proposedContractId}@1 \\
    //               --owner you@example.com
    datalex_contract = ""

    // Tier-2 proposal metadata. Keep these as flat fields so the draft remains
    // valid DQL and can be indexed by the local metadata catalog.
    asked_times = 1
    first_asked = "${now}"
    last_asked = "${now}"
    proposed_contract_id = "${escapeDqlString(rec.proposedContractId)}"
    proposed_domain = "${escapeDqlString(rec.proposedDomain ?? '')}"
    proposed_entity = "${escapeDqlString(rec.proposedEntity ?? '')}"
    source_question = "${escapeDqlString(rec.sourceQuestion ?? '')}"
    source_block = "${escapeDqlString(rec.sourceBlock ?? '')}"
    followup_kind = "${escapeDqlString(rec.followupKind ?? '')}"
    context_pack_id = "${escapeDqlString(rec.contextPackId ?? '')}"
    route_intent = "${escapeDqlString(rec.routeIntent ?? '')}"${rec.answerFingerprint ? `
    answer_fingerprint = "${rec.answerFingerprint}"` : ''}${rec.sourceRunId ? `
    source_run_id = "${escapeDqlString(rec.sourceRunId)}"` : ''}${upstream}${sourceDql}${requestedFilters}${requestedDimensions}${warnings}

    query = """
        ${safeSql.split('\n').join('\n        ')}
    """
}
`;
}

function stampGeneratedDqlArtifactDraft(
  rec: GeneratedDqlArtifactDraftRecord,
  draftPath: string,
  owner: string,
  provenance: { answerFingerprint?: string; sourceRunId?: string } = {},
): string {
  const now = new Date().toISOString();
  const sourceWithOwner = insertOwner(rec.dqlArtifact.source.trimEnd(), owner);
  const metadata = [
    '',
    '  // Generated DQL artifact metadata. This artifact was assembled before execution;',
    '  // promotion should persist this reviewed block rather than translating SQL.',
    `  asked_times = 1`,
    `  first_asked = "${now}"`,
    `  last_asked = "${now}"`,
    `  proposed_contract_id = "${escapeDqlString(rec.proposedContractId)}"`,
    `  proposed_domain = "${escapeDqlString(rec.proposedDomain ?? '')}"`,
    `  source_question = "${escapeDqlString(rec.sourceQuestion ?? '')}"`,
    // The question the answer was given for: certified, the block answers it before any model reads it.
    /\bexamples\s*=/.test(sourceWithOwner) ? '' : `  examples = [{ question = "${escapeDqlString(rec.question.replace(/\s+/g, ' ').trim())}" }]`,
    `  source_block = "${escapeDqlString(rec.sourceBlock ?? '')}"`,
    `  followup_kind = "${escapeDqlString(rec.followupKind ?? '')}"`,
    `  context_pack_id = "${escapeDqlString(rec.contextPackId ?? '')}"`,
    `  route_intent = "${escapeDqlString(rec.routeIntent ?? '')}"`,
    `  draft_path = "${escapeDqlString(draftPath)}"`,
    provenance.answerFingerprint ? `  answer_fingerprint = "${provenance.answerFingerprint}"` : '',
    provenance.sourceRunId ? `  source_run_id = "${escapeDqlString(provenance.sourceRunId)}"` : '',
    arrayField('outputs', rec.outputs ?? []).trimEnd(),
    arrayField('validation_warnings', rec.validationWarnings ?? []).trimEnd(),
  ].filter(Boolean).join('\n');
  return `${insertBeforeFinalBrace(sourceWithOwner, `\n${metadata}`)}\n`;
}

function insertOwner(source: string, owner: string): string {
  if (!owner || /\n\s*owner\s*=/.test(source)) return source;
  if (/\n\s*status\s*=/.test(source)) {
    return source.replace(/(\n\s*status\s*=\s*"[^"]*")/, `$1\n  owner = "${escapeDqlString(owner)}"`);
  }
  return source.replace(/(\bblock\s+"[^"]+"\s*\{)/, `$1\n  owner = "${escapeDqlString(owner)}"`);
}

function insertBeforeFinalBrace(source: string, insertion: string): string {
  const trimmed = source.trimEnd();
  const index = trimmed.lastIndexOf('}');
  if (index < 0) return `${trimmed}${insertion}`;
  return `${trimmed.slice(0, index).trimEnd()}${insertion}\n${trimmed.slice(index)}`;
}

function renderSourceDqlMetadata(artifact: GeneratedDraftSourceDqlArtifact | undefined): string {
  if (!artifact?.source?.trim()) return '';
  const metrics = arrayField('source_dql_metrics', artifact.metrics ?? []);
  const dimensions = arrayField('source_dql_dimensions', artifact.dimensions ?? []);
  const filters = arrayField('source_dql_filters', flattenDqlFilters(artifact.filters));
  const timeDimension = artifact.timeDimension
    ? `
    source_dql_time_dimension = "${escapeDqlString(artifact.timeDimension.name)}"
    source_dql_granularity = "${escapeDqlString(artifact.timeDimension.granularity)}"`
    : '';
  const orderBy = arrayField('source_dql_order_by', flattenDqlOrderBy(artifact.orderBy));
  const limit = typeof artifact.limit === 'number' && Number.isFinite(artifact.limit) && artifact.limit > 0
    ? `
    source_dql_limit = ${Math.floor(artifact.limit)}`
    : '';
  return `
    source_dql_kind = "${escapeDqlString(artifact.kind)}"
    source_dql_name = "${escapeDqlString(artifact.name ?? '')}"
    source_dql_path = "${escapeDqlString(artifact.sourcePath ?? '')}"
    source_dql_hash = "${hashSourceDql(artifact.source)}"${metrics}${dimensions}${filters}${timeDimension}${orderBy}${limit}`;
}

function flattenDqlFilters(filters: DqlArtifactFilter[] | undefined): string[] {
  return (filters ?? []).flatMap((filter) => {
    const values = filter.values.length ? filter.values : [''];
    return values.map((value) =>
      filter.operator === 'equals'
        ? `${filter.dimension}=${value}`.trim()
        : `${filter.dimension} ${filter.operator} ${value}`.trim(),
    );
  });
}

function flattenDqlOrderBy(orderBy: DqlArtifactOrderBy[] | undefined): string[] {
  return (orderBy ?? []).map((order) => `${order.name} ${order.direction}`);
}

function hashSourceDql(source: string): string {
  return createHash('sha256').update(source.trim()).digest('hex');
}

function arrayField(name: string, values: string[]): string {
  if (values.length === 0) return '';
  return `\n    ${name} = [${values.map((value) => `"${escapeDqlString(value)}"`).join(', ')}]`;
}

function stampLastAsked(content: string): string {
  const now = new Date().toISOString();
  if (/last_asked\s*=\s*"[^"]*"/.test(content)) {
    return content.replace(/last_asked\s*=\s*"[^"]*"/, `last_asked = "${now}"`);
  }
  return content;
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
