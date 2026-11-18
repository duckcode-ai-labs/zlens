/**
 * THE MEASURED RULES OF A DRAFT WAITING FOR REVIEW, read by Ask.
 *
 * A first start drafts the models and keeps the draft until a person reviews it (the ZLens app for
 * Snowflake does this by itself). The draft's rules are what counting queries returned on the data: "Every
 * GAME_ID in RAW_GAMES has 8 characters, and the first one takes 4 values: 1 (3,548 rows), 2 (46,488 rows),
 * …". Ask read only saved rules, so until the review it never learnt that the first character of GAME_ID is
 * the kind of game. New-user test V17 p6, fresh install: "2015 playoffs" found no field for playoffs, and
 * "2016 regular season" counted every kind of game (89 wins in an 82-game season, "4 checks passed"); the
 * reviewed install answered both.
 *
 * Ask now reads those rules too, as the drafts they are: only measured rules (each carries the query that
 * measured it), never one a saved rule of the same id already says, never a deprecated one. Nothing is written,
 * and the answer stays AI-generated and review-required as before. The App builder reads open drafts the same
 * way (related fields, design D2).
 */
import type { DQLManifest, ManifestModelRule } from '@zlens/core';
import type { ContextAuthoringProposalV1 } from '@zlens/agent';

const qualified = (domain: string, id: string) => {
  const prefix = `${domain}::rule::`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
};

/** The measured rules of the drafts waiting for review, keyed as the manifest keys rules. Newest draft first wins. */
export function waitingDraftRules(proposals: ContextAuthoringProposalV1[]): Record<string, ManifestModelRule> {
  const rules: Record<string, ManifestModelRule> = {};
  const waiting = proposals
    .filter((proposal) => proposal.status === 'proposed')
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  for (const proposal of waiting) {
    for (const operation of proposal.operations ?? []) {
      if (operation.kind !== 'modeling_change' || operation.change.operation !== 'upsert_rule') continue;
      const value = operation.change.value;
      if (!value.id || !value.domain || !value.expression?.trim() || !value.evidence?.query) continue;
      if (value.status === 'deprecated') continue;
      const key = qualified(value.domain, value.id);
      if (rules[key]) continue;
      rules[key] = {
        id: key,
        localId: value.id,
        qualifiedId: key,
        domain: value.domain,
        kind: value.kind ?? 'custom',
        expression: value.expression.trim(),
        status: 'draft',
        ...(value.entities?.length ? { entities: value.entities.map((entity) => (entity.includes('::') ? entity : `${value.domain}::entity::${entity}`)) } : {}),
        evidence: { query: value.evidence.query, measured: value.evidence.measured, ...(value.evidence.checkedAt ? { checkedAt: value.evidence.checkedAt } : {}) },
        sourcePath: `draft:${proposal.id}`,
      };
    }
  }
  return rules;
}

/**
 * The manifest Ask reads: the saved model, with the measured rules of the drafts waiting for review beside its
 * own rules. A saved rule of the same id wins. Without waiting rules, the manifest itself.
 */
export function withWaitingDraftRules(manifest: DQLManifest, proposals: ContextAuthoringProposalV1[]): DQLManifest {
  const drafted = waitingDraftRules(proposals);
  const saved = manifest.modeling?.rules ?? {};
  const added = Object.entries(drafted).filter(([key]) => !Object.prototype.hasOwnProperty.call(saved, key));
  if (added.length === 0 || !manifest.modeling) return manifest;
  return { ...manifest, modeling: { ...manifest.modeling, rules: { ...saved, ...Object.fromEntries(added) } } };
}
