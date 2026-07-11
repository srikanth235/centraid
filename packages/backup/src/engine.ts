/*
 * The provider-agnostic engine: snapshot / restore / verify / recovery kit.
 * Everything here is data-semantics the client owns (PROTOCOL.md's framing)
 * — chunking, encryption, manifest shape, restore gating — driven purely
 * through the `BackupProvider` + `ObjectStore` seams, so it runs unchanged
 * against `LocalBackupProvider` or `RemoteBackupProvider`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chunkStream } from './chunker.js';
import {
  activeMasterKey,
  chunkId as computeChunkId,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  encrypt,
  type Keyring,
  masterKeyForEpoch,
} from './crypto.js';
import {
  canonicalJson,
  isSafeEntryPath,
  type ManifestEntry,
  type ManifestEntryKind,
  openManifest,
  sealManifest,
  SNAPSHOT_FORMAT,
} from './manifest.js';
import type { BackupProvider, SnapshotRow } from './provider.js';

export interface SourceEntry {
  /** Path recorded in the manifest — relative, forward-slash, no traversal. */
  path: string;
  kind: ManifestEntryKind;
  /** Where to actually read the bytes from on this machine. */
  absolutePath: string;
}

export interface EngineLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

const noopLog: Required<EngineLogger> = { info: () => undefined, warn: () => undefined };

// ---------------------------------------------------------------------------
// Bounded concurrency helper — chunk uploads run up to 4 in flight while
// entries are still read/chunked one file at a time (bounded memory).
// ---------------------------------------------------------------------------

class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(count: number) {
    this.available = count;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available--;
    return () => this.release();
  }

  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// createSnapshot
// ---------------------------------------------------------------------------

export interface CreateSnapshotOptions {
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  entries: SourceEntry[];
  generation: number;
  appMeta: Record<string, string>;
  log?: EngineLogger;
}

interface PreviousManifestInfo {
  row: SnapshotRow;
  keyEpoch: number;
  entriesByPath: Map<string, ManifestEntry>;
  /** id -> plaintext size, from the previous manifest's public chunkIndex. */
  chunkSizes: Map<string, number>;
}

async function loadPreviousManifest(
  provider: BackupProvider,
  targetId: string,
  keyring: Keyring,
  vaultId: string,
): Promise<PreviousManifestInfo | null> {
  const rows = await provider.listSnapshots(targetId);
  const newest = rows[0];
  if (!newest) return null;
  const store = await provider.openDataPlane(targetId, 'read');
  const bytes = await store.get(newest.manifestKey);
  const opened = openManifest(bytes, keyring, vaultId, newest.manifestHash);
  const entriesByPath = new Map(opened.entries.map((e) => [e.path, e] as const));
  const chunkSizes = new Map(opened.public.chunkIndex.map((c) => [c.id, c.size] as const));
  return { row: newest, keyEpoch: opened.public.keyEpoch, entriesByPath, chunkSizes };
}

async function statEntry(absolutePath: string): Promise<{ size: number; mtimeMs: number }> {
  const st = await fs.stat(absolutePath);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

async function* readFileStream(absolutePath: string): AsyncGenerator<Uint8Array> {
  const handle = await fs.open(absolutePath, 'r');
  try {
    const bufSize = 256 * 1024;
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

/**
 * Build + register one snapshot. Returns `null` when nothing changed (every
 * entry reused its previous chunk refs and the resulting chunkIndex is
 * identical to the previous manifest's) — "a no-change run registers
 * nothing" (spec decision, kept explicit rather than registering a
 * byte-identical manifest under a fresh key every tick).
 */
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<SnapshotRow | null> {
  const log = { ...noopLog, ...opts.log };
  const { epoch: keyEpoch, key: master } = activeMasterKey(opts.keyring);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const dedupKey = deriveDedupKey(master, opts.vaultId);

  const previous = await loadPreviousManifest(
    opts.provider,
    opts.targetId,
    opts.keyring,
    opts.vaultId,
  );
  const sameEpochPrevious = previous && previous.keyEpoch === keyEpoch ? previous : null;
  if (previous && !sameEpochPrevious) {
    log.info(
      `createSnapshot: previous manifest is epoch ${previous.keyEpoch}, active is ${keyEpoch} — full re-upload`,
    );
  }

  const store = await opts.provider.openDataPlane(opts.targetId, 'read-write');
  const uploadSem = new Semaphore(4);
  const knownChunkIds = new Set<string>(sameEpochPrevious?.chunkSizes.keys());
  const newChunkIndex = new Map<string, number>(); // id -> size, this snapshot's full set
  const sealedEntries: ManifestEntry[] = [];
  let totalBytes = 0;
  let everyEntryReused = true;

  for (const entry of opts.entries) {
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`createSnapshot: unsafe entry path "${entry.path}"`);
    }
    const stat = await statEntry(entry.absolutePath);
    totalBytes += stat.size;
    const prior = sameEpochPrevious?.entriesByPath.get(entry.path);

    if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
      // Fast path: reuse recorded chunk refs without reading the file.
      for (const id of prior.chunks) {
        if (!newChunkIndex.has(id)) {
          newChunkIndex.set(id, sameEpochPrevious?.chunkSizes.get(id) ?? 0);
        }
      }
      sealedEntries.push({
        path: entry.path,
        kind: entry.kind,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        chunks: prior.chunks,
      });
      continue;
    }

    everyEntryReused = false;
    const chunkIds: string[] = [];
    const uploads: Promise<void>[] = [];
    for await (const plain of chunkStream(readFileStream(entry.absolutePath))) {
      const id = computeChunkId(dedupKey, plain);
      chunkIds.push(id);
      newChunkIndex.set(id, plain.length);
      if (knownChunkIds.has(id)) continue; // already known to exist (previous manifest or this run)
      knownChunkIds.add(id);
      const release = await uploadSem.acquire();
      const objectKey = `chunks/${id}`;
      const encrypted = encrypt(dataKey, plain);
      uploads.push(
        store
          .head(objectKey)
          .then((head) => (head ? undefined : store.put(objectKey, encrypted)))
          .finally(release),
      );
    }
    await Promise.all(uploads);
    sealedEntries.push({
      path: entry.path,
      kind: entry.kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      chunks: chunkIds,
    });
  }

  const previousChunkIdSet = sameEpochPrevious
    ? new Set(sameEpochPrevious.chunkSizes.keys())
    : null;
  const chunkIndexIdentical =
    everyEntryReused &&
    previousChunkIdSet !== null &&
    previousChunkIdSet.size === newChunkIndex.size &&
    [...newChunkIndex.keys()].every((id) => previousChunkIdSet.has(id));

  if (chunkIndexIdentical) {
    log.info('createSnapshot: no change since previous snapshot — skipping registration');
    return null;
  }

  const chunkIndex = [...newChunkIndex.entries()].map(([id, size]) => ({ id, size }));
  const { bytes, manifestHash } = sealManifest({
    keyring: opts.keyring,
    vaultId: opts.vaultId,
    keyEpoch,
    generation: opts.generation,
    prevManifestHash: previous?.row.manifestHash ?? null,
    chunkIndex,
    appMeta: opts.appMeta,
    entries: sealedEntries,
  });
  const hash8 = manifestHash.slice(0, 8);
  const manifestKey = `manifests/${Date.now()}-${hash8}.json`;
  await store.put(manifestKey, bytes);

  const row = await opts.provider.registerSnapshot(opts.targetId, {
    idempotencyKey: manifestHash,
    manifestKey,
    manifestHash,
    totalBytes,
    objectCount: chunkIndex.length,
    generation: opts.generation,
    format: SNAPSHOT_FORMAT,
    appMeta: opts.appMeta,
  });
  log.info(
    `createSnapshot: registered seq ${row.seq} (${chunkIndex.length} chunks, ${totalBytes} bytes)`,
  );
  return row;
}

// ---------------------------------------------------------------------------
// restoreSnapshot
// ---------------------------------------------------------------------------

export interface RestoreCurrentVersions {
  gatewayVersion: string;
  vaultUserVersion: string;
  ontologyVersion: string;
}

export interface RestoreSnapshotOptions {
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  seq?: number;
  destDir: string;
  current: RestoreCurrentVersions;
}

export interface RestoreResult {
  seq: number;
  generation: number;
  entries: string[];
}

/** `x.y` (or bare `x`) numeric version compare: -1/0/1. Non-numeric parts compare as 0. */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const MIN_SUPPORTED_VAULT_USER_VERSION = '1';
const MIN_SUPPORTED_ONTOLOGY_VERSION = '1.0';

export async function restoreSnapshot(opts: RestoreSnapshotOptions): Promise<RestoreResult> {
  const row =
    opts.seq !== undefined
      ? await opts.provider.getSnapshot(opts.targetId, opts.seq)
      : (await opts.provider.listSnapshots(opts.targetId))[0];
  if (!row) throw new Error('restoreSnapshot: no snapshot available');

  // 1. Compatibility gate BEFORE downloading anything.
  if (row.format !== SNAPSHOT_FORMAT) {
    throw new Error(`restoreSnapshot: unknown format "${row.format}" — update the gateway first`);
  }
  const vaultUserVersion = row.appMeta['vaultUserVersion'];
  const ontologyVersion = row.appMeta['ontologyVersion'];
  if (vaultUserVersion !== undefined) {
    if (compareVersion(vaultUserVersion, opts.current.vaultUserVersion) > 0) {
      throw new Error(
        `restoreSnapshot: snapshot vaultUserVersion ${vaultUserVersion} is newer than running ${opts.current.vaultUserVersion} — update the gateway first (no migrations, v0 stance)`,
      );
    }
    if (compareVersion(vaultUserVersion, MIN_SUPPORTED_VAULT_USER_VERSION) < 0) {
      throw new Error(
        `restoreSnapshot: snapshot vaultUserVersion ${vaultUserVersion} is older than the reader guarantee`,
      );
    }
  }
  if (ontologyVersion !== undefined) {
    if (compareVersion(ontologyVersion, opts.current.ontologyVersion) > 0) {
      throw new Error(
        `restoreSnapshot: snapshot ontologyVersion ${ontologyVersion} is newer than running ${opts.current.ontologyVersion} — update the gateway first`,
      );
    }
    if (compareVersion(ontologyVersion, MIN_SUPPORTED_ONTOLOGY_VERSION) < 0) {
      throw new Error(
        `restoreSnapshot: snapshot ontologyVersion ${ontologyVersion} is older than the reader guarantee`,
      );
    }
  }

  // 3. Fresh directory only — never over a live vault.
  let destEntries: string[];
  try {
    destEntries = await fs.readdir(opts.destDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(opts.destDir, { recursive: true });
      destEntries = [];
    } else {
      throw err;
    }
  }
  if (destEntries.length > 0) {
    throw new Error(
      `restoreSnapshot: destDir "${opts.destDir}" is not empty — refusing to restore over it`,
    );
  }

  const store = await opts.provider.openDataPlane(opts.targetId, 'read');
  const manifestBytes = await store.get(row.manifestKey);

  // 2. Manifest hash verification, then decrypt.
  const opened = openManifest(manifestBytes, opts.keyring, opts.vaultId, row.manifestHash);
  const master = masterKeyForEpoch(opts.keyring, opened.public.keyEpoch);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const dedupKey = deriveDedupKey(master, opts.vaultId);

  for (const entry of opened.entries) {
    // 2 (continued). Reject path traversal entries — openManifest already
    // validated this, but re-check defensively at the point we touch disk.
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`restoreSnapshot: entry path rejected: "${entry.path}"`);
    }
    const parts: Buffer[] = [];
    for (const id of entry.chunks) {
      const ciphertext = await store.get(`chunks/${id}`);
      const plain = decrypt(dataKey, ciphertext);
      const recomputed = computeChunkId(dedupKey, plain);
      if (recomputed !== id) {
        throw new Error(
          `restoreSnapshot: chunk integrity mismatch for "${entry.path}" (chunk ${id})`,
        );
      }
      parts.push(Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength));
    }
    const dest = path.join(opts.destDir, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.concat(parts));
  }

  // 4. Side-effect quarantine marker for the gateway to act on at mount.
  const marker = {
    restoredAt: new Date().toISOString(),
    sourceSeq: row.seq,
    quarantine: ['outbox', 'automations', 'connections'],
  };
  await fs.writeFile(
    path.join(opts.destDir, 'RESTORE_QUARANTINE.json'),
    `${JSON.stringify(marker, null, 2)}\n`,
  );

  return { seq: row.seq, generation: row.generation, entries: opened.entries.map((e) => e.path) };
}

// ---------------------------------------------------------------------------
// verifySnapshot
// ---------------------------------------------------------------------------

export interface VerifySnapshotOptions {
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  seq?: number;
  sampleCount?: number;
}

export interface VerifySnapshotResult {
  checkedObjects: number;
  missing: string[];
  corrupt: string[];
  sampled: number;
}

export async function verifySnapshot(opts: VerifySnapshotOptions): Promise<VerifySnapshotResult> {
  const row =
    opts.seq !== undefined
      ? await opts.provider.getSnapshot(opts.targetId, opts.seq)
      : (await opts.provider.listSnapshots(opts.targetId))[0];
  if (!row) throw new Error('verifySnapshot: no snapshot available');

  const store = await opts.provider.openDataPlane(opts.targetId, 'read');
  const missing: string[] = [];
  const corrupt: string[] = [];
  let checkedObjects = 0;

  const manifestHead = await store.head(row.manifestKey);
  checkedObjects++;
  if (!manifestHead) {
    missing.push(row.manifestKey);
    return { checkedObjects, missing, corrupt, sampled: 0 };
  }
  const manifestBytes = await store.get(row.manifestKey);
  const opened = openManifest(manifestBytes, opts.keyring, opts.vaultId, row.manifestHash);
  const master = masterKeyForEpoch(opts.keyring, opened.public.keyEpoch);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const dedupKey = deriveDedupKey(master, opts.vaultId);

  for (const chunk of opened.public.chunkIndex) {
    checkedObjects++;
    const head = await store.head(`chunks/${chunk.id}`);
    if (!head) missing.push(chunk.id);
  }

  const sampleCount = Math.min(opts.sampleCount ?? 8, opened.public.chunkIndex.length);
  const sample = sampleWithoutReplacement(opened.public.chunkIndex, sampleCount);
  for (const chunk of sample) {
    try {
      const ciphertext = await store.get(`chunks/${chunk.id}`);
      const plain = decrypt(dataKey, ciphertext);
      const recomputed = computeChunkId(dedupKey, plain);
      if (recomputed !== chunk.id) corrupt.push(chunk.id);
    } catch {
      corrupt.push(chunk.id);
    }
  }

  return { checkedObjects, missing, corrupt, sampled: sample.length };
}

function sampleWithoutReplacement<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool[idx] as T);
    pool.splice(idx, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// writeRecoveryKit
// ---------------------------------------------------------------------------

export interface RecoveryKitTarget {
  provider: string;
  targetId: string;
  vaultId: string;
  label: string;
}

export interface WriteRecoveryKitOptions {
  keyring: Keyring;
  targets: RecoveryKitTarget[];
  destFile: string;
}

/** Emit the recovery kit (FORMAT.md § Recovery kit) — live key material, handle accordingly. */
export async function writeRecoveryKit(opts: WriteRecoveryKitOptions): Promise<void> {
  const kit = {
    version: 1,
    kind: 'centraid-recovery-kit',
    createdAt: new Date().toISOString(),
    keyring: opts.keyring,
    targets: opts.targets,
  };
  await fs.mkdir(path.dirname(opts.destFile), { recursive: true });
  const tmp = `${opts.destFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${canonicalJson(kit)}\n`, { mode: 0o600 });
  await fs.rename(tmp, opts.destFile);
}
