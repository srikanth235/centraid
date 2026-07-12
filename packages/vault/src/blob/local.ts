// The local tier of blob custody (issue #296): a content-addressed store
// that is ALWAYS present — the spool every ingress hashes into, the tier
// egress serves from, and the only tier the synchronous command pipeline may
// touch (data_uri spills happen inside a command's transaction, so the local
// store exposes a synchronous surface alongside the async BlobStore
// contract). File-backed vaults keep bytes under `<vault-dir>/blobs/sha256/`
// with a two-hex-char fan-out (a directory detail, not part of any key);
// in-memory vaults (tests) get a Map with identical semantics.

import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { asVaultDiskFullError } from '../errors.js';
import { assertSha, resolveRange, type BlobRange, type BlobStat, type BlobStore } from './store.js';

/* eslint-disable max-classes-per-file -- (#296) FsBlobStore + MemoryBlobStore are the two tiers of one LocalBlobStore contract (file-backed + in-memory, identical semantics), paired by design */

/** The synchronous surface the command pipeline and sweeps rely on. */
export interface LocalBlobStore extends BlobStore {
  putSync(sha256: string, bytes: Buffer): void;
  getSync(sha256: string, range?: BlobRange): Buffer | null;
  hasSync(sha256: string): boolean;
  deleteSync(sha256: string): void;
  listSync(): string[];
  statSync(sha256: string): BlobStat | null;
  /**
   * Open a large blob for streaming (issue #367 §C8) instead of reading it
   * whole into memory — the replication path uses this for anything over
   * the multipart threshold. `null` when the driver has no streaming seam
   * (e.g. `MemoryBlobStore`) or the blob is absent; callers fall back to
   * `getSync`.
   */
  openReadStreamSync?(sha256: string): { stream: NodeJS.ReadableStream; size: number } | null;
}

export class FsBlobStore implements LocalBlobStore {
  readonly kind = 'fs';

  constructor(readonly root: string) {}

  private fileFor(sha: string): string {
    assertSha(sha);
    return path.join(this.root, 'sha256', sha.slice(0, 2), sha);
  }

  putSync(sha: string, bytes: Buffer): void {
    const file = this.fileFor(sha);
    if (existsSync(file)) return; // content-addressed: same key, same bytes
    mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename so a crash never leaves a half blob under its key.
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch (err) {
      // A write that ran out of disk leaves a partial (or zero-byte) tmp
      // file behind — never let that linger under the blob's fan-out dir.
      rmSync(tmp, { force: true });
      throw asVaultDiskFullError('blob CAS write', err);
    }
  }

  getSync(sha: string, range?: BlobRange): Buffer | null {
    const file = this.fileFor(sha);
    let whole: Buffer;
    try {
      whole = readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!range) return whole;
    const r = resolveRange(whole.length, range);
    return r ? whole.subarray(r.start, r.end + 1) : null;
  }

  hasSync(sha: string): boolean {
    return existsSync(this.fileFor(sha));
  }

  deleteSync(sha: string): void {
    rmSync(this.fileFor(sha), { force: true });
  }

  listSync(): string[] {
    const base = path.join(this.root, 'sha256');
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
        if (/^[0-9a-f]{64}$/.test(name)) shas.push(name);
      }
    }
    return shas.sort();
  }

  statSync(sha: string): BlobStat | null {
    try {
      return { size: statSync(this.fileFor(sha)).size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  openReadStreamSync(sha: string): { stream: NodeJS.ReadableStream; size: number } | null {
    const stat = this.statSync(sha);
    if (!stat) return null;
    return { stream: createReadStream(this.fileFor(sha)), size: stat.size };
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

/** In-memory twin for `:memory:` vaults — identical semantics, no files. */
export class MemoryBlobStore implements LocalBlobStore {
  readonly kind = 'memory';
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
