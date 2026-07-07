/*
 * Per-app blob content-addressed store (CAS) — issue #190.
 *
 * Attachment bytes live on the filesystem under the vault workspace's app dir
 * (`<workspace appsDir>/<appId>/blobs/<hash>`), keyed by the sha256 of their
 * content — never base64'd into a `*_json` column (which would bloat every
 * transcript read). Content addressing buys free dedup: the same file uploaded
 * twice (or arriving on two turns) lands once. The `attachments` rows in the
 * vault's `journal.db` carry the metadata + `hash`; this store owns the
 * bytes. The root is a provider — it resolves the ACTIVE vault's workspace
 * per call (#280), so the bytes are vault-scoped and export with the vault.
 *
 * GC is refcount-by-hash: the conversation ledger is the source of truth for
 * which hashes are still referenced (`ConversationStore.referencedHashes`), and
 * `gc()` deletes every blob file whose hash is absent from that live set. Run
 * it after a delete-conversation cascade (which drops the `attachments` rows).
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isValidAppId } from '../registry/app-paths.js';

/** A sha256 hex digest — the CAS key + blob filename. */
const HASH_RE = /^[a-f0-9]{64}$/;

/** Compute the CAS key (sha256 hex) for a byte buffer. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The renderer-facing download path for an attachment blob. Served by the
 * conversation route dispatcher (`makeConversationRouteHandler`).
 */
export function blobUrl(appId: string, hash: string): string {
  return `/_centraid-conversations/apps/${encodeURIComponent(appId)}/blobs/${hash}`;
}

export interface PutResult {
  hash: string;
  sizeBytes: number;
  /** True when the bytes were already present (dedup hit) — no write happened. */
  deduped: boolean;
}

export class BlobStore {
  private readonly appsDir: () => string;

  /** `appsDir` resolves the CAS root per call (the active vault's workspace). */
  constructor(appsDir: string | (() => string)) {
    this.appsDir = typeof appsDir === 'string' ? () => appsDir : appsDir;
  }

  private blobDir(appId: string): string {
    if (!isValidAppId(appId)) throw new Error(`blob-store: invalid app id "${appId}"`);
    return path.join(this.appsDir(), appId, 'blobs');
  }

  /** Absolute on-disk path for a blob. Throws on a non-sha256 hash (traversal guard). */
  pathFor(appId: string, hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`blob-store: invalid hash "${hash}"`);
    return path.join(this.blobDir(appId), hash);
  }

  /** Content-address + persist bytes. Idempotent: a dedup hit skips the write. */
  async put(appId: string, bytes: Uint8Array): Promise<PutResult> {
    const hash = hashBytes(bytes);
    const dest = this.pathFor(appId, hash);
    try {
      await fs.access(dest);
      return { hash, sizeBytes: bytes.byteLength, deduped: true };
    } catch {
      // not present — write it
    }
    await fs.mkdir(this.blobDir(appId), { recursive: true });
    // Write to a temp sibling then rename so a crashed write never leaves a
    // partial blob under its (now-wrong) content hash.
    const tmp = `${dest}.tmp-${process.pid}-${hash.slice(0, 8)}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, dest);
    return { hash, sizeBytes: bytes.byteLength, deduped: false };
  }

  async read(appId: string, hash: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(this.pathFor(appId, hash));
    } catch {
      return undefined;
    }
  }

  async exists(appId: string, hash: string): Promise<boolean> {
    try {
      await fs.access(this.pathFor(appId, hash));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete every blob whose hash is not in `referenced` (the live set from the
   * conversation ledger). Returns the count removed. A missing blobs dir is a
   * no-op. `.tmp-*` leftovers from an interrupted `put` are swept too.
   */
  async gc(appId: string, referenced: Set<string>): Promise<{ removed: number }> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.blobDir(appId));
    } catch {
      return { removed: 0 };
    }
    let removed = 0;
    for (const name of entries) {
      const stale = name.includes('.tmp-') || (HASH_RE.test(name) && !referenced.has(name));
      if (!stale) continue;
      try {
        await fs.unlink(path.join(this.blobDir(appId), name));
        removed++;
      } catch {
        /* best-effort */
      }
    }
    return { removed };
  }
}
