export type CascadeLane = 'triage' | 'certified' | 'semantic' | 'generated' | 'refusal';

export type CascadeLaneStatus = 'selected' | 'checked' | 'skipped' | 'failed';

export interface CascadeLaneTrace {
  lane: CascadeLane;
  status: CascadeLaneStatus;
  label: string;
  detail?: string;
  terminal?: boolean;
}

export interface CascadeLaneTraceInput {
  status?: CascadeLaneStatus;
  label?: string;
  detail?: string;
}

export interface CascadeTraceInput {
  terminalLane?: CascadeLane;
  lanes?: Partial<Record<CascadeLane, CascadeLaneTraceInput>>;
}

export interface CascadeEvidenceRouteStep {
  tool: `cascade_${CascadeLane}`;
  status: CascadeLaneStatus;
  label: string;
  detail?: string;
}

export type CascadeAnswerTier =
  | 'certified_block'
  | 'semantic_metric'
  | 'generated_sql'
  | 'business_context'
  | 'no_answer';

export interface CascadeAnswerResultInput {
  routeTier: CascadeAnswerTier;
  label: string;
  ref?: string;
  artifactKind?: string;
  refusalCode?: string;
  reason?: string;
  rowCount?: number;
  executionStatus?: 'executed' | 'failed' | 'not_requested' | 'not_applicable';
  draftBlockId?: string;
  metrics?: string[];
  dimensions?: string[];
  hasSqlPreview?: boolean;
}

export type CascadeTerminalLane = Exclude<CascadeLane, 'triage'>;

export interface CascadeAnswerResult {
  terminalLane: CascadeTerminalLane;
  routeTier: CascadeAnswerTier;
  label: string;
  ref?: string;
  artifactKind?: string;
  refusalCode?: string;
  outcome: CascadeLaneOutcome;
}

export type CascadeLaneOutcome =
  | CascadeCertifiedOutcome
  | CascadeSemanticOutcome
  | CascadeGeneratedOutcome
  | CascadeRefusalOutcome;

export interface CascadeCertifiedOutcome {
  lane: 'certified';
  routeTier: 'certified_block' | 'business_context';
  ref?: string;
  executionStatus: 'executed' | 'failed' | 'not_requested' | 'not_applicable';
  rowCount?: number;
}

export interface CascadeSemanticOutcome {
  lane: 'semantic';
  routeTier: 'semantic_metric';
  ref?: string;
  artifactKind?: string;
  metrics?: string[];
  dimensions?: string[];
  rowCount?: number;
}

export interface CascadeGeneratedOutcome {
  lane: 'generated';
  routeTier: 'generated_sql';
  artifactKind?: string;
  draftBlockId?: string;
  hasSqlPreview: boolean;
  executionStatus: 'executed' | 'failed' | 'not_requested' | 'not_applicable';
  rowCount?: number;
}

export interface CascadeRefusalOutcome {
  lane: 'refusal';
  routeTier: 'no_answer';
  refusalCode?: string;
  reason: string;
}

const CASCADE_LANE_ORDER: CascadeLane[] = ['triage', 'certified', 'semantic', 'generated', 'refusal'];

const DEFAULT_LANE_LABELS: Record<CascadeLane, string> = {
  triage: 'Lane 0 triage checked request intent and ambiguity',
  certified: 'Lane 1 checked certified saved queries and business context',
  semantic: 'Lane 2 checked semantic metrics and dimensions',
  generated: 'Lane 3 checked generated DQL artifact with SQL preview',
  refusal: 'Lane 4 checked honest refusal and redirect',
};

const TERMINAL_LANE_LABELS: Record<CascadeLane, string> = {
  triage: 'Lane 0 triage was terminal',
  certified: 'Lane 1 certified answer was terminal',
  semantic: 'Lane 2 semantic DQL artifact was terminal',
  generated: 'Lane 3 generated DQL artifact was terminal',
  refusal: 'Lane 4 refusal was terminal',
};

export function createCascadeTrace(input: CascadeTraceInput = {}): CascadeLaneTrace[] {
  const terminalIndex = input.terminalLane ? CASCADE_LANE_ORDER.indexOf(input.terminalLane) : -1;
  return CASCADE_LANE_ORDER.map((lane, index) => {
    const override = input.lanes?.[lane];
    const isTerminal = terminalIndex === index;
    const afterTerminal = terminalIndex >= 0 && index > terminalIndex;
    if (afterTerminal) {
      return {
        lane,
        status: 'skipped',
        label: override?.label ?? skippedByTerminalLaneLabel(lane, input.terminalLane!),
        ...(override?.detail ? { detail: override.detail } : {}),
      };
    }
    const status = override?.status ?? (isTerminal ? 'selected' : terminalIndex >= 0 ? 'checked' : 'skipped');
    return {
      lane,
      status,
      label: override?.label ?? (isTerminal ? TERMINAL_LANE_LABELS[lane] : DEFAULT_LANE_LABELS[lane]),
      ...(override?.detail ? { detail: override.detail } : {}),
      ...(isTerminal ? { terminal: true } : {}),
    };
  });
}

export function cascadeTraceToEvidenceRouteSteps(trace: CascadeLaneTrace[]): CascadeEvidenceRouteStep[] {
  return trace.map((step) => ({
    tool: `cascade_${step.lane}`,
    status: step.status,
    label: step.label,
    ...(step.detail ? { detail: step.detail } : {}),
  }));
}

export function createCascadeAnswerResult(input: CascadeAnswerResultInput): CascadeAnswerResult {
  const terminalLane = terminalLaneForRouteTier(input.routeTier);
  return {
    terminalLane,
    routeTier: input.routeTier,
    label: input.label,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.artifactKind ? { artifactKind: input.artifactKind } : {}),
    ...(input.refusalCode ? { refusalCode: input.refusalCode } : {}),
    outcome: createCascadeLaneOutcome({ ...input, terminalLane }),
  };
}

export function terminalLaneForRouteTier(routeTier: CascadeAnswerTier): CascadeTerminalLane {
  switch (routeTier) {
    case 'certified_block':
    case 'business_context':
      return 'certified';
    case 'semantic_metric':
      return 'semantic';
    case 'generated_sql':
      return 'generated';
    case 'no_answer':
      return 'refusal';
  }
}

function createCascadeLaneOutcome(
  input: CascadeAnswerResultInput & { terminalLane: CascadeTerminalLane },
): CascadeLaneOutcome {
  switch (input.terminalLane) {
    case 'certified':
      return {
        lane: 'certified',
        routeTier: input.routeTier === 'business_context' ? 'business_context' : 'certified_block',
        ...(input.ref ? { ref: input.ref } : {}),
        executionStatus: input.executionStatus ?? 'not_requested',
        ...(input.rowCount === undefined ? {} : { rowCount: input.rowCount }),
      };
    case 'semantic':
      return {
        lane: 'semantic',
        routeTier: 'semantic_metric',
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.artifactKind ? { artifactKind: input.artifactKind } : {}),
        ...(input.metrics?.length ? { metrics: input.metrics } : {}),
        ...(input.dimensions?.length ? { dimensions: input.dimensions } : {}),
        ...(input.rowCount === undefined ? {} : { rowCount: input.rowCount }),
      };
    case 'generated':
      return {
        lane: 'generated',
        routeTier: 'generated_sql',
        ...(input.artifactKind ? { artifactKind: input.artifactKind } : {}),
        ...(input.draftBlockId ? { draftBlockId: input.draftBlockId } : {}),
        hasSqlPreview: input.hasSqlPreview ?? false,
        executionStatus: input.executionStatus ?? 'not_requested',
        ...(input.rowCount === undefined ? {} : { rowCount: input.rowCount }),
      };
    case 'refusal':
      return {
        lane: 'refusal',
        routeTier: 'no_answer',
        ...(input.refusalCode ? { refusalCode: input.refusalCode } : {}),
        reason: input.reason ?? input.label,
      };
  }
}

function skippedByTerminalLaneLabel(lane: CascadeLane, terminalLane: CascadeLane): string {
  return `${DEFAULT_LANE_LABELS[lane]} skipped because ${terminalLane} lane already produced a terminal outcome`;
}
