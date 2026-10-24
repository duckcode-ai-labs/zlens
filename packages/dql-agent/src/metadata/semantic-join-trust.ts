/**
 * May a semantic compile be labelled Governed ("From Metrics")?
 *
 * The compiler reads only governed metrics and dimensions, but the joins it
 * takes come from the semantic models (dbt entities), not from the DQL
 * relationship model. A compile is Governed only when every join it takes is a
 * DQL relationship that passes the same executable invariant
 * `resolve_analytical_path` and `explain_relationship_proof` apply
 * (`assessAnalyticalRelationship`: certified, fresh warehouse proof, safe
 * fanout). A join through a draft relationship, or one no relationship
 * models, makes the answer AI-Generated, and the caveat names the join.
 * A single-table compile takes no join and stays Governed.
 */
import type { DQLManifest, ManifestModelRelationship, SemanticJoinStep } from '@zlens/core';
import { parsePhysicalIdentifier } from '../ask-pipeline/physical-binding.js';
import { assessAnalyticalRelationship } from './analytical-policy.js';

export interface SemanticJoinProof {
  /** The tables joined, as the semantic model names them. */
  from: string;
  to: string;
  keys: Array<{ from: string; to: string }>;
  /** The DQL relationship this join matched, when one models it. */
  relationshipId?: string;
  relationshipName?: string;
  status?: string;
  certified: boolean;
  reason: string;
}

export interface SemanticJoinTrust {
  /** True when the compile takes no join, or every join is a certified, executable relationship. */
  certified: boolean;
  joins: SemanticJoinProof[];
  /** Names each uncertified join and what would make the compile From Metrics; absent when `certified`. */
  caveat?: string;
}

export function assessSemanticJoinTrust(joinPath: SemanticJoinStep[] | undefined, manifest: DQLManifest | undefined): SemanticJoinTrust {
  const steps = dedupeSteps(joinPath ?? []);
  if (steps.length === 0) return { certified: true, joins: [] };
  const joins = steps.map((step) => proveStep(step, manifest));
  const uncertified = joins.filter((join) => !join.certified);
  if (uncertified.length === 0) return { certified: true, joins };
  return { certified: false, joins, caveat: uncertifiedJoinCaveat(uncertified) };
}

function proveStep(step: SemanticJoinStep, manifest: DQLManifest | undefined): SemanticJoinProof {
  const from = tableLabel(step.leftTable, step.left);
  const to = tableLabel(step.rightTable, step.right);
  const base = { from, to, keys: step.keys };
  const modeling = manifest?.modeling;
  const relationOf = (entityId: string): string | undefined => {
    const entity = modeling?.entities?.[entityId];
    if (!entity) return undefined;
    return entity.relation ?? manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation;
  };
  const candidates: Array<{ relationship: ManifestModelRelationship; reversed: boolean }> = [];
  for (const relationship of Object.values(modeling?.relationships ?? {})) {
    if (relationship.status === 'deprecated') continue;
    const relFrom = relationOf(relationship.from);
    const relTo = relationOf(relationship.to);
    if (!relFrom || !relTo) continue;
    if (sameRelation(relFrom, step.leftTable) && sameRelation(relTo, step.rightTable)) candidates.push({ relationship, reversed: false });
    else if (sameRelation(relFrom, step.rightTable) && sameRelation(relTo, step.leftTable)) candidates.push({ relationship, reversed: true });
  }
  // When the compiler's ON clause is plain key equalities, only a relationship
  // on those same keys models this join.
  const matching = step.keys.length === 0 ? candidates : candidates.filter(({ relationship, reversed }) => sameKeys(
    relationship.keys.map((key) => (reversed ? { from: key.to, to: key.from } : key)),
    step.keys,
  ));
  if (matching.length === 0) {
    return {
      ...base,
      certified: false,
      reason: candidates.length > 0
        ? `No DQL relationship joins ${from} to ${to} on ${keyText(step.keys)}.`
        : `No DQL relationship models the join from ${from} to ${to}.`,
    };
  }
  const decided = matching.map(({ relationship }) => ({ relationship, decision: assessAnalyticalRelationship(relationship, manifest) }));
  const chosen = decided.find((entry) => entry.decision.executable) ?? decided[0]!;
  return {
    ...base,
    relationshipId: chosen.relationship.qualifiedId ?? chosen.relationship.id,
    relationshipName: chosen.relationship.localId ?? chosen.relationship.id,
    status: chosen.relationship.status,
    certified: chosen.decision.executable,
    reason: chosen.decision.message,
  };
}

function uncertifiedJoinCaveat(joins: SemanticJoinProof[]): string {
  const parts = joins.map((join) => !join.relationshipName
    ? `the join ${join.from} → ${join.to} is not modeled as a DQL relationship`
    : join.status === 'certified'
      ? `${join.from} → ${join.to} joins through relationship "${join.relationshipName}", which is certified but its proof does not hold (${join.reason})`
      : `${join.from} → ${join.to} joins through relationship "${join.relationshipName}", which is ${join.status ?? 'not certified'}, not certified`);
  const sentence = parts.join('; ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. Certify the relationship in Modeling, with warehouse validation, for a From Metrics answer.`;
}

function dedupeSteps(steps: SemanticJoinStep[]): SemanticJoinStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = [step.leftTable, step.rightTable].map(relationKey).sort().join('|') + `|${step.keys.map((k) => `${k.from}=${k.to}`).sort().join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function relationParts(value: string): string[] {
  return parsePhysicalIdentifier(value).map((part) => part.value.trim().toLowerCase()).filter(Boolean);
}

function relationKey(value: string): string {
  return relationParts(value).slice(-2).join('.');
}

/** `"db"."dev"."orders"`, `dev.orders` and `orders` name one relation when the shorter is a suffix of the longer. */
function sameRelation(left: string, right: string): boolean {
  const a = relationParts(left);
  const b = relationParts(right);
  if (a.length === 0 || b.length === 0) return false;
  const length = Math.min(a.length, b.length, 2);
  return a.slice(-length).join('.') === b.slice(-length).join('.');
}

function sameKeys(left: Array<{ from: string; to: string }>, right: Array<{ from: string; to: string }>): boolean {
  const render = (keys: Array<{ from: string; to: string }>) => keys.map((key) => `${key.from.toLowerCase()}=${key.to.toLowerCase()}`).sort().join(',');
  return left.length === right.length && render(left) === render(right);
}

function keyText(keys: Array<{ from: string; to: string }>): string {
  return keys.map((key) => (key.from === key.to ? key.from : `${key.from} = ${key.to}`)).join(', ');
}

function tableLabel(table: string, cube: string): string {
  return relationParts(table).at(-1) ?? cube;
}
