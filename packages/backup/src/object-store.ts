import { createWriteStream, promises as fs } from "node:fs";
import type * as TypeImport_g9tn66 from "node:fs";
import path from "node:path";

export interface ObjectListEntry {
  key: string;
  size: number;
  etagOrHash?: string;
  storedAt?: number;
  storageClass?: string;
}

export interface ObjectStore {
  put: (
    key: string,
    data: Uint8Array | AsyncIterable<Uint8Array>
  ) => Promise<void>;
  get: (key: string) => Promise<Uint8Array>;
  getStream: (key: string) => AsyncIterable<Uint8Array>;
  head: (key: string) => Promise<{ size: number } | null>;
  list: (prefix: string) => AsyncIterable<ObjectListEntry>;
  delete: (key: string) => Promise<void>;
}

export function assertSafeKey(key: string): void {
  if (key.length === 0) throw new Error("object key must not be empty");
  if (key.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(key)) {
    throw new Error(`object key must be relative: "${key}"`);
  }
  const segments = key.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new Error(
        `object key must not contain "." or ".." segments: "${key}"`
      );
    }
  }
}

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

  async put(
    key: string,
    data: Uint8Array | AsyncIterable<Uint8Array>
  ): Promise<void> {
    const dest = this.resolve(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      if (data instanceof Uint8Array) {
        await fs.writeFile(tmp, data);
      } else {
        await new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(tmp);
          ws.on("error", reject);
          ws.on("finish", resolve);
          void (async () => {
            const iterator = data[Symbol.asyncIterator]();
            const writeNext = async (): Promise<void> => {
              const next = await iterator.next();
              if (next.done) {
                ws.end();
                return;
              }
              if (!ws.write(next.value)) {
                await new Promise<void>((_resolve) => {
                  ws.once("drain", () => _resolve());
                });
              }
              return writeNext();
            };
            try {
              await writeNext();
            } catch (error) {
              await iterator.return?.();
              ws.destroy();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          })();
        });
      }
      await fs.rename(tmp, dest);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.resolve(key));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  getStream(key: string): AsyncIterable<Uint8Array> {
    const full = this.resolve(key);
    async function* gen(): AsyncGenerator<Uint8Array> {
      const handle = await fs.open(full, "r");
      try {
        const bufSize = 64 * 1024;
        const buf = Buffer.alloc(bufSize);
        const readNext = async function* (): AsyncGenerator<Uint8Array> {
          const { bytesRead } = await handle.read(buf, 0, bufSize, null);
          if (bytesRead === 0) return;
          yield new Uint8Array(buf.subarray(0, bytesRead));
          yield* readNext();
        };
        yield* readNext();
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  list(prefix: string): AsyncIterable<{ key: string; size: number }> {
    const root = this.root;
    async function* walk(
      dir: string
    ): AsyncGenerator<{ key: string; size: number }> {
      let entries: TypeImport_g9tn66.Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const walkNextEntry = async function* (
        index: number
      ): AsyncGenerator<{ key: string; size: number }> {
        const entry = entries[index];
        if (!entry) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(root, full).split(path.sep).join("/");
          if (rel.startsWith(prefix)) {
            const st = await fs.stat(full);
            yield { key: rel, size: st.size };
          }
        }
        yield* walkNextEntry(index + 1);
      };
      yield* walkNextEntry(0);
    }
    if (prefix.length > 0)
      assertSafeKey(prefix.endsWith("/") ? `${prefix}x` : prefix);
    return walk(root);
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
