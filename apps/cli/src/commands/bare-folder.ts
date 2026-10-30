import { relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { FolderContents } from './init.js';

/**
 * `zlens notebook <folder>` on a folder with no ZLens project (design D7):
 * in a terminal, ask "No ZLens project here. Create one? [Y/n]" and create it;
 * without a terminal (a script, CI, a desktop launcher) print the single
 * command that creates and opens it. A database file (DuckDB or SQLite) or a
 * folder of CSV, Parquet or JSON files is picked up, so the project is
 * Database only without a flag; a dbt project makes it a dbt project.
 */

export type BareFolderDecision =
  | { action: 'create' }
  | { action: 'declined'; message: string }
  | { action: 'explain'; message: string };

/** The one command that creates the project and opens it, as typed from `cwd`. */
export function bareFolderCommand(folder: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, folder) || '.';
  // Quote only a path a shell would split or expand.
  const shown = /^[\w./-]+$/.test(rel) ? rel : JSON.stringify(rel);
  return `npx zlens notebook ${shown} --yes`;
}

/** The database a folder holds, in plain words: `shop.sqlite`, `3 data files in data/: orders.csv, …`. */
export function describeDatabase(contents: FolderContents): string {
  if (contents.duckdbPath) return contents.duckdbPath;
  if (contents.sqlitePath) return contents.sqlitePath;
  const folder = contents.dataFolder;
  if (!folder) return '';
  const shown = folder.files.slice(0, 3).join(', ') + (folder.files.length > 3 ? ', …' : '');
  const where = folder.path === '.' ? '' : ` in ${folder.path}/`;
  return `${folder.files.length} data file${folder.files.length === 1 ? '' : 's'}${where}: ${shown}`;
}

/** What the folder holds, in plain words, for the question and the message. */
export function describeFolder(contents: FolderContents): string {
  if (contents.isDbt) return contents.duckdbPath ? `a dbt project and the database ${contents.duckdbPath}` : 'a dbt project';
  if (contents.duckdbPath || contents.sqlitePath) return `the database ${describeDatabase(contents)}`;
  if (contents.dataFolder) return describeDatabase(contents);
  return '';
}

/** The kind of project ZLens would create, in plain words. */
export function plannedProjectKind(contents: FolderContents): string {
  if (contents.isDbt) return 'a dbt project';
  if (contents.duckdbPath || contents.sqlitePath) return 'Database only';
  if (contents.dataFolder) return 'Database only, each file a table';
  return 'Guided Setup asks whether you use dbt or a database only';
}

/** "Y", "yes", or Enter accept; anything else declines. */
export function acceptsCreate(answer: string): boolean {
  const value = answer.trim().toLowerCase();
  return value === '' || value === 'y' || value === 'yes';
}

export async function decideBareFolder(input: {
  folder: string;
  contents: FolderContents;
  /** `--yes`: create without asking. */
  yes: boolean;
  /** stdin and stdout are a terminal. */
  interactive: boolean;
  /** Ask one question in the terminal and return the answer. */
  ask?: (question: string) => Promise<string>;
  cwd?: string;
}): Promise<BareFolderDecision> {
  const found = describeFolder(input.contents);
  const command = bareFolderCommand(input.folder, input.cwd);
  if (input.yes) return { action: 'create' };
  if (!input.interactive || !input.ask) {
    return {
      action: 'explain',
      message: [
        `No ZLens project here: ${input.folder}${found ? ` (found ${found})` : ''}.`,
        'To create one and open it, run:',
        '',
        `  ${command}`,
      ].join('\n'),
    };
  }
  const detail = found ? `Found ${found}; the project will be ${plannedProjectKind(input.contents)}.` : plannedProjectKind(input.contents) + '.';
  const answer = await input.ask(`  No ZLens project here. Create one? [Y/n]\n  ${detail}\n  > `);
  if (acceptsCreate(answer)) return { action: 'create' };
  return {
    action: 'declined',
    message: `Nothing was created. To create it later, run:\n\n  ${command}`,
  };
}

/** Ask one question on the terminal. */
export async function askInTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
