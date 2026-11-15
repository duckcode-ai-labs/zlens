import type { IncomingMessage, ServerResponse } from 'node:http';
import { HistoryError, type HistoryRunner, type HistoryService } from './history-service.js';

/**
 * History's API (V15). Every route sits behind the server's Snowflake sign-in and the free app's one-person rule
 * (they run before any route), names items by their project path, and opens tracked files only.
 *
 *   GET  /api/history/changes?kind=&by=&days=&certified=1&q=&limit=&offset=   the project's changes, newest first
 *   GET  /api/history/item?path=                                             the versions of one item
 *   GET  /api/history/version?path=&version=                                 one version's files
 *   GET  /api/history/compare?path=&from=&to=                                two versions compared
 *   POST /api/history/compare/run  { path, from, to }                        both versions' SQL run now, rows lined up
 *   POST /api/history/restore      { path, version }                         an old version back, as the next draft
 *   GET  /api/history/status                                                 size, version count, the SQL log
 */
export interface HistoryRouteContext {
  history: HistoryService;
  /** The Snowflake user who signed in. */
  user: string | undefined;
  readJSON: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  serialize: (value: unknown) => string;
  /** Runs a saved query's source on the project's connection (the app's warehouse). */
  run?: HistoryRunner;
  /** Whether a hosted request may open this project file (hosted rules); always true in the app. */
  mayOpen?: (path: string) => boolean;
}

export const HISTORY_ROUTE_PREFIX = '/api/history/';

function send(res: ServerResponse, status: number, body: unknown, serialize: (value: unknown) => string): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(serialize(body));
}

function versionNumber(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/^v/i, '') : '';
  if (!/^\d{1,9}$/.test(text)) throw new HistoryError('A version is a number, like 3 or v3.', 400, 'HISTORY_BAD_VERSION');
  return Number(text);
}

function itemPath(value: unknown): string {
  const path = typeof value === 'string' ? value.trim().replace(/^\/+/, '') : '';
  if (!path) throw new HistoryError('path is required.', 400, 'HISTORY_PATH_REQUIRED');
  return path;
}

/** Answers a History request; false when the path is not one of History's. */
export async function handleHistoryRequest(req: IncomingMessage, res: ServerResponse, url: URL, context: HistoryRouteContext): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith(HISTORY_ROUTE_PREFIX)) return false;
  const { history, serialize } = context;
  const method = req.method ?? 'GET';
  const checked = (value: string) => {
    if (context.mayOpen && !context.mayOpen(value)) throw new HistoryError('This file is not one ZLens opens here.', 400, 'PERMISSION_DENIED');
    return value;
  };
  try {
    if (method === 'GET' && path === '/api/history/changes') {
      const params = url.searchParams;
      const days = Number(params.get('days') ?? '');
      send(res, 200, history.feed({
        kind: params.get('kind') ?? undefined,
        by: params.get('by') ?? undefined,
        days: Number.isFinite(days) && days > 0 ? days : undefined,
        certifiedOnly: params.get('certified') === '1' || params.get('certified') === 'true',
        q: params.get('q') ?? undefined,
        limit: Number(params.get('limit') ?? '') || undefined,
        offset: Number(params.get('offset') ?? '') || undefined,
      }), serialize);
      return true;
    }
    if (method === 'GET' && path === '/api/history/item') {
      send(res, 200, history.item(checked(itemPath(url.searchParams.get('path')))), serialize);
      return true;
    }
    if (method === 'GET' && path === '/api/history/version') {
      send(res, 200, await history.versionFiles(checked(itemPath(url.searchParams.get('path'))), versionNumber(url.searchParams.get('version'))), serialize);
      return true;
    }
    if (method === 'GET' && path === '/api/history/compare') {
      const item = checked(itemPath(url.searchParams.get('path')));
      send(res, 200, await history.compare(item, versionNumber(url.searchParams.get('from')), versionNumber(url.searchParams.get('to'))), serialize);
      return true;
    }
    if (method === 'POST' && path === '/api/history/compare/run') {
      const body = await context.readJSON(req);
      if (!context.run) throw new HistoryError('Running a saved query is not available here.', 409, 'HISTORY_NOT_RUNNABLE');
      send(res, 200, await history.runBoth(checked(itemPath(body.path)), versionNumber(body.from), versionNumber(body.to), context.run), serialize);
      return true;
    }
    if (method === 'POST' && path === '/api/history/restore') {
      const body = await context.readJSON(req);
      const restored = await history.restore({ item: checked(itemPath(body.path)), version: versionNumber(body.version), ...(context.user ? { user: context.user } : {}) });
      send(res, 200, { ok: true, ...restored, status: 'draft' }, serialize);
      return true;
    }
    if (method === 'GET' && path === '/api/history/status') {
      send(res, 200, await history.status(), serialize);
      return true;
    }
    send(res, 404, { error: 'Not found.', code: 'HISTORY_ROUTE_NOT_FOUND' }, serialize);
    return true;
  } catch (error) {
    if (error instanceof HistoryError) {
      send(res, error.status, { error: error.message, code: error.code }, serialize);
    } else {
      send(res, 500, { error: error instanceof Error ? error.message : String(error), code: 'HISTORY_FAILED' }, serialize);
    }
    return true;
  }
}
