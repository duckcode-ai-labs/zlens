import type { DQLContext } from './context.js';

/**
 * One line that says how far to trust an answer, for the client to show first.
 * MCP clients render tool results as their own prose, so the trust label only
 * reaches the reader if the model writes it out; a fixed, ready-made line makes
 * that the same on every answer: "🟢 Certified · saved query monthly_revenue ·
 * owner analytics@jaffle.shop". Only answer tools that returned rows get one.
 */
const ANSWER_TOOLS = new Set(['query_via_block', 'query_semantic_model', 'query_via_metadata', 'answer_question']);

const MARK: Record<string, string> = {
  certified: '🟢',
  governed: '🔵',
  reviewed: '🟢',
  ai_generated: '🟠',
  insufficient_context: '🔴',
  conflict: '🔴',
};

type Rec = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function line(mark: string, parts: Array<string | undefined>): string {
  return `${mark} ${parts.filter(Boolean).join(' · ')}`;
}

function draftPart(path: string | undefined): string | undefined {
  return path ? `draft saved for review at ${path}` : undefined;
}

export function trustLineFor(ctx: DQLContext, toolName: string, result: unknown): string | undefined {
  if (!ANSWER_TOOLS.has(toolName) || !result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const r = result as Rec;
  if (str(r.error) && r.ok !== true) return undefined;

  if (toolName === 'query_via_block') {
    const display = str(r.trustLabel);
    const block = str(r.block);
    if (!display || !block || !Array.isArray(r.rows)) return undefined;
    let owner: string | undefined;
    try {
      owner = str((ctx.manifest?.blocks?.[block] as { owner?: unknown } | undefined)?.owner);
    } catch {
      owner = undefined;
    }
    // A downgraded certified block ("Certified · stale data") is amber, not green.
    const mark = display === 'Certified' ? MARK.certified : '🟡';
    return line(mark, [display, `saved query ${block}`, owner ? `owner ${owner}` : undefined]);
  }

  if (toolName === 'query_semantic_model') {
    const info = r.trustLabelInfo as { id?: string; display?: string } | undefined;
    if (r.matched !== true || !info?.display || !Array.isArray(r.rows)) return undefined;
    const metrics = Array.isArray(r.metrics) ? (r.metrics as unknown[]).filter((m) => typeof m === 'string') : [];
    const status = r.trustStatus as { draftPath?: unknown } | undefined;
    return line(MARK[info.id ?? ''] ?? '🟠', [
      info.display,
      metrics.length > 0 ? `metric ${metrics.join(', ')}` : undefined,
      info.id === 'governed' ? 'not certified' : 'needs review',
      draftPart(str(status?.draftPath)),
    ]);
  }

  if (toolName === 'query_via_metadata') {
    const status = r.trustStatus as { reviewStatus?: unknown; draftPath?: unknown } | undefined;
    if (status?.reviewStatus !== 'draft_ready' || !Array.isArray(r.rows)) return undefined;
    return line(MARK.ai_generated, ['AI-Generated', 'SQL written for this question', 'needs review', draftPart(str(status.draftPath))]);
  }

  // answer_question
  const info = r.trustLabelInfo as { id?: string; display?: string } | undefined;
  if (r.ok !== true || !info?.display) return undefined;
  return line(MARK[info.id ?? ''] ?? '🟠', [
    info.display,
    info.id === 'certified' ? undefined : 'needs review',
    draftPart(str(r.draftBlockPath)),
  ]);
}

/** Puts `trustLine` first, so a client reads it before the rows. */
export function withTrustLine(ctx: DQLContext, toolName: string, result: unknown): unknown {
  const trustLine = trustLineFor(ctx, toolName, result);
  return trustLine ? { trustLine, ...(result as Rec) } : result;
}
