// governance: allow-repo-hygiene file-size-limit (#363) the provider-agnostic snapshot/restore/verify/recovery engine (PROTOCOL.md's data-semantics owner); splitting the pipeline stages would scatter one cohesive contract across files that all change together on a protocol revision
/*
 * The provider-agnostic engine: snapshot / restore / verify / recovery kit.
 * Everything here is data-semantics the client owns (PROTOCOL.md's framing)
 * — chunking, encryption, manifest shape, restore gating — driven purely
 * through the `BackupProvider` + `ObjectStore` seams, so it runs unchanged
 * against `LocalBackupProvider` or `RemoteBackupProvider`.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { frameChunkPayload, unframeChunkPayload } from './compress.js';
import {
  activeMasterKey,
  chunkId as computeChunkId,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  deriveNonce,
  encryptWithNonce,
  type Keyring,
  masterKeyForEpoch,
} from './crypto.js';
import type { EngineLogger } from './engine-log.js';
import {
  assertManifestMatchesRegistry,
  canonicalJson,
  isSafeEntryPath,
  type ManifestEntry,
  type ManifestEntryKind,
  openManifest,
  READABLE_SNAPSHOT_FORMATS,
  sealManifest,
  SNAPSHOT_FORMAT,
  validateSnapshotBasePair,
} from './manifest.js';
import { partStream } from './parts.js';
import type { BackupProvider, SnapshotRow } from './provider.js';
import type { ObjectStore } from './object-store.js';
import {
  openWalCloser,
  openWalPairMarker,
  openWalSegment,
  parseWalCloserKey,
  parseWalPairMarkerKey,
  parseWalSegmentKey,
  planCoordinatedReplay,
  planWalReplay,
  type WalDbName,
  type WalGroupCloser,
  type WalPairMarker,
  type WalSegmentAddress,
  type WalStreamListing,
  WAL_DB_FILES,
  WAL_DB_NAMES,
  walPairMarkerPrefix,
  walSegmentKey,
  walSegmentPrefix,
} from './wal-format.js';
import { replayWalSegments, type WalReplayOutcome } from './wal-restore.js';

export interface SourceEntry {
  /** Path recorded in the manifest — relative, forward-slash, no traversal. */
  path: string;
  kind: ManifestEntryKind;
  /** Where to actually read the bytes from on this machine. */
  absolutePath: string;
  /** /1, `kind: 'db'` only: plaintext SHA-256 of the base file (G9 marker). */
  sha256?: string;
  /** /1, `kind: 'db'` only: the WAL stream generation this base anchors. */
  walGeneration?: string;
  /** /1, `kind: 'db'` only: the tick this base was cloned at. MUST match the sibling's. */
  baseTickMs?: number;
  /** /1, `kind: 'db'` only: newest pair-marker tick CONFIRMED uploaded (a floor the store owes). */
  walTipTickMs?: number;
}

export type { EngineLogger } from './engine-log.js';

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
  const store = await provider.openDataPlane(targetId, 'backup', 'read');
  const { opened } = await openSnapshotRow(newest, store, keyring, vaultId);
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

  const store = await opts.provider.openDataPlane(opts.targetId, 'backup', 'read-write');
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

    // `(size, mtimeMs)` is a HEURISTIC for "unchanged", not an identity — and
    // for the WAL-backed db path it is a heuristic over a file the caller REPLACED:
    // each generation's base is a fresh clone at a fresh path, and two clones
    // of one database routinely share a size (same page count). On a
    // filesystem whose mtime granularity is coarser than the gap between two
    // checkpoints they share an mtime too, and then the fast path below would
    // reuse the PREVIOUS generation's chunk refs while stamping the CURRENT
    // generation's `sha256`/`walGeneration` into the entry — a manifest whose
    // chunks restore the old base under the new generation's segments. Restore
    // catches it (the base hash is verified), so the failure is loud rather
    // than silent, but the snapshot it registered can never be restored: a
    // destroyed restore point that every surface reports as healthy.
    // When the caller vouches for the content — the WAL shipper always hashes
    // its base clones — that hash IS the identity test, so require it.
    const contentUnchanged = entry.sha256 === undefined || prior?.sha256 === entry.sha256;
    if (prior && contentUnchanged && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
      // Fast path: reuse recorded chunk refs without reading the file. The
      // WAL db-entry fields come from the CURRENT source (not `prior`): the
      // file's bytes are the ones `prior` chunked (checked above), and its
      // walGeneration is the caller's live truth.
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
        ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
        ...(entry.walGeneration !== undefined ? { walGeneration: entry.walGeneration } : {}),
        ...(entry.baseTickMs !== undefined ? { baseTickMs: entry.baseTickMs } : {}),
        ...(entry.walTipTickMs !== undefined ? { walTipTickMs: entry.walTipTickMs } : {}),
      });
      continue;
    }

    everyEntryReused = false;
    const chunkIds: string[] = [];
    const uploads: Promise<void>[] = [];
    for await (const plain of partStream(readFileStream(entry.absolutePath))) {
      const id = computeChunkId(dedupKey, plain);
      chunkIds.push(id);
      newChunkIndex.set(id, plain.length);
      if (knownChunkIds.has(id)) continue; // already known to exist (previous manifest or this run)
      knownChunkIds.add(id);
      const release = await uploadSem.acquire();
      const objectKey = `chunks/${id}`;
      // Deterministic nonce from the chunk's own keyed content hash (G7):
      // same plaintext ⇒ same id ⇒ byte-identical object (retries and dedup
      // races converge); different plaintext ⇒ different id ⇒ fresh nonce —
      // the (key, nonce) pair can never repeat with different content. Both id
      // and nonce derive from the RAW plaintext, so entropy-gated compression
      // (below) is invisible to identity: it changes only the sealed byte
      // count, never where the object lands (#405 §1).
      const nonce = deriveNonce(dataKey, `centraid-backup:chunk-nonce:${id}`);
      // /2 (#405 §1): compress-then-seal. The sealed plaintext is the framed
      // payload `[algo-id][possibly-compressed body]`, not the raw part —
      // keep-if-smaller, so incompressible parts cost at most one extra byte.
      const encrypted = encryptWithNonce(dataKey, nonce, frameChunkPayload(plain));
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
      ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
      ...(entry.walGeneration !== undefined ? { walGeneration: entry.walGeneration } : {}),
      ...(entry.baseTickMs !== undefined ? { baseTickMs: entry.baseTickMs } : {}),
      ...(entry.walTipTickMs !== undefined ? { walTipTickMs: entry.walTipTickMs } : {}),
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
  // The bytes can be identical while the ENTRY METADATA is not, and one of
  // those fields is load-bearing: `walTipTickMs` is the floor a verification
  // holds the provider to, and it only advances as markers are confirmed
  // uploaded. A generation's base file never changes, so a chunk-only
  // no-change test would freeze that floor at whatever it was when the
  // generation was first registered — and a provider could then delete every
  // marker written since, undetected. A run whose only change is a fresher tip
  // therefore still registers (a small manifest object, at the backup
  // interval); a genuinely idle vault still registers nothing, because an idle
  // vault ships no markers and its tip does not move.
  const entriesIdentical =
    sameEpochPrevious !== null &&
    sealedEntries.length === sameEpochPrevious.entriesByPath.size &&
    sealedEntries.every((entry) => {
      const prior = sameEpochPrevious.entriesByPath.get(entry.path);
      return prior !== undefined && canonicalJson(prior) === canonicalJson(entry);
    });

  if (chunkIndexIdentical && entriesIdentical) {
    log.info('createSnapshot: no change since previous snapshot — skipping registration');
    return null;
  }

  const chunkIndex = [...newChunkIndex.entries()].map(([id, size]) => ({ id, size }));
  validateSnapshotBasePair(sealedEntries);
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
  // PROTOCOL.md "Snapshot registration": manifestKey MUST fall under the
  // target's `backup` store prefix (`u/{id}/backup/`, matching the
  // credential grant's own `prefix` — see `S3Grant`). The key is used
  // unchanged both as the object store's address (relative to the target's
  // already store-scoped ObjectStore — for the local provider this just
  // nests one harmless extra directory level, for the remote provider it
  // lands under the grant's own `u/{id}/backup/` prefix too, so the object
  // ends up at `u/{id}/backup/u/{id}/backup/manifests/…` in the bucket — a
  // longer key than strictly necessary, but a single unambiguous key with no
  // second "relative vs. wire" representation to keep in sync) and as the
  // registered `manifestKey` field a real provider validates
  // (`isWithinVaultPrefix`-equivalent — a bare `manifests/…` key a
  // conformant provider MUST 400 with `invalid_manifest_key`).
  const manifestKey = `u/${opts.targetId}/backup/manifests/${Date.now()}-${hash8}.json`;
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
  /**
   * Point-in-time restore: pick the newest snapshot created at or
   * before this instant, then replay WAL segments only up to it. Omit for
   * restore-to-tip (newest snapshot + every shipped segment). With `seq`, the
   * named snapshot is used as the base and the WAL cut still applies — but
   * only if that base is itself at or before the instant; see below.
   */
  pointInTimeMs?: number;
  destDir: string;
  current: RestoreCurrentVersions;
  /**
   * Lazy/partial restore predicate (issue #405 §5). Consulted ONCE per `blob`
   * entry, keyed by the blob's content sha (parsed from its
   * `blobs/sha256/<fan>/<sha>` path). Return true to SKIP materializing that
   * blob's bytes to disk — its chunks are never downloaded and no file is
   * created. This is what lets a >30 GB library restore onto a small disk: a
   * blob the remote CAS already holds stays remote-only (the vault's custody
   * read-through fetches it on demand), while a blob NOT in the remote (the
   * snapshot is its ONLY copy) must NOT be skipped or it is lost. The engine is
   * deliberately format-neutral about the decision — it only ever consults this
   * for `kind: 'blob'`, never for `db`/`git-bundle`/`seal-key` entries (those
   * are load-bearing for the restore itself and are always materialized).
   */
  skipBlob?: (blob: { path: string; sha: string }) => boolean | Promise<boolean>;
  log?: EngineLogger;
}

export interface RestoreResult {
  seq: number;
  generation: number;
  entries: string[];
  /** WAL replay outcome for the authenticated coordinated base pair. */
  walReplay: WalReplayOutcome;
  /**
   * Blob shas the `skipBlob` predicate held back (issue #405 §5) — materialized
   * remotely-only, to be served on demand by the vault's custody read-through.
   * Empty on a full restore (no predicate, or nothing skipped).
   */
  skippedBlobs: string[];
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

/**
 * Registry-row-level compatibility gate (issue #439 R1): does a snapshot's
 * `appMeta` (the versions it was written under) fall within what the running
 * gateway can read? Exported so `recover()` can refuse an incompatible
 * snapshot from the registry row ALONE — before a manifest, a chunk, or a
 * single egress byte is fetched (`SnapshotRow.appMeta` carries the same three
 * version fields). `restoreSnapshot` re-runs it on the authenticated envelope
 * too, so the early gate can only prevent a futile (and, on a metered home,
 * billed) download — never authorize a restore the sealed manifest forbids.
 */
export function assertCompatibleAppMeta(
  appMeta: Record<string, string>,
  current: RestoreCurrentVersions,
): void {
  const vaultUserVersion = appMeta['vaultUserVersion'];
  const ontologyVersion = appMeta['ontologyVersion'];
  if (vaultUserVersion !== undefined) {
    if (compareVersion(vaultUserVersion, current.vaultUserVersion) > 0) {
      throw new Error(
        `restoreSnapshot: snapshot vaultUserVersion ${vaultUserVersion} is newer than running ${current.vaultUserVersion} — update the gateway first (no migrations, v0 stance)`,
      );
    }
    if (compareVersion(vaultUserVersion, MIN_SUPPORTED_VAULT_USER_VERSION) < 0) {
      throw new Error(
        `restoreSnapshot: snapshot vaultUserVersion ${vaultUserVersion} is older than the reader guarantee`,
      );
    }
  }
  if (ontologyVersion !== undefined) {
    if (compareVersion(ontologyVersion, current.ontologyVersion) > 0) {
      throw new Error(
        `restoreSnapshot: snapshot ontologyVersion ${ontologyVersion} is newer than running ${current.ontologyVersion} — update the gateway first`,
      );
    }
    if (compareVersion(ontologyVersion, MIN_SUPPORTED_ONTOLOGY_VERSION) < 0) {
      throw new Error(
        `restoreSnapshot: snapshot ontologyVersion ${ontologyVersion} is older than the reader guarantee`,
      );
    }
  }
}

interface OpenedSnapshot {
  row: SnapshotRow;
  opened: ReturnType<typeof openManifest>;
  baseTimeMs: number;
}

async function openSnapshotRow(
  row: SnapshotRow,
  store: ObjectStore,
  keyring: Keyring,
  vaultId: string,
  current?: RestoreCurrentVersions,
): Promise<OpenedSnapshot> {
  if (!READABLE_SNAPSHOT_FORMATS.includes(row.format)) {
    throw new Error(`restoreSnapshot: unknown format "${row.format}" — update the gateway first`);
  }
  // Registry metadata is only an early refusal gate: it can prevent a futile
  // download, never authorize a restore. The authenticated envelope is checked
  // again below and must match this row exactly.
  if (current) assertCompatibleAppMeta(row.appMeta, current);
  const bytes = await store.get(row.manifestKey);
  const opened = openManifest(bytes, keyring, vaultId, row.manifestHash);
  if (!READABLE_SNAPSHOT_FORMATS.includes(opened.public.format)) {
    throw new Error(
      `restoreSnapshot: unknown authenticated format "${opened.public.format}" — update the gateway first`,
    );
  }
  if (current) assertCompatibleAppMeta(opened.public.appMeta, current);
  assertManifestMatchesRegistry(opened.public, opened.entries, row);
  const baseTimeMs = validateSnapshotBasePair(opened.entries).baseTickMs;
  return { row, opened, baseTimeMs };
}

export async function restoreSnapshot(opts: RestoreSnapshotOptions): Promise<RestoreResult> {
  const log = { ...noopLog, ...opts.log };
  const store = await opts.provider.openDataPlane(opts.targetId, 'backup', 'read');
  let selected: OpenedSnapshot | undefined;
  if (opts.seq !== undefined) {
    const row = await opts.provider.getSnapshot(opts.targetId, opts.seq);
    if (row) selected = await openSnapshotRow(row, store, opts.keyring, opts.vaultId, opts.current);
    if (selected && opts.pointInTimeMs !== undefined && selected.baseTimeMs > opts.pointInTimeMs) {
      throw new Error(
        `restoreSnapshot: snapshot seq ${opts.seq} has a base at ` +
          `${new Date(selected.baseTimeMs).toISOString()}, which is NEWER than the requested ` +
          `point in time ${new Date(opts.pointInTimeMs).toISOString()} — its base already ` +
          'contains later writes and cannot be rewound; drop --seq to pick the newest snapshot ' +
          'at or before that instant',
      );
    }
  } else if (opts.pointInTimeMs !== undefined) {
    const rows = await opts.provider.listSnapshots(opts.targetId);
    const candidates: OpenedSnapshot[] = [];
    for (const row of rows) {
      const candidate = await openSnapshotRow(row, store, opts.keyring, opts.vaultId, opts.current);
      if (candidate.baseTimeMs <= opts.pointInTimeMs) candidates.push(candidate);
    }
    selected = candidates.sort((a, b) => b.baseTimeMs - a.baseTimeMs)[0];
    if (!selected) {
      throw new Error(
        `restoreSnapshot: no snapshot exists at or before ${new Date(opts.pointInTimeMs).toISOString()}`,
      );
    }
  } else {
    const row = (await opts.provider.listSnapshots(opts.targetId))[0];
    if (row) selected = await openSnapshotRow(row, store, opts.keyring, opts.vaultId, opts.current);
  }
  if (!selected) throw new Error('restoreSnapshot: no snapshot available');
  const { row, opened } = selected;

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

  const master = masterKeyForEpoch(opts.keyring, opened.public.keyEpoch);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const dedupKey = deriveDedupKey(master, opts.vaultId);

  const skippedBlobs: string[] = [];
  for (const entry of opened.entries) {
    // 2 (continued). Reject path traversal entries — openManifest already
    // validated this, but re-check defensively at the point we touch disk.
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`restoreSnapshot: entry path rejected: "${entry.path}"`);
    }
    // Lazy/partial restore (issue #405 §5): a blob the caller says the remote
    // CAS already holds is left remote-only — never downloaded, never written.
    // The custody read-through serves it on demand later. Only `blob` entries
    // are ever eligible; the sha is the file name of the content-addressed path.
    if (opts.skipBlob && entry.kind === 'blob') {
      const sha = entry.path.split('/').pop() ?? '';
      if (await opts.skipBlob({ path: entry.path, sha })) {
        skippedBlobs.push(sha);
        continue;
      }
    }
    const dest = path.join(opts.destDir, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // Stream parts straight to disk (bases can be GBs — never buffer whole
    // files), hashing as we go so db entries verify against their
    // capture-time sha256 before any WAL replay mutates the file.
    const hash = createHash('sha256');
    const handle = await fs.open(dest, 'w');
    try {
      for (const id of entry.chunks) {
        const ciphertext = await store.get(`chunks/${id}`);
        // Unseal, then unframe: the sealed plaintext is `[algo-id][body]`
        // (/2, #405 §1); the raw part is what the keyed id is recomputed over,
        // so decompression happens BEFORE the integrity check.
        const plain = unframeChunkPayload(decrypt(dataKey, ciphertext));
        const recomputed = computeChunkId(dedupKey, plain);
        if (recomputed !== id) {
          throw new Error(
            `restoreSnapshot: chunk integrity mismatch for "${entry.path}" (chunk ${id})`,
          );
        }
        const buf = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
        hash.update(buf);
        await handle.write(buf);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (entry.sha256 !== undefined) {
      const actual = hash.digest('hex');
      if (actual !== entry.sha256) {
        throw new Error(
          `restoreSnapshot: "${entry.path}" hash mismatch (expected ${entry.sha256}, got ${actual})`,
        );
      }
    }
  }

  // Replay shipped WAL segments on top of the restored base files —
  // SQLite itself performs and validates the replay (wal-restore.ts).
  const pair = validateSnapshotBasePair(opened.entries);
  const walReplay = await replayWalSegments({
    store,
    dataKey,
    vaultId: opts.vaultId,
    destDir: opts.destDir,
    generationByDb: {
      vault: pair.vault.walGeneration!,
      journal: pair.journal.walGeneration!,
    },
    baseTickMsByDb: { vault: pair.baseTickMs, journal: pair.baseTickMs },
    ...(pair.walTipTickMs !== undefined ? { walTipTickMs: pair.walTipTickMs } : {}),
    ...(opts.pointInTimeMs !== undefined ? { pointInTimeMs: opts.pointInTimeMs } : {}),
    log,
  });

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

  return {
    seq: row.seq,
    generation: row.generation,
    entries: opened.entries.map((e) => e.path),
    walReplay,
    skippedBlobs,
  };
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
  /** Shipped WAL segments seen for the snapshot's generations. */
  walSegments: number;
  /** WAL segments sample-unsealed (counted into `corrupt` on failure). */
  walSampled: number;
}

export async function verifySnapshot(opts: VerifySnapshotOptions): Promise<VerifySnapshotResult> {
  const row =
    opts.seq !== undefined
      ? await opts.provider.getSnapshot(opts.targetId, opts.seq)
      : (await opts.provider.listSnapshots(opts.targetId))[0];
  if (!row) throw new Error('verifySnapshot: no snapshot available');

  const store = await opts.provider.openDataPlane(opts.targetId, 'backup', 'read');
  const missing: string[] = [];
  const corrupt: string[] = [];
  let checkedObjects = 0;

  const manifestHead = await store.head(row.manifestKey);
  checkedObjects++;
  if (!manifestHead) {
    missing.push(row.manifestKey);
    return { checkedObjects, missing, corrupt, sampled: 0, walSegments: 0, walSampled: 0 };
  }
  const manifestBytes = await store.get(row.manifestKey);
  const opened = openManifest(manifestBytes, opts.keyring, opts.vaultId, row.manifestHash);
  if (!READABLE_SNAPSHOT_FORMATS.includes(opened.public.format)) {
    throw new Error(
      `verifySnapshot: unknown authenticated format "${opened.public.format}" — update the gateway first`,
    );
  }
  assertManifestMatchesRegistry(opened.public, opened.entries, row);
  const basePair = validateSnapshotBasePair(opened.entries);
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
      // Unseal → unframe → recompute the keyed id over the raw plaintext
      // (/2, #405 §1): a sample that decompresses and re-addresses proves the
      // object is both readable and the content it claims to be.
      const plain = unframeChunkPayload(decrypt(dataKey, ciphertext));
      const recomputed = computeChunkId(dedupKey, plain);
      if (recomputed !== chunk.id) corrupt.push(chunk.id);
    } catch {
      corrupt.push(chunk.id);
    }
  }

  // The snapshot's WAL streams. Existence is NOT just "the LIST
  // returned keys" — a lost mid-stream segment or closer silently truncates
  // every future restore to an earlier point, so verify PLANS the replay
  // over the listing (authenticating closers, exactly like restore) and
  // treats a hole-truncated plan as missing objects. A small sample of
  // segments is additionally unsealed end-to-end.
  //
  // The per-chain hole check is NOT sufficient on its own, and believing it
  // was is what let an entirely-lost stream verify GREEN: a listing with no
  // segments has no hole, and neither does one whose newest objects are gone.
  // The pair marker is the only thing that can tell "idle" from "erased", so
  // verify runs the SAME coordinated planner restore does and reports when the
  // newest point the producer proved it shipped can no longer be reassembled.
  let walSegments = 0;
  let walSampled = 0;
  {
    const generationByDb: Partial<Record<WalDbName, string>> = {};
    const listingByDb: Partial<Record<WalDbName, WalStreamListing>> = {};
    const walTipTickMs = basePair.walTipTickMs ?? -1;
    for (const db of WAL_DB_NAMES) {
      const entry = opened.entries.find((e) => e.kind === 'db' && e.path === WAL_DB_FILES[db]);
      if (entry?.walGeneration === undefined) continue;
      const generation = entry.walGeneration;
      generationByDb[db] = generation;
      const segments: WalSegmentAddress[] = [];
      const closers: WalGroupCloser[] = [];
      for await (const obj of store.list(walSegmentPrefix(db, generation))) {
        const addr = parseWalSegmentKey(obj.key);
        if (addr) {
          segments.push(addr);
          continue;
        }
        const closer = parseWalCloserKey(obj.key);
        if (!closer) continue;
        try {
          openWalCloser(dataKey, opts.vaultId, closer, await store.get(obj.key));
          closers.push(closer);
        } catch {
          corrupt.push(obj.key);
        }
      }
      listingByDb[db] = { segments, closers };
      walSegments += segments.length;
      const plan = planWalReplay({ segments, closers }, { db, generation });
      if (plan.truncatedByHole) {
        missing.push(
          `wal/${db}/${generation}: stream hole — replay reaches tick ${plan.lastTickMs} ` +
            `but ${segments.length - plan.segments.length} listed segment(s) lie beyond it`,
        );
      }
      for (const addr of sampleWithoutReplacement(segments, Math.min(4, segments.length))) {
        walSampled++;
        const key = walSegmentKey(addr);
        try {
          openWalSegment(dataKey, opts.vaultId, addr, await store.get(key));
        } catch {
          corrupt.push(key);
        }
      }
    }

    const { vault: gv, journal: gj } = generationByDb;
    if (gv !== undefined && gj !== undefined) {
      const markers: WalPairMarker[] = [];
      for await (const obj of store.list(walPairMarkerPrefix(gv, gj))) {
        const addr = parseWalPairMarkerKey(obj.key);
        if (!addr) continue;
        try {
          markers.push(openWalPairMarker(dataKey, opts.vaultId, addr, await store.get(obj.key)));
        } catch {
          corrupt.push(obj.key);
        }
      }
      const coordinated = planCoordinatedReplay({ listingByDb, generationByDb, markers });
      if (
        coordinated.newestMarkerTickMs >= 0 &&
        coordinated.coordinatedCutMs < coordinated.newestMarkerTickMs
      ) {
        missing.push(
          `wal/tick/${gv}-${gj}: the newest coordinated point the producer shipped ` +
            `(tick ${coordinated.newestMarkerTickMs}) cannot be reassembled — the pair can only ` +
            `be restored at tick ${coordinated.coordinatedCutMs}; segments are missing`,
        );
      }
      // …and the markers THEMSELVES can be deleted, which the check above
      // cannot see: with no markers there is no "newest marker", the plan
      // quietly falls back to the base pair, and every object the manifest
      // names is still present. Nothing is missing; the restore is just
      // silently hours stale. `walTipTickMs` is the floor that closes it — the
      // newest marker tick the producer WATCHED this store accept. Falling
      // short of it means the store lost something it acknowledged.
      if (walTipTickMs >= 0 && coordinated.coordinatedCutMs < walTipTickMs) {
        missing.push(
          `wal/tick/${gv}-${gj}: pair marker(s) this snapshot registered are GONE — the producer ` +
            `confirmed the pair reached tick ${walTipTickMs}, but the store can only be replayed ` +
            `to tick ${coordinated.coordinatedCutMs}. A restore would silently return an earlier ` +
            'state.',
        );
      }
    }
  }

  return { checkedObjects, missing, corrupt, sampled: sample.length, walSegments, walSampled };
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
