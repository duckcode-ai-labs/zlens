export type BlockStatus =
  | 'draft'
  | 'review'
  | 'certified'
  | 'deprecated'
  | 'pending_recertification'
  | 'proposed';

export interface BlockEntry {
  name: string;
  domain: string;
  status: BlockStatus | string;
  owner: string | null;
  tags: string[];
  path: string;
  lastModified: string;
  description: string;
  llmContext?: string | null;
  /**
   * `private` lives under `.dql/local/` and is invisible to git until it is
   * published. Not to be confused with the tracked `_drafts/` folder, which
   * holds unpublished edits to a certified block.
   */
  visibility?: 'private' | 'shared';
  /** Retired blocks: the block named as the replacement, as written in source. */
  replacedBy?: string;
  /** Retired blocks: retirement date, YYYY-MM-DD. */
  deprecatedOn?: string;
  /** The active block replacedBy resolves to; null when it names no block. */
  replacement?: { name: string; path: string } | null;
  /** Certified on the branch being served: under a host that certifies through review, not reviewed yet. */
  certificationProposed?: boolean;
  /** An automatic Ask draft nobody changed. Pickers leave it out; "Clear drafts" removes it. */
  automaticDraft?: boolean;
}

/**
 * The saved queries a picker offers: every one but the drafts Ask saved on
 * its own (new-user test: a "Saved query" cell offered 29 of them, named
 * like "about_2009"). Those stay in Saved queries → Drafts for review.
 */
export function pickableBlocks<T extends { automaticDraft?: boolean }>(blocks: T[]): T[] {
  return blocks.filter((block) => !block.automaticDraft);
}

export const STATUS_COLORS: Record<string, string> = {
  draft: '#8b949e',
  review: '#d29922',
  certified: '#3fb950',
  deprecated: '#f85149',
  pending_recertification: '#db6d28',
  proposed: '#d29922',
};

/** A saved query's name from its file path: `blocks/_drafts/how_many_teams.dql` → `how_many_teams`. */
export function draftNameFromPath(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.dql$/, '');
}

/**
 * A saved query name from a question, cut only between words:
 * "How many points did LeBron score?" → `how_many_points_did_lebron_score`.
 * A name cut mid-word ("…_golden_state_w") reads as a different query.
 */
export function savedQueryNameFromQuestion(question: string, max = 64): string {
  const words = question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let name = '';
  for (const word of words) {
    const next = name ? `${name}_${word}` : word;
    if (next.length > max) break;
    name = next;
  }
  if (!name && words[0]) name = words[0].slice(0, max);
  return (name || 'saved_answer').replace(/^(\d)/, 'q_$1');
}
