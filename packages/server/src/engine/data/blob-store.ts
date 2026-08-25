// Per-app CAS (#190): `<appsDir>/<appId>/blobs/<sha256>`. GC is refcount-by-hash.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isValidAppOrAssistantId } from "../registry/app-paths.js";

const HASH_RE = /^[a-f0-9]{64}$/u;

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function blobUrl(appId: string, hash: string): string {
  return `/_centraid-conversations/apps/${encodeURIComponent(appId)}/blobs/${hash}`;
}

export interface PutResult {
  hash: string;
  sizeBytes: number;
  deduped: boolean;
}

export class BlobStore {
  private readonly appsDir: () => string;

  constructor(appsDir: string | (() => string)) {
    this.appsDir = typeof appsDir === "string" ? () => appsDir : appsDir;
  }

  private blobDir(appId: string): string {
    if (!isValidAppOrAssistantId(appId)) {
      throw new Error(`blob-store: invalid app id "${appId}"`);
    }
    return path.join(this.appsDir(), appId, "blobs");
  }

  pathFor(appId: string, hash: string): string {
    if (!HASH_RE.test(hash))
      throw new Error(`blob-store: invalid hash "${hash}"`);
    return path.join(this.blobDir(appId), hash);
  }

  async put(appId: string, bytes: Uint8Array): Promise<PutResult> {
    const hash = hashBytes(bytes);
    const dest = this.pathFor(appId, hash);
    try {
      await fs.access(dest);
      return { hash, sizeBytes: bytes.byteLength, deduped: true };
    } catch {
      // absent — write
    }
    await fs.mkdir(this.blobDir(appId), { recursive: true });
    // Temp sibling then rename so a crash never leaves a partial blob under its hash.
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

  async gc(
    appId: string,
    referenced: Set<string>
  ): Promise<{ removed: number }> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.blobDir(appId));
    } catch {
      return { removed: 0 };
    }
    const removals = await Promise.all(
      entries
        .filter(
          (name) =>
            name.includes(".tmp-") ||
            (HASH_RE.test(name) && !referenced.has(name))
        )
        .map(async (name) => {
          try {
            await fs.unlink(path.join(this.blobDir(appId), name));
            return 1;
          } catch {
            return 0;
          }
        })
    );
    const removed = removals.filter(Boolean).length;
    return { removed };
  }
}
