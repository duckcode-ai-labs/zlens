/** The part of tar-stream 2.x (MIT) that project-archive.ts uses; the package ships no types. */
declare module 'tar-stream' {
  import type { Readable, Writable } from 'node:stream';

  namespace tarStream {
    type EntryType =
      | 'file' | 'link' | 'symlink' | 'character-device' | 'block-device' | 'directory' | 'fifo' | 'contiguous-file'
      | 'pax-header' | 'pax-global-header' | 'gnu-long-link-path' | 'gnu-long-path';

    interface Headers {
      name: string;
      size?: number;
      mode?: number;
      mtime?: Date;
      type?: EntryType | null;
      linkname?: string | null;
      uid?: number;
      gid?: number;
      uname?: string;
      gname?: string;
      devmajor?: number;
      devminor?: number;
    }

    interface Pack extends Readable {
      entry(header: Headers, callback?: (error?: Error | null) => void): Writable;
      entry(header: Headers, buffer: string | Buffer, callback?: (error?: Error | null) => void): Writable;
      finalize(): void;
      destroy(error?: Error): this;
    }

    interface Extract extends Writable {
      on(event: 'entry', listener: (header: Headers, stream: Readable, next: (error?: unknown) => void) => void): this;
      on(event: string | symbol, listener: (...args: any[]) => void): this;
      destroy(error?: Error): this;
    }
  }

  const tarStream: {
    pack(): tarStream.Pack;
    extract(options?: { filenameEncoding?: string; allowUnknownFormat?: boolean }): tarStream.Extract;
  };
  export = tarStream;
}
