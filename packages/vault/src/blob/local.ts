// The local tier of blob custody (#296): a content-addressed store
// that is ALWAYS present — the spool every ingress hashes into, the tier
// egress serves from, and the only tier the synchronous command pipeline may
// touch (data_uri spills happen inside a command's transaction, so the local
// store exposes a synchronous surface alongside the async BlobStore
// contract). File-backed vaults keep bytes under `<vault-dir>/blobs/sha256/`
// with a two-hex-char fan-out (a directory detail, not part of any key);
// in-memory vaults (tests) get a Map with identical semantics.

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

/* oxlint-disable max-classes-per-file -- (#296) FsBlobStore + MemoryBlobStore are the two tiers of one LocalBlobStore contract (file-backed + in-memory, identical semantics), paired by design */

/**
 * What `linkFromSync` did (#599 decision 11):
 *   - `linked`      a new directory entry now points at the SAME inode — zero
 *                   bytes copied, and the filesystem's link count is the
 *                   cross-vault refcount.
 *   - `exists`      the content address is already populated here. CAS files
 *                   are immutable and write-once, so same key ⇒ same bytes.
 *   - `unsupported` the filesystem refused the link (EXDEV across mounts,
 *                   EPERM where hardlinks are restricted). The caller falls
 *                   back to a byte copy: identical semantics, costs bytes.
 */
export type BlobLinkOutcome = "linked" | "exists" | "unsupported";

/** The synchronous surface the command pipeline and sweeps rely on. */
export interface LocalBlobStore extends BlobStore {
  putSync: (sha256: string, bytes: Buffer) => void;
  getSync: (sha256: string, range?: BlobRange) => Buffer | null;
  hasSync: (sha256: string) => boolean;
  deleteSync: (sha256: string) => void;
  listSync: () => string[];
  statSync: (sha256: string) => BlobStat | null;
  /**
   * Atomically adopt a fully-written, hash-verified ingress temp file under
   * its content address. File stores rename without materializing the body;
   * memory stores may read it for test parity. Returns false on a dedup hit.
   */
  adoptTempSync?: (sha256: string, tempPath: string) => boolean;
  /** Allocate a same-filesystem temp path for a bounded remote promotion. */
  promotionTempPathSync?: (sha256: string) => string;
  /**
   * Open a large blob for streaming (#367) instead of reading it
   * whole into memory — the replication path uses this for anything over
   * the multipart threshold. `null` when the driver has no streaming seam
   * (e.g. `MemoryBlobStore`) or the blob is absent; callers fall back to
   * `getSync`.
   */
  openReadStreamSync?: (
    sha256: string,
    range?: BlobRange
  ) => {
    stream: Readable;
    size: number;
    range: { start: number; end: number };
  } | null;
  /** Local path for an authorized X-Sendfile-style native handoff. */
  localPathSync?: (sha256: string) => string | null;
  /**
   * Adopt `sourcePath`'s bytes under `sha256` by HARDLINK (#599 decision
   * 11) — the share-by-placement primitive. Present only on file-backed
   * stores; an absent implementation (the memory tier) means the caller copies
   * instead. The two-hex fan-out stays a directory detail owned by this
   * module, so callers never compute a CAS path themselves.
   */
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
    if (existsSync(file)) return; // content-addressed: same key, same bytes
    mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename so a crash never leaves a half blob under its key.
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
      // A write that ran out of disk leaves a partial (or zero-byte) tmp
      // file behind — never let that linger under the blob's fan-out dir.
      rmSync(tmp, { force: true });
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

  /**
   * Hardlink `sourcePath` (another vault's CAS entry for the same content
   * address) into this store. All vaults sit under one gateway rootDir on one
   * filesystem and CAS files are immutable write-once, so a second directory
   * entry onto the same inode is safe and copies ZERO bytes — and the
   * filesystem's link count becomes the cross-vault refcount, so each vault's
   * own sweep can unlink its entry without ever freeing bytes another vault
   * still holds.
   *
   * Attempt-and-catch rather than a boot probe: the classification is per
   * call, and the fallback path must be exercised either way. The catch is
   * narrow — only the errnos that mean "this filesystem will not link" become
   * `unsupported`; ENOSPC becomes the usual `VaultDiskFullError` and every
   * other errno (ENOENT on a vanished source, EIO, …) propagates untouched.
   */
  linkFromSync(sha: string, sourcePath: string): BlobLinkOutcome {
    const file = this.fileFor(sha);
    if (existsSync(file)) return "exists";
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      linkSync(sourcePath, file);
      return "linked";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A concurrent placer won the race to the same content address. CAS is
      // write-once, so the winner's bytes are ours too.
      if (code === "EEXIST") return "exists";
      // EXDEV: source and destination are on different filesystems.
      // EPERM/EACCES/EOPNOTSUPP/ENOSYS/EMLINK: the filesystem (or its mount
      // options, or the inode's link limit) refuses this link.
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

/** In-memory twin for `:memory:` vaults — identical semantics, no files. */
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
