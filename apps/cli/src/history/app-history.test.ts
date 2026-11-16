import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appBuildDraftHash, applyAppBuildDraftOperations, type AppBuildDraft, type AppBuildDraftOperation } from '@zlens/core';
import {
  appHistorySource,
  createStoredAppBuildDraft,
  deleteAppPackage,
  deleteStoredAppBuildDraft,
  discardUnkeptAppBuildDraft,
  loadStoredAppBuildDraft,
  markStoredAppBuildDraftPreflighted,
  publishStoredAppBuildDraft,
  removeEmptyAppCopies,
  restoreAppHistoryVersion,
  writeStoredAppBuildDraft,
} from '../apps-api.js';
import { appChanges, appDraftHistoryText, appDraftShape, appPagesKey, publishedAppShape } from './app-drafts.js';
import { HistoryService, type HistoryAppSource } from './history-service.js';
import { historyAppIds } from './known-app-ids.js';
import { readableFileLabel } from './tracked-files.js';

/**
 * V2 History and Apps (the ZLens app for Snowflake). App Studio keeps an App as a draft in ZLens's local store, not
 * as project files, so History reads the drafts from there: every App save is one version by the person who made it;
 * Delete draft and the upgrade's clean-ups are removals that can be restored, as a draft; what went to the trash
 * before History kept Apps is listed as removed and can be restored too.
 */
const roots: string[] = [];
const services: HistoryService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-app-history-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  return root;
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf-8');
}

/** The App source the server uses; restoring from published pages reads no catalog here (text tiles only). */
function source(root: string): HistoryAppSource {
  return { ...appHistorySource(root), restore: (input) => restoreAppHistoryVersion(root, input, async () => ({})) };
}

async function open(root: string, options: Partial<ConstructorParameters<typeof HistoryService>[0]> = {}): Promise<HistoryService> {
  const service = new HistoryService({ projectRoot: root, sweepDelayMs: 0, apps: source(root), log: { info: () => undefined, warn: () => undefined }, ...options });
  services.push(service);
  await service.start();
  return service;
}

/** A request answered: its changes become a version by the person who sent it. */
const after = async (history: HistoryService, method: string, path: string, user = 'JSMITH') => (await history.afterRequest({ user, method, path, status: 200 })) ?? [];

const tile = (id: string, title: string) => ({ i: id, x: 0, y: 0, w: 6, h: 3, title, text: { markdown: title }, viz: { type: 'text' as const } });

/** An App Studio save, as PATCH /api/app-builds/:id writes it. */
function edit(root: string, draft: AppBuildDraft, operations: AppBuildDraftOperation[]): AppBuildDraft {
  const next = applyAppBuildDraftOperations(draft, draft.revision, operations);
  writeStoredAppBuildDraft(root, next, { expectedRevision: draft.revision, operations });
  return next;
}

describe('every App save is a version', () => {
  it('keeps creating an App, each tile and a rename as one version each, by the Snowflake user; a preview run is none', async () => {
    const root = project();
    const history = await open(root);
    let draft = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    const key = `apps/${draft.appId}`;
    const made = await after(history, 'POST', '/api/app-builds');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ author: { name: 'JSMITH', kind: 'person' }, changes: [expect.objectContaining({ item: key, kind: 'app', name: 'Sales overview', version: 1, change: 'created', detail: 'In App Studio, not published yet' })] });
    // Kept in History's repository only: no file is written in the project.
    expect(existsSync(join(root, 'apps'))).toBe(false);

    for (const [n, title] of ['Revenue', 'Orders', 'Margin'].entries()) {
      draft = edit(root, draft, [{ type: 'add_tile', pageId: draft.pages[0]!.id, tile: { ...tile(`t${n}`, title), y: n * 3 } }]);
      expect(await after(history, 'PATCH', `/api/app-builds/${draft.id}`)).toHaveLength(1);
    }
    draft = edit(root, draft, [{ type: 'update_tile', pageId: draft.pages[0]!.id, tileId: 't1', patch: { title: 'Orders by week', text: { markdown: 'Orders by week' } } }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    draft = edit(root, draft, [{ type: 'set_name', name: 'Sales 2026' }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    // A preview run's receipt changes no content: no version.
    const receipt = { ...draft, revision: draft.revision + 1, previewReceipts: [{ id: 'r1', pageId: draft.pages[0]!.id, revision: draft.revision, snapshotId: 's', filterFingerprint: 'f', resultFingerprint: 'r', createdAt: new Date().toISOString() }] };
    writeStoredAppBuildDraft(root, { ...receipt, proposalHash: appBuildDraftHash({ ...receipt, proposalHash: undefined }) }, { expectedRevision: draft.revision });
    expect(await after(history, 'PATCH', `/api/app-builds/${draft.id}`)).toEqual([]);

    const item = history.item(key);
    expect(item.item).toMatchObject({ key, kind: 'app', name: 'Sales 2026', removed: false, currentVersion: 6 });
    expect(item.versions.map((row) => [row.version, row.change, row.detail, row.by.name, row.state])).toEqual([
      [6, 'renamed', 'Was "Sales overview"', 'JSMITH', 'saved'],
      [5, 'edited', 'Tile "Orders" renamed to "Orders by week". Text changed in "Orders"', 'JSMITH', 'saved'],
      [4, 'edited', 'Added 1 tile', 'JSMITH', 'saved'],
      [3, 'edited', 'Added 1 tile', 'JSMITH', 'saved'],
      [2, 'edited', 'Added 1 tile', 'JSMITH', 'saved'],
      [1, 'created', 'In App Studio, not published yet', 'JSMITH', 'saved'],
    ]);
    // The project's changes and the content-free SQL log list them under Apps.
    const feed = history.feed({ kind: 'app' });
    expect(feed.entries.map((entry) => `${entry.change} v${entry.version}`)).toEqual(['renamed v6', 'edited v5', 'edited v4', 'edited v3', 'edited v2', 'created v1']);
    expect(feed.people).toEqual(['JSMITH']);
    const compared = await history.compare(key, 1, 4);
    expect(compared.files.map((file) => [file.path, file.status])).toEqual([[`${key}/studio-draft.json`, 'changed']]);
    expect(compared.files[0]!.lines.some((line) => line.kind === 'added' && line.text.includes('Margin'))).toBe(true);
  });

  it('logs App versions to the SQL log with the App name and kind', async () => {
    const root = project();
    const history = await open(root, { sqlLog: { appName: 'ZLENS_APP', warehouse: () => 'WH', query: async () => [] } });
    const draft = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    await after(history, 'POST', '/api/app-builds');
    edit(root, draft, [{ type: 'add_tile', pageId: draft.pages[0]!.id, tile: tile('t1', 'Revenue') }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    expect(history.pendingSqlRows().filter((row) => row.kind === 'app').map((row) => [row.item, row.version, row.change, row.changedBy])).toEqual([
      ['Sales overview', 1, 'created', 'JSMITH'],
      ['Sales overview', 2, 'edited', 'JSMITH'],
    ]);
  });

  it('says when an App was published, and when a draft of a published App was discarded', async () => {
    const root = project();
    const history = await open(root);
    const draft = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    const withTiles = edit(root, draft, [{ type: 'add_tile', pageId: draft.pages[0]!.id, tile: tile('t1', 'Revenue') }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, withTiles));
    const published = await after(history, 'POST', `/api/app-builds/${draft.id}/publish-to-project`);
    expect(published).toHaveLength(1);
    const key = `apps/${draft.appId}`;
    expect(history.item(key).versions[0]).toMatchObject({ version: 2, change: 'published', detail: '1 page, 1 tile' });
    // Opened for edit and changed, then the draft deleted: the published App never changed.
    let editDraft = createStoredAppBuildDraft(root, { baseAppId: draft.appId, authoringMode: 'manual' });
    await after(history, 'POST', '/api/app-builds');
    editDraft = edit(root, editDraft, [{ type: 'add_tile', pageId: editDraft.pages[0]!.id, tile: { ...tile('t2', 'Orders'), y: 3 } }]);
    await after(history, 'PATCH', `/api/app-builds/${editDraft.id}`);
    expect(history.item(key).versions[0]).toMatchObject({ version: 3, change: 'edited', detail: 'Added 1 tile. Not published yet' });
    deleteStoredAppBuildDraft(root, editDraft);
    await after(history, 'DELETE', `/api/app-builds/${editDraft.id}`);
    expect(history.item(key).versions[0]).toMatchObject({ version: 4, change: 'edited', detail: 'Draft discarded. The published App did not change' });
    expect(history.item(key).item.removed).toBe(false);
  });

  it('makes no version for opening a published App for edit; the first real change is one version by the user', async () => {
    const root = project();
    const draft = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'executive_brief' });
    const withTiles = edit(root, draft, [{ type: 'add_tile', pageId: draft.pages[0]!.id, tile: { ...tile('t1', 'Revenue'), y: 2 } }]);
    publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, withTiles));
    const history = await open(root);
    const key = `apps/${draft.appId}`;
    expect(history.item(key).versions).toHaveLength(1);

    // Edit opens a draft that holds what the published App holds: no line, whoever asks and however often.
    let editDraft = createStoredAppBuildDraft(root, { baseAppId: draft.appId, authoringMode: 'manual' });
    expect(await after(history, 'POST', '/api/app-builds')).toEqual([]);
    expect(await after(history, 'PATCH', `/api/app-builds/${editDraft.id}`)).toEqual([]);
    expect(await history.sweep()).toEqual([]);
    expect(history.item(key).versions).toHaveLength(1);
    expect(history.feed({ kind: 'app' }).entries).toHaveLength(1);

    // Changing a tile is the one version, by the person, saying what changed.
    editDraft = edit(root, editDraft, [{ type: 'update_tile', pageId: editDraft.pages[0]!.id, tileId: 't1', patch: { title: 'Revenue by month', text: { markdown: 'Revenue by month' } } }]);
    const changed = await after(history, 'PATCH', `/api/app-builds/${editDraft.id}`);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ author: { name: 'JSMITH', kind: 'person' }, changes: [expect.objectContaining({ item: key, version: 2, change: 'edited', detail: 'Tile "Revenue" renamed to "Revenue by month". Text changed in "Revenue". Not published yet' })] });
    expect(history.item(key).versions.map((row) => row.version)).toEqual([2, 1]);
    // The published App and its draft compare by what people see: no data "added" because the draft names it otherwise.
    expect((await history.compare(key, 1, 2)).app!.changes).toEqual([
      { kind: 'tile', text: 'Tile "Revenue" renamed to "Revenue by month"' },
      { kind: 'text', text: 'Text changed in "Revenue"' },
    ]);

    // Opened for edit and left without a change, then discarded: nothing either.
    const other = createStoredAppBuildDraft(root, { name: 'Margins', authoringMode: 'manual', template: 'blank' });
    publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, other));
    await after(history, 'POST', `/api/app-builds/${other.id}/publish-to-project`);
    const otherKey = `apps/${other.appId}`;
    const versions = history.item(otherKey).versions.length;
    const untouched = createStoredAppBuildDraft(root, { baseAppId: other.appId, authoringMode: 'manual' });
    expect(await after(history, 'POST', '/api/app-builds')).toEqual([]);
    deleteStoredAppBuildDraft(root, untouched);
    expect(await after(history, 'DELETE', `/api/app-builds/${untouched.id}`)).toEqual([]);
    expect(history.item(otherKey).versions).toHaveLength(versions);
  });
});

describe('removed Apps stay in History and come back as drafts', () => {
  it('lists Delete draft as removed with Restore, and restores the App as a draft with its tiles', async () => {
    const root = project();
    const history = await open(root);
    let draft = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    await after(history, 'POST', '/api/app-builds');
    draft = edit(root, draft, [{ type: 'add_tile', pageId: draft.pages[0]!.id, tile: tile('t1', 'Revenue') }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    deleteStoredAppBuildDraft(root, draft);
    const removed = await after(history, 'DELETE', `/api/app-builds/${draft.id}`);
    const key = `apps/${draft.appId}`;
    expect(removed[0]).toMatchObject({ action: 'delete', changes: [expect.objectContaining({ item: key, change: 'removed', version: 3, name: 'Sales overview' })] });
    expect(history.feed().entries[0]).toMatchObject({ change: 'removed', kind: 'app', canRestore: true, items: [expect.objectContaining({ name: 'Sales overview', removed: true })] });
    expect(history.item(key).item.removed).toBe(true);

    const restored = await history.restore({ item: key, version: 2, user: 'JSMITH' });
    expect(restored).toMatchObject({ item: key, restored: 2, version: 4, message: 'Restored v2 as v4', appDraft: { appId: draft.appId } });
    const back = loadStoredAppBuildDraft(root, restored.appDraft!.id)!;
    expect(back).toMatchObject({ appId: draft.appId, name: 'Sales overview', state: 'local_draft' });
    expect(back.baseApp).toBeUndefined();
    expect(back.pages[0]!.layout.items.map((item) => item.title)).toEqual(draft.pages[0]!.layout.items.map((item) => item.title));
    expect(history.item(key).versions[0]).toMatchObject({ version: 4, change: 'restored', detail: 'Restored v2 as v4, as a draft', by: { name: 'JSMITH' }, current: true });
    // Nothing was published.
    expect(existsSync(join(root, 'apps'))).toBe(false);
  });

  it('restores an older version into the App\'s open draft, as its next revision', async () => {
    const root = project();
    const history = await open(root);
    let draft = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    await after(history, 'POST', '/api/app-builds');
    draft = edit(root, draft, [{ type: 'add_tile', pageId: draft.pages[0]!.id, tile: tile('t1', 'Revenue') }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    draft = edit(root, draft, [{ type: 'remove_tile', pageId: draft.pages[0]!.id, tileId: 't1' }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    const restored = await history.restore({ item: `apps/${draft.appId}`, version: 2, user: 'JSMITH' });
    expect(restored).toMatchObject({ version: 4, appDraft: { id: draft.id } });
    const now = loadStoredAppBuildDraft(root, draft.id)!;
    expect(now.revision).toBe(draft.revision + 1);
    expect(now.pages[0]!.layout.items.map((item) => item.i)).toContain('t1');
  });

  it('restores a deleted published App as a new, unpublished draft', async () => {
    const root = project();
    const draft = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    const withTiles = edit(root, draft, [{ type: 'add_tile', pageId: draft.pages[0]!.id, tile: tile('t1', 'Revenue') }]);
    const published = publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, withTiles));
    const history = await open(root);
    const key = `apps/${draft.appId}`;
    expect(history.item(key).item).toMatchObject({ kind: 'app', name: 'Sales overview' });
    // Delete App moves the App's folder to the trash (with the fingerprint its confirmation showed).
    expect(deleteAppPackage(root, draft.appId, { expectedFingerprint: published.app.fingerprint })).toMatchObject({ ok: true });
    const removed = await after(history, 'DELETE', `/api/apps/${draft.appId}`);
    expect(removed[0]!.changes).toEqual([expect.objectContaining({ item: key, change: 'removed' })]);
    expect(history.item(key).item.removed).toBe(true);
    const restored = await history.restore({ item: key, version: 1, user: 'JSMITH' });
    expect(restored.appDraft).toBeDefined();
    const back = loadStoredAppBuildDraft(root, restored.appDraft!.id)!;
    expect(back).toMatchObject({ appId: draft.appId, name: 'Sales overview', state: 'local_draft' });
    expect(back.baseApp).toBeUndefined();
    expect(back.pages[0]!.layout.items.map((item) => item.i)).toContain('t1');
    // Unpublished: the App's folder is not back until the draft is published.
    expect(existsSync(join(root, key, 'dql.app.json'))).toBe(false);
    expect(history.item(key).versions[0]).toMatchObject({ change: 'restored', state: 'saved', by: { name: 'JSMITH' } });
  });
});

describe('the trash, before History kept Apps', () => {
  /**
   * What an earlier version did: a draft deleted, the upgrade's empty "(3)" copy moved to the trash, and a Describe
   * with AI plan left before it was built (V12 deleted such plans to the trash).
   */
  function trashBeforeHistory(root: string): { kept: AppBuildDraft; shell: AppBuildDraft; live: AppBuildDraft; plan: AppBuildDraft } {
    const kept = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    const withTile = edit(root, kept, [{ type: 'add_tile', pageId: kept.pages[0]!.id, tile: tile('t1', 'Revenue') }]);
    deleteStoredAppBuildDraft(root, withTile);
    // The copy V12 made of "Sales overview": the template's intro only, never edited.
    const live = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    const shell = createStoredAppBuildDraft(root, { name: 'Sales overview (3)', authoringMode: 'manual', template: 'operational_dashboard', goal: 'Sales by month' });
    expect(removeEmptyAppCopies(root)).toEqual(['Sales overview (3)']);
    expect(loadStoredAppBuildDraft(root, live.id)).not.toBeNull();
    const plan = createStoredAppBuildDraft(root, { authoringMode: 'ai', template: 'operational_dashboard', goal: 'Team wins by season' });
    deleteStoredAppBuildDraft(root, plan);
    return { kept: withTile, shell, live, plan };
  }

  it('lists Apps found in the trash as one line that opens, by ZLens, and restores each as a draft', async () => {
    const root = project();
    const { kept, shell, live, plan } = trashBeforeHistory(root);
    await new Promise((done) => setTimeout(done, 5));
    const history = await open(root);
    // One line for everything found in the trash (V3: 13 lines filled the top of History), each with its reason.
    const removed = history.feed().entries.filter((entry) => entry.change === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ action: 'trash', by: { name: 'ZLens' }, count: 2, canRestore: true, canCompare: false, detail: 'Each can be restored from History' });
    expect(removed[0]!.version).toBeUndefined();
    const found = removed[0]!.items;
    expect(found.map((item) => [item.name, item.removed, item.version])).toEqual([['Sales overview (3)', true, 2], ['Sales overview', true, 2]]);
    expect(found[0]!.detail).toMatch(/^An empty copy of another App, moved to the trash on \d{4}-\d{2}-\d{2}\. It can be restored from History$/);
    expect(found[1]!.detail).toMatch(/^Deleted on \d{4}-\d{2}-\d{2}, before History kept App drafts\. It can be restored from History$/);
    // A Describe with AI plan nobody built was never an App: it is not found in the trash (V3).
    expect(history.feed().entries.flatMap((entry) => entry.items).some((item) => item.key === `apps/${plan.appId}`)).toBe(false);
    // The kept content is not a line of its own.
    expect(history.feed().entries.filter((entry) => entry.action === 'trash' && entry.change !== 'removed')).toEqual([]);

    // The deleted App's id is still free: it comes back under it. The copy's id is too.
    const restoredShell = await history.restore({ item: `apps/${shell.appId}`, version: 1, user: 'JSMITH' });
    expect(loadStoredAppBuildDraft(root, restoredShell.appDraft!.id)).toMatchObject({ name: 'Sales overview (3)', state: 'local_draft' });
    // The deleted App's id went to a newer App since: it is kept under a key of its own, and comes back as a new
    // draft under a free name. The newer App's own draft is not touched.
    const deletedKey = found[1]!.current;
    expect(deletedKey).toMatch(new RegExp(`^apps/${kept.appId}-removed-`));
    const liveBefore = loadStoredAppBuildDraft(root, live.id)!;
    const restoredKept = await history.restore({ item: deletedKey, version: 1, user: 'JSMITH' });
    expect(restoredKept.appDraft!.id).not.toBe(live.id);
    const back = loadStoredAppBuildDraft(root, restoredKept.appDraft!.id)!;
    expect(back).toMatchObject({ name: 'Sales overview (2)', appId: `${kept.appId}-2`, state: 'local_draft' });
    expect(back.pages[0]!.layout.items.map((item) => item.i)).toEqual(kept.pages[0]!.layout.items.map((item) => item.i));
    expect(loadStoredAppBuildDraft(root, live.id)).toEqual(liveBefore);
    expect(restoredKept.message).toBe('Restored v1 as a new draft, "Sales overview (2)"');
    expect(history.item(`apps/${kept.appId}-2`).versions[0]).toMatchObject({ version: 1, change: 'restored', detail: 'Restored from v1 of "Sales overview", as a draft' });
    history.stop();

    // A later start keeps nothing twice, and what went to the trash after History kept drafts it saw itself.
    const again = await open(root);
    expect(again.feed().entries.filter((entry) => entry.action === 'trash').flatMap((entry) => entry.items)).toHaveLength(2);
    const later = createStoredAppBuildDraft(root, { name: 'Later', authoringMode: 'manual', template: 'blank' });
    await after(again, 'POST', '/api/app-builds');
    deleteStoredAppBuildDraft(root, later);
    await after(again, 'DELETE', `/api/app-builds/${later.id}`);
    again.stop();
    const third = await open(root);
    expect(third.feed().entries.filter((entry) => entry.action === 'trash').flatMap((entry) => entry.items)).toHaveLength(2);
    expect(third.feed().entries.filter((entry) => entry.change === 'removed' && entry.items[0]!.name === 'Later').map((entry) => entry.action)).toEqual(['delete']);
  });

  it('lists the clean-up of an empty copy while History runs as ZLens\'s, never as the person\'s', async () => {
    const root = project();
    const live = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    createStoredAppBuildDraft(root, { name: 'Sales overview (3)', authoringMode: 'manual', template: 'operational_dashboard', goal: 'Sales by month' });
    const history = await open(root);
    expect(removeEmptyAppCopies(root)).toEqual(['Sales overview (3)']);
    // Listing the drafts (GET /api/app-builds) is where ZLens tidies them, and where History sees it.
    const made = await after(history, 'GET', '/api/app-builds');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ author: { name: 'ZLens', kind: 'zlens' }, action: 'upgrade', changes: [expect.objectContaining({ change: 'removed', name: 'Sales overview (3)' })] });
    expect(made[0]!.changes[0]!.detail).toBe('An empty copy of another App, moved to the trash. It can be restored from History');
    // Another GET with nothing changed: no version; other GETs never make one.
    expect(await after(history, 'GET', '/api/app-builds')).toEqual([]);
    // An edit saved at the same moment (another tab) is never ZLens's: the person's own request keeps it.
    edit(root, live, [{ type: 'add_tile', pageId: live.pages[0]!.id, tile: tile('t1', 'Revenue') }]);
    expect(await after(history, 'GET', '/api/app-builds')).toEqual([]);
    const edited = await after(history, 'PATCH', `/api/app-builds/${live.id}`);
    expect(edited[0]).toMatchObject({ author: { name: 'JSMITH', kind: 'person' }, changes: [expect.objectContaining({ name: 'Sales overview', detail: 'Added 1 tile' })] });
    expect(history.afterRequest({ user: 'JSMITH', method: 'GET', path: '/api/apps', status: 200 })).toBeUndefined();
  });

  it('keeps the trashed App under its own key when another App now has its id', async () => {
    const root = project();
    const gone = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    deleteStoredAppBuildDraft(root, gone);
    // A new App took the freed id since.
    const now = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    expect(now.appId).toBe(gone.appId);
    const history = await open(root);
    const keys = history.feed().entries.filter((entry) => entry.action === 'trash').map((entry) => entry.items[0]!.key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(`apps/${now.appId}`);
    expect(keys[0]).toMatch(new RegExp(`^apps/${now.appId}-removed-`));
    expect(history.item(`apps/${now.appId}`).item.removed).toBe(false);
  });
});

describe('Describe with AI plans (V3): an App only once someone keeps it', () => {
  /** "Generate editable App": a draft made from the description, before its plan is applied. */
  const plan = (root: string, goal = 'How did the Warriors do in each season') => createStoredAppBuildDraft(root, { authoringMode: 'ai', template: 'operational_dashboard', goal });
  const trashed = (root: string) => existsSync(join(root, '.dql/local/trash/app-drafts')) ? readdirSync(join(root, '.dql/local/trash/app-drafts')) : [];

  it('keeps no line for a plan nobody built, and leaving it leaves no line and no trash', async () => {
    const root = project();
    const history = await open(root);
    const draft = plan(root);
    expect(await after(history, 'POST', '/api/app-builds')).toEqual([]);
    expect(await history.sweep()).toEqual([]);
    // Back to Apps discards it: no trash entry, and History has nothing to say about it.
    expect(discardUnkeptAppBuildDraft(root, draft)).toMatchObject({ ok: true, discarded: true, recoveryId: null });
    expect(loadStoredAppBuildDraft(root, draft.id)).toBeNull();
    expect(trashed(root)).toEqual([]);
    expect(await after(history, 'DELETE', `/api/app-builds/${draft.id}`)).toEqual([]);
    expect(history.feed({ kind: 'app' }).entries).toEqual([]);
    expect(history.item.bind(history, `apps/${draft.appId}`)).toThrow(/no versions/);
  });

  it('keeps the App from when its plan is applied, named by the plan', async () => {
    const root = project();
    const history = await open(root);
    let draft = plan(root);
    await after(history, 'POST', '/api/app-builds');
    // Applying the plan renames the App and adds its tiles, in one save (apps-api plannedAppName).
    draft = edit(root, draft, [
      { type: 'set_name', name: 'Warriors wins by season' },
      { type: 'add_tile', pageId: draft.pages[0]!.id, tile: { ...tile('wins', 'Wins by season'), y: 3 } },
    ]);
    const made = await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    expect(made[0]!.changes).toEqual([expect.objectContaining({ item: `apps/${draft.appId}`, name: 'Warriors wins by season', version: 1, change: 'created' })]);
    // Kept from now on: leaving it never discards it, and Delete puts it in the trash, restorable from History.
    expect(discardUnkeptAppBuildDraft(root, draft)).toBeNull();
    expect(loadStoredAppBuildDraft(root, draft.id)).not.toBeNull();
  });

  it('counts a rename as keeping a plan, and discards nothing anyone changed', async () => {
    const root = project();
    const history = await open(root);
    let draft = plan(root);
    draft = edit(root, draft, [{ type: 'set_name', name: 'Season review' }]);
    const made = await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    expect(made[0]!.changes[0]).toMatchObject({ name: 'Season review', change: 'created' });
    expect(discardUnkeptAppBuildDraft(root, draft)).toBeNull();
    // A manual App is the person's from the start.
    createStoredAppBuildDraft(root, { name: 'By hand', authoringMode: 'manual', template: 'blank' });
    expect((await after(history, 'POST', '/api/app-builds'))[0]!.changes[0]).toMatchObject({ name: 'By hand', change: 'created' });
  });

  it('never gives a new App the id of an App History knows, there or in its trash', async () => {
    const root = project();
    const history = await open(root);
    let gone = createStoredAppBuildDraft(root, { name: 'Points per game', authoringMode: 'manual', template: 'blank' });
    await after(history, 'POST', '/api/app-builds');
    gone = edit(root, gone, [{ type: 'add_tile', pageId: gone.pages[0]!.id, tile: tile('t1', 'Points') }]);
    await after(history, 'PATCH', `/api/app-builds/${gone.id}`);
    deleteStoredAppBuildDraft(root, gone);
    await after(history, 'DELETE', `/api/app-builds/${gone.id}`);
    const key = `apps/${gone.appId}`;
    expect(history.item(key).versions.map((row) => row.change)).toEqual(['removed', 'edited', 'created']);
    expect(historyAppIds(root)).toContain(gone.appId);

    // The same name again: the name is the person's, the id is a new one, and the removed App's History is its own.
    const next = createStoredAppBuildDraft(root, { name: 'Points per game', authoringMode: 'manual', template: 'blank' });
    expect(next.name).toBe('Points per game');
    expect(next.appId).toBe(`${gone.appId}-2`);
    await after(history, 'POST', '/api/app-builds');
    expect(history.item(key).versions).toHaveLength(3);
    expect(history.item(`apps/${next.appId}`).versions.map((row) => [row.version, row.change])).toEqual([[1, 'created']]);
    // Asked for by id, an id History knows is refused.
    expect(() => createStoredAppBuildDraft(root, { name: 'Other', appId: gone.appId, authoringMode: 'manual', template: 'blank' })).toThrow(/kept in History/);
    // A plan made now takes a fresh id too, and the removed App still comes back, as a new draft beside the new one.
    expect(plan(root, 'Points per game').appId).not.toBe(gone.appId);
    const restored = await history.restore({ item: key, version: 2, user: 'JSMITH' });
    expect(restored.message).toMatch(/^Restored v2 as a new draft, "Points per game \(\d\)"$/);
    expect(new Set([gone.appId, next.appId]).has(restored.appDraft!.appId)).toBe(false);
    expect(history.item(restored.item).versions[0]).toMatchObject({ change: 'restored', detail: 'Restored from v2 of "Points per game", as a draft' });

    // Without History (open source), nothing is held back.
    history.stop();
    expect(historyAppIds(root)).toEqual([]);
  });

  it('keeps a plan History kept before V3 as it is, and still restores it after it is removed', async () => {
    const root = project();
    const draft = plan(root);
    const key = `apps/${draft.appId}`;
    const real = source(root);
    // History before V3 kept every draft, plans too.
    let before = true;
    const history = await open(root, { apps: { ...real, drafts: () => (before ? new Map([[`${key}/studio-draft.json`, appDraftHistoryText(draft)]]) : real.drafts()) } });
    expect(history.item(key).versions).toHaveLength(1);
    before = false;
    // Now a plan: not listed as removed while it is there.
    expect(await after(history, 'PATCH', `/api/app-builds/${draft.id}`)).toEqual([]);
    expect(history.item(key).item.removed).toBe(false);
    // Deleted, it is removed like any App History keeps, and its version comes back as a draft.
    deleteStoredAppBuildDraft(root, draft);
    expect((await after(history, 'DELETE', `/api/app-builds/${draft.id}`))[0]!.changes[0]).toMatchObject({ item: key, change: 'removed' });
    const restored = await history.restore({ item: key, version: 1, user: 'JSMITH' });
    expect(loadStoredAppBuildDraft(root, restored.appDraft!.id)).toMatchObject({ authoringMode: 'ai', state: 'local_draft' });
    expect(history.item(key).versions[0]).toMatchObject({ change: 'restored', current: true });
  });
});

describe('App compare in words (V3)', () => {
  const textTile = (id: string, title: string, markdown: string, y = 0) => ({ i: id, x: 0, y, w: 12, h: 2, title, text: { markdown }, viz: { type: 'text' as const } });
  const winsTile = { i: 'wins', x: 0, y: 2, w: 6, h: 4, title: 'Wins by season', sourceId: 'app:block:nba:wins', block: { ref: 'blocks/nba/wins.dql' }, viz: { type: 'bar' as const } };
  const winsSource = { id: 'app:block:nba:wins', kind: 'block' as const, sourceRef: 'blocks/nba/wins_by_season.dql', trustState: 'certified' as const, reviewStatus: 'not_required' as const };

  it('says only a text tile\'s text changed, by the tile\'s title', async () => {
    const root = project();
    const history = await open(root);
    let draft = createStoredAppBuildDraft(root, { name: 'Season review', authoringMode: 'manual', template: 'blank' });
    await after(history, 'POST', '/api/app-builds');
    const page = draft.pages[0]!.id;
    draft = edit(root, draft, [{ type: 'add_tile', pageId: page, tile: textTile('intro', 'Intro', '## Intro\nHow the season went.') }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    draft = edit(root, draft, [{ type: 'update_tile', pageId: page, tileId: 'intro', patch: { text: { markdown: '## Intro\nHow the 2016 season went.' } } }]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    expect(history.item(`apps/${draft.appId}`).versions[0]).toMatchObject({ version: 3, change: 'edited', detail: 'Text changed in "Intro"' });
  });

  it('lists what changed in plain words, never the App\'s files', async () => {
    const root = project();
    const history = await open(root);
    let draft = createStoredAppBuildDraft(root, { name: 'Season review', authoringMode: 'manual', template: 'blank' });
    await after(history, 'POST', '/api/app-builds');
    const page = draft.pages[0]!.id;
    draft = edit(root, draft, [
      { type: 'add_tile', pageId: page, tile: textTile('intro', 'Intro', 'How the season went.') },
      { type: 'add_tile', pageId: page, tile: textTile('notes', 'Notes', 'Notes.', 6) },
    ]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    draft = edit(root, draft, [
      { type: 'set_name', name: 'Warriors season review' },
      { type: 'update_tile', pageId: page, tileId: 'intro', patch: { text: { markdown: 'How the 2016 season went.' }, w: 6 } },
      { type: 'remove_tile', pageId: page, tileId: 'notes' },
      { type: 'add_tile', pageId: page, tile: winsTile },
      { type: 'upsert_source', source: winsSource },
    ]);
    await after(history, 'PATCH', `/api/app-builds/${draft.id}`);
    const key = `apps/${draft.appId}`;
    const compared = await history.compare(key, 1, 3);
    expect(compared.app!.changes).toEqual([
      { kind: 'name', text: 'Name changed from "Season review" to "Warriors season review"' },
      { kind: 'tile', text: 'Tile added: "Intro"' },
      { kind: 'tile', text: 'Tile added: "Wins by season"' },
    ].concat([{ kind: 'data', text: 'Data added: Wins by season' }]));
    const step = await history.compare(key, 2, 3);
    expect(step.app!.changes).toEqual([
      { kind: 'name', text: 'Name changed from "Season review" to "Warriors season review"' },
      { kind: 'tile', text: 'Tile added: "Wins by season"' },
      { kind: 'tile', text: 'Tile removed: "Notes"' },
      { kind: 'text', text: 'Text changed in "Intro"' },
      { kind: 'layout', text: 'Layout changed: 1 tile moved or resized' },
      { kind: 'data', text: 'Data added: Wins by season' },
    ]);
    // Plain words: no file, path, id or fingerprint.
    const said = step.app!.changes.map((change) => change.text).join(' ');
    expect(said).not.toMatch(/studio-draft|\.dql|sha256|app:block|draftId/);
    // The files stay, for Technical details.
    expect(step.files.map((file) => [file.path, file.status])).toEqual([[`${key}/studio-draft.json`, 'changed']]);
  });

  it('compares a published App with its draft by what people see, and names pages', () => {
    const page = (id: string, title: string, items: unknown[]) => JSON.stringify({ version: 1, id, metadata: { title }, layout: { kind: 'grid', cols: 12, rowHeight: 80, items } });
    const app = (name: string) => JSON.stringify({ version: 1, id: 'season', name });
    const before = publishedAppShape(app('Season'), [page('overview', 'Overview', [winsTile])]);
    const after = publishedAppShape(app('Season'), [
      page('overview', 'Summary', [{ ...winsTile, viz: { type: 'line' } }]),
      page('detail', 'Detail', [textTile('n', 'Notes', 'Notes')]),
    ]);
    expect(appChanges(before, after)).toEqual([
      { kind: 'page', text: 'Page added: "Detail" (1 tile)' },
      { kind: 'page', text: 'Page "Overview" renamed to "Summary"' },
      { kind: 'tile', text: '"Wins by season": chart changed on "Summary"' },
    ]);
    expect(appChanges(before, before)).toEqual([]);
    // The same App opened for edit names its data by catalog id, not by path: no data change for that.
    const draft = appDraftShape({
      kind: 'zlens-app-studio-draft', format: 1, draftId: 'd1', appId: 'season', name: 'Season', authoringMode: 'manual', template: 'blank',
      frame: { goal: 'Season', audience: 'stakeholders', metrics: [], dimensions: [], filters: [], desiredOutput: '', clarificationQuestions: [] },
      requirements: [], coverage: [], reviewTasks: [], sources: [winsSource],
      pages: [JSON.parse(page('overview', 'Overview', [{ ...winsTile, sourceRevision: 'sha256:abc' }]))],
    });
    expect(appChanges(before, draft)).toEqual([]);
  });
});

describe('readable names and kinds', () => {
  it('names model, domain and semantic files for people, and starts with "History starts here" for mixed items', async () => {
    const root = project();
    put(root, 'domains/tpch/domain.dql', 'domain "TPC-H" {\n  id = "tpch"\n}\n');
    put(root, 'domains/tpch/modeling/model.dql.yaml', 'entities: []\n');
    put(root, 'domains/tpch/modeling/areas/core.dql.yaml', 'entities: []\n');
    put(root, 'semantic-layer/metrics/revenue.yaml', 'name: revenue\n');
    put(root, 'notebooks/welcome.dqlnb', '{"title":"workspace - ZLens Workbench","cells":[]}');
    put(root, 'blocks/nba/wins.dql', 'block "wins" {\n  status = "draft"\n  query = """SELECT 1"""\n}\n');
    createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    const history = await open(root);
    const [started] = history.feed().entries;
    expect(started).toMatchObject({ change: 'started', count: 7 });
    expect(Object.fromEntries(started!.items.map((item) => [item.key, [item.name, item.kind]]))).toEqual({
      'apps/sales-overview': ['Sales overview', 'app'],
      'blocks/nba/wins.dql': ['wins', 'saved_query'],
      'domains/tpch/domain.dql': ['Domain: TPC-H', 'model'],
      'domains/tpch/modeling/areas/core.dql.yaml': ['Model: TPC-H core', 'model'],
      'domains/tpch/modeling/model.dql.yaml': ['Model: TPC-H', 'model'],
      // The welcome notebook ZLens writes is named by its file, not "workspace - ZLens Workbench" (V3).
      'notebooks/welcome.dqlnb': ['Welcome', 'notebook'],
      'semantic-layer/metrics/revenue.yaml': ['Metric: revenue', 'semantic'],
    });
    expect(readableFileLabel('domains/tpch/modeling/areas/core.dql.yaml')).toBe('Model: Tpch core');
    expect(readableFileLabel('domains/nba_stats/domain.yaml')).toBe('Domain: Nba stats');
    expect(readableFileLabel('domains/tpch/terms/net_revenue.yaml')).toBe('Term: net revenue (Tpch)');
    expect(readableFileLabel('semantic-layer/semantic_model.yaml')).toBe('Semantic layer: semantic_model');
  });

  it('keeps a domain\'s App as an App, not a model file', async () => {
    const root = project();
    put(root, 'domains/nba/apps/seasons/dql.app.json', JSON.stringify({ name: 'Seasons' }));
    put(root, 'domains/nba/apps/seasons/dashboards/main.dqld', JSON.stringify({ id: 'main', layout: { items: [{ i: 'a' }] } }));
    const history = await open(root);
    expect(history.feed().entries[0]!.items.map((item) => [item.key, item.kind, item.name])).toEqual([['domains/nba/apps/seasons', 'app', 'Seasons']]);
    expect(history.item('domains/nba/apps/seasons').item.kind).toBe('app');
  });

  it('rebuilds an index saved before V2, so names already shown become readable', async () => {
    const root = project();
    put(root, 'domains/tpch/modeling/model.dql.yaml', 'entities: []\n');
    const first = await open(root);
    first.stop();
    const indexPath = join(root, '.dql', 'history', 'zlens-index.json');
    const saved = JSON.parse((await import('node:fs')).readFileSync(indexPath, 'utf-8'));
    saved.format = 1;
    saved.commits[0].changes[0].name = 'model.dql';
    writeFileSync(indexPath, JSON.stringify(saved));
    const again = await open(root);
    expect(again.feed().entries[0]!.items[0]!.name).toBe('Model: Tpch');
  });
});

describe('the App draft file', () => {
  it('holds what the person made, never preview bookkeeping', () => {
    const root = project();
    const draft = createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    const text = appDraftHistoryText(draft);
    const later = { ...draft, revision: 9, updatedAt: '2030-01-01T00:00:00.000Z', proposalHash: 'sha256:x', preflightReceipt: { id: 'p', revision: 9, proposalHash: 'x', sourceFingerprint: 'y', createdAt: 'z' } };
    expect(appDraftHistoryText(later)).toBe(text);
    expect(JSON.parse(text)).toMatchObject({ kind: 'zlens-app-studio-draft', appId: draft.appId, name: 'Sales overview' });
    expect(text).not.toContain('revision');
    expect(text).not.toContain('Receipt');
  });

  it('compares a draft with the published App without what publishing and opening for edit add', () => {
    const page = { id: 'overview', version: 2, metadata: { title: 'Overview', visibility: 'shared', lifecycle: 'certified' }, layout: { kind: 'grid', items: [{ i: 'a', x: 0, y: 0, w: 6, h: 3, block: { ref: 'blocks/wins.dql' } }] } };
    const opened = { id: 'overview', metadata: { lifecycle: 'review', title: 'Overview' }, layout: { items: [{ block: { ref: 'blocks/wins.dql' }, h: 3, i: 'a', sourceId: 'block:wins', sourceRevision: 'sha256:abc', w: 6, x: 0, y: 0 }], kind: 'grid' } };
    expect(appPagesKey([page])).toBe(appPagesKey([opened]));
    expect(appPagesKey([page])).not.toBe(appPagesKey([{ ...opened, layout: { ...opened.layout, items: [{ ...opened.layout.items[0]!, w: 12 }] } }]));
    expect(appPagesKey([page])).not.toBe(appPagesKey([{ ...opened, metadata: { title: 'Seasons' } }]));
  });

  it('never lists drafts as removed when the store cannot be read this time', async () => {
    const root = project();
    createStoredAppBuildDraft(root, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    let fail = false;
    const real = source(root);
    const history = await open(root, { apps: { ...real, drafts: () => { if (fail) throw new Error('database is locked'); return real.drafts(); } } });
    fail = true;
    put(root, 'notebooks/a.dqlnb', '{"title":"A"}');
    const made = await after(history, 'POST', '/api/notebooks');
    expect(made[0]!.changes.map((change) => change.item)).toEqual(['notebooks/a.dqlnb']);
    expect(history.item('apps/sales-overview').item.removed).toBe(false);
  });
});
