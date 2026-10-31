import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ExportRefused, readExport, type ExportTable } from './read-export.js';

/**
 * Reading an export off the server's own thread. Reading a person's file is the
 * one step whose cost a stranger decides, so it gets a thread, a memory ceiling
 * and a clock of its own, and the worst a file can do is fail. Exports are read
 * one at a time.
 */

const WORKER = new URL('./read-export-worker.js', import.meta.url);
const TIME_LIMIT_MS = 60_000;
const MEMORY_LIMIT_MB = 1_536;

let reading: Promise<unknown> = Promise.resolve();

export function readExportAside(bytes: Buffer, fileName: string): Promise<ExportTable> {
  const read = reading.then(() => readInWorker(bytes, fileName));
  reading = read.catch(() => undefined);
  return read;
}

function readInWorker(bytes: Buffer, fileName: string): Promise<ExportTable> {
  // Run from source, as the tests do, there is no compiled worker.
  if (!existsSync(fileURLToPath(WORKER))) return Promise.resolve().then(() => readExport(bytes, fileName));
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: { bytes, fileName },
      resourceLimits: { maxOldGenerationSizeMb: MEMORY_LIMIT_MB },
    });
    const finish = (settle: () => void) => {
      clearTimeout(clock);
      void worker.terminate();
      settle();
    };
    const clock = setTimeout(() => finish(() => reject(new ExportRefused(`${fileName} took too long to read. Export it as CSV.`))), TIME_LIMIT_MS);
    worker.once('message', (message: { table?: ExportTable; refused?: string; failed?: string }) => finish(() => {
      if (message.table) resolve(message.table);
      else if (message.refused) reject(new ExportRefused(message.refused));
      else reject(new Error(message.failed ?? `${fileName} could not be read.`));
    }));
    worker.once('error', () => finish(() => reject(new ExportRefused(`${fileName} needs more memory to read than ZLens allows. Export it as CSV.`))));
  });
}
