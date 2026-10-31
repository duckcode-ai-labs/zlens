import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockCompanionRelativePath, certifiedSourceSha256, certifiedSourceState, type BlockCheckRecord } from '@zlens/core';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';

/**
 * The record left behind when a person certifies a block.
 *
 * ZLens's trust promise is that nothing becomes certified implicitly: saving a
 * block (AI-generated, imported, or hand-written) always writes a draft, and a
 * block turns certified only through an explicit Certify action that runs the
 * certification rules. That action writes this receipt into the block's
 * companion YAML (`semantic-layer/blocks/.../<slug>.yaml`) next to
 * `reviewStatus: certified`, so the tracked source says who certified it, when,
 * through which surface, under which rule set, and for exactly which source.
 */
export interface CertificationReceipt {
  /** Who certified: the host's signed-in person, else the local git/OS owner. */
  certifiedBy: string;
  /**
   * The certifier's display name, when one is known (the host's display name,
   * else git `user.name`), so badges say "Certified by Kranthi" instead of an
   * email. Receipts written before this was recorded have none.
   */
  certifiedByName?: string;
  /** ISO-8601 timestamp of the certification. */
  certifiedAt: string;
  /** The surface the explicit Certify action came from. */
  via: CertificationSurface;
  /** The rule set that was evaluated: OSS (owner + run + tests) or enterprise. */
  rules: 'oss' | 'enterprise';
  /** sha256 of the certified `.dql` source, so a later edit is detectable. */
  sourceSha256: string;
  /** Names of the passed checks, when the certifier reported them. */
  checks?: string[];
  /** Advisory warnings the certifier reported (not blockers). */
  warnings?: string[];
  /**
   * The git branch this certification was made on, recorded only under a host.
   * Where the host certifies through its own review (`certification:
   * 'proposes'`), a certification made on the branch being served has not been
   * reviewed yet, so the screens call it a proposal. Merged, the same receipt
   * sits on another branch and reads as certified.
   */
  branch?: string;
}

export type CertificationSurface =
  | 'block-studio'
  | 'sql-import'
  | 'app-dataset'
  | 'cli';

export type BlockLifecycleStatus = 'draft' | 'review' | 'certified' | 'deprecated';

/**
 * The record a Deprecate action leaves in the companion YAML. A deprecated
 * block keeps its certification receipt beside this record, so the tracked
 * source still says who certified it and who retired it, and when.
 */
export interface DeprecationRecord {
  /** Who deprecated: the host's signed-in person, else the local git/OS owner. */
  deprecatedBy: string;
  /** ISO-8601 timestamp of the deprecation. */
  deprecatedAt: string;
  /** The surface the Deprecate action came from. */
  via: CertificationSurface;
  /** The block's status just before it was deprecated. */
  previousStatus: BlockLifecycleStatus;
}

export function buildDeprecationRecord(input: {
  deprecatedBy: string | undefined | null;
  via: CertificationSurface;
  previousStatus: BlockLifecycleStatus;
  now?: Date;
}): DeprecationRecord {
  return {
    deprecatedBy: input.deprecatedBy?.trim() || 'local',
    deprecatedAt: (input.now ?? new Date()).toISOString(),
    via: input.via,
    previousStatus: input.previousStatus,
  };
}

const STATUS_LINE = /^\s*status\s*=\s*"([^"]*)"/m;

/** The `status = "…"` a `.dql` source declares, defaulting to draft. */
export function blockSourceStatus(source: string): BlockLifecycleStatus {
  const declared = STATUS_LINE.exec(source)?.[1]?.trim().toLowerCase();
  if (declared === 'certified' || declared === 'review' || declared === 'deprecated') return declared;
  return 'draft';
}

/** Returns the source with a certified `status` written as `draft`; other sources unchanged. */
export function demoteCertifiedSource(source: string): string {
  if (blockSourceStatus(source) !== 'certified') return source;
  return source.replace(/(\bstatus\s*=\s*)"certified"/, '$1"draft"');
}

/**
 * The lifecycle tag a draft carries while it waits for review. SQL import, AI
 * drafts and notebook research all add it; Ask never serves a block tagged
 * with it as certified evidence (a certified status beside "review required"
 * is a contradiction). Certifying is the review, so it removes the tag.
 */
const REVIEW_PENDING_TAG = /^\s*review[\s_-]*required\s*$/i;

export function isReviewPendingTag(tag: string): boolean {
  return REVIEW_PENDING_TAG.test(tag);
}

/**
 * Wording in a human description that says the block still needs review. Ask
 * never serves a certified block whose description says this, so Certify
 * refuses it; review state belongs in the status and tags, not in prose.
 */
const REVIEW_PENDING_WORDING = /review[\s_-]*required/i;

export function describesReviewPending(description: string | undefined): boolean {
  return REVIEW_PENDING_WORDING.test(description ?? '');
}

/**
 * The description with every statement of review status taken out, keeping
 * what it says about the data: "Review required: ranks the top 5 …" becomes
 * "Ranks the top 5 …", "… games played. Review required." loses its last
 * sentence, "Review-required comparison of …" keeps the comparison, and
 * "(review required)" asides go. Empty when nothing else is left.
 */
export function withoutReviewPendingWording(description: string): string {
  let text = description
    .replace(/\s*[([]\s*[^()[\]]*?review[\s_-]*required[^()[\]]*?[)\]]/gi, '')
    .replace(/^\s*(?:this\s+(?:block|draft)\s+is\s+)?review[\s_-]*required\s*(?:[:.,;!-]|–|—)\s*/i, '')
    // The hyphenated adjective: "Review-required comparison of …" → "Comparison of …".
    .replace(/\breview[_-]required\s+(?=\w)/gi, '');
  const sentences = text.split(/(?<=[.!?])\s+/);
  text = sentences
    .map((sentence) => sentence
      // A trailing clause: "…, review required." / "… — review required"
      .replace(/\s*(?:[,;:-]|–|—)\s*(?:this\s+(?:block|draft)\s+is\s+|and\s+)?review[\s_-]*required\s*([.!?]?)\s*$/i, '$1'))
    .filter((sentence) => !REVIEW_PENDING_WORDING.test(sentence))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The `tags = [ … ]` list of a `.dql` source without the review-pending lifecycle tag. */
export function withoutReviewPendingTags(source: string): string {
  return source.replace(/(\btags\s*=\s*\[)([^\]]*)(\])/, (whole, open: string, body: string, close: string) => {
    const items = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!);
    const kept = items.filter((tag) => !isReviewPendingTag(tag));
    if (kept.length === items.length) return whole;
    return `${open}${kept.map((tag) => `"${tag}"`).join(', ')}${close}`;
  });
}

/**
 * Set a `.dql` source's lifecycle status. Certifying also removes the
 * review-pending tag, so a block certified through any surface is one Ask
 * serves as certified, never one it silently skips as contradictory.
 */
export function withBlockStatus(source: string, status: string): string {
  const next = /status\s*=\s*"[^"]*"/.test(source)
    ? source.replace(/status\s*=\s*"[^"]*"/, `status = "${status}"`)
    : source.replace(/block\s+"[^"]*"\s*\{/, (match) => `${match}\n  status = "${status}"`);
  return status === 'certified' ? withoutReviewPendingTags(next) : next;
}

/** The fingerprint a receipt records; `@zlens/core` compares it with the file on disk. */
export function sourceSha256(source: string): string {
  return certifiedSourceSha256(source);
}

export function buildCertificationReceipt(input: {
  source: string;
  certifiedBy: string | undefined | null;
  certifiedByName?: string | undefined | null;
  via: CertificationSurface;
  enterprise?: boolean;
  checks?: string[];
  warnings?: string[];
  branch?: string;
  now?: Date;
}): CertificationReceipt {
  const certifiedBy = input.certifiedBy?.trim() || 'local';
  const certifiedByName = input.certifiedByName?.replace(/[\r\n]/g, ' ').trim();
  return {
    certifiedBy,
    ...(certifiedByName && certifiedByName !== certifiedBy ? { certifiedByName } : {}),
    certifiedAt: (input.now ?? new Date()).toISOString(),
    via: input.via,
    rules: input.enterprise ? 'enterprise' : 'oss',
    sourceSha256: sourceSha256(input.source),
    ...(input.checks && input.checks.length > 0 ? { checks: Array.from(new Set(input.checks)) } : {}),
    ...(input.warnings && input.warnings.length > 0 ? { warnings: Array.from(new Set(input.warnings)) } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
}

const CHECKLIST_LABELS: Record<string, string> = {
  metadata: 'metadata',
  validation: 'validation',
  run: 'run',
  tests: 'tests',
  chart: 'chart',
  lineage: 'lineage',
  aiReviewed: 'ai-reviewed',
};

/** Names of the checks a Block Studio certification checklist passed, for the receipt. */
export function passedCheckNames(checklist: unknown): string[] {
  if (!checklist || typeof checklist !== 'object') return [];
  const record = checklist as Record<string, unknown>;
  return Object.entries(CHECKLIST_LABELS)
    .filter(([key]) => record[key] === true)
    .map(([, label]) => label);
}

/**
 * Remove a top-level YAML key and every indented line that belongs to it.
 * The companion files are written by ZLens with two-space indentation, so a
 * line-based edit keeps the rest of the hand-readable file untouched.
 */
/** The companion's top-level `tags:` list without the review-pending lifecycle tag. */
function withoutCompanionReviewPendingTags(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  let inTags = false;
  return lines.filter((line) => {
    if (/^\S/.test(line)) inTags = /^tags:\s*$/.test(line);
    if (!inTags) return true;
    const item = /^\s+-\s+["']?(.*?)["']?\s*$/.exec(line);
    return !(item && isReviewPendingTag(item[1]!));
  }).join('\n');
}

function removeTopLevelKey(yaml: string, key: string): string {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      if (line.trim() === '' || /^\s/.test(line)) continue;
      skipping = false;
    }
    if (new RegExp(`^${key}:(\\s|$)`).test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Write the companion's lifecycle so it always agrees with the `.dql` source:
 * `reviewStatus` mirrors the block's status. The `certification` receipt is
 * written while the block is certified; a deprecated block keeps the receipt
 * it had (passed in, else the one already in `companion`) beside its
 * `deprecation` record. Draft and review hold neither.
 *
 * Every reader trusts a receipt only while `reviewStatus` is certified, so a
 * receipt kept on a deprecated block is history, never a claim.
 */
export function applyCompanionCertification(
  companion: string,
  status: BlockLifecycleStatus,
  receipt: CertificationReceipt | null | undefined,
  deprecation?: DeprecationRecord | null,
): string {
  const keptReceipt = status === 'deprecated' ? receipt ?? readCompanionCertification(companion) : null;
  const keptDeprecation = status === 'deprecated' ? deprecation ?? readCompanionDeprecation(companion) : null;
  // A certified block that goes back to draft or review keeps who certified
  // it and when, so every surface can say "Changed since it was certified on
  // 22 Oct" (T4). Certifying again replaces it with the new receipt.
  const keptPrevious = status === 'draft' || status === 'review'
    ? previousFromReceipt(readCompanionCertification(companion)) ?? readCompanionPreviousCertification(companion)
    : null;
  let next = removeTopLevelKey(removeTopLevelKey(removeTopLevelKey(removeTopLevelKey(companion, 'reviewStatus'), 'certification'), 'deprecation'), 'previousCertification').trimEnd();
  if (status === 'certified') next = withoutCompanionReviewPendingTags(next);
  next += `\nreviewStatus: ${status}\n`;
  if (status === 'certified' && receipt) {
    next += dumpYaml({ certification: receipt }, { lineWidth: 200, noRefs: true });
  }
  if (keptReceipt) next += dumpYaml({ certification: keptReceipt }, { lineWidth: 200, noRefs: true });
  if (keptDeprecation) next += dumpYaml({ deprecation: keptDeprecation }, { lineWidth: 200, noRefs: true });
  if (keptPrevious) next += dumpYaml({ previousCertification: keptPrevious }, { lineWidth: 200, noRefs: true });
  return next.endsWith('\n') ? next : `${next}\n`;
}

/**
 * Who certified a block before it changed, and when: what a companion keeps
 * after a certified block went back to draft or review. History only — no
 * reader treats it as a certification.
 */
export interface PreviousCertificationRecord {
  certifiedBy: string;
  certifiedByName?: string;
  certifiedAt: string;
}

function previousFromReceipt(receipt: CertificationReceipt | null): PreviousCertificationRecord | null {
  if (!receipt) return null;
  return {
    certifiedBy: receipt.certifiedBy,
    ...(receipt.certifiedByName ? { certifiedByName: receipt.certifiedByName } : {}),
    certifiedAt: receipt.certifiedAt,
  };
}

/** The `previousCertification` record a companion YAML holds, when it holds a valid one. */
export function readCompanionPreviousCertification(companion: string | null | undefined): PreviousCertificationRecord | null {
  if (!companion) return null;
  try {
    const parsed = loadYaml(companion) as { previousCertification?: Record<string, unknown> } | null;
    const record = parsed?.previousCertification;
    if (!record || typeof record !== 'object' || typeof record.certifiedBy !== 'string') return null;
    const at = record.certifiedAt as unknown;
    if (at === undefined || at === null) return null;
    return {
      certifiedBy: record.certifiedBy,
      ...(typeof record.certifiedByName === 'string' && record.certifiedByName.trim() ? { certifiedByName: record.certifiedByName.trim() } : {}),
      certifiedAt: at instanceof Date ? at.toISOString() : String(at),
    };
  } catch {
    return null;
  }
}

/** The deprecation record a companion YAML holds, when it holds a valid one. */
export function readCompanionDeprecation(companion: string | null | undefined): DeprecationRecord | null {
  if (!companion) return null;
  try {
    const parsed = loadYaml(companion) as { deprecation?: Partial<DeprecationRecord> } | null;
    const record = parsed?.deprecation;
    if (!record || typeof record !== 'object' || typeof record.deprecatedBy !== 'string') return null;
    const deprecatedAt = record.deprecatedAt as unknown;
    if (deprecatedAt === undefined) return null;
    const previous = record.previousStatus;
    return {
      deprecatedBy: record.deprecatedBy,
      deprecatedAt: deprecatedAt instanceof Date ? deprecatedAt.toISOString() : String(deprecatedAt),
      via: (record.via ?? 'block-studio') as CertificationSurface,
      previousStatus: previous === 'certified' || previous === 'review' || previous === 'deprecated' ? previous : 'draft',
    };
  } catch {
    return null;
  }
}

/** The certification receipt a companion YAML holds, when it holds a valid one. */
export function readCompanionCertification(companion: string | null | undefined): CertificationReceipt | null {
  if (!companion) return null;
  try {
    const parsed = loadYaml(companion) as { certification?: Partial<CertificationReceipt> } | null;
    const receipt = parsed?.certification;
    if (!receipt || typeof receipt !== 'object') return null;
    if (typeof receipt.certifiedBy !== 'string' || typeof receipt.certifiedAt !== 'string') return null;
    const certifiedAt = receipt.certifiedAt as unknown;
    return {
      certifiedBy: receipt.certifiedBy,
      ...(typeof receipt.certifiedByName === 'string' && receipt.certifiedByName.trim() ? { certifiedByName: receipt.certifiedByName.trim() } : {}),
      certifiedAt: certifiedAt instanceof Date ? certifiedAt.toISOString() : String(certifiedAt),
      via: (receipt.via ?? 'block-studio') as CertificationSurface,
      rules: receipt.rules === 'enterprise' ? 'enterprise' : 'oss',
      sourceSha256: typeof receipt.sourceSha256 === 'string' ? receipt.sourceSha256 : '',
      ...(Array.isArray(receipt.checks) ? { checks: receipt.checks.map(String) } : {}),
      ...(Array.isArray(receipt.warnings) ? { warnings: receipt.warnings.map(String) } : {}),
      ...(typeof receipt.branch === 'string' && receipt.branch.trim() ? { branch: receipt.branch.trim() } : {}),
    };
  } catch {
    return null;
  }
}

/** The git branch checked out at the project, if any. Never throws. */
export function currentGitBranch(projectRoot: string): string | undefined {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort git `user.name` (project first, then global): the display name
 * a local certification records, so "Certified by" names a person rather
 * than an email address. Never throws.
 */
export function gitUserName(projectRoot: string): string | undefined {
  const run = (args: string[]): string | undefined => {
    try {
      const out = execFileSync('git', args, { cwd: projectRoot, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  };
  return run(['config', 'user.name']) ?? run(['config', '--global', 'user.name']);
}

function gitConfig(projectRoot: string, key: string): string | undefined {
  const run = (args: string[]): string | undefined => {
    try {
      const out = execFileSync('git', args, { cwd: projectRoot, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  };
  return run(['config', key]) ?? run(['config', '--global', key]);
}

/**
 * The identity a certification or a check made at this machine records: the
 * person's own git `user.email`, else `$USER@local`. Never the project's
 * `identity.owner` (B6): a sample project ships an owner of its own
 * ("analytics@jaffle.shop"), and recording it would put someone else's name
 * on the person's certification. Under a host the signed-in person is used
 * instead (the caller checks that first).
 */
export function localPersonIdentity(projectRoot: string): string {
  const user = process.env.USER?.trim() || process.env.USERNAME?.trim();
  return gitConfig(projectRoot, 'user.email') ?? (user ? `${user}@local` : 'local');
}

/** Identities that name no person: a record written before ZLens knew who did it. */
const ANONYMOUS_IDENTITIES = new Set(['local', 'owner@local', 'guest@local', 'analyst@local', 'unknown', 'anonymous']);

/**
 * The person's own identities at this machine: git `user.email` and
 * `$USER@local`. Only these make a record "by you" (B6) — never the project's
 * `identity.owner`, which a shared or sample project sets to someone else.
 * Lower-cased.
 */
export function localPersonSelf(projectRoot: string): Set<string> {
  const user = process.env.USER?.trim() || process.env.USERNAME?.trim();
  return new Set([
    gitConfig(projectRoot, 'user.email'),
    user ? `${user}@local` : undefined,
  ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim().toLowerCase()));
}

/**
 * The identities that read as this machine's person by their display name
 * (one person, one name): their own identities, the local owner cache, and
 * the generic local owners. Lower-cased; empty under a host, where each record
 * names its own person. The project's `identity.owner` is not one of them
 * (B6): in a sample project it is someone else.
 */
export function localPersonAliases(projectRoot: string, recordedOwner?: string): Set<string> {
  let cachedOwner: string | undefined;
  try {
    cachedOwner = readFileSync(join(projectRoot, '.dql', 'local', 'owner'), 'utf-8').trim() || undefined;
  } catch {
    cachedOwner = undefined;
  }
  return new Set([
    recordedOwner,
    cachedOwner,
    ...localPersonSelf(projectRoot),
    'owner@local', 'guest@local', 'analyst@local', 'local',
  ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim().toLowerCase()));
}

/**
 * One name for one person on every App surface (the same rule as "Certified
 * by", D5): an identity that is this machine's person reads as their display
 * name (git user.name), never as three spellings (git name, a noreply email,
 * "Kranthi@local"). Someone else's identity is shown as recorded.
 */
export function personDisplayName(identity: string | null | undefined, person: { name?: string; aliases: ReadonlySet<string> }): string | undefined {
  const value = identity?.trim();
  if (!value) return undefined;
  return person.name && person.aliases.has(value.toLowerCase()) ? person.name : value;
}

/** Who certified a block and when, as every App surface shows it (D5). */
export interface CertificationByline {
  /** The recorded identity ("local" when none was known). */
  by?: string;
  /** The display name, when one was recorded. */
  name?: string;
  /** ISO-8601 time of certification. */
  at?: string;
  /** Checks that passed, by checklist name or as plain sentences. */
  checks?: string[];
  /** The person viewing is the person recorded: "Certified by you" (design Q1). */
  byYou?: boolean;
}

/**
 * Whether a recorded identity is the person viewing: one of their own
 * identities (git user.email, `$USER@local`, or the host's signed-in person),
 * never the project's configured owner or a placeholder (B6).
 */
export function isViewer(identity: string | null | undefined, person: { aliases: ReadonlySet<string>; self?: ReadonlySet<string> }): boolean {
  const value = identity?.trim().toLowerCase();
  // A placeholder names nobody, so it is nobody's "you" (B6).
  if (!value || ANONYMOUS_IDENTITIES.has(value)) return false;
  return (person.self ?? person.aliases).has(value);
}

/** A byline as the viewer reads it: `byYou` when they are the person it names. */
export function bylineForViewer<Byline extends CertificationByline>(byline: Byline, person: { aliases: ReadonlySet<string>; self?: ReadonlySet<string> }): Byline {
  return isViewer(byline.by, person) ? { ...byline, byYou: true } : byline;
}

/**
 * The record "Check and use" writes (design Q1): who checked the data, when,
 * what the check found, for exactly which source. It is not a certification.
 */
export function buildCheckRecord(input: {
  source: string;
  checkedBy: string | undefined | null;
  checkedByName?: string | undefined | null;
  checks?: string[];
  hiddenColumns?: BlockCheckRecord['hiddenColumns'];
  now?: Date;
}): BlockCheckRecord {
  const checkedBy = input.checkedBy?.trim() || 'local';
  const checkedByName = input.checkedByName?.replace(/[\r\n]/g, ' ').trim();
  return {
    checkedBy,
    ...(checkedByName && checkedByName !== checkedBy ? { checkedByName } : {}),
    checkedAt: (input.now ?? new Date()).toISOString(),
    sourceSha256: sourceSha256(input.source),
    ...(input.checks?.length ? { checks: Array.from(new Set(input.checks)) } : {}),
    ...(input.hiddenColumns?.length ? { hiddenColumns: input.hiddenColumns } : {}),
  };
}

/** The companion YAML with its `check:` record replaced (or removed, with null). */
export function applyCompanionCheck(companion: string, check: BlockCheckRecord | null): string {
  let next = removeTopLevelKey(companion, 'check').trimEnd();
  next += '\n';
  if (check) next += dumpYaml({ check }, { lineWidth: 200, noRefs: true });
  return next.endsWith('\n') ? next : `${next}\n`;
}

/** Who checked a check record and when, for "Checked by you · 22 Oct". */
export function checkByline(check: Pick<BlockCheckRecord, 'checkedBy' | 'checkedByName' | 'checkedAt' | 'checks'>): CertificationByline {
  return {
    by: check.checkedBy,
    ...(check.checkedByName ? { name: check.checkedByName } : {}),
    at: check.checkedAt,
    ...(check.checks?.length ? { checks: check.checks } : {}),
  };
}

/** The byline of a receipt, for the browser. */
export function certificationByline(receipt: CertificationReceipt): CertificationByline {
  return {
    by: receipt.certifiedBy,
    ...(receipt.certifiedByName ? { name: receipt.certifiedByName } : {}),
    at: receipt.certifiedAt,
    ...(receipt.checks?.length ? { checks: receipt.checks } : {}),
  };
}

/**
 * Who certified a block that is no longer certified as it stands, and when:
 * a certified file edited after it was certified (its receipt's sha256 no
 * longer matches the source), or a block that went back to draft or review
 * and kept a `previousCertification` record. Null for a block that is
 * certified as it stands, or was never certified (T4: "Changed since it was
 * certified on 22 Oct").
 */
export function blockPreviousCertificationByline(projectRoot: string, blockPath: string | undefined | null): CertificationByline | null {
  if (!blockPath) return null;
  try {
    const absolute = join(projectRoot, blockPath);
    if (!existsSync(absolute)) return null;
    const source = readFileSync(absolute, 'utf-8');
    const companionPath = blockCompanionRelativePath(projectRoot, blockPath);
    const companion = companionPath && existsSync(join(projectRoot, companionPath)) ? readFileSync(join(projectRoot, companionPath), 'utf-8') : null;
    const status = blockSourceStatus(source);
    if (status === 'certified') {
      if (certifiedSourceState(source, companion) !== 'changed') return null;
      const receipt = readCompanionCertification(companion);
      return receipt ? { by: receipt.certifiedBy, ...(receipt.certifiedByName ? { name: receipt.certifiedByName } : {}), at: receipt.certifiedAt } : null;
    }
    if (status === 'deprecated') return null;
    const previous = readCompanionPreviousCertification(companion);
    return previous ? { by: previous.certifiedBy, ...(previous.certifiedByName ? { name: previous.certifiedByName } : {}), at: previous.certifiedAt } : null;
  } catch {
    return null;
  }
}

/**
 * The source with its owner set (`owner = "…"`): replaced when declared,
 * else written on the line after the `block "…" {` header. Certifying needs
 * an owner; the inline review asks for one when the source has none.
 */
export function withBlockOwner(source: string, owner: string): string {
  const value = owner.replace(/[\r\n]/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (!value) return source;
  if (/^\s*owner\s*=\s*"[^"]*"/m.test(source)) return source.replace(/^(\s*owner\s*=\s*)"[^"]*"/m, (_whole, lead: string) => `${lead}"${value}"`);
  return source.replace(/(block\s+"[^"]*"\s*\{)/, (match) => `${match}\n  owner = "${value}"`);
}

/**
 * Who certified a certified block file and when, read from its companion
 * receipt; `{}` for a block certified before receipts were recorded, and
 * null when the block is not certified or cannot be read.
 */
export function blockCertificationByline(projectRoot: string, blockPath: string | undefined | null): CertificationByline | null {
  if (!blockPath) return null;
  try {
    const absolute = join(projectRoot, blockPath);
    if (!existsSync(absolute)) return null;
    if (blockSourceStatus(readFileSync(absolute, 'utf-8')) !== 'certified') return null;
    const companionPath = blockCompanionRelativePath(projectRoot, blockPath);
    const companion = companionPath && existsSync(join(projectRoot, companionPath)) ? readFileSync(join(projectRoot, companionPath), 'utf-8') : null;
    const receipt = readCompanionCertification(companion);
    return receipt ? certificationByline(receipt) : {};
  } catch {
    return null;
  }
}
