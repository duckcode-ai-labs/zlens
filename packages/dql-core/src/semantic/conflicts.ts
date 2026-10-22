/**
 * Cross-artifact trust-conflict detection (compile time).
 *
 * The most dangerous governance failure is two *certified* definitions that
 * claim the SAME concept/grain but DISAGREE — e.g. two terms named the same
 * business concept, sharing an identifier and grain, but with divergent
 * business rules or definitions. Without detection the agent would silently
 * pick one. This pass flags such pairs as `kind: 'conflict'` diagnostics so a
 * governed system can refuse to guess and ask a human to pick the winner.
 *
 * This is a *manifest-level* (cross-file) check: the per-file semantic analyzer
 * cannot see two files at once, so this operates on the assembled term/block
 * maps. It is re-exported from `semantic/analyzer.ts` and invoked by the
 * manifest builder after blocks/terms are scanned.
 *
 * Heuristics are deliberately CONSERVATIVE to avoid false positives:
 *   - Both sides must be governance-grade (terms: status certified/approved or
 *     no status; certified blocks only).
 *   - They must claim the SAME concept: a shared, normalized identifier AND the
 *     same grain (when both declare a grain).
 *   - They must DIVERGE: different normalized definition OR different business
 *     rules. Two artifacts that agree are NOT a conflict, and the same artifact
 *     compared with itself is never a conflict.
 */

import type {
  ManifestBlock,
  ManifestConflictDetail,
  ManifestDiagnostic,
  ManifestTerm,
} from '../manifest/types.js';

/** Normalize free text for divergence comparison (case/space/punctuation-insensitive). */
function normalizeText(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalize an identifier/grain token for equality comparison. Underscores are
 * preserved (they are part of identifier tokens like `active_customer`); other
 * separators collapse to a single space.
 */
function normalizeKey(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Stable, order-insensitive fingerprint of a business-rules list. */
function rulesFingerprint(rules: string[] | undefined): string {
  if (!rules || rules.length === 0) return '';
  return rules
    .map((rule) => normalizeText(rule))
    .filter(Boolean)
    .sort()
    .join('||');
}

/**
 * The set of normalized identifiers an artifact claims. For terms this is the
 * declared `identifiers`; for blocks the declared `grain`/`entities` act as the
 * concept anchor. Includes the (normalized) name as a weak identifier so two
 * same-named certified definitions are comparable even when identifiers are
 * sparse.
 */
function termIdentifierSet(term: ManifestTerm): Set<string> {
  const ids = new Set<string>();
  for (const id of term.identifiers ?? []) {
    const norm = normalizeKey(id);
    if (norm) ids.add(norm);
  }
  const name = normalizeKey(term.name);
  if (name) ids.add(`name:${name}`);
  return ids;
}

function blockIdentifierSet(block: ManifestBlock): Set<string> {
  const ids = new Set<string>();
  for (const entity of block.entities ?? []) {
    const norm = normalizeKey(entity);
    if (norm) ids.add(norm);
  }
  if (block.grain) {
    const norm = normalizeKey(block.grain);
    if (norm) ids.add(`grain:${norm}`);
  }
  const name = normalizeKey(block.name);
  if (name) ids.add(`name:${name}`);
  return ids;
}

function sharedIdentifier(a: Set<string>, b: Set<string>): string | undefined {
  for (const id of a) {
    if (b.has(id)) return id;
  }
  return undefined;
}

/** A term counts as governance-grade unless explicitly marked draft/deprecated. */
function isGovernedTerm(term: ManifestTerm): boolean {
  const status = term.status?.toLowerCase();
  return status !== 'draft' && status !== 'deprecated' && status !== 'archived';
}

function isCertifiedBlock(block: ManifestBlock): boolean {
  const status = block.status?.toLowerCase();
  return status === 'certified' || status === 'approved';
}

/**
 * Two terms conflict when they share an identifier and (when both declare one)
 * the same grain, but their definitions or business rules diverge. We compare
 * the `description` as the term's definition.
 */
function termsConflict(a: ManifestTerm, b: ManifestTerm): { concept: string; reason: string } | null {
  const shared = sharedIdentifier(termIdentifierSet(a), termIdentifierSet(b));
  if (!shared) return null;

  // If both declare identifiers but none overlap beyond the name, require a
  // real (non-name) shared identifier to stay conservative.
  const aHasIds = (a.identifiers ?? []).length > 0;
  const bHasIds = (b.identifiers ?? []).length > 0;
  if (aHasIds && bHasIds && shared.startsWith('name:')) {
    const realShared = sharedIdentifier(
      new Set([...termIdentifierSet(a)].filter((id) => !id.startsWith('name:'))),
      new Set([...termIdentifierSet(b)].filter((id) => !id.startsWith('name:'))),
    );
    if (!realShared) return null;
  }

  const defA = normalizeText(a.description);
  const defB = normalizeText(b.description);
  const rulesA = rulesFingerprint(a.businessRules);
  const rulesB = rulesFingerprint(b.businessRules);

  // Need at least one concrete divergence signal; if both sides are empty of
  // definitions AND rules, we cannot claim divergence — stay silent.
  const hasComparable = Boolean(defA || defB || rulesA || rulesB);
  if (!hasComparable) return null;

  const definitionDiverges = Boolean(defA && defB && defA !== defB);
  const rulesDiverge = Boolean(rulesA && rulesB && rulesA !== rulesB);
  if (!definitionDiverges && !rulesDiverge) return null;

  const concept = shared.replace(/^name:/, '');
  const reasonParts: string[] = [];
  if (definitionDiverges) reasonParts.push('definitions differ');
  if (rulesDiverge) reasonParts.push('business rules differ');
  return {
    concept,
    reason: `Both terms claim "${concept}" but ${reasonParts.join(' and ')}.`,
  };
}

/**
 * Two certified blocks conflict when they share a concept anchor (entity or
 * grain) and the same grain, but their SQL semantics or business rules diverge.
 */
function blocksConflict(a: ManifestBlock, b: ManifestBlock): { concept: string; reason: string } | null {
  const shared = sharedIdentifier(blockIdentifierSet(a), blockIdentifierSet(b));
  if (!shared) return null;

  // Require the SAME grain when both declare one (conservative: differing grain
  // is a legitimate different question, not a conflict).
  if (a.grain && b.grain && normalizeKey(a.grain) !== normalizeKey(b.grain)) return null;

  // A purely name-based overlap between two arbitrary blocks is too weak; need
  // a shared business entity or grain to anchor the concept.
  if (shared.startsWith('name:')) {
    const anchored = sharedIdentifier(
      new Set([...blockIdentifierSet(a)].filter((id) => !id.startsWith('name:'))),
      new Set([...blockIdentifierSet(b)].filter((id) => !id.startsWith('name:'))),
    );
    if (!anchored) return null;
  }

  const sqlA = normalizeText(a.sql);
  const sqlB = normalizeText(b.sql);
  const rulesA = rulesFingerprint(a.businessRules);
  const rulesB = rulesFingerprint(b.businessRules);

  const hasComparable = Boolean(sqlA || sqlB || rulesA || rulesB);
  if (!hasComparable) return null;

  const sqlDiverges = Boolean(sqlA && sqlB && sqlA !== sqlB);
  const rulesDiverge = Boolean(rulesA && rulesB && rulesA !== rulesB);
  if (!sqlDiverges && !rulesDiverge) return null;

  const concept = shared.replace(/^(name|grain):/, '');
  const reasonParts: string[] = [];
  if (sqlDiverges) reasonParts.push('SQL semantics differ');
  if (rulesDiverge) reasonParts.push('business rules differ');
  return {
    concept,
    reason: `Both certified saved queries claim "${concept}" but ${reasonParts.join(' and ')}.`,
  };
}

function buildPrompt(objectType: 'term' | 'block', a: string, b: string, concept: string): string {
  return `Two certified ${objectType}s define "${concept}" differently: "${a}" and "${b}". Which one is authoritative? A human must decide; ZLens will not guess.`;
}

/**
 * Detect same-identifier + same-grain + divergent-definition/rule pairs across
 * the manifest's terms and certified blocks, returning additive
 * `kind: 'conflict'` diagnostics. Pairs are compared once (no self-comparison,
 * no duplicate A/B + B/A).
 */
export function detectTrustConflicts(
  terms: Record<string, ManifestTerm>,
  blocks: Record<string, ManifestBlock>,
): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = [];

  const governedTerms = Object.values(terms).filter(isGovernedTerm);
  for (let i = 0; i < governedTerms.length; i += 1) {
    for (let j = i + 1; j < governedTerms.length; j += 1) {
      const a = governedTerms[i];
      const b = governedTerms[j];
      const hit = termsConflict(a, b);
      if (!hit) continue;
      const detail: ManifestConflictDetail = {
        objectType: 'term',
        concept: hit.concept,
        reason: hit.reason,
        prompt: buildPrompt('term', a.name, b.name, hit.concept),
        sides: [termSide(a), termSide(b)],
      };
      diagnostics.push({
        kind: 'conflict',
        filePath: a.filePath,
        severity: 'warning',
        message: `Conflicting certified terms "${a.name}" and "${b.name}": ${hit.reason}`,
        conflict: detail,
      });
    }
  }

  const certifiedBlocks = Object.values(blocks).filter(isCertifiedBlock);
  for (let i = 0; i < certifiedBlocks.length; i += 1) {
    for (let j = i + 1; j < certifiedBlocks.length; j += 1) {
      const a = certifiedBlocks[i];
      const b = certifiedBlocks[j];
      const hit = blocksConflict(a, b);
      if (!hit) continue;
      const detail: ManifestConflictDetail = {
        objectType: 'block',
        concept: hit.concept,
        reason: hit.reason,
        prompt: buildPrompt('block', a.name, b.name, hit.concept),
        sides: [blockSide(a), blockSide(b)],
      };
      diagnostics.push({
        kind: 'conflict',
        filePath: a.filePath,
        severity: 'warning',
        message: `Conflicting certified saved queries "${a.name}" and "${b.name}": ${hit.reason}`,
        conflict: detail,
      });
    }
  }

  return diagnostics;
}

function termSide(term: ManifestTerm): ManifestConflictDetail['sides'][number] {
  return {
    name: term.name,
    filePath: term.filePath,
    owner: term.owner ?? term.businessOwner,
    domain: term.domain,
    definition: term.description,
    businessRules: term.businessRules,
  };
}

function blockSide(block: ManifestBlock): ManifestConflictDetail['sides'][number] {
  return {
    name: block.name,
    filePath: block.filePath,
    owner: block.owner ?? block.businessOwner,
    domain: block.domain,
    definition: block.description,
    businessRules: block.businessRules,
  };
}
