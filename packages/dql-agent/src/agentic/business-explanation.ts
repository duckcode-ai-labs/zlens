/**
 * Answering "what does this mean?" from governed metadata, without SQL.
 *
 * A definitional question — "what does the top_customers block measure?", "how
 * is revenue defined here?" — is routed to `converse` today, which replies
 * conversationally with NO governed evidence attached. So the product knows the
 * answer (it has the description, the owner, the grain, the outputs, the
 * certification status) and does not use it, which is the shape of the
 * complaint that Ask AI cannot explain business context.
 *
 * This composes the explanation deterministically from what the catalog already
 * holds. No provider, no warehouse: the facts are all in the object, and a model
 * paraphrasing them can only add drift.
 */

/** The subset of a catalog object this needs. Structural, so any source can supply it. */
export interface ExplainableObject {
  objectKey: string;
  objectType: string;
  name: string;
  fullName?: string;
  description?: string;
  domain?: string;
  owner?: string;
  status?: string;
  payload?: Record<string, unknown>;
}

export interface BusinessExplanation {
  text: string;
  /** Object keys the explanation drew on, for the provenance footer. */
  citations: string[];
  /**
   * Whether every claim came from a governed artifact. False when the object is
   * a raw dbt/warehouse node rather than something a person certified — the
   * answer is still useful, it is just not an authored definition.
   */
  governed: boolean;
}

const CERTIFIED_STATUSES = new Set(['certified', 'approved']);

function stringField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(payload: Record<string, unknown> | undefined, key: string): string[] {
  const value = payload?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const name = (entry as { name?: unknown }).name;
        return typeof name === 'string' ? name : '';
      }
      return '';
    })
    .filter((entry): entry is string => Boolean(entry));
}

/** How a reader should weigh this object, in plain words. */
function trustSentence(object: ExplainableObject): string {
  const status = object.status?.toLowerCase() ?? '';
  if (CERTIFIED_STATUSES.has(status)) {
    return object.owner
      ? `It is certified and owned by ${object.owner}.`
      : 'It is certified.';
  }
  if (status === 'draft') return 'It is a draft — not certified, so treat the numbers as provisional.';
  if (object.objectType.startsWith('dbt:') || object.objectType.startsWith('dbt_')) {
    return 'This comes from the dbt project rather than a certified saved query, so it describes the model, not an approved business definition.';
  }
  return status ? `Status: ${status}.` : 'It has no certification status recorded.';
}

/**
 * Compose an explanation of one governed object.
 *
 * Returns `null` when there is nothing beyond a bare name to say. A confident
 * paragraph assembled from an empty description is worse than falling through
 * to the normal cascade: it reads like an answer and carries no information.
 */
export function explainObject(object: ExplainableObject): BusinessExplanation | null {
  const parts: string[] = [];
  const label = object.fullName ?? object.name;

  const description = object.description?.trim();
  const guidance = stringField(object.payload, 'llmContext');
  if (!description && !guidance) return null;

  parts.push(`**${label}** — ${description ?? guidance}`);

  const grain = stringField(object.payload, 'grain');
  if (grain) parts.push(`Reported at ${grain} grain.`);

  const outputs = stringList(object.payload, 'declaredOutputs');
  const resolvedOutputs = outputs.length > 0 ? outputs : stringList(object.payload, 'outputs');
  if (resolvedOutputs.length > 0) parts.push(`Returns: ${resolvedOutputs.join(', ')}.`);

  const dimensions = stringList(object.payload, 'dimensions');
  if (dimensions.length > 0) parts.push(`Can be broken down by: ${dimensions.join(', ')}.`);

  // Authored guidance is the one field written FOR a reader deciding whether to
  // use this, so it earns its own line when a description already led.
  if (description && guidance && guidance !== description) parts.push(`When to use it: ${guidance}`);

  if (object.domain) parts.push(`Domain: ${object.domain}.`);
  parts.push(trustSentence(object));

  return {
    text: parts.join('\n\n'),
    citations: [object.objectKey],
    governed: CERTIFIED_STATUSES.has(object.status?.toLowerCase() ?? ''),
  };
}

/**
 * Pick the object a definitional question is about, then explain it.
 *
 * Matching is by NAME MENTION, not relevance rank: "what does top_customers
 * measure?" is asking about a specific artifact, and answering about a merely
 * similar one would be a different question confidently answered. When nothing
 * is named, return null and let the cascade run — guessing the subject of a
 * definition is exactly the failure this is meant to avoid.
 */
export function composeBusinessExplanation(
  question: string,
  objects: readonly ExplainableObject[],
): BusinessExplanation | null {
  const lower = question.toLowerCase();
  const named = objects.filter((object) => {
    for (const candidate of [object.name, object.fullName]) {
      if (!candidate) continue;
      const bare = candidate.toLowerCase();
      if (bare.length < 3) continue;
      if (lower.includes(bare)) return true;
      const spaced = bare.replace(/[_.]+/g, ' ');
      if (spaced.length > 3 && lower.includes(spaced)) return true;
    }
    return false;
  });
  if (named.length === 0) return null;

  // Prefer the most specific mention, then the most trustworthy artifact: a
  // certified block explains a concept better than the raw dbt model beneath it.
  const best = [...named].sort((left, right) => {
    const leftName = (left.fullName ?? left.name).length;
    const rightName = (right.fullName ?? right.name).length;
    const leftCertified = CERTIFIED_STATUSES.has(left.status?.toLowerCase() ?? '') ? 1 : 0;
    const rightCertified = CERTIFIED_STATUSES.has(right.status?.toLowerCase() ?? '') ? 1 : 0;
    return rightCertified - leftCertified
      || rightName - leftName
      || left.objectKey.localeCompare(right.objectKey);
  })[0]!;
  return explainObject(best);
}
