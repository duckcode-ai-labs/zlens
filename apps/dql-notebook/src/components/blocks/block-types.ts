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
}

export const STATUS_COLORS: Record<string, string> = {
  draft: '#8b949e',
  review: '#d29922',
  certified: '#3fb950',
  deprecated: '#f85149',
  pending_recertification: '#db6d28',
  proposed: '#d29922',
};
