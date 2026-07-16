/*
 * The data-plane seam: a flat, S3-shaped key/value object namespace. Every
 * engine write goes through this interface — `FsObjectStore` backs the
 * local provider directly; `s3-store.ts` implements the same interface over
 * a real S3-compatible grant so the engine (`engine.ts`) never branches on
 * "am I local or remote".
 */

import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';

export interface ObjectListEntry {
  key: string;
  size: number;
  /** Present when the underlying LIST surface reports it. */
  etagOrHash?: string;
  /** Unix epoch seconds; present when the underlying LIST reports it. */
  storedAt?: number;
  storageClass?: string;
}

export interface ObjectStore {
  put(key: string, data: Uint8Array | AsyncIterable<Uint8Array>): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  getStream(key: string): AsyncIterable<Uint8Array>;
  head(key: string): Promise<{ size: number } | null>;
  list(prefix: string): AsyncIterable<ObjectListEntry>;
  delete(key: string): Promise<void>;
}

/**
 * Reject anything that could escape the store root: absolute paths, `..`
 * segments, and empty keys. Object keys are always POSIX-style (`chunks/ab`,
 * `manifests/123-abcd.json`) regardless of host OS.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0) throw new Error('object key must not be empty');
  if (key.startsWith('/') || /^[A-Za-z]:[\\/]/.test(key)) {
    throw new Error(`object key must be relative: "${key}"`);
  }
  const segments = key.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(`object key must not contain "." or ".." segments: "${key}"`);
    }
  }
}

/**
 * `ObjectStore` backed by files under `root`. Keys map 1:1 to relative
 * paths; writes are atomic (temp file + rename, mirroring the registry/
 * keyring atomic-write convention elsewhere in the monorepo) so a crash
 * mid-write never leaves a half-written chunk or manifest object visible.
 */
export class FsObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    const rootResolved = path.resolve(this.root) + path.sep;
    if (full !== path.resolve(this.root) && !full.startsWith(rootResolved)) {
      throw new Error(`object key escapes store root: "${key}"`);
    }
    return full;
  }

  async put(key: string, data: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    const dest = this.resolve(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      if (data instanceof Uint8Array) {
        await fs.writeFile(tmp, data);
      } else {
        await new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(tmp);
          ws.on('error', reject);
          ws.on('finish', resolve);
          (async () => {
            try {
              for await (const chunk of data) {
                if (!ws.write(chunk)) {
                  await new Promise<void>((resolve) => ws.once('drain', () => resolve()));
                }
              }
              ws.end();
            } catch (err) {
              ws.destroy();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        });
      }
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.resolve(key));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  getStream(key: string): AsyncIterable<Uint8Array> {
    const full = this.resolve(key);
    /** @yields Successive byte ranges of the file, in order. */
    async function* gen(): AsyncGenerator<Uint8Array> {
      const handle = await fs.open(full, 'r');
      try {
        const bufSize = 64 * 1024;
        const buf = Buffer.alloc(bufSize);
        for (;;) {
          const { bytesRead } = await handle.read(buf, 0, bufSize, null);
          if (bytesRead === 0) break;
          yield new Uint8Array(buf.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    }
    return gen();
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const st = await fs.stat(this.resolve(key));
      if (!st.isFile()) return null;
      return { size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  list(prefix: string): AsyncIterable<{ key: string; size: number }> {
    const root = this.root;
    // An empty prefix lists everything; a non-empty prefix must still resolve
    // safely (reuse assertSafeKey semantics) even though it may not exist as
    // a literal path segment boundary (e.g. prefix "chunks/ab" over key
    // "chunks/abcd..."), so we walk the nearest existing ancestor directory
    // and filter by string prefix on the POSIX-joined relative key.
    async function* walk(dir: string): AsyncGenerator<{ key: string; size: number }> {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (rel.startsWith(prefix)) {
            const st = await fs.stat(full);
            yield { key: rel, size: st.size };
          }
        }
      }
    }
    if (prefix.length > 0) assertSafeKey(prefix.endsWith('/') ? `${prefix}x` : prefix);
    return walk(root);
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
