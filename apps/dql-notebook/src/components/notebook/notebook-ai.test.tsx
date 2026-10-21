import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConversationThread, NotebookResearchRun } from '../../api/client';
import { themes } from '../../themes/notebook-theme';
import { NotebookAiHistoryList, notebookAiCellContext } from './NotebookEditor';
import type { Cell } from '../../store/types';

const t = themes.paper;

const thread = (id: string, title: string): AgentConversationThread => ({
  id,
  surface: 'notebook',
  title,
  notebookPath: 'notebooks/stores.dqlnb',
  archived: false,
  createdAt: '2026-10-21T10:00:00.000Z',
  updatedAt: '2026-10-21T10:05:00.000Z',
});

const research = {
  id: 'research-1',
  notebookPath: 'notebooks/stores.dqlnb',
  question: 'Why did store revenue drop?',
  title: 'Store revenue drop',
  status: 'open',
  updatedAt: '2026-10-20T09:00:00.000Z',
} as unknown as NotebookResearchRun;

const render = (props: Partial<Parameters<typeof NotebookAiHistoryList>[0]>) => renderToStaticMarkup(
  <NotebookAiHistoryList
    t={t}
    conversations={[]}
    runs={[]}
    loading={false}
    error={null}
    onOpenConversation={() => undefined}
    onAskFromHistory={() => undefined}
    {...props}
  />,
);

describe('Notebook AI history', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("lists the notebook's Notebook AI conversations and marks the open one", () => {
    const markup = render({
      conversations: [thread('thread-1', 'Fix this query'), thread('thread-2', 'Top store by order value')],
      runs: [research],
      currentThreadId: 'thread-1',
    });
    expect(markup).toContain('Conversations');
    expect(markup).toContain('Fix this query');
    expect(markup).toContain('Top store by order value');
    expect(markup).toContain('This conversation is open');
    expect(markup).toContain('Continue this conversation');
    expect(markup).toContain('Research');
    expect(markup).toContain('Store revenue drop');
    expect(markup).not.toContain('No saved AI history');
  });

  it('says there is no history only when there are no conversations and no research', () => {
    expect(render({})).toContain('No saved AI history for this notebook yet.');
    expect(render({ conversations: [thread('thread-1', 'Fix this query')] })).not.toContain('No saved AI history');
  });

  it("asks the server for one notebook's conversations", async () => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ threads: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../../api/client');
    await api.listAgentThreads({ notebookPath: 'notebooks/stores.dqlnb', limit: 12 });
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/api/agent/threads?');
    expect(url).toContain('limit=12');
    expect(url).toContain(`notebookPath=${encodeURIComponent('notebooks/stores.dqlnb')}`);
  });
});

describe('Notebook AI opened from a cell', () => {
  const cell = (updates: Partial<Cell>): Cell => ({
    id: 'cell-1',
    type: 'sql',
    name: 'store_names',
    content: '  SELECT location_nme FROM dev.locations  ',
    status: 'error',
    ...updates,
  });

  it("sends the cell's SQL and its error", () => {
    expect(notebookAiCellContext(cell({ error: 'Binder Error: column "location_nme" not found' }))).toEqual({
      cellSql: 'SELECT location_nme FROM dev.locations',
      cellError: 'Binder Error: column "location_nme" not found',
    });
    expect(notebookAiCellContext(cell({ status: 'success' }))).toEqual({ cellSql: 'SELECT location_nme FROM dev.locations' });
  });

  it('sends nothing for the whole notebook or a cell without a query', () => {
    expect(notebookAiCellContext(null)).toEqual({});
    expect(notebookAiCellContext(cell({ type: 'markdown', content: '# Notes', error: 'x' }))).toEqual({});
  });
});
