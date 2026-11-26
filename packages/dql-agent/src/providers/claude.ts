import type {
  AgentProvider,
  AgentMessage,
  AgentToolDefinition,
  NativeToolLoopStop,
  NativeToolLoopResult,
  ProviderToolLoopOptions,
  ProviderRunOptions,
  ProviderDispatchOperation,
} from './types.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './types.js';
import { supportsReasoningEffort } from './reasoning-effort.js';
import { compactToolOutput } from './tool-output.js';
import { fetchProviderHttpDispatch, providerDispatchLimit, type ProviderHttpTransport } from './dispatch.js';
import { adoptProseAsFinishNarration, admittedToolNames } from '../agentic/tool-loop.js';
import { runGatedTool } from '../agentic/tool-gate.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Translate the abstract reasoning effort into Anthropic's `output_config.effort`
 * — the same mechanism the chat-cell agent loop already uses. Emits an empty
 * object (spread-friendly) when no effort is set or the model can't reason, so it
 * never sends an unsupported field to older Claude models or plain gateways.
 */
function anthropicReasoning(model: string, options: ProviderRunOptions): Record<string, unknown> {
  if (!options.reasoningEffort || !supportsReasoningEffort('claude', model)) return {};
  return { output_config: { effort: options.reasoningEffort } };
}

/** A 400 whose body implicates the effort/output_config field — safe to retry without it. */
function isEffortRejection(status: number, body: string): boolean {
  return status === 400
    && /output_config|effort|unexpected|unsupported|unrecognized|not\s+supported|thinking|temperature/i.test(body);
}

/**
 * Extended thinking and a custom temperature cannot be sent together.
 *
 * The Messages API accepts `temperature` only at 1 while thinking is enabled,
 * and rejects the request outright otherwise. Every Ask turn on a subscription
 * transport carries both — a reasoning effort from the run and a temperature
 * from the caller — so every one of them 400'd, and the user saw "The AI
 * provider could not complete this Ask step" for a question that was perfectly
 * well formed. Thinking is the deliberate, per-run setting; the temperature is
 * a default. The default gives way.
 */
/**
 * Models this process has seen retire `temperature`. Process-local and
 * additive: the worst a stale entry costs is a request without an optional
 * sampling field.
 */
const MODELS_REJECTING_SAMPLING = new Set<string>();

/**
 * Models known to have retired `temperature` (checked against the Messages API
 * on 2026-09-18: Opus 4.7, Opus 4.8 and every Claude 5 model answer 400
 * "`temperature` is deprecated for this model"; Opus 4.6, Sonnet 4.6 and Haiku
 * 4.5 accept it). Knowing it up front matters: learning it from the 400 costs a
 * second physical attempt, and a call allowed one (the Ask reading) failed —
 * the first question after every server start stopped with "the AI model did
 * not respond". A model not listed here is still learned from its 400.
 */
export function retiresSampling(model: string): boolean {
  if (MODELS_REJECTING_SAMPLING.has(model)) return true;
  const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i.exec(model);
  if (!match) return false;
  const major = Number(match[2]);
  // A dated suffix (claude-haiku-4-5-20251001) is not a minor version.
  const minor = match[3] && match[3].length <= 2 ? Number(match[3]) : 0;
  if (major >= 5) return true;
  return match[1]!.toLowerCase() === 'opus' && major === 4 && minor >= 7;
}

/** Every optional sampling control, removed together. */
function withoutSamplingFields(body: Record<string, unknown>): Record<string, unknown> {
  const { temperature, top_p: topP, top_k: topK, ...rest } = body;
  void temperature; void topP; void topK;
  return rest;
}

function withoutConflictingSampling(
  baseBody: Record<string, unknown>,
  reasoning: Record<string, unknown>,
): Record<string, unknown> {
  const thinking = reasoning.thinking;
  const enabled = Boolean(thinking)
    && typeof thinking === 'object'
    && (thinking as { type?: unknown }).type === 'enabled';
  if (!enabled || !('temperature' in baseBody)) return baseBody;
  const { temperature, top_p: topP, top_k: topK, ...rest } = baseBody;
  void temperature; void topP; void topK;
  return rest;
}

/**
 * POST to the Messages API with a defensive effort fallback: if the request
 * carried `output_config.effort` and the API 400s implicating it (a model or
 * gateway that doesn't accept it despite our capability gate), retry once WITHOUT
 * the effort field so the turn degrades gracefully instead of failing.
 */
export async function postMessages(
  url: string,
  headers: Record<string, string>,
  baseBody: Record<string, unknown>,
  reasoning: Record<string, unknown>,
  dispatch: {
    operation: ProviderDispatchOperation;
    options: ProviderRunOptions;
    nextAttempt(): number;
  },
  transport?: ProviderHttpTransport,
): Promise<Response> {
  const send = (envelope: Record<string, unknown>): Promise<Response> => {
    const attemptIndex = dispatch.nextAttempt();
    return fetchProviderHttpDispatch({
      provider: 'claude',
      operation: dispatch.operation,
      attemptIndex,
      envelope,
      options: dispatch.options,
      url,
      init: {
        method: 'POST',
        headers,
        signal: dispatch.options.signal,
      },
      ...(transport ? { transport } : {}),
    });
  };
  const model = typeof baseBody.model === 'string' ? baseBody.model : '';
  const opening = retiresSampling(model)
    ? withoutSamplingFields(baseBody)
    : withoutConflictingSampling(baseBody, reasoning);
  const res = await send({ ...opening, ...reasoning });
  if (res.ok) return res;
  const peek = await res.clone().text().catch(() => '');
  // STRIP EXACTLY WHAT THE API NAMED, THEN TRY ONCE MORE.
  //
  // Models retire sampling controls on their own schedule, and a rejected
  // OPTIONAL field should never cost a turn: `claude-sonnet-5` answers
  // "`temperature` is deprecated for this model", and ZLens sent temperature on
  // every dispatch, so every question that reached this transport failed with
  // "the AI provider could not complete this Ask step". Dropping the field the
  // error names is a smaller, more honest degradation than dropping the
  // reasoning config the run asked for.
  if (res.status === 400 && /temperature|top_p|top_k/i.test(peek)) {
    // Remember it. A model that has retired `temperature` will reject it on
    // every dispatch, and paying a doomed round trip each time doubled the
    // wall clock of every turn on this transport.
    const model = typeof baseBody.model === 'string' ? baseBody.model : '';
    if (model) MODELS_REJECTING_SAMPLING.add(model);
    const retried = await send({ ...withoutSamplingFields(baseBody), ...reasoning });
    if (retried.ok || Object.keys(reasoning).length === 0) return retried;
    const retryPeek = await retried.clone().text().catch(() => '');
    return isEffortRejection(retried.status, retryPeek) ? send(withoutSamplingFields(baseBody)) : retried;
  }
  if (Object.keys(reasoning).length === 0) return res;
  if (!isEffortRejection(res.status, peek)) return res;
  return send(baseBody);
}

/**
 * Normalize an Anthropic base URL to the SDK's "root" convention: the host (and
 * optional gateway path) that `/v1/messages` is appended to. Trailing slashes and
 * a trailing `/v1` are stripped so both `https://gw/anthropic` and
 * `https://gw/anthropic/v1` resolve to the same endpoint. Enterprise gateways
 * (LiteLLM, Portkey, Cloudflare AI Gateway, internal proxies) mirror this path.
 */
export function normalizeAnthropicBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return DEFAULT_ANTHROPIC_BASE_URL;
  // Trailing slashes trimmed by hand: `/\/+$/` is slow on a value with many slashes (CodeQL js/polynomial-redos).
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '/') end -= 1;
  return raw.slice(0, end).replace(/\/v1$/, '');
}

/**
 * Anthropic Claude provider via the Messages API. Reads ANTHROPIC_API_KEY and an
 * optional ANTHROPIC_BASE_URL (or an explicit baseUrl) so enterprise deployments
 * can route through a gateway/proxy.
 *
 * We deliberately avoid `@anthropic-ai/sdk` to keep dql-agent zero-dep —
 * the existing `apps/cli/src/llm/providers/claude-agent-sdk.ts` already
 * uses the SDK for the chat-cell agent loop, and that's a different layer.
 * Here we want a simple "generate from a message list" surface.
 */
export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  /** Claude on another cloud (Bedrock, Vertex): its URL, body and signature. */
  private readonly transport?: ProviderHttpTransport;
  /** False where the service's stream format is not Anthropic's (Bedrock): stream by one final delta. */
  private readonly streaming: boolean;

  constructor(opts: { apiKey?: string; baseUrl?: string; model?: string; transport?: ProviderHttpTransport; streaming?: boolean } = {}) {
    this.apiKey = opts.apiKey ?? (opts.transport ? undefined : process.env.ANTHROPIC_API_KEY);
    this.baseUrl = normalizeAnthropicBaseUrl(opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL);
    this.defaultModel = opts.model ?? 'claude-opus-4-7';
    this.transport = opts.transport;
    this.streaming = opts.streaming ?? true;
  }

  async available(): Promise<boolean> {
    return Boolean(this.apiKey || this.transport);
  }

  private post(...args: Parameters<typeof postMessages>): Promise<Response> {
    const [url, headers, body, reasoning, dispatch] = args;
    return postMessages(url, headers, body, reasoning, dispatch, this.transport);
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    if (!this.apiKey && !this.transport) {
      throw new Error('claude: ANTHROPIC_API_KEY is not set');
    }
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const model = options.model ?? this.defaultModel;
    let dispatches = 0;
    const res = await this.post(
      `${this.baseUrl}/v1/messages`,
      {
        'x-api-key': this.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      {
        model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: options.temperature ?? 0.2,
        system: system || undefined,
        messages: turns,
      },
      anthropicReasoning(model, options),
      { operation: 'generate', options, nextAttempt: () => ++dispatches },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`claude: ${res.status} ${body}`);
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const blocks = json.content ?? [];
    return blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }

  async generateWithTools(
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    options: ProviderToolLoopOptions = {},
  ): Promise<NativeToolLoopResult> {
    if (!this.apiKey && !this.transport) {
      throw new Error('claude: ANTHROPIC_API_KEY is not set');
    }
    if (tools.length === 0) return this.generate(messages, options);
    return runAnthropicNativeToolLoop({
      label: 'claude',
      endpoint: `${this.baseUrl}/v1/messages`,
      defaultModel: this.defaultModel,
      defaultMaxTokens: 1024,
      headers: () => ({
        'x-api-key': this.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }),
      buildSystem: (text) => text || undefined,
      reasoning: anthropicReasoning,
      post: (...args: Parameters<typeof postMessages>) => this.post(...args),
    }, messages, tools, options);
  }

  async generateStream(
    messages: AgentMessage[],
    options: ProviderRunOptions,
    onDelta: (delta: string) => void,
  ): Promise<string> {
    if (!this.apiKey && !this.transport) {
      throw new Error('claude: ANTHROPIC_API_KEY is not set');
    }
    if (!this.streaming) {
      // The service streams in its own framing (Bedrock's event stream):
      // answer whole, as one delta.
      const text = await this.generate(messages, options);
      if (text) onDelta(text);
      return text;
    }
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const model = options.model ?? this.defaultModel;
    let dispatches = 0;
    const res = await this.post(
      `${this.baseUrl}/v1/messages`,
      {
        'x-api-key': this.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      {
        model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: options.temperature ?? 0.2,
        system: system || undefined,
        messages: turns,
        stream: true,
      },
      anthropicReasoning(model, options),
      { operation: 'generate_stream', options, nextAttempt: () => ++dispatches },
    );
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`claude: ${res.status} ${body}`);
    }
    let full = '';
    await consumeSse(res.body, (data) => {
      try {
        const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          full += event.delta.text;
          onDelta(event.delta.text);
        }
      } catch {
        // ignore keep-alive / non-JSON lines
      }
    });
    return full;
  }
}

function assertMayStartToolCall(options: ProviderToolLoopOptions, toolName?: string): void {
  // finish_answer is host-local terminal control after an already admitted
  // provider response; it must not be treated as a fresh discovery branch.
  if (toolName === 'finish_answer') return;
  if (options.mayStartToolCall?.() === false) {
    throw Object.assign(new Error('The run soft target elapsed before this tool branch could start.'), {
      code: 'RUN_SOFT_TARGET_EXCEEDED',
    });
  }
}

/**
 * Only the canonical V2 terminal control may end a native tool loop early.
 * A generic `{ finished: true }` from a retrieval/execution tool is not a
 * terminal authority, so the check stays intentionally narrow at the caller.
 */
function isFinishedToolOutput(value: unknown): boolean {
  return Boolean(value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { finished?: unknown }).finished === true);
}

function isAskV2TerminalControlTool(name: string): boolean {
  return name === 'finish_answer' || name === 'request_clarification';
}

function nativeToolLoopStop(
  kind: NativeToolLoopStop['kind'],
  text: string,
  toolCalls: number,
): NativeToolLoopResult {
  return { version: 1, kind, text, toolCalls };
}

function toolLoopErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' ? code : undefined;
}

function nativeToolLoopStopForError(error: unknown, toolCalls: number): NativeToolLoopResult | undefined {
  const code = toolLoopErrorCode(error);
  if (code === 'RUN_SOFT_TARGET_EXCEEDED') {
    return nativeToolLoopStop('run_soft_target_exceeded', '', toolCalls);
  }
  if (code === 'RUN_DEADLINE_INSUFFICIENT') {
    return nativeToolLoopStop('run_deadline_insufficient', '', toolCalls);
  }
  if (code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') {
    return nativeToolLoopStop('provider_dispatch_budget_exhausted', '', toolCalls);
  }
  return undefined;
}

/** Resolve the host's current V2 policy immediately before a native send. */
function nativeToolPolicy(
  options: ProviderToolLoopOptions,
  tools: readonly AgentToolDefinition[],
): { tools: AgentToolDefinition[]; admittedTools: AgentToolDefinition[]; terminalActionToolNames: Set<string>; visibleTerminalActionToolNames: Set<string>; instruction?: string } {
  const policy = options.getCurrentToolPolicy?.();
  const allowed = admittedToolNames(policy?.allowedToolNames ?? tools.map((tool) => tool.name), tools);
  // A hidden alias is admitted through its advertised tool — it stays in the
  // dispatch table — but is never declared to the API.
  const admitted = tools.filter((tool) => allowed.has(tool.name));
  const enabled = admitted.filter((tool) => !tool.hidden);
  const terminalActionToolNames = new Set(
    [...admittedToolNames(policy?.terminalActionToolNames ?? [], tools)].filter((name) => allowed.has(name)),
  );
  return {
    tools: enabled,
    admittedTools: admitted,
    terminalActionToolNames,
    visibleTerminalActionToolNames: new Set([...terminalActionToolNames].filter((name) => enabled.some((tool) => tool.name === name))),
    ...(policy?.instruction?.trim() ? { instruction: policy.instruction.trim() } : {}),
  };
}

/** Consume an SSE stream, invoking `onData` with each `data:` payload (skips [DONE]). */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let sep = buffer.search(/\r?\n\r?\n/);
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(buffer[sep] === '\r' ? sep + 4 : sep + 2);
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') onData(data);
        }
        sep = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (done) break;
  }
}


/**
 * What one Anthropic transport must supply to drive the shared native tool
 * loop. Everything else — turn management, tool_result plumbing, policy
 * narrowing, budget accounting — is identical and lives in the loop.
 */
export interface AnthropicToolLoopTransport {
  /** Used in error text so a failure names the transport a user configured. */
  label: string;
  endpoint: string;
  defaultModel: string;
  defaultMaxTokens: number;
  headers(): Record<string, string>;
  /** Plain string for API-key transports; a system block array for OAuth. */
  buildSystem(text: string | undefined): unknown;
  reasoning(model: string, options: ProviderRunOptions): Record<string, unknown>;
  post(
    url: string,
    headers: Record<string, string>,
    baseBody: Record<string, unknown>,
    reasoning: Record<string, unknown>,
    dispatch: { operation: ProviderDispatchOperation; options: ProviderRunOptions; nextAttempt(): number },
  ): Promise<Response>;
}

/**
 * The Anthropic native tool loop, shared by every Claude transport.
 *
 * Two transports speak this protocol: the API-key provider and the
 * subscription OAuth provider. They differ only in where the request goes,
 * which headers authorize it, how the system prompt is shaped, and how
 * reasoning effort is expressed — never in how the conversation is driven.
 * Keeping the loop in one place is what lets a subscription user get native
 * tool calling (one round trip per turn, server-side argument validation,
 * cacheable prefix) instead of a text protocol that re-ships the whole
 * transcript to a fresh process every time.
 */
export async function runAnthropicNativeToolLoop(
transport: AnthropicToolLoopTransport,
messages: AgentMessage[],
tools: AgentToolDefinition[],
options: ProviderToolLoopOptions = {},
): Promise<NativeToolLoopResult> {

  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns: Array<Record<string, unknown>> = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const model = options.model ?? transport.defaultModel;
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const dispatchLimit = providerDispatchLimit(options);
  const requestedToolBudget = Math.max(0, Math.min(dispatchLimit <= 2 ? 4 : 30, options.maxToolCalls ?? 8));
  // The V2 controller can reserve the last physical provider send for one
  // host-approved terminal action. Preserve the legacy native-loop budget
  // semantics when no live policy is supplied.
  const dynamicToolPolicy = Boolean(options.getCurrentToolPolicy);
  const ordinaryToolBudget = dynamicToolPolicy
    ? Math.min(requestedToolBudget, Math.max(0, dispatchLimit - 1))
    : requestedToolBudget;
  let toolCallsUsed = 0;
  let lastText = '';
  let dispatches = 0;
  const requiresPostExecutionFinish = dynamicToolPolicy
    && tools.some((tool) => tool.name === 'finish_answer');
  let requiredActionSignature = '';
  let requiredActionProseRetries = 0;
  const dispatch = {
    operation: 'generate_with_tools' as const,
    options,
    nextAttempt: () => ++dispatches,
  };

  const forcedFinal = async (): Promise<string> => {
    const finalRes = await transport.post(
      transport.endpoint,
      transport.headers(),
      {
        model,
        max_tokens: options.maxTokens ?? transport.defaultMaxTokens,
        temperature: options.temperature ?? 0.2,
        system: transport.buildSystem(system) as never,
        messages: turns,
      },
      transport.reasoning(model, options),
      dispatch,
    );
    if (!finalRes.ok) return '';
    const finalJson = (await finalRes.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const blocks = finalJson.content ?? [];
    if (blocks.some((block) => block.type === 'tool_use')) return '';
    return blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('').trim();
  };

  for (;;) {
    const currentPolicy = nativeToolPolicy(options, tools);
    const nextRequiredActionSignature = [...currentPolicy.terminalActionToolNames].sort().join('|');
    if (nextRequiredActionSignature !== requiredActionSignature) {
      requiredActionSignature = nextRequiredActionSignature;
      requiredActionProseRetries = 0;
    }
    const narrationControlRound = currentPolicy.terminalActionToolNames.has('finish_answer');
    // A clarification is its own host terminal; only a selected execution
    // action consumes the final post-result narration reserve.
    const terminalExecutionAction = [...currentPolicy.terminalActionToolNames]
      .some((name) => !isAskV2TerminalControlTool(name));
    const reservePostExecutionNarration = requiresPostExecutionFinish && terminalExecutionAction;
    // Keep the last physical tool-followup for the controller-selected
    // execution action and the final physical send for finish/narration.
    // This is host-owned progress accounting only; the model still chooses
    // among the snapshot-bound terminal tools the kernel exposes.
    const finalExecutionActionRound = !narrationControlRound
      && dispatches >= Math.max(0, dispatchLimit - (reservePostExecutionNarration ? 2 : 1));
    const terminalActionRound = dynamicToolPolicy
      && currentPolicy.terminalActionToolNames.size > 0
      && (toolCallsUsed >= ordinaryToolBudget
        || (narrationControlRound ? dispatches >= dispatchLimit - 1 : finalExecutionActionRound));
    if (dynamicToolPolicy && toolCallsUsed >= ordinaryToolBudget && !terminalActionRound) {
      return forcedFinal();
    }
    const roundTools = terminalActionRound
      ? currentPolicy.tools.filter((tool) => currentPolicy.terminalActionToolNames.has(tool.name))
      : currentPolicy.tools;
    const roundToolMap = new Map(
      (terminalActionRound
        ? currentPolicy.admittedTools.filter((tool) => currentPolicy.terminalActionToolNames.has(tool.name))
        : currentPolicy.admittedTools).map((tool) => [tool.name, tool]),
    );
    const roundToolDefs = roundTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    const roundSystem = [system, currentPolicy.instruction].filter((value): value is string => Boolean(value)).join('\n\n') || undefined;
    // THE MESSAGES API'S OWN PRECONDITIONS, HONOURED BEFORE SENDING.
    //
    // Extended thinking may not be combined with a forced `tool_choice`, and a
    // forced tool choice is exactly what the kernel asks for when it narrows to
    // one terminal action. Sending both 400s the request, which on this
    // transport meant the LAST step of a turn — the one that would have
    // produced the answer — could never be sent. Reasoning is the request's
    // optional part; the tool the host requires is not.
    const forcesToolChoice = dynamicToolPolicy && currentPolicy.visibleTerminalActionToolNames.size === 1;
    const roundReasoning = ((): Record<string, unknown> => {
      const reasoning = transport.reasoning(model, options);
      if (!forcesToolChoice) return reasoning;
      const { thinking, ...rest } = reasoning;
      void thinking;
      return rest;
    })();
    let res: Response;
    try {
      res = await transport.post(
        transport.endpoint,
        transport.headers(),
        {
          model,
          max_tokens: options.maxTokens ?? transport.defaultMaxTokens,
          temperature: options.temperature ?? 0.2,
          system: transport.buildSystem(roundSystem) as never,
          messages: turns,
          tools: roundToolDefs,
          ...(forcesToolChoice
            ? { tool_choice: { type: 'tool', name: [...currentPolicy.visibleTerminalActionToolNames][0]! } }
            : {}),
        },
        roundReasoning,
        dispatch,
      );
    } catch (error) {
      const terminal = nativeToolLoopStopForError(error, toolCallsUsed);
      if (terminal) return terminal;
      throw error;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`${transport.label}: ${res.status} ${body}`);
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    };
    const blocks = json.content ?? [];
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const toolUses = blocks.filter((block): block is { type: string; id: string; name: string; input?: unknown } =>
      block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
    );
    if (toolUses.length === 0) {
      // Prose in the narration phase is the narration the host asked for.
      if (dynamicToolPolicy && text && await adoptProseAsFinishNarration(
        options,
        tools,
        { allowedToolNames: new Set(currentPolicy.tools.map((tool) => tool.name)), terminalActionToolNames: currentPolicy.terminalActionToolNames },
        text,
      )) {
        toolCallsUsed += 1;
        return text;
      }
      // Do not let prose bypass a host-required V2 execution/terminal
      // action. The next send exposes only the narrowed safe action.
      if (dynamicToolPolicy && currentPolicy.terminalActionToolNames.size > 0) {
        // No retry may be invented after the last admitted physical send.
        // Preserve that as a budget terminal (and retain a validated
        // result); `invalid_tool_response` is reserved for two ignored
        // narrowed actions while a retry remained available.
        if (dispatches >= dispatchLimit) {
          return nativeToolLoopStop('provider_dispatch_budget_exhausted', '', toolCallsUsed);
        }
        if (requiredActionProseRetries >= 1) {
          return nativeToolLoopStop('invalid_tool_response', '', toolCallsUsed);
        }
        requiredActionProseRetries += 1;
        turns.push({
          role: 'user',
          content: `Controller progression required. Call exactly one of: ${[...currentPolicy.visibleTerminalActionToolNames].join(', ')}. Do not answer in prose.`,
        });
        continue;
      }
      if (text) lastText = text;
      return text || lastText;
    }
    if (text) lastText = text;
    const roundToolBudget = terminalActionRound ? ordinaryToolBudget + 1 : ordinaryToolBudget;
    const invalidTerminalAction = terminalActionRound && (
      toolUses.length !== 1 || !currentPolicy.terminalActionToolNames.has(toolUses[0]!.name)
    );
    if (invalidTerminalAction || toolCallsUsed + toolUses.length > roundToolBudget) {
      options.onToolCall?.({
        name: 'tool_budget_exhausted',
        input: {
          requestedToolCalls: toolUses.map((call) => call.name),
          maxToolCalls: roundToolBudget,
          toolCallsUsed,
        },
        output: { error: `Tool-call budget exhausted after ${toolCallsUsed} call(s).` },
        isError: true,
      });
      if (dynamicToolPolicy) {
        return nativeToolLoopStop('tool_budget_exhausted', '', toolCallsUsed);
      }
      // Graceful final turn: instead of dead-ending on whatever stray text the
      // model last emitted, ask it to answer NOW from what the prior tool calls
      // already returned — with `tools` OMITTED from the request so it physically
      // cannot request another tool and the loop is guaranteed to terminate.
      turns.push({
        role: 'user',
        content: 'Tool budget reached — do not call any more tools. Answer now using only the information the tool calls above already returned, following the required output format.',
      });
      try {
        const finalText = await forcedFinal();
        if (finalText) return finalText;
      } catch {
        // Fall through to the legacy behavior on any final-turn failure.
      }
      return lastText || JSON.stringify({
        summary: `Tool-call budget exhausted after ${toolCallsUsed} call(s).`,
      });
    }

    turns.push({ role: 'assistant', content: blocks });
    const toolResults: Array<Record<string, unknown>> = [];
    for (const call of toolUses) {
      toolCallsUsed += 1;
      const tool = roundToolMap.get(call.name) ?? (dynamicToolPolicy ? undefined : toolMap.get(call.name));
      let output: unknown;
      let isError = false;
      let deadlineStop: NativeToolLoopResult | undefined;
      const toolStartedAt = Date.now();
      if (!tool) {
        output = { error: `Unknown tool: ${call.name}` };
        isError = true;
      } else {
        try {
          assertMayStartToolCall(options, call.name);
          output = await runGatedTool(tool, call.input ?? {});
        } catch (err) {
          const code = toolLoopErrorCode(err);
          output = {
            error: err instanceof Error ? err.message : String(err),
            ...(code ? { code } : {}),
          };
          isError = true;
          deadlineStop = nativeToolLoopStopForError(err, toolCallsUsed);
        }
      }
      options.onToolCall?.({ name: call.name, input: call.input ?? {}, output, isError, durationMs: Date.now() - toolStartedAt });
      if (deadlineStop) return deadlineStop;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: compactToolOutput(output),
        is_error: isError,
      });
      // A completed Ask V2 host control already contains the answer or
      // stable clarification. A rejected control has no `finished` marker
      // and must instead become the next controller observation.
      if (isAskV2TerminalControlTool(call.name) && !isError && isFinishedToolOutput(output)) {
        return text || lastText;
      }
    }
    if (terminalActionRound) {
      const terminalCall = toolUses[0];
      if (terminalCall && isAskV2TerminalControlTool(terminalCall.name)) {
        return nativeToolLoopStop('tool_budget_exhausted', '', toolCallsUsed);
      }
      // A narrowed execution action is not the conversational terminal.
      // Continue once so the resulting live policy can require and receive
      // the bounded finish_answer/narration control.
      if (reservePostExecutionNarration) {
        turns.push({ role: 'user', content: toolResults });
        continue;
      }
      return text || lastText;
    }
    turns.push({ role: 'user', content: toolResults });
    // Keep the historical short-loop prose final only for static tool
    // surfaces. Ask V2's live policy uses the last send for a bounded
    // terminal tool action (for example semantic execution).
    if (dispatchLimit <= 2 && !dynamicToolPolicy) {
      try {
        const finalText = await forcedFinal();
        return finalText || lastText || JSON.stringify({
          summary: 'The provider did not return a final answer within the bounded tool round.',
        });
      } catch {
        return lastText || JSON.stringify({
          summary: 'The provider dispatch budget was exhausted before a final answer.',
        });
      }
    }
  }
}

/** The shared Anthropic POST helper, including the effort-rejection retry. */
export const anthropicToolLoopPost = postMessages;
