import type { ContextAuthoringDiagnosticV1, ContextAuthoringOrigin, ContextAuthoringProposalV1 } from '../../api/client';

/**
 * Plain words for the proposal review drawer (new-user round 2, Q3).
 *
 * A database-only first run used to show "Review exact proposal · immutable
 * revision", thirteen identical `MODEL_AREA_DEFAULTED` lines and ids such as
 * `scope:domain:dev`. A person reads one line per kind of note and what each
 * change does; codes, operation ids and the proposal hash sit under
 * Technical details.
 */

export interface ProposalNoteGroup {
  key: string;
  code: string;
  severity: ContextAuthoringDiagnosticV1['severity'];
  /** One plain line for the whole group. */
  summary: string;
  /** How many things the group covers (tables, changes). */
  count: number;
  /** The notes as the server wrote them, for Technical details. */
  details: ContextAuthoringDiagnosticV1[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One plain line for a code that repeats once per table or change. */
const GROUP_SUMMARY: Record<string, (count: number, origin: ContextAuthoringOrigin) => string> = {
  MODEL_AREA_DEFAULTED: (count, origin) => `${plural(count, origin === 'warehouse_discovery' ? 'table' : 'model')} placed in the default area. You can rename or move ${count === 1 ? 'it' : 'them'} later.`,
  DATASET_CHANGE_REVIEW_REQUIRED: (count) => `${plural(count, 'Dataset change')} will be saved as needing review. Nothing is certified or rebound.`,
  DATASET_DRAFT_REVIEW_REQUIRED: (count) => `${plural(count, 'new Dataset')} will be saved as ${count === 1 ? 'a draft' : 'drafts'} for review.`,
};

/** How many things one note covers: a grouped note lists its operations. */
function noteCount(diagnostic: ContextAuthoringDiagnosticV1): number {
  return diagnostic.operationIds?.length || 1;
}

/**
 * Group the notes: one line per code and severity, blocking ones first.
 * A server that already grouped them ("13 tables placed in the default area")
 * keeps its sentence; older proposals with one line per table are grouped here.
 */
export function groupProposalDiagnostics(
  diagnostics: readonly ContextAuthoringDiagnosticV1[],
  origin: ContextAuthoringOrigin,
): ProposalNoteGroup[] {
  const groups = new Map<string, ContextAuthoringDiagnosticV1[]>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}:${diagnostic.code}`;
    groups.set(key, [...(groups.get(key) ?? []), diagnostic]);
  }
  const order = { blocking: 0, warning: 1, info: 2 } as const;
  return [...groups.entries()]
    .map(([key, details]): ProposalNoteGroup => {
      const first = details[0]!;
      const count = details.reduce((total, diagnostic) => total + noteCount(diagnostic), 0);
      const plain = GROUP_SUMMARY[first.code];
      const summary = details.length === 1 && (!plain || first.operationIds)
        ? first.message
        : plain
          ? plain(count, origin)
          : `${first.message}${details.length > 1 ? ` (and ${plural(details.length - 1, 'more note')} like this)` : ''}`;
      return { key, code: first.code, severity: first.severity, summary, count, details };
    })
    .sort((left, right) => order[left.severity] - order[right.severity]);
}

/** The drawer's title: what is being reviewed, in words. */
export function proposalReviewTitle(origin: ContextAuthoringOrigin): string {
  if (origin === 'warehouse_discovery') return 'Review the models ZLens drafted';
  if (origin === 'dbt_discovery') return 'Review the models drafted from dbt';
  if (origin === 'ai') return 'Review what AI drafted';
  return 'Review the proposed changes';
}

/** Where the proposal came from, in words, for the line under the title. */
export function proposalOriginWords(origin: ContextAuthoringOrigin): string {
  switch (origin) {
    case 'warehouse_discovery': return 'Drafted from your database';
    case 'dbt_discovery': return 'Drafted from your dbt project';
    case 'ai': return 'Drafted by AI';
    case 'yaml_import': return 'Imported from YAML';
    case 'correction': return 'A correction';
    default: return 'Your changes';
  }
}

/** Names of the Domains and areas the proposal creates, by id, so a change reads "in Jaffle shop". */
export function proposalScopeNames(proposal: Pick<ContextAuthoringProposalV1, 'operations'>): { domains: Map<string, string>; areas: Map<string, string> } {
  const domains = new Map<string, string>();
  const areas = new Map<string, string>();
  for (const operation of proposal.operations) {
    if (operation.kind !== 'modeling_change') continue;
    const change = operation.change;
    if (change.operation === 'upsert_domain' && change.value.name) domains.set(change.value.id, change.value.name);
    if (change.operation === 'upsert_area' && change.value.name) areas.set(`${change.value.domain}::${change.value.id}`, change.value.name);
  }
  return { domains, areas };
}

/**
 * A one-line, plain-language summary of what an operation does.
 *
 * The exact source patch is still one click away, but leading with
 * "Add orders as Order in Jaffle shop" is what makes a 40-model import
 * reviewable; a list of operation ids is not.
 */
export function describeProposalOperation(
  operation: ContextAuthoringProposalV1['operations'][number],
  names: { domains: Map<string, string>; areas: Map<string, string> } = { domains: new Map(), areas: new Map() },
): string {
  if (operation.kind === 'skill_change') {
    return `${operation.operation === 'create' ? 'Create' : operation.operation === 'move' ? 'Move' : 'Update'} skill ${operation.value.id}`;
  }
  if (operation.kind === 'dbt_source_change') return 'Patch dbt source';
  if (operation.kind === 'dataset_change') {
    return `Update Dataset definition ${operation.change.targetPath}`;
  }
  if (operation.kind === 'dataset_draft') {
    return `Create review-required Dataset draft ${operation.change.domain}/${operation.change.slug}`;
  }
  const change = operation.change;
  const domainName = (domain?: string) => (domain ? names.domains.get(domain) ?? domain : '');
  const scope = (domain?: string, areaId?: string) => {
    const area = domain && areaId ? names.areas.get(`${domain}::${areaId}`) : undefined;
    return [domainName(domain), area].filter(Boolean).join(' / ');
  };
  switch (change.operation) {
    case 'upsert_domain': return `Create the Domain ${change.value.name || change.value.id}`;
    case 'upsert_area': return `Create the area ${change.value.name || change.value.id} in ${domainName(change.value.domain)}`;
    case 'upsert_entity': {
      const table = change.value.dbtModel.split('.').at(-1);
      const where = scope(change.value.domain, change.value.areaId);
      return `Add ${table} as ${change.value.businessName || change.value.id}${where ? ` in ${where}` : ''}`;
    }
    case 'upsert_relationship': {
      const keys = change.value.keys.map((key) => `${key.from} = ${key.to}`).join(' and ');
      const name = (ref: string) => ref.split('::').pop() ?? ref;
      // The level the relationship is saved at, as the Modeling page names it.
      const level = change.value.status === 'certified'
        ? 'certified'
        : change.value.status === 'deprecated'
          ? 'retired'
          : change.value.status !== 'draft' && change.value.validation?.status === 'passed' ? 'validated' : 'draft';
      return `Connect ${name(change.value.from)} to ${name(change.value.to)} on ${keys} (${change.value.cardinality.replace(/_/g, ' ')}, saved as ${level})`;
    }
    case 'remove_entity': return `Remove model ${change.value.id}`;
    case 'remove_relationship': return `Remove relationship ${change.value.id}`;
    case 'remove_area': return `Remove subject area ${change.value.id}`;
    default: return change.operation.replace(/_/g, ' ');
  }
}

/** "9 drafted models waiting for review in Jaffle shop. They are kept until you save or discard them." */
export function waitingDraftsSentence(waiting: { models: number; joins: number; domains: string[] }): string {
  const models = waiting.models || waiting.joins;
  const noun = waiting.models ? plural(models, 'drafted model') : plural(models, 'drafted join');
  const where = waiting.domains.length ? ` in ${waiting.domains.join(', ')}` : '';
  return `${noun} waiting for review${where}. They are kept until you save or discard them.`;
}

/** "Left out 2 staging tables (stg_customers, stg_orders): a final table holds the same data." */
export function stagingLeftOutSentence(hidden: ReadonlyArray<{ relation: string }>): string {
  const names = hidden.map((item) => item.relation.split('.').at(-1) ?? item.relation);
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3} more` : '');
  return `Left out ${plural(hidden.length, 'staging table')} (${shown}): a final table holds the same data.`;
}
