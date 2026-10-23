import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DQLContext } from '../../context.js';
import {
  describeDataset,
  listDatasets,
  previewTileQuery,
  queryDataset,
} from '../datasets.js';

function ctxStub(): DQLContext {
  return { projectRoot: '/tmp/project' } as DQLContext;
}

function mockFetch(status: number, payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

const revenueQuery = { dimensions: [], measures: [{ measure: 'revenue' }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dataset MCP runtime adapter', () => {
  it('lists and describes only runtime-projected Dataset metadata', async () => {
    const fetchMock = mockFetch(200, {
      version: 1,
      snapshotId: 'snapshot-a',
      datasets: [{ sourceId: 'source:orders', title: 'Orders', trust: 'certified' }],
      total: 1,
    });
    const listed = await listDatasets(ctxStub(), { query: 'orders', serverUrl: 'http://runtime/' });
    expect(listed).toMatchObject({ ok: true, snapshotId: 'snapshot-a', total: 1 });
    expect(fetchMock).toHaveBeenCalledWith('http://runtime/api/app-datasets?query=orders', expect.objectContaining({ method: 'GET' }));
    // Every runtime call carries a deadline so a stuck workbench cannot hang the agent.
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, snapshotId: 'snapshot-a', dataset: { sourceId: 'source:orders' } }),
      text: async () => '',
    });
    const described = await describeDataset(ctxStub(), { sourceId: 'source:orders', serverUrl: 'http://runtime' });
    expect(described).toMatchObject({ ok: true, dataset: { sourceId: 'source:orders' } });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('http://runtime/api/app-datasets?sourceId=source%3Aorders');
  });

  it('points an empty Dataset list at ask_dql when the project has certified blocks or semantic metrics', async () => {
    mockFetch(200, { version: 1, snapshotId: 'snapshot-a', datasets: [], total: 0 });
    const governedCtx = {
      projectRoot: '/tmp/project',
      manifest: { blocks: { monthly_revenue: { status: 'certified' }, scratch: { status: 'draft' } } },
      semanticLayer: { listMetrics: () => [{ name: 'large_orders' }, { name: 'revenue' }] },
    } as unknown as DQLContext;
    const listed = await listDatasets(governedCtx, {});
    expect(listed).toMatchObject({ ok: true, datasets: [], total: 0, nextTool: 'ask_dql' });
    expect((listed as { note?: string }).note).toContain('1 certified block and 2 semantic metrics');

    const bareCtx = {
      projectRoot: '/tmp/project',
      manifest: { blocks: {} },
      semanticLayer: { listMetrics: () => [] },
    } as unknown as DQLContext;
    mockFetch(200, { version: 1, snapshotId: 'snapshot-a', datasets: [], total: 0 });
    expect(await listDatasets(bareCtx, {})).not.toHaveProperty('nextTool');

    // A non-empty list stays exactly as the runtime sent it.
    mockFetch(200, { version: 1, snapshotId: 'snapshot-a', datasets: [{ sourceId: 'source:orders' }], total: 1 });
    expect(await listDatasets(governedCtx, {})).not.toHaveProperty('nextTool');
  });

  it('forwards only typed Dataset query input and strips non-contract runtime payload fields', async () => {
    const fetchMock = mockFetch(200, {
      ok: true,
      version: 1,
      source: { sourceId: 'source:orders', trust: 'certified' },
      query: revenueQuery,
      validation: { outcome: 'covered', diagnostics: [] },
      scope: 'ephemeral_mcp_runtime',
      partial: true,
      publicationEvidence: false,
      result: { columns: ['revenue'], rows: [{ revenue: 60 }], rowCount: 1 },
      trustState: 'certified',
      receipt: { snapshotId: 'snapshot-a', targetFingerprint: 'target-a' },
      artifact: { sql: 'SELECT secret' },
    });

    const result = await queryDataset(ctxStub(), {
      sourceId: 'source:orders',
      query: revenueQuery,
      parameters: { region: 'CA' },
      serverUrl: 'http://runtime',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { rows: [{ revenue: 60 }] },
      receipt: { snapshotId: 'snapshot-a', targetFingerprint: 'target-a' },
      publicationEvidence: false,
    });
    expect(result).not.toHaveProperty('artifact');
    expect(fetchMock).toHaveBeenCalledWith('http://runtime/api/app-datasets/run', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toEqual({ sourceId: 'source:orders', query: revenueQuery, parameters: { region: 'CA' } });
    expect(body).not.toHaveProperty('serverUrl');
    expect(body).not.toHaveProperty('sql');
  });

  it('uses the same typed preview endpoint and preserves runtime refusals', async () => {
    const fetchMock = mockFetch(400, { ok: false, error: 'Dataset MCP query was refused: unknown approved measure.' });
    const preview = await previewTileQuery(ctxStub(), {
      sourceId: 'source:orders',
      query: revenueQuery,
      serverUrl: 'http://runtime',
    });
    expect(preview).toEqual({ ok: false, error: 'Dataset MCP query was refused: unknown approved measure.' });
    expect(fetchMock).toHaveBeenCalledWith('http://runtime/api/app-datasets/preview', expect.objectContaining({ method: 'POST' }));
  });

  it('reports an unavailable runtime without pretending that a fallback query ran', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    const result = await queryDataset(ctxStub(), {
      sourceId: 'source:orders',
      query: revenueQuery,
    });
    expect(result).toMatchObject({ ok: false, runtimeUnavailable: true });
    expect(result.error).toContain('zlens notebook');
  });
});
