import { randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

import { asVaultDiskFullError } from "../errors.js";
import { assertSha, resolveRange } from "./store.js";
import type { BlobRange, BlobStat, BlobStore } from "./store.js";

/* oxlint-disable max-classes-per-file -- (#296) FsBlobStore + MemoryBlobStore are one LocalBlobStore contract, paired by design */

export type BlobLinkOutcome = "linked" | "exists" | "unsupported";

export interface LocalBlobStore extends BlobStore {
  putSync: (sha256: string, bytes: Buffer) => void;
  getSync: (sha256: string, range?: BlobRange) => Buffer | null;
  hasSync: (sha256: string) => boolean;
  deleteSync: (sha256: string) => void;
  listSync: () => string[];
  statSync: (sha256: string) => BlobStat | null;
  adoptTempSync?: (sha256: string, tempPath: string) => boolean;
  promotionTempPathSync?: (sha256: string) => string;
  openReadStreamSync?: (
    sha256: string,
    range?: BlobRange
  ) => {
    stream: Readable;
    size: number;
    range: { start: number; end: number };
  } | null;
  localPathSync?: (sha256: string) => string | null;
  linkFromSync?: (sha256: string, sourcePath: string) => BlobLinkOutcome;
}

export class FsBlobStore implements LocalBlobStore {
  readonly kind = "fs";

  constructor(readonly root: string) {}

  private fileFor(sha: string): string {
    assertSha(sha);
    return path.join(this.root, "sha256", sha.slice(0, 2), sha);
  }

  putSync(sha: string, bytes: Buffer): void {
    const file = this.fileFor(sha);
    if (existsSync(file)) return; // same key, same bytes
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true }); // never leave a partial tmp behind
      throw asVaultDiskFullError("blob CAS write", error);
    }
  }

  getSync(sha: string, range?: BlobRange): Buffer | null {
    const file = this.fileFor(sha);
    if (range) {
      try {
        const size = statSync(file).size;
        const resolved = resolveRange(size, range);
        if (!resolved) return null;
        const bytes = Buffer.alloc(resolved.end - resolved.start + 1);
        const fd = openSync(file, "r");
        try {
          readSync(fd, bytes, 0, bytes.length, resolved.start);
        } finally {
          closeSync(fd);
        }
        return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }
    let whole: Buffer;
    try {
      whole = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return whole;
  }

  hasSync(sha: string): boolean {
    return existsSync(this.fileFor(sha));
  }

  deleteSync(sha: string): void {
    rmSync(this.fileFor(sha), { force: true });
  }

  listSync(): string[] {
    const base = path.join(this.root, "sha256");
    if (!existsSync(base)) return [];
    const shas: string[] = [];
    for (const fan of readdirSync(base)) {
      const dir = path.join(base, fan);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (/^[0-9a-f]{64}$/u.test(name)) shas.push(name);
      }
    }
    return shas.sort();
  }

  statSync(sha: string): BlobStat | null {
    try {
      return { size: statSync(this.fileFor(sha)).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  openReadStreamSync(
    sha: string,
    range?: BlobRange
  ): {
    stream: Readable;
    size: number;
    range: { start: number; end: number };
  } | null {
    const stat = this.statSync(sha);
    if (!stat) return null;
    const resolved = resolveRange(stat.size, range);
    if (!resolved) return null;
    return {
      stream: createReadStream(this.fileFor(sha), resolved),
      size: stat.size,
      range: resolved,
    };
  }

  localPathSync(sha: string): string | null {
    const file = this.fileFor(sha);
    return existsSync(file) ? file : null;
  }

  adoptTempSync(sha: string, tempPath: string): boolean {
    const file = this.fileFor(sha);
    if (existsSync(file)) {
      rmSync(tempPath, { force: true });
      return false;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      renameSync(tempPath, file);
      return true;
    } catch (error) {
      throw asVaultDiskFullError("blob CAS temp adoption", error);
    }
  }

  linkFromSync(sha: string, sourcePath: string): BlobLinkOutcome {
    const file = this.fileFor(sha);
    if (existsSync(file)) return "exists";
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      linkSync(sourcePath, file);
      return "linked";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "exists";
      if (
        code === "EXDEV" ||
        code === "EPERM" ||
        code === "EACCES" ||
        code === "EOPNOTSUPP" ||
        code === "ENOSYS" ||
        code === "EMLINK"
      ) {
        return "unsupported";
      }
      throw asVaultDiskFullError("blob CAS hardlink", error);
    }
  }

  promotionTempPathSync(sha: string): string {
    const file = this.fileFor(sha);
    mkdirSync(path.dirname(file), { recursive: true });
    return `${file}.${randomBytes(6).toString("hex")}.read-through.tmp`;
  }

  put(sha: string, bytes: Buffer): Promise<void> {
    this.putSync(sha, bytes);
    return Promise.resolve();
  }
  get(sha: string, range?: BlobRange): Promise<Buffer | null> {
    return Promise.resolve(this.getSync(sha, range));
  }
  has(sha: string): Promise<boolean> {
    return Promise.resolve(this.hasSync(sha));
  }
  delete(sha: string): Promise<void> {
    this.deleteSync(sha);
    return Promise.resolve();
  }
  list(): Promise<string[]> {
    return Promise.resolve(this.listSync());
  }
  stat(sha: string): Promise<BlobStat | null> {
    return Promise.resolve(this.statSync(sha));
  }
}

export class MemoryBlobStore implements LocalBlobStore {
  readonly kind = "memory";
  private readonly blobs = new Map<string, Buffer>();

  putSync(sha: string, bytes: Buffer): void {
    assertSha(sha);
    if (!this.blobs.has(sha)) this.blobs.set(sha, Buffer.from(bytes));
  }
  getSync(sha: string, range?: BlobRange): Buffer | null {
    const whole = this.blobs.get(assertSha(sha));
    if (!whole) return null;
    if (!range) return Buffer.from(whole);
    const r = resolveRange(whole.length, range);
    return r ? Buffer.from(whole.subarray(r.start, r.end + 1)) : null;
  }
  hasSync(sha: string): boolean {
    return this.blobs.has(assertSha(sha));
  }
  deleteSync(sha: string): void {
    this.blobs.delete(assertSha(sha));
  }
  listSync(): string[] {
    return [...this.blobs.keys()].sort();
  }
  statSync(sha: string): BlobStat | null {
    const b = this.blobs.get(assertSha(sha));
    return b ? { size: b.length } : null;
  }
  adoptTempSync(sha: string, tempPath: string): boolean {
    assertSha(sha);
    if (this.blobs.has(sha)) {
      rmSync(tempPath, { force: true });
      return false;
    }
    this.blobs.set(sha, readFileSync(tempPath));
    rmSync(tempPath, { force: true });
    return true;
  }

  put(sha: string, bytes: Buffer): Promise<void> {
    this.putSync(sha, bytes);
    return Promise.resolve();
  }
  get(sha: string, range?: BlobRange): Promise<Buffer | null> {
    return Promise.resolve(this.getSync(sha, range));
  }
  has(sha: string): Promise<boolean> {
    return Promise.resolve(this.hasSync(sha));
  }
  delete(sha: string): Promise<void> {
    this.deleteSync(sha);
    return Promise.resolve();
  }
  list(): Promise<string[]> {
    return Promise.resolve(this.listSync());
  }
  stat(sha: string): Promise<BlobStat | null> {
    return Promise.resolve(this.statSync(sha));
  }
}
