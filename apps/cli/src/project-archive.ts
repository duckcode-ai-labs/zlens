import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import tarStream from 'tar-stream';

/**
 * A ZLens project as a .tar.gz, made and unpacked inside Node.
 *
 * The app for Snowflake runs on a distroless image with no tar, gzip or shell (#331), so the copy of the project
 * in the customer's backup stage cannot shell out to tar. This writes the same archive `tar -czf FILE -C ROOT .`
 * wrote (entries named `./`, `./domains/`, `./domains/sales.dql`; gzip), so copies made before still restore and a
 * person can still open one with tar, and it unpacks one under the rules the restore needs: every entry stays
 * inside the folder it is unpacked into, only folders and plain files are written (no links, devices or FIFOs),
 * nothing changes owner, and files take the time they are unpacked (tar's -m).
 */

const CHUNK = 1024 * 1024;

/** Why an archive was refused, in words the restore puts after "the project is unchanged". */
export class ArchiveRefusedError extends Error {}

/**
 * Write the project at `root` to `file` as a .tar.gz, leaving out every path `excluded` names (paths relative to
 * `root`, with `/`). Folders and plain files only: a symbolic link, socket or device in the project is left out,
 * because a restore would refuse it.
 */
export async function packProject(root: string, file: string, excluded: (path: string) => boolean): Promise<void> {
  const pack = tarStream.pack();
  const written = pipeline(pack, createGzip(), createWriteStream(file));
  let failure: unknown;
  try {
    await addFolder(pack, root, '', excluded);
    pack.finalize();
  } catch (error) {
    failure = error;
    pack.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  try {
    await written;
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

type Pack = tarStream.Pack;

function addEntry(pack: Pack, header: tarStream.Headers): Promise<void> {
  return new Promise((done, fail) => {
    pack.entry(header, (error?: Error | null) => (error ? fail(error) : done()));
  });
}

async function addFolder(pack: Pack, root: string, path: string, excluded: (path: string) => boolean): Promise<void> {
  const absolute = path ? join(root, path) : root;
  const info = await lstat(absolute);
  // `tar -C ROOT .` names the root `./` and everything under it `./…`, folders with a trailing slash.
  await addEntry(pack, { name: path ? `./${path}/` : './', type: 'directory', mode: info.mode & 0o7777, mtime: info.mtime });
  for (const name of (await readdir(absolute)).sort()) {
    const child = path ? `${path}/${name}` : name;
    if (excluded(child)) continue;
    const childInfo = await lstat(join(root, child));
    if (childInfo.isDirectory()) await addFolder(pack, root, child, excluded);
    else if (childInfo.isFile()) await addFile(pack, join(root, child), `./${child}`, childInfo.size, childInfo.mode, childInfo.mtime);
    // Symbolic links, sockets, FIFOs and devices are not part of a project.
  }
}

/**
 * One file, as many bytes as it had when it was listed: what a file gains while it is read is left out, and what
 * it loses is padded with zeros, as tar does, so a database written meanwhile cannot break the archive.
 */
async function addFile(pack: Pack, absolute: string, name: string, size: number, mode: number, mtime: Date): Promise<void> {
  const handle = await open(absolute, 'r');
  try {
    await new Promise<void>((done, fail) => {
      const sink = pack.entry({ name, type: 'file', size, mode: mode & 0o7777, mtime }, (error?: Error | null) => (error ? fail(error) : done()));
      let closed = false;
      sink.on('close', () => { closed = true; });
      const drained = () => new Promise<void>((ready) => {
        const go = () => { sink.off('drain', go); sink.off('close', go); ready(); };
        sink.on('drain', go);
        sink.on('close', go);
      });
      void (async () => {
        let left = size;
        while (left > 0 && !closed) {
          const want = Math.min(CHUNK, left);
          // Zeros where the file ended early (it shrank while it was read).
          const chunk = Buffer.alloc(want);
          let filled = 0;
          while (filled < want) {
            const { bytesRead } = await handle.read(chunk, filled, want - filled, null);
            if (bytesRead === 0) break;
            filled += bytesRead;
          }
          left -= want;
          if (!sink.write(chunk)) await drained();
        }
        sink.end();
      })().catch((error: unknown) => fail(error));
    });
  } finally {
    await handle.close();
  }
}

/**
 * Where an entry goes inside the folder it is unpacked into, or a refusal: no absolute path, no `..`, no
 * backslash or NUL. `./` and empty parts are dropped, so `./domains/x.dql` and `domains/x.dql` are the same.
 */
export function entryPath(name: string): string {
  if (name.includes('\0') || name.includes('\\')) throw new ArchiveRefusedError(`It has an entry with a name ZLens will not write (${JSON.stringify(name)}).`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ArchiveRefusedError(`It has an entry with an absolute path (${name}).`);
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) throw new ArchiveRefusedError(`It has an entry that would be written outside the project (${name}).`);
  return parts.join('/');
}

/**
 * Unpack a .tar.gz into `into` (an empty folder), or refuse it: every entry must stay inside `into`, and only
 * folders and plain files are written. A refusal or a broken archive throws; what was unpacked so far stays in
 * `into` for the caller to remove.
 */
export async function unpackProject(archive: string, into: string): Promise<void> {
  const root = resolve(into);
  const extract = tarStream.extract();
  extract.on('entry', (header: tarStream.Headers, stream: Readable, next: (error?: unknown) => void) => {
    writeEntry(root, header, stream).then(() => next(), (error: unknown) => {
      stream.resume();
      extract.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await pipeline(createReadStream(archive), createGunzip(), extract);
}

async function writeEntry(root: string, header: tarStream.Headers, stream: Readable): Promise<void> {
  const path = entryPath(header.name);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) throw new ArchiveRefusedError(`It has an entry that would be written outside the project (${header.name}).`);
  // tar-stream names every type it knows ('0' and the old NUL type are 'file'); anything else is refused below.
  const type = header.type ?? 'an unknown kind of entry';
  if (type === 'directory') {
    stream.resume();
    if (target !== root) await mkdir(target, { recursive: true, mode: 0o755 });
    return;
  }
  if (type !== 'file' && type !== 'contiguous-file') {
    const what = type === 'symlink' ? 'a symbolic link' : type === 'link' ? 'a hard link' : type.startsWith('an ') ? type : `a ${type}`;
    throw new ArchiveRefusedError(`It has ${what} (${header.name}), which ZLens does not restore.`);
  }
  if (target === root) throw new ArchiveRefusedError(`It has a file with no name (${header.name}).`);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  // The owner can always read and write; group and others never write; no set-id bits. The time is now (-m).
  const mode = ((header.mode ?? 0o644) & 0o755) | 0o600;
  await pipeline(stream, createWriteStream(target, { mode }));
}
