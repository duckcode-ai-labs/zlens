import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A block saved in a notebook cell has the manifest path
 * `notebooks/x.dqlnb#<cell id>` (see `extractNotebookBlocks`): the notebook
 * file, then the cell. Returns the two parts, or undefined for a block file.
 */
export function notebookBlockPath(filePath: string): { notebookPath: string; cellId: string } | undefined {
  const match = /^(.+\.dqlnb)#(.+)$/i.exec(filePath);
  return match ? { notebookPath: match[1]!, cellId: match[2]! } : undefined;
}

/**
 * The DQL text of a block, from its manifest `filePath`. A block file is read
 * as it is; a block in a notebook cell is that cell's source, found the way
 * the manifest scan names cells (its id, else `cell-<n>` counting the SQL and
 * DQL cells before it). Every place that reads a block for an App, a run or a
 * revision reads it here, so a notebook block resolves like a block file and
 * hashes to the same source revision everywhere.
 *
 * Throws (like `readFileSync`) when the file or the cell is missing.
 */
export function readBlockSource(projectRoot: string, filePath: string): string {
  const notebook = notebookBlockPath(filePath);
  if (!notebook) return readFileSync(join(projectRoot, filePath), 'utf-8');
  const doc = JSON.parse(readFileSync(join(projectRoot, notebook.notebookPath), 'utf-8')) as { cells?: unknown };
  const cells = Array.isArray(doc.cells) ? doc.cells : [];
  let index = 0;
  for (const raw of cells) {
    if (!raw || typeof raw !== 'object') continue;
    const cell = raw as { id?: unknown; type?: unknown; source?: unknown; content?: unknown };
    if (cell.type !== 'sql' && cell.type !== 'dql') continue;
    const source = typeof cell.source === 'string' ? cell.source : typeof cell.content === 'string' ? cell.content : '';
    if (!source.trim()) continue;
    const id = cell.id !== undefined && cell.id !== null ? String(cell.id) : `cell-${index}`;
    index += 1;
    if (id === notebook.cellId) return source;
  }
  const error = new Error(`ENOENT: the notebook ${notebook.notebookPath} has no cell ${notebook.cellId} any more`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}
