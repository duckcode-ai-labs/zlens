import type {
  ProviderDispatchCompletionEvent,
  ProviderDispatchOperation,
  ProviderName,
  ProviderRunOptions,
} from './types.js';
import { recordProviderUsage } from './usage-ledger.js';

/**
 * The physical ceiling on sends from one provider call when the caller sets no
 * `maxProviderDispatches`. This is a backstop against a runaway loop, not a
 * budget: the run-scoped dispatch ledger is the only authority on how many
 * sends a turn may make, and a caller that wants a tighter bound states it.
 * (A silent default of two ended real turns mid-discovery for months.)
 */
export const PROVIDER_DISPATCH_PHYSICAL_CEILING = 30;

export function providerDispatchLimit(options: ProviderRunOptions): number {
  return Math.max(1, Math.min(PROVIDER_DISPATCH_PHYSICAL_CEILING, options.maxProviderDispatches ?? PROVIDER_DISPATCH_PHYSICAL_CEILING));
}

/**
 * Enforce the physical-send budget and return the exact envelope to serialize.
 * The observer runs even when fetch will reject for cancellation or transport
 * failure, so attempted dispatches have matching counters and receipts.
 */
export function prepareProviderHttpDispatch(input: {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  envelope: Record<string, unknown>;
  options: ProviderRunOptions;
}): Record<string, unknown> {
  const limit = providerDispatchLimit(input.options);
  if (input.attemptIndex > limit) {
    const error = Object.assign(new Error(
      `${input.provider}: provider dispatch budget exhausted after ${limit} attempt${limit === 1 ? '' : 's'}`,
    ), { code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' });
    try {
      input.options.onProviderDispatchRejected?.({
        provider: input.provider,
        operation: input.operation,
        attemptIndex: input.attemptIndex,
        ...(input.options.model ? { model: input.options.model } : {}),
        error,
      });
    } catch {
      // A local observation is never allowed to influence admission.
    }
    throw error;
  }
  return input.options.onProviderDispatch?.({
    provider: input.provider,
    operation: input.operation,
    attemptIndex: input.attemptIndex,
    ...(input.options.model ? { model: input.options.model } : {}),
    options: {
      ...(input.options.maxTokens !== undefined ? { maxTokens: input.options.maxTokens } : {}),
      ...(input.options.temperature !== undefined ? { temperature: input.options.temperature } : {}),
      ...(input.options.reasoningEffort ? { reasoningEffort: input.options.reasoningEffort } : {}),
    },
    envelope: input.envelope,
  }) ?? input.envelope;
}

/**
 * Emit a content-free observation when a physical send settles. This stays
 * outside provider receipts and does not affect admission, retries, or the
 * wire payload. It exists so a local trace can close the span started by the
 * matching `onProviderDispatch` callback with its real outcome and duration.
 */
export function completeProviderHttpDispatch(input: {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  options: ProviderRunOptions;
}, completion: Omit<ProviderDispatchCompletionEvent, 'provider' | 'operation' | 'attemptIndex' | 'model'>): void {
  try {
    input.options.onProviderDispatchComplete?.({
      provider: input.provider,
      operation: input.operation,
      attemptIndex: input.attemptIndex,
      ...(input.options.model ? { model: input.options.model } : {}),
      ...completion,
    });
  } catch {
    // Observation must never turn a completed provider request into a failed
    // Ask run. The call site still owns the actual transport result.
  }
}

/**
 * Shared physical send wrapper. Providers still own parsing and retry policy;
 * this reports the actual transport settlement only. A 2xx response is not a
 * successful provider result until the provider has consumed/validated it.
 */
/**
 * Where and how one provider request is sent when it does not go to the
 * provider's own public API — for example Claude on Amazon Bedrock or Google
 * Vertex, which take a different URL, a reshaped body and their own
 * signature. Given the request ZLens would send, returns what to send instead.
 */
export interface ProviderHttpTransport {
  prepare(input: { url: string; body: Record<string, unknown>; headers: Record<string, string> }): Promise<{ url: string; body: string; headers: Record<string, string> }>;
  /**
   * Sends the prepared request itself, in place of `fetch`, when the transport has a route of its
   * own (Claude through Snowflake Cortex answers through SQL when the account refuses its REST API).
   * It returns the provider's own response shape, so parsing, retries and accounting stay as they are.
   */
  send?(prepared: { url: string; body: string; headers: Record<string, string> }, init: Omit<RequestInit, 'body' | 'headers'>): Promise<Response>;
}

export async function fetchProviderHttpDispatch(input: {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  envelope: Record<string, unknown>;
  options: ProviderRunOptions;
  url: string;
  init: Omit<RequestInit, 'body'>;
  transport?: ProviderHttpTransport;
}): Promise<Response> {
  const dispatchedBody = prepareProviderHttpDispatch(input);
  try {
    const prepared = input.transport
      ? await input.transport.prepare({ url: input.url, body: dispatchedBody, headers: { ...(input.init.headers as Record<string, string> | undefined) } })
      : { url: input.url, body: JSON.stringify(dispatchedBody), headers: input.init.headers };
    const response = input.transport?.send
      ? await input.transport.send(prepared as { url: string; body: string; headers: Record<string, string> }, input.init)
      : await fetch(prepared.url, {
        ...input.init,
        headers: prepared.headers,
        body: prepared.body,
      });
    completeProviderHttpDispatch(input, {
      outcome: response.ok ? 'ok' : 'error',
      settlement: 'transport',
      httpStatus: response.status,
    });
    const model = typeof dispatchedBody.model === 'string' ? dispatchedBody.model : /\/models\/([^/:?]+)/.exec(input.url)?.[1];
    recordProviderUsage({ provider: input.provider, operation: input.operation, ...(model ? { model } : {}), response });
    return response;
  } catch (error) {
    completeProviderHttpDispatch(input, {
      outcome: input.options.signal?.aborted ? 'cancelled' : 'error',
      settlement: 'transport',
      error,
    });
    throw error;
  }
}
