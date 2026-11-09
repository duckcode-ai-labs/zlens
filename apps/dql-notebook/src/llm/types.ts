import type { DqlArtifactReference } from '@zlens/core/artifacts';

export type ProviderId = 'anthropic' | 'claude-agent-sdk' | 'claude-code' | 'openai' | 'gemini' | 'ollama' | 'custom-openai' | 'cortex';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentConversationDqlArtifact = DqlArtifactReference;

export interface AgentAnswerCascade {
  terminalLane?: 'certified' | 'semantic' | 'generated' | 'refusal' | string;
  routeTier?: 'certified_block' | 'semantic_metric' | 'generated_sql' | 'business_context' | 'no_answer' | string;
  label?: string;
  ref?: string;
  artifactKind?: string;
  refusalCode?: string;
  outcome?: Record<string, unknown>;
}

export interface AgentConversationContext {
  activeSurface?: 'notebook' | 'block' | 'app' | 'research' | 'chat' | string;
  conversationStateVersion?: number;
  activeTurnId?: string;
  activeTopic?: string;
  conversationSummary?: string;
  turns?: AgentConversationTurn[];
  sourceAnswerId?: string;
  sourceCertifiedBlock?: string;
  sourceQuestion?: string;
  sourceAnswerSummary?: string;
  followupKind?: 'generic' | 'drilldown' | 'contextual';
  requestedFilters?: string[];
  requestedDimensions?: string[];
  answerContract?: unknown;
  resultColumns?: string[];
  resultRowsSample?: Record<string, unknown>[];
  resultDimensionValues?: Record<string, string[]>;
  appliedFilters?: Record<string, unknown>;
  priorLimit?: number;
  priorMeasures?: string[];
  outputColumns?: string[];
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  route?: string;
  contextPackId?: string;
  draftBlockPath?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  cascade?: AgentAnswerCascade;
  selectedEvidence?: unknown[];
  sourceSql?: string;
  updatedAt?: string;
}

export interface AgentConversationTurn {
  id: string;
  question: string;
  answerSummary?: string;
  completedAt?: string;
  artifactKind?: string;
  sourceCertifiedBlock?: string;
  route?: string;
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  contextPackId?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  cascade?: AgentAnswerCascade;
  requestedFilters?: string[];
  requestedDimensions?: string[];
  requestedMeasures?: string[];
  answerContract?: unknown;
  topN?: number;
  result?: {
    columns?: string[];
    rowsSample?: Record<string, unknown>[];
    dimensionValues?: Record<string, string[]>;
    measureColumns?: string[];
    rowCount?: number;
  };
  sourceSql?: string;
}

export interface BlockProposal {
  name: string;
  path?: string;
  domain: string;
  owner: string;
  description: string;
  sql: string;
  blockType?: 'custom' | 'semantic';
  dqlSource?: string;
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ dimension: string; operator: string; values: string[] }>;
  timeDimension?: { name: string; granularity: string };
  tags?: string[];
  chartType?: string;
}

export type AgentTurn =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: unknown; isError?: boolean }
  | {
      kind: 'proposal';
      proposal: BlockProposal;
      governance: { certified: boolean; errors: string[]; warnings: string[] };
    }
  | { kind: 'error'; message: string }
  | { kind: 'done'; stopReason?: string };
