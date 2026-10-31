import { parentPort, workerData } from 'node:worker_threads';
import { ExportRefused, readExport } from './read-export.js';

const { bytes, fileName } = workerData as { bytes: Uint8Array; fileName: string };

try {
  parentPort!.postMessage({ table: readExport(Buffer.from(bytes), fileName) });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  parentPort!.postMessage(error instanceof ExportRefused ? { refused: message } : { failed: message });
}
