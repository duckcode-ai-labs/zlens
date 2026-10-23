import type { DQLContext } from '../context.js';

/**
 * An empty discovery result reads like "this project has no data" to an MCP
 * client that skipped ask_dql. When the project does have governed answers
 * (certified blocks or semantic metrics), say so and name ask_dql as the next
 * tool, so the client turns back to the governed path instead of giving up.
 */
export function governedAnswerPointer(ctx: DQLContext, emptyWhat: string) {
  let certifiedBlocks = 0;
  let semanticMetrics = 0;
  try {
    certifiedBlocks = Object.values(ctx.manifest?.blocks ?? {}).filter((block) => block.status === 'certified').length;
    semanticMetrics = ctx.semanticLayer.listMetrics().length;
  } catch {
    return undefined;
  }
  if (certifiedBlocks === 0 && semanticMetrics === 0) return undefined;
  const has = [
    certifiedBlocks > 0 ? `${certifiedBlocks} certified block${certifiedBlocks === 1 ? '' : 's'}` : undefined,
    semanticMetrics > 0 ? `${semanticMetrics} semantic metric${semanticMetrics === 1 ? '' : 's'}` : undefined,
  ].filter(Boolean).join(' and ');
  return {
    note: `${emptyWhat} This project has ${has}, which answer business questions. Call ask_dql with the user's question next.`,
    nextTool: 'ask_dql' as const,
  };
}
