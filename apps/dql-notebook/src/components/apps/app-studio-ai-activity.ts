export const APP_STUDIO_AI_ACTIVITY_LABELS = [
  'Understanding your decision',
  'Finding certified tables, Metrics and saved queries',
  'Checking trust and capabilities',
  'Preparing source review',
] as const;

export function nextAppStudioAiActivityIndex(current: number): number {
  return (Math.max(0, current) + 1) % APP_STUDIO_AI_ACTIVITY_LABELS.length;
}

export type AppStudioAiActivityRetry =
  | { kind: 'propose'; prompt: string; requiredSourceIds: string[] }
  | { kind: 'revise'; answers?: Record<string, string>; requiredSourceIds: string[] }
  | { kind: 'enable_review_and_propose'; prompt: string; sourceId: string; requiredSourceIds: string[] };

function uniqueSourceIds(sourceIds: string[]): string[] {
  return Array.from(new Set(sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean)));
}

export function appStudioProposalRetry(prompt: string, requiredSourceIds: string[]): AppStudioAiActivityRetry {
  return { kind: 'propose', prompt, requiredSourceIds: uniqueSourceIds(requiredSourceIds) };
}

export function appStudioRevisionRetry(
  answers: Record<string, string> | undefined,
  requiredSourceIds: string[],
): AppStudioAiActivityRetry {
  return {
    kind: 'revise',
    ...(answers ? { answers: { ...answers } } : {}),
    requiredSourceIds: uniqueSourceIds(requiredSourceIds),
  };
}

export function appStudioReviewAddRetry(
  prompt: string,
  sourceId: string,
  requiredSourceIds: string[],
): AppStudioAiActivityRetry {
  return { kind: 'enable_review_and_propose', prompt, sourceId, requiredSourceIds: uniqueSourceIds(requiredSourceIds) };
}

export type AppStudioSourceActionStatus = 'idle' | 'adding' | 'added' | 'error';

export function appStudioSourceActionLabel(input: {
  view: string;
  status: AppStudioSourceActionStatus;
  /** @deprecated Ignored (T3): data nobody certified is added like any other. */
  reviewRequired?: boolean;
  alreadyUsed: boolean;
  pageTitle?: string;
}): string {
  if (input.status === 'adding') return 'Adding…';
  if (input.status === 'added') return `Added to ${input.pageTitle?.trim() || 'Overview'}`;
  if (input.status === 'error') return `Try add ${input.view}`;
  if (input.alreadyUsed) return `Add another ${input.view}`;
  return `Add ${input.view}`;
}
