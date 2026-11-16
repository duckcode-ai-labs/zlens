import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_LINK_COPIED, COPY_APP_LINK, DELETED_NOTE, deleteAppWords, deleteDraftWords } from './app-studio-words';

/** V3 retest: deleting an App and the App view said "local recovery", "recovery bundle", "local app handoff". */
const INTERNAL = /\blocal\b|bundle|handoff|recovery/i;

describe('deleting an App, in true and plain words', () => {
  it('says the draft leaves the App list, Undo works right away, and History brings it back where there is History', () => {
    expect(deleteDraftWords({ history: true, builtApp: true })).toBe('leaves the App list. You can Undo right away, or restore it later from History.');
    // A Describe with AI plan nobody built is not kept in History: only Undo is promised.
    expect(deleteDraftWords({ history: true, builtApp: false })).toBe('leaves the App list. You can Undo right away.');
    expect(deleteDraftWords({ history: false, builtApp: true })).toBe('leaves the App list. You can Undo right away.');
    expect(DELETED_NOTE).toBe('removed.');
    expect(deleteAppWords({ history: true })).toMatch(/restore it later from History/);
    for (const words of [deleteDraftWords({ history: true, builtApp: true }), DELETED_NOTE, deleteAppWords({ history: true }), deleteAppWords({ history: false }), COPY_APP_LINK, APP_LINK_COPIED]) {
      expect(words).not.toMatch(INTERNAL);
    }
  });

  it('uses those words in App Studio and the Apps view, and none of the old ones', () => {
    const studio = readFileSync(fileURLToPath(new URL('./AppStudioV2.tsx', import.meta.url)), 'utf8');
    const view = readFileSync(fileURLToPath(new URL('./AppsView.tsx', import.meta.url)), 'utf8');
    expect(studio).toContain('{deleteDraftWords({ history: historyKept, builtApp: !appStudioAiDataResume(draft) })}');
    expect(studio).not.toContain('recovery bundle');
    expect(view).toContain('{DELETED_NOTE}');
    expect(view).toContain('{deleteAppWords({ history: historyKept })}');
    for (const old of ['moved to local recovery', 'Share local app handoff', 'Copied handoff', 'Local handoff', 'recoverable local trash']) expect(view).not.toContain(old);
  });
});
