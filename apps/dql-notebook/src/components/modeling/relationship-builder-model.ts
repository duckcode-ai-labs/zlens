import type { ManifestModelRelationship, ManifestRelationshipValidationEvidence } from '@zlens/core';

/**
 * The relationship builder in plain words.
 *
 * A relationship is read as a sentence ("Each order belongs to one customer"),
 * saved at one of three levels that say what Ask does with it, and checked in
 * the warehouse before it can be more than a draft. Everything here is pure so
 * the wording and the save rules are tested, not eyeballed.
 */

export type RelationshipCardinality = ManifestModelRelationship['cardinality'];
export type RelationshipLevel = 'draft' | 'validated' | 'certified';
export type RelationshipEvidence = ManifestRelationshipValidationEvidence;

export const CARDINALITY_CHOICES: Array<{ value: RelationshipCardinality; label: string }> = [
  { value: 'many_to_one', label: 'belongs to one' },
  { value: 'one_to_many', label: 'can have many' },
  { value: 'one_to_one', label: 'matches exactly one' },
  { value: 'many_to_many', label: 'matches many (not safe to join)' },
];

export const RELATIONSHIP_LEVELS: Array<{ value: RelationshipLevel; label: string; meaning: string }> = [
  { value: 'draft', label: 'Draft', meaning: 'Ask sees it as a hint only.' },
  { value: 'validated', label: 'Validated', meaning: 'Checked safe to join. Ask prefers it when it writes SQL.' },
  { value: 'certified', label: 'Certified', meaning: 'Ask must join these models on exactly these keys.' },
];

export function relationshipSentence(cardinality: RelationshipCardinality, fromName: string, toName: string): string {
  switch (cardinality) {
    case 'many_to_one': return `Each ${fromName} belongs to one ${toName}.`;
    case 'one_to_many': return `Each ${fromName} can have many ${toName} rows.`;
    case 'one_to_one': return `Each ${fromName} matches exactly one ${toName}.`;
    case 'many_to_many': return `${fromName} and ${toName} match many-to-many, so joining them multiplies rows.`;
    default: return `${fromName} relates to ${toName}.`;
  }
}

/** Fanout follows from cardinality: every join except many-to-many keeps each row once. */
export function fanoutForCardinality(cardinality: RelationshipCardinality): 'safe' | 'forbidden' | 'unknown' {
  if (cardinality === 'many_to_many') return 'forbidden';
  if (cardinality === 'unknown') return 'unknown';
  return 'safe';
}

const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * A short, readable id (`orders_to_customers`) that never collides: a second
 * relationship between the same models gets `_2`. Ids used to embed the full
 * qualified keys, and a second relationship silently overwrote the first.
 */
export function nextRelationshipLocalId(fromLocalId: string, toLocalId: string, takenIds: Iterable<string>): string {
  const taken = new Set([...takenIds].map((id) => id.toLowerCase()));
  const base = `${slug(fromLocalId) || 'model'}_to_${slug(toLocalId) || 'model'}`;
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface RelationshipStatusView {
  level: RelationshipLevel | 'stale' | 'retired';
  label: string;
  meaning: string;
  color: string;
}

/** The one badge a relationship shows everywhere: canvas edge, legend, inspector, popover. */
export function relationshipStatusView(relationship: Pick<ManifestModelRelationship, 'status' | 'automaticJoinAllowed' | 'validation'> & Partial<Pick<ManifestModelRelationship, 'certificationFingerprint'>>): RelationshipStatusView {
  if (relationship.status === 'deprecated') return { level: 'retired', label: 'Retired', meaning: 'Ask ignores this relationship.', color: 'var(--text-tertiary)' };
  if (relationship.status === 'certified') {
    if (relationship.automaticJoinAllowed) return { level: 'certified', label: 'Certified', meaning: 'Ask must join these models on exactly these keys.', color: '#2e9b63' };
    const meaning = relationship.validation?.status === 'passed' && !relationship.certificationFingerprint
      ? 'Certified without the grain and key columns of both models, so Ask treats it as a hint. Set them in each model\'s settings, then certify it again.'
      : 'Certified, but its warehouse check is missing, stale or failed, or a model\'s grain or keys changed. Ask treats it as a hint until it is checked again.';
    return { level: 'stale', label: 'Needs recheck', meaning, color: '#d47822' };
  }
  // A draft keeps reading Draft after its warehouse check passed, the level
  // the editor opens on (B6): the badge never claims more than the editor.
  if (relationship.validation?.status === 'passed' && relationship.status !== 'draft') return { level: 'validated', label: 'Validated', meaning: 'Checked safe to join. Ask prefers it when it writes SQL.', color: '#5b73d6' };
  if (relationship.validation?.status === 'passed') return { level: 'draft', label: 'Draft', meaning: 'Checked in the warehouse, but nobody reviewed it yet. Ask sees it as a hint only.', color: '#9a6b2f' };
  return { level: 'draft', label: 'Draft', meaning: 'Not checked in the warehouse. Ask sees it as a hint only.', color: '#9a6b2f' };
}

export const RELATIONSHIP_LEGEND: Array<{ label: string; color: string }> = [
  { label: 'Certified', color: '#2e9b63' },
  { label: 'Validated', color: '#5b73d6' },
  { label: 'Draft', color: '#9a6b2f' },
  { label: 'Needs recheck', color: '#d47822' },
];

export function levelOfRelationship(relationship?: Pick<ManifestModelRelationship, 'status' | 'validation'>): RelationshipLevel {
  if (!relationship) return 'draft';
  if (relationship.status === 'certified') return 'certified';
  if (relationship.validation?.status === 'passed' && relationship.status !== 'draft') return 'validated';
  return 'draft';
}

export function lifecycleForLevel(level: RelationshipLevel): 'draft' | 'reviewed' | 'certified' {
  return level === 'certified' ? 'certified' : level === 'validated' ? 'reviewed' : 'draft';
}

/** What a warehouse check was run against. A check for other keys, cardinality or fanout is not evidence for this one. */
export function proofSignature(input: { from: string; to: string; keys: Array<{ from: string; to: string }>; cardinality: RelationshipCardinality; fanout?: string }): string {
  return JSON.stringify([input.from, input.to, input.keys.map((key) => [key.from.toLowerCase(), key.to.toLowerCase()]), input.cardinality, input.fanout ?? fanoutForCardinality(input.cardinality)]);
}

/** Why the chosen level cannot be saved yet, in plain words. Empty means it can. */
export function relationshipSaveBlockers(input: {
  level: RelationshipLevel;
  keysComplete: boolean;
  evidence?: RelationshipEvidence;
  evidenceSignature?: string;
  currentSignature: string;
  fromName: string;
  toName: string;
  fromGrain?: string;
  toGrain?: string;
  fromKeys?: string[];
  toKeys?: string[];
}): string[] {
  const blockers: string[] = [];
  if (!input.keysComplete) blockers.push('Choose the matching column on both sides.');
  if (input.level !== 'draft') {
    if (!input.evidence || input.evidenceSignature !== input.currentSignature) blockers.push('Run the warehouse check for these keys first.');
    else if (input.evidence.status !== 'passed') blockers.push('The warehouse check did not pass, so this can only be saved as a draft.');
  }
  if (input.level === 'certified') {
    // Certification records both models' grain and key columns so a later dbt
    // change is detected; without them the certificate cannot bind Ask.
    const missing = [
      !input.fromGrain || !input.fromKeys?.length ? input.fromName : null,
      !input.toGrain || !input.toKeys?.length ? input.toName : null,
    ].filter(Boolean);
    if (missing.length) blockers.push(`Certifying needs the grain and key columns of ${missing.join(' and ')}: what one row means and which columns identify it. Set them in the model's settings first.`);
  }
  return blockers;
}

const relationKey = (relation: string) => relation.replace(/["`\[\]]/g, '').toLowerCase().split('.').filter(Boolean).slice(-2);

/** The model on the map that reads a warehouse relation, matched on schema and table (a bare table matches on the table). */
export function entityForRelation(
  entities: Record<string, { dbtUniqueId: string }>,
  nodes: Record<string, { relation?: string } | undefined>,
  relation: string,
): string | undefined {
  const wanted = relationKey(relation);
  const matches = Object.entries(entities).filter(([, entity]) => {
    const actual = relationKey(nodes[entity.dbtUniqueId]?.relation ?? '');
    if (!actual.length || !wanted.length) return false;
    if (actual.length === 2 && wanted.length === 2) return actual[0] === wanted[0] && actual[1] === wanted[1];
    return actual.at(-1) === wanted.at(-1);
  });
  return matches.length === 1 ? matches[0]![0] : undefined;
}

/**
 * A join an answer made, as a relationship draft: the two models on the map
 * and the first key pair. Relations nobody put on the map are named so the
 * page can say what to add first.
 */
export function relationshipDraftFromJoin(
  join: { relations: string[]; keys: Array<{ from: string; to: string }> },
  entities: Record<string, { dbtUniqueId: string }>,
  nodes: Record<string, { relation?: string } | undefined>,
): { draft?: { from: string; to: string; fromColumn?: string; toColumn?: string }; missing: string[] } {
  const [fromRelation = '', toRelation = ''] = join.relations;
  const from = entityForRelation(entities, nodes, fromRelation);
  const to = entityForRelation(entities, nodes, toRelation);
  const missing = [!from ? fromRelation : '', !to ? toRelation : ''].filter(Boolean);
  if (!from || !to) return { missing };
  const key = join.keys[0];
  return { draft: { from, to, ...(key ? { fromColumn: key.from, toColumn: key.to } : {}) }, missing: [] };
}

function percentMatched(matched: number, total: number): string {
  if (total <= 0) return '0';
  const ratio = matched / total;
  // Never round a partial match up to 100%.
  const value = ratio < 1 ? Math.floor(ratio * 1000) / 10 : 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The warehouse check as short sentences a person can act on. */
export function relationshipProfileLines(evidence: RelationshipEvidence, fromName: string, toName: string): string[] {
  const lines: string[] = [];
  const matched = Math.max(0, evidence.fromRows - evidence.unmatchedFrom);
  lines.push(evidence.unmatchedFrom === 0
    ? `Every ${fromName} row finds a ${toName}.`
    : `${percentMatched(matched, evidence.fromRows)}% of ${fromName} rows find a ${toName} (${evidence.unmatchedFrom.toLocaleString()} don't).`);
  if (evidence.fromNullKeys > 0) lines.push(`${evidence.fromNullKeys.toLocaleString()} ${fromName} row${evidence.fromNullKeys === 1 ? ' has' : 's have'} an empty key.`);
  const times = (count: number) => (count <= 1 ? 'once' : `up to ${count.toLocaleString()} times`);
  lines.push(`Each ${toName} key appears ${times(evidence.maxToPerKey)}; each ${fromName} key appears ${times(evidence.maxFromPerKey)}.`);
  if (evidence.joinedRows > evidence.fromRows && evidence.fromRows > 0) {
    lines.push(`Joining turns ${evidence.fromRows.toLocaleString()} ${fromName} rows into ${evidence.joinedRows.toLocaleString()}: totals would be counted more than once.`);
  }
  return lines;
}
