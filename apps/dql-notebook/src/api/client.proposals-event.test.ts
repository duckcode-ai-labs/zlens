import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from './client';

let client: typeof ClientModule;
let fired: string[];

beforeEach(async () => {
  vi.resetModules();
  fired = [];
  vi.stubGlobal('window', {
    location: { origin: 'http://localhost' },
    dispatchEvent: (event: Event) => { fired.push(event.type); return true; },
  });
  client = await import('./client');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('saving or discarding drafts tells the page', () => {
  it('announces a saved draft, so the setup strip stops saying nothing is saved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ proposal: { id: 'p1', status: 'committed' }, snapshotId: 's2' })));
    await expect(client.api.commitContextProposal('p1', 'hash', 'key')).resolves.toMatchObject({ snapshotId: 's2' });
    expect(fired).toEqual([client.CONTEXT_PROPOSALS_CHANGED_EVENT]);
  });

  it('announces a discarded draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ proposal: { id: 'p1', status: 'discarded' } })));
    await client.api.discardContextProposal('p1');
    expect(fired).toEqual([client.CONTEXT_PROPOSALS_CHANGED_EVENT]);
  });

  it('says nothing when the save fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'proposal changed' }, 409)));
    await expect(client.api.commitContextProposal('p1', 'hash', 'key')).rejects.toThrow();
    expect(fired).toEqual([]);
  });
});
