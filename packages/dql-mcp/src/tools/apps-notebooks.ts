/**
 * Read-only views of the project's Apps and notebooks, for clients that cannot
 * open project files themselves (Claude Desktop) and for any agent asking
 * "which Apps do we have, what do their tiles run, are they certified?".
 *
 * Both read the compiled manifest and the files it points at. Neither runs a
 * query, a tile or a cell.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';

export const listAppsInput = zodInputShapeForTool('list_apps');
export const listNotebooksInput = zodInputShapeForTool('list_notebooks');

const MAX_APPS = 50;
const MAX_NOTEBOOKS = 50;
const CELL_PREVIEW_CHARS = 1_500;
const CELL_FULL_CHARS = 12_000;

interface DashboardItem {
  i?: string;
  title?: string;
  block?: { blockId?: string; path?: string };
  viz?: { type?: string };
  dataset?: { sourceId?: string };
  query?: unknown;
}

function matches(query: string | undefined, values: Array<string | undefined>): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => value?.toLowerCase().includes(needle));
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function tileTrust(status: string | undefined): string {
  if (status === 'certified') return 'Certified';
  if (status === 'deprecated') return 'Deprecated';
  return 'Needs review';
}

export function listApps(ctx: DQLContext, args: { query?: string }) {
  const manifest = ctx.manifest;
  const blocks = manifest.blocks ?? {};
  const dashboards = manifest.dashboards ?? {};
  const all = Object.values(manifest.apps ?? {}).filter((app) =>
    matches(args.query, [app.id, app.name, app.description, app.domain, ...(app.tags ?? [])]));
  const apps = all.slice(0, MAX_APPS).map((app) => {
    const appDashboards = (app.dashboards ?? []).map((qualifiedId) => {
      const dashboard = dashboards[qualifiedId] ?? Object.values(dashboards).find((d) => d.appId === app.id && d.id === qualifiedId);
      if (!dashboard) return { id: qualifiedId, missing: true };
      const file = readJson(join(ctx.projectRoot, dashboard.filePath));
      const items = ((file?.layout as { items?: DashboardItem[] } | undefined)?.items ?? []);
      const tiles = items.length > 0
        ? items.map((item) => {
          const blockName = item.block?.blockId ?? blockNameForPath(blocks, item.block?.path);
          const block = blockName ? blocks[blockName] : undefined;
          return {
            id: item.i,
            title: item.title,
            chart: item.viz?.type,
            ...(blockName ? { block: blockName, blockStatus: block?.status ?? 'unknown', blockPath: block?.filePath } : {}),
            ...(item.dataset?.sourceId ? { datasetSourceId: item.dataset.sourceId } : {}),
            trustLabel: blockName ? tileTrust(block?.status) : 'Needs review',
          };
        })
        : (dashboard.blockIds ?? []).map((blockName) => ({
          block: blockName,
          blockStatus: blocks[blockName]?.status ?? 'unknown',
          blockPath: blocks[blockName]?.filePath,
          trustLabel: tileTrust(blocks[blockName]?.status),
        }));
      return {
        id: dashboard.id,
        qualifiedId: dashboard.qualifiedId,
        title: dashboard.title,
        description: dashboard.description,
        lifecycle: dashboard.lifecycle,
        filePath: dashboard.filePath,
        tiles,
        certifiedTiles: tiles.filter((tile) => tile.trustLabel === 'Certified').length,
        ...(dashboard.unresolvedRefs?.length ? { unresolvedBlocks: dashboard.unresolvedRefs } : {}),
      };
    });
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      domain: app.domain,
      lifecycle: app.lifecycle,
      visibility: app.visibility,
      owners: app.owners,
      tags: app.tags,
      filePath: app.filePath,
      homepage: app.homepage,
      dashboards: appDashboards,
      schedules: (app.schedules ?? []).map((schedule) => ({
        id: schedule.id,
        cron: schedule.cron,
        dashboard: schedule.dashboard,
        enabled: schedule.enabled,
        deliver: schedule.deliver.map((target) => target.kind),
        description: schedule.description,
      })),
      notebooks: app.notebooks,
    };
  });
  return {
    total: all.length,
    returned: apps.length,
    apps,
    note: apps.length === 0
      ? (args.query ? `No App matches "${args.query}".` : 'This project has no Apps yet. build_dql_app drafts one.')
      : 'A tile is Certified only when the saved query it runs is certified. Open an App in the workbench (Apps) to run it.',
  };
}

function blockNameForPath(blocks: Record<string, { filePath?: string }>, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const wanted = normalize(path);
  return Object.entries(blocks).find(([, block]) => block.filePath && normalize(block.filePath) === wanted)?.[0];
}

interface NotebookCellFile {
  id?: string;
  type?: string;
  name?: string;
  title?: string;
  content?: unknown;
  source?: unknown;
}

function cellText(cell: NotebookCellFile): string {
  const value = cell.content ?? cell.source;
  if (Array.isArray(value)) return value.join('');
  return typeof value === 'string' ? value : '';
}

function clip(text: string, max: number): { text: string; truncated?: true } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text };
}

export function listNotebooks(ctx: DQLContext, args: { path?: string; query?: string }) {
  const manifestNotebooks = ctx.manifest.notebooks ?? {};
  const wanted = args.path?.trim() ? normalize(args.path.trim()).replace(/^\.\//, '') : undefined;
  const entries = Object.values(manifestNotebooks).filter((notebook) =>
    (!wanted || normalize(notebook.filePath) === wanted)
    && matches(args.query, [notebook.filePath, notebook.title]));
  if (wanted && entries.length === 0) {
    const known = Object.values(manifestNotebooks).map((notebook) => notebook.filePath);
    return {
      ok: false as const,
      error: `No notebook at "${args.path}". Known notebooks: ${known.length ? known.join(', ') : 'none'}.`,
    };
  }
  const full = Boolean(wanted);
  const notebooks = entries.slice(0, MAX_NOTEBOOKS).map((notebook) => {
    const absolute = join(ctx.projectRoot, notebook.filePath);
    const file = existsSync(absolute) ? readJson(absolute) : undefined;
    const metadata = (file?.metadata ?? {}) as { description?: string };
    const fileCells = Array.isArray(file?.cells) ? file!.cells as NotebookCellFile[] : undefined;
    const cells = fileCells
      ? fileCells.map((cell) => ({
        id: cell.id,
        type: cell.type,
        title: cell.name ?? cell.title,
        ...clip(cellText(cell), full ? CELL_FULL_CHARS : CELL_PREVIEW_CHARS),
      }))
      : notebook.cells.map((cell) => ({ id: cell.id, type: cell.type, title: cell.title, ...clip(cell.source, full ? CELL_FULL_CHARS : CELL_PREVIEW_CHARS) }));
    return {
      path: notebook.filePath,
      title: notebook.title,
      description: metadata.description,
      ownerDomain: notebook.ownerDomain,
      cellCount: cells.length,
      cells,
      tables: [...new Set(notebook.cells.flatMap((cell) => cell.tableDependencies ?? []))],
    };
  });
  return {
    total: entries.length,
    returned: notebooks.length,
    notebooks,
    note: notebooks.length === 0
      ? 'This project has no notebooks yet.'
      : 'Notebook cells are working analysis, not certified answers. Open a notebook in the workbench (Notebooks) to run it.',
  };
}
