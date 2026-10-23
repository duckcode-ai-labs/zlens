import type { DQLContext } from '../context.js';
import type { ManifestBlock } from '@zlens/core';
import { zodInputShapeForTool } from '../tool-schema.js';
import { governedAnswerPointer } from './next-step.js';

export const searchBlocksInput = zodInputShapeForTool('search_blocks');

export function searchBlocks(
  ctx: DQLContext,
  args: {
    query?: string;
    domain?: string;
    status?: string;
    limit?: number;
  },
) {
  const { query, domain, status, limit = 50 } = args;
  const needle = query?.trim().toLowerCase();

  const scoped = Object.values(ctx.manifest.blocks).filter((block) => {
    if (domain && block.domain !== domain) return false;
    if (status && block.status !== status) return false;
    return true;
  });

  const ranked = needle ? rankBlocksByQuery(scoped, needle) : scoped;
  const results = ranked.slice(0, limit).map(summarize);
  const pointer = results.length === 0 && needle
    ? governedAnswerPointer(ctx, 'No saved query names or descriptions match this search text.')
    : undefined;
  return {
    total: ranked.length,
    returned: results.length,
    blocks: results,
    ...(pointer ?? {}),
  };
}

/**
 * Token-aware, index-free block ranking. A single contiguous substring match ("X")
 * misses multi-word queries whose terms are reordered or separated in the block's
 * text — "region tax by product" never matches a block described "tax by region and
 * product". So we tokenize the query and rank by how many terms are present:
 * AND-first (every term co-occurs) for precision, OR fallback (any term) for recall,
 * with a boost when terms hit the block NAME. This stays an in-memory scan over the
 * live manifest — no FTS index, so it can never serve a stale view of the blocks.
 */
function rankBlocksByQuery(blocks: ManifestBlock[], needle: string): ManifestBlock[] {
  const terms = Array.from(new Set(needle.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_]/gu, '')).filter((t) => t.length > 1)));
  if (terms.length === 0) {
    return blocks.filter((block) => haystackFor(block).includes(needle));
  }
  const scored = blocks
    .map((block) => {
      const name = block.name.toLowerCase();
      const haystack = haystackFor(block);
      let matched = 0;
      let nameMatched = 0;
      for (const term of terms) {
        if (haystack.includes(term)) matched += 1;
        if (name.includes(term)) nameMatched += 1;
      }
      return { block, matched, nameMatched };
    })
    .filter((entry) => entry.matched > 0);
  // AND-first: keep only blocks that contain every term. Fall back to any-term.
  const allTerms = scored.filter((entry) => entry.matched === terms.length);
  const pool = allTerms.length > 0 ? allTerms : scored;
  return pool
    .sort((a, b) => b.nameMatched - a.nameMatched || b.matched - a.matched || a.block.name.localeCompare(b.block.name))
    .map((entry) => entry.block);
}

function haystackFor(block: ManifestBlock): string {
  return [block.name, block.description ?? '', (block.tags ?? []).join(' '), block.llmContext ?? '']
    .join(' ')
    .toLowerCase();
}

function summarize(block: ManifestBlock) {
  return {
    name: block.name,
    path: block.filePath,
    domain: block.domain ?? null,
    owner: block.owner ?? null,
    status: block.status ?? 'draft',
    description: block.description ?? null,
    tags: block.tags ?? [],
    dependencies: block.allDependencies,
    chartType: block.chartType ?? null,
    // v1.2 Track G — agent-facing metadata. Surfaced so agents can prefer
    // blocks with richer grounding without a second tool round-trip.
    llmContext: block.llmContext ?? null,
    hasExamples: !!(block.examples && block.examples.length > 0),
    hasInvariants: !!(block.invariants && block.invariants.length > 0),
  };
}
