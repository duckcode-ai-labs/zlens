import { streamServerEvents, type ServerEventFrame } from './server-auth';
import { isSnowflakeApp } from '../snowflake-app/snowflake-app-mode';
import { isZLensStopped, markZLensStopped, stoppingNotice, subscribeZLensStopped } from '../snowflake-app/zlens-stopped';

/** How long the page waits before it opens a failed event stream again. */
export const STREAM_RETRY_MS = 5_000;
/**
 * In the app for Snowflake: after this many attempts in a row that could not open the stream, the page
 * takes ZLens as stopped and asks no more (each attempt would wake a stopped service).
 */
export const STREAM_FAILURES_BEFORE_STOPPED = 3;

/**
 * Follow one of the server's event streams (`/api/operations/events`, `/api/watch`) for as long as the page
 * wants it: opened again 5 s after it fails, as before. Returns the function that stops following.
 *
 * The `stopping` event (sent only inside Snowflake, as ZLens stops) is not passed on: the page takes ZLens as
 * stopped, which ends every stream and holds every other request (zlens-stopped.ts). In the app for
 * Snowflake, a stream that cannot be opened STREAM_FAILURES_BEFORE_STOPPED times in a row means the same.
 * Everywhere else a failed stream is opened again for as long as the page is open, as it always was.
 */
export function followServerEvents(
  path: string,
  onEvent: (frame: ServerEventFrame) => void,
  options: { retryMs?: number } = {},
): () => void {
  const retryMs = options.retryMs ?? STREAM_RETRY_MS;
  let following = true;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const stop = () => {
    following = false;
    if (retry) clearTimeout(retry);
    retry = undefined;
    controller?.abort();
  };
  const unsubscribe = subscribeZLensStopped(() => { if (isZLensStopped()) stop(); });

  const connect = () => {
    retry = undefined;
    if (!following || isZLensStopped()) return;
    const current = new AbortController();
    controller = current;
    let opened = false;
    void streamServerEvents(path, (frame) => {
      if (frame.event === 'stopping') {
        markZLensStopped(stoppingNotice(frame.data));
        return;
      }
      onEvent(frame);
    }, current.signal, () => {
      opened = true;
      failures = 0;
    }).catch(() => {
      if (!following || current.signal.aborted || isZLensStopped()) return;
      if (!opened) failures += 1;
      if (isSnowflakeApp() && failures >= STREAM_FAILURES_BEFORE_STOPPED) {
        markZLensStopped({ reason: 'lost' });
        return;
      }
      retry = setTimeout(connect, retryMs);
    });
  };

  connect();
  return () => {
    stop();
    unsubscribe();
  };
}
