import { inflateRawSync } from 'node:zlib';

/**
 * Read files out of a zip: a Tableau .twbx and a Power BI .pbit are zips. Only
 * what the import needs: stored and deflated entries, no ZIP64, no
 * encryption, and a cap on what an entry may inflate to, so a crafted file
 * cannot fill memory.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
/** Workbook XML and model JSON are a few MB; extracts and images are never read. */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

export function listZipEntries(zip: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(zip);
  if (end < 0) throw new Error('Not a zip file.');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (offset === 0xffffffff) throw new Error('This file uses ZIP64, which ZLens does not read.');
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) throw new Error('The zip directory is damaged.');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString((flags & 0x800) ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x1)) entries.push({ name, method, compressedSize, size, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(zip: Buffer, entry: ZipEntry, maxBytes: number = MAX_ZIP_ENTRY_BYTES): Buffer {
  if (entry.size > maxBytes) throw new Error(`${entry.name} is larger than ZLens reads (${Math.round(maxBytes / 1024 / 1024)} MB).`);
  const local = entry.localHeaderOffset;
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL_FILE_HEADER) throw new Error(`The zip entry ${entry.name} is damaged.`);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    // A stored entry's real size is what it occupies, whatever its header says.
    if (data.length > maxBytes) throw new Error(`${entry.name} is larger than ZLens reads (${Math.round(maxBytes / 1024 / 1024)} MB).`);
    return Buffer.from(data);
  }
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new Error(`The zip entry ${entry.name} uses a compression ZLens does not read (method ${entry.method}).`);
}

/** The first entry `pick` accepts, read; null when there is none. */
export function readZipFile(zip: Buffer, pick: (name: string) => boolean): { name: string; data: Buffer } | null {
  const entry = listZipEntries(zip).find((item) => pick(item.name));
  return entry ? { name: entry.name, data: readZipEntry(zip, entry) } : null;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const stop = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= stop; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

/** Text a Power BI file stores as UTF-16 (DataModelSchema) or UTF-8, without its byte order mark. */
export function decodeModelText(data: Buffer): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString('utf16le');
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3).toString('utf8');
  // UTF-16 without a mark: every other byte of ASCII JSON is zero.
  if (data.length >= 4 && data[1] === 0 && data[3] === 0) return data.toString('utf16le');
  return data.toString('utf8');
}
