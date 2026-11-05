/**
 * Composting v2 — recurring join-pattern mining (W4.4).
 *
 * The composting flywheel distills recurring single-table aggregates from certified
 * blocks into governed metric drafts. This complements it by mining recurring JOIN
 * shapes across certified blocks: when several certified blocks join the same two
 * relations on the same keys, that join is a de-facto governed relationship worth
 * proposing as a saved join (and its keys feed the grain ledger). Reuses the join
 * extraction from `analyzeSqlReferences` (W1.3), so it understands real SQL, not regex.
 */
import { analyzeSqlReferences, tableName } from '@zlens/core';

export interface JoinPatternCandidate {
  leftRelation: string;
  leftColumn: string;
  rightRelation: string;
  rightColumn: string;
  support: number;
  donorBlocks: string[];
}

function normalizeColumn(column: string): string {
  return column.replace(/["`]/g, '').trim().toLowerCase();
}

/**
 * Mine equality join shapes that recur across ≥ `minSupport` certified blocks. A
 * join is canonicalized order-independently (A.x=B.y is the same shape as B.y=A.x),
 * and each block contributes at most once per shape.
 */
export function mineJoinPatterns(
  blocks: Array<{ name: string; sql?: string }>,
  minSupport = 2,
): JoinPatternCandidate[] {
  interface Group {
    left: { relation: string; column: string };
    right: { relation: string; column: string };
    donors: Set<string>;
  }
  const groups = new Map<string, Group>();

  for (const block of blocks) {
    if (!block.sql) continue;
    let analysis;
    try {
      analysis = analyzeSqlReferences(block.sql);
    } catch {
      continue;
    }
    if (!analysis.parsed) continue;
    const seenInBlock = new Set<string>();
    for (const join of analysis.joins) {
      const left = tableName(join.leftRelation ?? '').toLowerCase() || undefined;
      const right = tableName(join.rightRelation ?? '').toLowerCase() || undefined;
      if (!left || !right || left === right) continue;
      const leftSide = { relation: left, column: normalizeColumn(join.leftColumn) };
      const rightSide = { relation: right, column: normalizeColumn(join.rightColumn) };
      // Canonical (order-independent) ordering by relation, then column.
      const [a, b] = `${leftSide.relation}.${leftSide.column}` <= `${rightSide.relation}.${rightSide.column}`
        ? [leftSide, rightSide]
        : [rightSide, leftSide];
      const key = `${a.relation}.${a.column}=${b.relation}.${b.column}`;
      if (seenInBlock.has(key)) continue;
      seenInBlock.add(key);
      const group = groups.get(key) ?? { left: a, right: b, donors: new Set<string>() };
      group.donors.add(block.name);
      groups.set(key, group);
    }
  }

  return [...groups.values()]
    .filter((group) => group.donors.size >= minSupport)
    .map((group) => ({
      leftRelation: group.left.relation,
      leftColumn: group.left.column,
      rightRelation: group.right.relation,
      rightColumn: group.right.column,
      support: group.donors.size,
      donorBlocks: [...group.donors].sort(),
    }))
    .sort((x, y) => y.support - x.support
      || `${x.leftRelation}.${x.rightRelation}`.localeCompare(`${y.leftRelation}.${y.rightRelation}`));
}
