import type { ServerResponse } from 'node:http';

/**
 * How often a long-lived event stream sends a keep-alive line while it has
 * nothing else to say.
 *
 * Snowflake documents that the ingress in front of the Native App ends a
 * connection with no activity for 90 seconds (Snowpark Container Services,
 * service networking, "Ingress connection timeout"). Other proxies commonly
 * cut at 60 s (nginx `proxy_read_timeout`, cloud load balancers). An Ask
 * stream is quiet while an AI call runs (on Cortex a reading step took up to
 * 70 s), and in outside testing a 96 s run lost its stream. 15 s stays well
 * under every common idle cut. Should a proxy end a long stream anyway, the
 * notebook reconnects to the run by id (`AgentRunStreamDroppedError`).
 */
export const SSE_KEEP_ALIVE_MS = 15_000;

/**
 * Write an SSE comment line (`: keep-alive`) every `intervalMs` until the
 * response ends or closes. Comment lines carry no event: EventSource and the
 * notebook's own stream reader skip them. Returns a function that stops it.
 */
export function keepSseStreamAlive(response: ServerResponse, intervalMs: number = SSE_KEEP_ALIVE_MS): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(timer);
      return;
    }
    try {
      response.write(': keep-alive\n\n');
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  response.once('close', stop);
  return stop;
}
