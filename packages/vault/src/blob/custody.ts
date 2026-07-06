// Blob custody facade (issue #296): the two tiers behind one surface.
//
//   local  — a LocalBlobStore, ALWAYS present and always complete: every
//            ingress hashes into it (it is the spool), every egress serves
//            from it, and the synchronous command pipeline touches only it.
//   remote — an optional BlobStore (S3-compatible) that REPLICATES the local
//            tier for durability. Replication is a sweep, never in-line with
//            a write; remote deletes are reconciliation's job (list-diff), so
//            a crash between a local purge and a remote delete costs an
//            orphan object, never a dangling row.
//
// Encryption (settings `blob_store.encrypt`): remote objects seal per blob
// with AES-256-GCM under the vault's DEK (the #293 key custody), AAD
// `blob:<sha>`. Identity and dedup key off the PLAINTEXT sha — re-keying
// never changes an address — and the local tier stays plaintext (it shares
// vault.db's disk trust; the remote tier is the third party).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LocalBlobStore } from './local.js';
import { sha256OfBytes, type BlobRange, type BlobStore } from './store.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** AAD binding a remote ciphertext to its content address. */
function blobAad(sha: string): Buffer {
  return Buffer.from(`blob:${sha}`, 'utf8');
}

export function sealBlob(key: Buffer, sha: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(blobAad(sha));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function unsealBlob(key: Buffer, sha: string, sealed: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('sealed blob truncated');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(blobAad(sha));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** How the host resolves the (settings-declared) remote tier on demand. */
export interface RemoteTier {
  store: BlobStore;
  /** Seal remote objects with this key (settings `blob_store.encrypt`). */
  encryptKey?: Buffer;
}

export interface ReconcileResult {
  /** Remote objects no live sha claims — deleted. */
  orphansDeleted: string[];
  /** Live shas the remote tier is missing — replicated now. */
  replicated: string[];
  /** Live shas missing from BOTH tiers — an integrity error, reported. */
  missing: string[];
}

export class BlobCustody {
  constructor(
    readonly local: LocalBlobStore,
    /**
     * Resolved lazily on every use: the remote tier follows the CURRENT
     * settings row, so switching `blob_store` needs no reopen. Returns null
     * when the vault is local-only.
     */
    private readonly remoteTier: () => RemoteTier | null,
  ) {}

  /** Hash raw bytes and store them locally — the one ingress everything uses. */
  ingestSync(bytes: Buffer): { sha256: string; byteSize: number } {
    const sha = sha256OfBytes(bytes);
    this.local.putSync(sha, bytes);
    return { sha256: sha, byteSize: bytes.length };
  }

  hasSync(sha: string): boolean {
    return this.local.hasSync(sha);
  }

  getSync(sha: string, range?: BlobRange): Buffer | null {
    return this.local.getSync(sha, range);
  }

  statSync(sha: string): { size: number } | null {
    return this.local.statSync(sha);
  }

  /** Local hit, else remote fetch (unsealing if configured) + re-cache. */
  async open(sha: string, range?: BlobRange): Promise<Buffer | null> {
    const localHit = this.local.getSync(sha, range);
    if (localHit) return localHit;
    const remote = this.remoteTier();
    if (!remote) return null;
    // Sealed objects can't honor a byte range remotely — fetch whole, unseal,
    // cache locally, then slice. Plain remotes could range-read, but caching
    // the whole blob is what makes the next read local; blobs are bounded.
    const raw = await remote.store.get(sha);
    if (!raw) return null;
    const plain = remote.encryptKey ? unsealBlob(remote.encryptKey, sha, raw) : raw;
    if (sha256OfBytes(plain) !== sha) {
      throw new Error(`remote blob ${sha} failed content verification`);
    }
    this.local.putSync(sha, plain);
    return this.local.getSync(sha, range);
  }

  /** Delete the local copy now; the remote copy falls to reconciliation. */
  deleteLocalSync(sha: string): void {
    this.local.deleteSync(sha);
  }

  /** Best-effort immediate delete on both tiers (vault deletion path). */
  async deleteEverywhere(sha: string): Promise<void> {
    this.local.deleteSync(sha);
    const remote = this.remoteTier();
    if (remote) await remote.store.delete(sha);
  }

  /** Push every local sha the remote tier lacks. Returns what moved. */
  async replicate(shas?: string[]): Promise<string[]> {
    const remote = this.remoteTier();
    if (!remote) return [];
    const want = shas ?? this.local.listSync();
    const there = new Set(await remote.store.list());
    const moved: string[] = [];
    for (const sha of want) {
      if (there.has(sha)) continue;
      const bytes = this.local.getSync(sha);
      if (!bytes) continue;
      await remote.store.put(
        sha,
        remote.encryptKey ? sealBlob(remote.encryptKey, sha, bytes) : bytes,
      );
      moved.push(sha);
    }
    return moved;
  }

  /**
   * The reconciliation sweep (issue #296 §6): remote list vs the live sha
   * set. Orphans (remote objects nothing claims) delete; missing replicas
   * re-push; shas absent from BOTH tiers are reported, never invented.
   */
  async reconcile(liveShas: Set<string>): Promise<ReconcileResult> {
    const result: ReconcileResult = { orphansDeleted: [], replicated: [], missing: [] };
    const remote = this.remoteTier();
    const remoteShas = remote ? new Set(await remote.store.list()) : new Set<string>();
    if (remote) {
      for (const sha of remoteShas) {
        if (!liveShas.has(sha)) {
          await remote.store.delete(sha);
          result.orphansDeleted.push(sha);
        }
      }
    }
    for (const sha of liveShas) {
      const localHas = this.local.hasSync(sha);
      if (!localHas && remote && remoteShas.has(sha)) {
        await this.open(sha); // re-cache from remote
        result.replicated.push(sha);
        continue;
      }
      if (localHas && remote && !remoteShas.has(sha)) {
        result.replicated.push(...(await this.replicate([sha])));
        continue;
      }
      if (!localHas && (!remote || !remoteShas.has(sha))) result.missing.push(sha);
    }
    return result;
  }

  /**
   * Copy the whole local tier into `destDir/blobs` — the self-contained
   * export/backup gesture (issue #296 §6: the exit ramp from S3 is a
   * directory). The local tier is always complete, so no remote pull needed.
   */
  exportTo(destDir: string): { copied: number } {
    const shas = this.local.listSync();
    const destRoot = path.join(destDir, 'blobs');
    let copied = 0;
    for (const sha of shas) {
      const bytes = this.local.getSync(sha);
      if (!bytes) continue;
      const file = path.join(destRoot, 'sha256', sha.slice(0, 2), sha);
      if (!existsSync(file)) {
        writeBlobFile(file, bytes);
        copied += 1;
      }
    }
    return { copied };
  }
}

/** Write-then-rename so a crashed export never leaves a half blob. */
function writeBlobFile(file: string, bytes: Buffer): void {
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, file);
}
