import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PUBLISH_SAVE_FAILED_LEAD, createDraftSaveGate, runAfterPendingSaves } from './app-studio-save-gate';
import { StudioErrorBanner } from './builder/studio-ui';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Publish waits for pending saves instead of doing nothing (C1)', () => {
  it('a click while a change is saving says "Saving changes…" and publishes once the save lands', async () => {
    const gate = createDraftSaveGate();
    const save = deferred<string>();
    void gate.track(save.promise);
    const publish = vi.fn(async () => 'dialog open');
    const waiting: boolean[] = [];

    const click = runAfterPendingSaves(gate, publish, { stopOnFailure: true, onWaiting: (value) => waiting.push(value) });
    await flush();
    // The click is kept, not dropped, and the button says it is saving.
    expect(waiting).toEqual([true]);
    expect(publish).not.toHaveBeenCalled();

    save.resolve('saved');
    await expect(click).resolves.toEqual({ status: 'ran', value: 'dialog open' });
    expect(waiting).toEqual([true, false]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('waits for every queued save and for busy Studio work, not just the first', async () => {
    const gate = createDraftSaveGate();
    const first = deferred();
    const second = deferred();
    void gate.track(first.promise);
    void gate.track(second.promise);
    gate.setBusy(true);
    const publish = vi.fn(async () => undefined);
    const click = runAfterPendingSaves(gate, publish);

    first.resolve();
    await flush();
    expect(publish).not.toHaveBeenCalled();
    second.resolve();
    await flush();
    expect(publish).not.toHaveBeenCalled();
    gate.setBusy(false);
    await click;
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('runs at once, without a saving state, when nothing is saving', async () => {
    const gate = createDraftSaveGate();
    const onWaiting = vi.fn();
    const publish = vi.fn(async () => 1);
    await expect(runAfterPendingSaves(gate, publish, { onWaiting })).resolves.toEqual({ status: 'ran', value: 1 });
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('a save that fails stops Publish and hands back the failure with its retry', async () => {
    const gate = createDraftSaveGate();
    const save = deferred();
    const retry = vi.fn(async () => undefined);
    void gate.track(save.promise.then(() => gate.recordFailure({ message: 'Network error', retry })));
    const publish = vi.fn(async () => undefined);
    const click = runAfterPendingSaves(gate, publish, { stopOnFailure: true });
    save.resolve();
    const outcome = await click;
    expect(outcome.status).toBe('save_failed');
    expect(publish).not.toHaveBeenCalled();
    if (outcome.status === 'save_failed') {
      expect(outcome.failure.message).toBe('Network error');
      await outcome.failure.retry?.();
      expect(retry).toHaveBeenCalledTimes(1);
    }
    // The next save that lands clears it, and Publish goes ahead.
    gate.clearFailure();
    await expect(runAfterPendingSaves(gate, publish, { stopOnFailure: true })).resolves.toEqual({ status: 'ran', value: undefined });
  });

  it('a rejected save does not leave the gate stuck', async () => {
    const gate = createDraftSaveGate();
    const save = deferred();
    gate.track(save.promise).catch(() => undefined);
    expect(gate.pending()).toBe(true);
    save.reject(new Error('boom'));
    await gate.settled();
    expect(gate.pending()).toBe(false);
  });

  it('says plainly that Publish did not start, with Try again beside Refresh', () => {
    const markup = renderToStaticMarkup(<StudioErrorBanner
      error="APP_BUILD_REVISION_CONFLICT: x"
      lead={PUBLISH_SAVE_FAILED_LEAD}
      action={{ label: 'Try again', onClick: () => undefined }}
      onRefresh={() => undefined}
    />);
    expect(markup).toContain('Your last change was not saved, so Publish did not start. This App changed in another tab.');
    expect(markup).toContain('>Try again</button>');
    expect(markup).toContain('>Refresh</button>');
  });
});
