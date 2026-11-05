import type { ContextAuthoringOperation } from '../../api/client';

/**
 * The review screen for a drafted model (RFC 0012, P5).
 *
 * Discovery drafts a whole model at once: the tables to answer from, the
 * look-alikes Ask should skip, the joins with what the warehouse said about
 * each, the rules it measured and the concepts it found. A flat list of
 * changes hid which of them a person needs to look at. This groups the
 * drafted changes by what they are and says which passed their checks, so
 * a reviewer can accept everything that passed in one step and look at the
 * rest. Everything here is read from the changes themselves, so a draft kept
 * for later reviews the same way.
 */

export type DraftCheck = 'passed' | 'failed' | 'unchecked';
export type DraftGroupKey = 'tables' | 'lookalikes' | 'joins' | 'rules' | 'concepts' | 'other';

export interface DraftReviewItem {
  operationId: string;
  title: string;
  /** One or two lines: what the change says. */
  detail?: string;
  /** What the warehouse said about it: joins are checked, everything else passes by being measured or bound. */
  check: DraftCheck;
  /** Why the check failed, or why a look-alike is set aside. */
  reason?: string;
  /** The query a measured rule was read with. */
  query?: string;
}

export interface DraftReviewGroup {
  key: DraftGroupKey;
  title: string;
  /** What the group is for, in one line. */
  hint: string;
  items: DraftReviewItem[];
}

export interface DraftReview {
  groups: DraftReviewGroup[];
  /** Every change except joins that did not pass their check. */
  passedIds: string[];
  counts: { tables: number; lookalikes: number; joins: number; joinsPassed: number; rules: number; concepts: number };
}

const GROUPS: Array<Omit<DraftReviewGroup, 'items'>> = [
  { key: 'tables', title: 'Tables to answer from', hint: 'One per business thing, with what one row is.' },
  { key: 'lookalikes', title: 'Use another table instead', hint: 'Each holds the same rows as a table above, less well. Ask answers from the other table unless a question names this one.' },
  { key: 'joins', title: 'Joins', hint: 'Each was checked on the warehouse. Certify a join that passed from the map once it is saved.' },
  { key: 'rules', title: 'Rules measured on the data', hint: 'Each number is what the saved query returned.' },
  { key: 'concepts', title: 'Concepts', hint: 'A key several tables share, with no table of its own.' },
  { key: 'other', title: 'Other changes', hint: '' },
];

const keyText = (keys: Array<{ from: string; to: string }>) => keys.map((pair) => (pair.from === pair.to ? pair.from : `${pair.from} = ${pair.to}`)).join(', ');
const localId = (id: string) => id.split('::').pop() ?? id;

/** Group a drafted model's changes for review, and say which passed. */
export function modelDraftReview(
  operations: readonly ContextAuthoringOperation[],
  /** Plain words for a change that is not a table, join, rule or concept (a new Domain or area). */
  describe: (operation: ContextAuthoringOperation) => string = (operation) => operation.id,
): DraftReview {
  const items = new Map<DraftGroupKey, DraftReviewItem[]>(GROUPS.map((group) => [group.key, []]));
  const push = (key: DraftGroupKey, item: DraftReviewItem) => items.get(key)!.push(item);
  for (const operation of operations) {
    if (operation.kind !== 'modeling_change') {
      push('other', { operationId: operation.id, title: describe(operation), check: 'passed' });
      continue;
    }
    const change = operation.change;
    if (change.operation === 'upsert_entity') {
      const value = change.value;
      const relation = operation.evidence?.find((line) => line.startsWith('warehouse relation '))?.slice('warehouse relation '.length) ?? value.dbtModel;
      const title = `${value.businessName ?? value.id} · ${relation.split('.').pop()}`;
      if (value.useInstead) {
        push('lookalikes', { operationId: operation.id, title, detail: `Use ${localId(value.useInstead.entity)} instead.`, check: 'passed', ...(value.useInstead.reason ? { reason: value.useInstead.reason } : {}) });
      } else {
        push('tables', { operationId: operation.id, title, ...(value.businessContext ? { detail: value.businessContext } : value.grain ? { detail: `One row per ${value.grain}.` } : {}), check: 'passed' });
      }
      continue;
    }
    if (change.operation === 'upsert_relationship') {
      const value = change.value;
      const status = value.validation?.status;
      const check: DraftCheck = status === 'passed' ? 'passed' : status ? 'failed' : 'unchecked';
      push('joins', {
        operationId: operation.id,
        title: `${localId(value.from)} → ${localId(value.to)} on ${keyText(value.keys)}`,
        ...(value.rationale ? { detail: value.rationale } : {}),
        check,
        ...(check === 'failed' && value.validation?.message ? { reason: value.validation.message } : check === 'unchecked' ? { reason: 'Not checked on the warehouse yet: validate it before relying on it.' } : {}),
      });
      continue;
    }
    if (change.operation === 'upsert_rule') {
      const value = change.value;
      push('rules', { operationId: operation.id, title: value.id, detail: value.expression, check: 'passed', ...(value.evidence?.query ? { query: value.evidence.query } : {}) });
      continue;
    }
    if (change.operation === 'upsert_concept') {
      const value = change.value;
      push('concepts', { operationId: operation.id, title: value.name ?? value.id, ...(value.description ? { detail: value.description } : {}), check: 'passed' });
      continue;
    }
    push('other', { operationId: operation.id, title: describe(operation), check: 'passed' });
  }
  const groups = GROUPS.map((group) => ({ ...group, items: items.get(group.key)! })).filter((group) => group.items.length > 0);
  const joins = items.get('joins')!;
  return {
    groups,
    passedIds: groups.flatMap((group) => group.items).filter((item) => item.check === 'passed').map((item) => item.operationId),
    counts: {
      tables: items.get('tables')!.length,
      lookalikes: items.get('lookalikes')!.length,
      joins: joins.length,
      joinsPassed: joins.filter((item) => item.check === 'passed').length,
      rules: items.get('rules')!.length,
      concepts: items.get('concepts')!.length,
    },
  };
}

/** Whether a proposal is a drafted model to review by group (discovery that drafted tables or joins). */
export function isModelDraft(operations: readonly ContextAuthoringOperation[]): boolean {
  return operations.some((operation) => operation.kind === 'modeling_change' && (operation.change.operation === 'upsert_entity' || operation.change.operation === 'upsert_relationship'));
}

/** The line above the groups: what was drafted, and what needs a look. */
export function modelDraftSummary(counts: DraftReview['counts']): string {
  const parts = [
    `${counts.tables} table${counts.tables === 1 ? '' : 's'} to answer from`,
    ...(counts.lookalikes ? [`${counts.lookalikes} with a better table to use instead`] : []),
    `${counts.joins} join${counts.joins === 1 ? '' : 's'} (${counts.joinsPassed} passed)`,
    ...(counts.rules ? [`${counts.rules} measured rule${counts.rules === 1 ? '' : 's'}`] : []),
    ...(counts.concepts ? [`${counts.concepts} concept${counts.concepts === 1 ? '' : 's'}`] : []),
  ];
  const needLook = counts.joins - counts.joinsPassed;
  return `${parts.join(' · ')}.${needLook ? ` ${needLook} join${needLook === 1 ? ' needs' : 's need'} a look before you keep ${needLook === 1 ? 'it' : 'them'}.` : ''}`;
}
