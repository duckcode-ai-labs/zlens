/**
 * App Studio's pending-save gate (C1).
 *
 * Every change an author makes in App Studio is saved in the background, one
 * save at a time. Publish and Run used to be disabled while a save was in
 * flight, so a click made right after choosing data did nothing and said
 * nothing. Now they wait here: the click is kept, the button says "Saving
 * changes…", and the action runs on the newest draft once every save has
 * landed. A save that fails stops Publish with a plain message and a retry.
 */

/** A save that did not land, and how to try it again. */
export interface DraftSaveFailure {
  /** The save's own error, shown in plain words. */
  message: string;
  /** Repeats the failed save from the newest draft. */
  retry?: () => Promise<unknown>;
}

export interface DraftSaveGate {
  /** Counts `work` as a save in flight until it settles. Returns `work`. */
  track<T>(work: Promise<T>): Promise<T>;
  /** Studio is busy with other work that changes the draft (not a tracked promise). */
  setBusy(busy: boolean): void;
  /** True while any save is in flight or Studio is busy. */
  pending(): boolean;
  /** Resolves once nothing is in flight; at once when nothing is. */
  settled(): Promise<void>;
  /** The latest save failed; cleared by the next save that lands. */
  recordFailure(failure: DraftSaveFailure): void;
  clearFailure(): void;
  failure(): DraftSaveFailure | null;
}

export function createDraftSaveGate(): DraftSaveGate {
  const inFlight = new Set<Promise<unknown>>();
  let busy = false;
  let lastFailure: DraftSaveFailure | null = null;
  let waiters: Array<() => void> = [];
  const idle = () => inFlight.size === 0 && !busy;
  const wake = () => {
    if (!idle() || waiters.length === 0) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };
  return {
    track(work) {
      inFlight.add(work);
      const done = () => {
        inFlight.delete(work);
        wake();
      };
      work.then(done, done);
      return work;
    },
    setBusy(next) {
      busy = next;
      wake();
    },
    pending: () => !idle(),
    settled() {
      if (idle()) return Promise.resolve();
      return new Promise<void>((resolve) => { waiters.push(resolve); });
    },
    recordFailure(failure) { lastFailure = failure; },
    clearFailure() { lastFailure = null; },
    failure: () => lastFailure,
  };
}

export type AfterSavesOutcome<T> =
  | { status: 'ran'; value: T }
  | { status: 'save_failed'; failure: DraftSaveFailure };

/**
 * Runs `action` once every pending save has landed. `onWaiting(true)` is
 * called only when there was something to wait for, and `onWaiting(false)`
 * when the wait ends, so the button can say "Saving changes…" meanwhile.
 * With `stopOnFailure`, a failed save keeps `action` from running and is
 * returned instead, so the caller can say so and offer a retry.
 */
export async function runAfterPendingSaves<T>(
  gate: DraftSaveGate,
  action: () => Promise<T>,
  options: { onWaiting?: (waiting: boolean) => void; stopOnFailure?: boolean } = {},
): Promise<AfterSavesOutcome<T>> {
  if (gate.pending()) {
    options.onWaiting?.(true);
    try {
      await gate.settled();
    } finally {
      options.onWaiting?.(false);
    }
  }
  const failure = gate.failure();
  if (options.stopOnFailure && failure) return { status: 'save_failed', failure };
  return { status: 'ran', value: await action() };
}

/** What Publish says when a save it waited for did not land. */
export const PUBLISH_SAVE_FAILED_LEAD = 'Your last change was not saved, so Publish did not start.';
