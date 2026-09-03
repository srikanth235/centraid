// governance: allow-repo-hygiene file-size-limit (#363) the provider-agnostic snapshot/restore/verify/recovery engine (PROTOCOL.md's data-semantics owner); splitting the pipeline stages would scatter one cohesive contract across files that all change together on a protocol revision
/*
 * Snapshot / restore / verify / recovery. This is the data-semantics the client
 * owns (PROTOCOL.md); it reaches storage only through the `BackupProvider` +
 * `ObjectStore` seams, so it runs unchanged on local and remote providers.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { frameChunkPayloadAsync, unframeChunkPayload } from "./compress.js";
import {
  activeMasterKey,
  chunkId as computeChunkId,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  deriveNonce,
  encryptWithNonce,
  masterKeyForEpoch,
} from "./crypto.js";
import type { Keyring } from "./crypto.js";
import type { EngineLogger } from "./engine-log.js";
import {
  assertManifestMatchesRegistry,
  canonicalJson,
  isSafeEntryPath,
  openManifest,
  READABLE_SNAPSHOT_FORMATS,
  sealManifest,
  SNAPSHOT_FORMAT_V2,
  validateSnapshotBase,
} from "./manifest.js";
import type { ManifestEntry, ManifestEntryKind } from "./manifest.js";
import type { ObjectStore } from "./object-store.js";
import {
  applyAvailableInOrder,
  applyInOrder,
  mapWithConcurrency,
} from "./ordered-work.js";
import { partStream } from "./parts.js";
import type { BackupProvider, SnapshotRow } from "./provider.js";
import {
  openWalCloser,
  openWalSegment,
  openWalTickMarker,
  parseWalCloserKey,
  parseWalSegmentKey,
  parseWalTickMarkerKey,
  planMarkedReplay,
  planWalReplay,
  walSegmentKey,
  walSegmentPrefix,
  walTickMarkerPrefix,
} from "./wal-format.js";
import type {
  WalGroupCloser,
  WalSegmentAddress,
  WalStreamListing,
  WalTickMarker,
} from "./wal-format.js";
import { replayWalSegments } from "./wal-restore.js";
import type { WalReplayOutcome } from "./wal-restore.js";

export interface SourceEntry {
  /** Manifest path: relative, forward-slash, no traversal. */
  path: string;
  kind: ManifestEntryKind;
  /** Local read source, unlike `path`. */
  absolutePath: string;
  /** `db` only: plaintext SHA-256 of the base file (G9). */
  sha256?: string;
  /** `db` only: the WAL stream generation this base anchors. */
  walGeneration?: string;
  /** `db` only: clone tick. MUST match the sibling's. */
  baseTickMs?: number;
  /** `db` only: newest marker tick CONFIRMED uploaded — a floor the store owes. */
  walTipTickMs?: number;
}

export type { EngineLogger } from "./engine-log.js";

const noopLog: Required<EngineLogger> = {
  info: () => undefined,
  warn: () => undefined,
};

// ─── Bounded concurrency ─────
// Uploads run 4 in flight; entries stay one-at-a-time so memory is bounded.

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
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.available--;
    return () => this.release();
  }

  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) return next();
  }
}

// ─── createSnapshot ─────

export interface CreateSnapshotOptions {
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  entries: SourceEntry[];
  generation: number;
  appMeta: Record<string, string>;
  /** Register even when entries match — for a fencing generation bump. */
  forceRegistration?: boolean;
  log?: EngineLogger;
}

interface PreviousManifestInfo {
  row: SnapshotRow;
  keyEpoch: number;
  entriesByPath: Map<string, ManifestEntry>;
  /** id -> plaintext size, from the previous public chunkIndex. */
  chunkSizes: Map<string, number>;
}

async function loadPreviousManifest(
  provider: BackupProvider,
  targetId: string,
  keyring: Keyring,
  vaultId: string
): Promise<PreviousManifestInfo | null> {
  const rows = await provider.listSnapshots(targetId);
  const newest = rows[0];
  if (!newest) return null;
  const store = await provider.openDataPlane(targetId, "backup", "read");
  const { opened } = await openSnapshotRow(newest, store, keyring, vaultId);
  const entriesByPath = new Map(
    opened.entries.map((e) => [e.path, e] as const)
  );
  const chunkSizes = new Map(
    opened.public.chunkIndex.map((c) => [c.id, c.size] as const)
  );
  return {
    row: newest,
    keyEpoch: opened.public.keyEpoch,
    entriesByPath,
    chunkSizes,
  };
}

async function statEntry(
  absolutePath: string
): Promise<{ size: number; mtimeMs: number }> {
  const st = await fs.stat(absolutePath);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

async function* readNextFileChunk(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Buffer,
  bufferSize: number
): AsyncGenerator<Uint8Array> {
  const { bytesRead } = await handle.read(buffer, 0, bufferSize, null);
  if (bytesRead === 0) return;
  yield new Uint8Array(buffer.subarray(0, bytesRead));
  yield* readNextFileChunk(handle, buffer, bufferSize);
}

async function* readFileStream(
  absolutePath: string
): AsyncGenerator<Uint8Array> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const bufSize = 256 * 1024;
    const buf = Buffer.alloc(bufSize);
    yield* readNextFileChunk(handle, buf, bufSize);
  } finally {
    await handle.close();
  }
}

/** Returns `null` when nothing changed: a no-change run registers nothing. */
export async function createSnapshot(
  opts: CreateSnapshotOptions
): Promise<SnapshotRow | null> {
  const log = { ...noopLog, ...opts.log };
  const { epoch: keyEpoch, key: master } = activeMasterKey(opts.keyring);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const dedupKey = deriveDedupKey(master, opts.vaultId);

  const previous = await loadPreviousManifest(
    opts.provider,
    opts.targetId,
    opts.keyring,
    opts.vaultId
  );
  const sameEpochPrevious =
    previous && previous.keyEpoch === keyEpoch ? previous : null;
  if (previous && !sameEpochPrevious) {
    log.info(
      `createSnapshot: previous manifest is epoch ${previous.keyEpoch}, active is ${keyEpoch} — full re-upload`
    );
  }

  const store = await opts.provider.openDataPlane(
    opts.targetId,
    "backup",
    "read-write"
  );
  const uploadSem = new Semaphore(4);
  const knownChunkIds = new Set<string>(sameEpochPrevious?.chunkSizes.keys());
  const newChunkIndex = new Map<string, number>(); // id -> size, this snapshot's full set
  const sealedEntries: ManifestEntry[] = [];
  let totalBytes = 0;
  let everyEntryReused = true;

  await applyInOrder(opts.entries, async (entry) => {
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`createSnapshot: unsafe entry path "${entry.path}"`);
    }
    const stat = await statEntry(entry.absolutePath);
    totalBytes += stat.size;
    const prior = sameEpochPrevious?.entriesByPath.get(entry.path);

    // `(size, mtimeMs)` is a HEURISTIC, not an identity: two clones of one
    // database share a size, and on a coarse-mtime filesystem an mtime too, so
    // the fast path would reuse the PREVIOUS generation's chunk refs under the
    // CURRENT generation's `sha256` — a snapshot that can never be restored.
    // Where the caller vouches for content, that hash IS the identity test.
    const contentUnchanged =
      entry.sha256 === undefined || prior?.sha256 === entry.sha256;
    if (
      prior &&
      contentUnchanged &&
      prior.size === stat.size &&
      prior.mtimeMs === stat.mtimeMs
    ) {
      // WAL db fields come from the CURRENT source, not `prior`: the bytes are
      // the ones `prior` chunked, but walGeneration is the caller's live truth.
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
        ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
        ...(entry.walGeneration === undefined
          ? {}
          : { walGeneration: entry.walGeneration }),
        ...(entry.baseTickMs === undefined
          ? {}
          : { baseTickMs: entry.baseTickMs }),
        ...(entry.walTipTickMs === undefined
          ? {}
          : { walTipTickMs: entry.walTipTickMs }),
      });
      return;
    }

    everyEntryReused = false;
    const chunkIds: string[] = [];
    const uploads: Promise<void>[] = [];
    await applyAvailableInOrder(
      partStream(readFileStream(entry.absolutePath)),
      async (plain) => {
        const id = computeChunkId(dedupKey, plain);
        chunkIds.push(id);
        newChunkIndex.set(id, plain.length);
        if (knownChunkIds.has(id)) return; // already known to exist (previous manifest or this run)
        knownChunkIds.add(id);
        const release = await uploadSem.acquire();
        const objectKey = `chunks/${id}`;
        // Nonce derives from the chunk's keyed content hash (G7), so (key,
        // nonce) never repeats with different content. Both id and nonce come
        // from the RAW plaintext — compression stays invisible to identity.
        const nonce = deriveNonce(dataKey, `centraid-backup:chunk-nonce:${id}`);
        // Compress-then-seal (#405): the sealed plaintext is the framed
        // payload `[algo-id][body]`, keep-if-smaller.
        const encrypted = encryptWithNonce(
          dataKey,
          nonce,
          await frameChunkPayloadAsync(plain)
        );
        uploads.push(
          store
            .head(objectKey)
            .then((head) =>
              head ? undefined : store.put(objectKey, encrypted)
            )
            .finally(release)
        );
      }
    );
    await Promise.all(uploads);
    sealedEntries.push({
      path: entry.path,
      kind: entry.kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      chunks: chunkIds,
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
      ...(entry.walGeneration === undefined
        ? {}
        : { walGeneration: entry.walGeneration }),
      ...(entry.baseTickMs === undefined
        ? {}
        : { baseTickMs: entry.baseTickMs }),
      ...(entry.walTipTickMs === undefined
        ? {}
        : { walTipTickMs: entry.walTipTickMs }),
    });
  });

  const previousChunkIdSet = sameEpochPrevious
    ? new Set(sameEpochPrevious.chunkSizes.keys())
    : null;
  const chunkIndexIdentical =
    everyEntryReused &&
    previousChunkIdSet !== null &&
    previousChunkIdSet.size === newChunkIndex.size &&
    [...newChunkIndex.keys()].every((id) => previousChunkIdSet.has(id));
  // The no-change test must cover ENTRY METADATA, not just chunks:
  // `walTipTickMs` is the floor verification holds the provider to, and a
  // chunk-only test freezes it at the generation's first registration, letting
  // a provider delete every marker since, undetected. An idle vault still
  // registers nothing — it ships no markers, so its tip does not move.
  const entriesIdentical =
    sameEpochPrevious !== null &&
    sealedEntries.length === sameEpochPrevious.entriesByPath.size &&
    sealedEntries.every((entry) => {
      const prior = sameEpochPrevious.entriesByPath.get(entry.path);
      return (
        prior !== undefined && canonicalJson(prior) === canonicalJson(entry)
      );
    });

  if (!opts.forceRegistration && chunkIndexIdentical && entriesIdentical) {
    log.info(
      "createSnapshot: no change since previous snapshot — skipping registration"
    );
    return null;
  }

  const chunkIndex = [...newChunkIndex.entries()].map(([id, size]) => ({
    id,
    size,
  }));
  validateSnapshotBase(sealedEntries);
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
  // PROTOCOL.md: manifestKey MUST carry the target's `u/{id}/backup/` prefix —
  // a bare `manifests/…` key a conformant provider MUST 400. The same string
  // doubles as the (already store-scoped) ObjectStore address, so the prefix
  // repeats in the bucket rather than needing a second wire form.
  const manifestKey = `u/${opts.targetId}/backup/manifests/${Date.now()}-${hash8}.json`;
  await store.put(manifestKey, bytes);

  const row = await opts.provider.registerSnapshot(opts.targetId, {
    idempotencyKey: manifestHash,
    manifestKey,
    manifestHash,
    totalBytes,
    objectCount: chunkIndex.length,
    generation: opts.generation,
    format: SNAPSHOT_FORMAT_V2,
    appMeta: opts.appMeta,
  });
  log.info(
    `createSnapshot: registered seq ${row.seq} (${chunkIndex.length} chunks, ${totalBytes} bytes)`
  );
  return row;
}

// ─── restoreSnapshot ─────

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
   * Newest snapshot at or before this instant, WAL replayed only up to it. Omit
   * for restore-to-tip. With `seq` the cut still applies, but only if that base
   * is itself at or before the instant.
   */
  pointInTimeMs?: number;
  destDir: string;
  current: RestoreCurrentVersions;
  /**
   * Lazy/partial restore (#405): true SKIPS materializing that blob. Consulted
   * for `kind: 'blob'` only — db/git-bundle/seal-key entries are load-bearing
   * and always materialized. A blob the remote CAS does not hold must not be
   * skipped; the snapshot is its only copy.
   */
  skipBlob?: (blob: {
    path: string;
    sha: string;
  }) => boolean | Promise<boolean>;
  log?: EngineLogger;
}

export interface RestoreResult {
  seq: number;
  generation: number;
  entries: string[];
  walReplay: WalReplayOutcome;
  /** Blob shas `skipBlob` held back (#405); the custody read-through serves them. */
  skippedBlobs: string[];
}

/** `x.y` numeric compare: -1/0/1. Non-numeric parts compare as 0. */
function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((p) => Math.trunc(Number(p)) || 0);
  const pb = b.split(".").map((p) => Math.trunc(Number(p)) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const MIN_SUPPORTED_VAULT_USER_VERSION = "1";
const MIN_SUPPORTED_ONTOLOGY_VERSION = "1.0";

/**
 * Registry-row compatibility gate (#439), exported so `recover()` can refuse
 * from the row ALONE before any egress byte. `restoreSnapshot` re-runs it on
 * the authenticated envelope: this gate may only prevent a futile download,
 * never authorize a restore the sealed manifest forbids.
 */
export function assertCompatibleAppMeta(
  appMeta: Record<string, string>,
  current: RestoreCurrentVersions
): void {
  const vaultUserVersion = appMeta["vaultUserVersion"];
  const ontologyVersion = appMeta["ontologyVersion"];
  if (vaultUserVersion !== undefined) {
    if (compareVersion(vaultUserVersion, current.vaultUserVersion) > 0) {
      throw new Error(
        `restoreSnapshot: snapshot vaultUserVersion ${vaultUserVersion} is newer than running ${current.vaultUserVersion} — update the gateway first (no migrations, v0 stance)`
      );
    }
    if (
      compareVersion(vaultUserVersion, MIN_SUPPORTED_VAULT_USER_VERSION) < 0
    ) {
      throw new Error(
        `restoreSnapshot: snapshot vaultUserVersion ${vaultUserVersion} is older than the reader guarantee`
      );
    }
  }
  if (ontologyVersion !== undefined) {
    if (compareVersion(ontologyVersion, current.ontologyVersion) > 0) {
      throw new Error(
        `restoreSnapshot: snapshot ontologyVersion ${ontologyVersion} is newer than running ${current.ontologyVersion} — update the gateway first`
      );
    }
    if (compareVersion(ontologyVersion, MIN_SUPPORTED_ONTOLOGY_VERSION) < 0) {
      throw new Error(
        `restoreSnapshot: snapshot ontologyVersion ${ontologyVersion} is older than the reader guarantee`
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
  current?: RestoreCurrentVersions
): Promise<OpenedSnapshot> {
  if (!READABLE_SNAPSHOT_FORMATS.includes(row.format)) {
    throw new Error(
      `restoreSnapshot: unknown format "${row.format}" — update the gateway first`
    );
  }
  // Registry metadata may only refuse; the envelope below authorizes, and must
  // match this row exactly.
  if (current) assertCompatibleAppMeta(row.appMeta, current);
  const bytes = await store.get(row.manifestKey);
  const opened = openManifest(bytes, keyring, vaultId, row.manifestHash);
  if (!READABLE_SNAPSHOT_FORMATS.includes(opened.public.format)) {
    throw new Error(
      `restoreSnapshot: unknown authenticated format "${opened.public.format}" — update the gateway first`
    );
  }
  if (current) assertCompatibleAppMeta(opened.public.appMeta, current);
  assertManifestMatchesRegistry(opened.public, opened.entries, row);
  const baseTimeMs = validateSnapshotBase(opened.entries).baseTickMs;
  return { row, opened, baseTimeMs };
}

export async function restoreSnapshot(
  opts: RestoreSnapshotOptions
): Promise<RestoreResult> {
  const log = { ...noopLog, ...opts.log };
  const store = await opts.provider.openDataPlane(
    opts.targetId,
    "backup",
    "read"
  );
  let selected: OpenedSnapshot | undefined;
  if (opts.seq !== undefined) {
    const row = await opts.provider.getSnapshot(opts.targetId, opts.seq);
    if (row)
      selected = await openSnapshotRow(
        row,
        store,
        opts.keyring,
        opts.vaultId,
        opts.current
      );
    if (
      selected &&
      opts.pointInTimeMs !== undefined &&
      selected.baseTimeMs > opts.pointInTimeMs
    ) {
      throw new Error(
        `restoreSnapshot: snapshot seq ${opts.seq} has a base at ` +
          `${new Date(selected.baseTimeMs).toISOString()}, which is NEWER than the requested ` +
          `point in time ${new Date(opts.pointInTimeMs).toISOString()} — its base already ` +
          "contains later writes and cannot be rewound; drop --seq to pick the newest snapshot " +
          "at or before that instant"
      );
    }
  } else if (opts.pointInTimeMs === undefined) {
    const row = (await opts.provider.listSnapshots(opts.targetId))[0];
    if (row)
      selected = await openSnapshotRow(
        row,
        store,
        opts.keyring,
        opts.vaultId,
        opts.current
      );
  } else {
    const rows = await opts.provider.listSnapshots(opts.targetId);
    const pointInTimeMs = opts.pointInTimeMs;
    if (pointInTimeMs === undefined) {
      throw new Error(
        "restoreSnapshot: point-in-time selection requires a point in time"
      );
    }
    const candidates = (
      await mapWithConcurrency(rows, 4, (row) =>
        openSnapshotRow(row, store, opts.keyring, opts.vaultId, opts.current)
      )
    ).filter((candidate) => candidate.baseTimeMs <= pointInTimeMs);
    selected = candidates.sort((a, b) => b.baseTimeMs - a.baseTimeMs)[0];
    if (!selected) {
      throw new Error(
        `restoreSnapshot: no snapshot exists at or before ${new Date(opts.pointInTimeMs).toISOString()}`
      );
    }
  }
  if (!selected) throw new Error("restoreSnapshot: no snapshot available");
  const { row, opened } = selected;

  let destEntries: string[];
  try {
    destEntries = await fs.readdir(opts.destDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.mkdir(opts.destDir, { recursive: true });
      destEntries = [];
    } else {
      throw error;
    }
  }
  if (destEntries.length > 0) {
    throw new Error(
      `restoreSnapshot: destDir "${opts.destDir}" is not empty — refusing to restore over it`
    );
  }

  const master = masterKeyForEpoch(opts.keyring, opened.public.keyEpoch);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const dedupKey = deriveDedupKey(master, opts.vaultId);

  const skippedBlobs: string[] = [];
  await applyInOrder(opened.entries, async (entry) => {
    // openManifest validated this; re-check at the point we touch disk.
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`restoreSnapshot: entry path rejected: "${entry.path}"`);
    }
    // Only `blob` entries are eligible (#405).
    if (opts.skipBlob && entry.kind === "blob") {
      const sha = entry.path.split("/").pop() ?? "";
      if (await opts.skipBlob({ path: entry.path, sha })) {
        skippedBlobs.push(sha);
        return;
      }
    }
    const dest = path.join(opts.destDir, ...entry.path.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // Never buffer whole files — bases can be GBs. Hash while streaming so db
    // entries verify against capture-time sha256 before WAL replay.
    const hash = createHash("sha256");
    const handle = await fs.open(dest, "w");
    try {
      await applyInOrder(entry.chunks, async (id) => {
        const ciphertext = await store.get(`chunks/${id}`);
        // Decompression must precede the integrity check: the keyed id is
        // recomputed over the RAW part, not the framed payload (#405).
        const plain = unframeChunkPayload(decrypt(dataKey, ciphertext));
        const recomputed = computeChunkId(dedupKey, plain);
        if (recomputed !== id) {
          throw new Error(
            `restoreSnapshot: chunk integrity mismatch for "${entry.path}" (chunk ${id})`
          );
        }
        const buf = Buffer.from(
          plain.buffer,
          plain.byteOffset,
          plain.byteLength
        );
        hash.update(buf);
        await handle.write(buf);
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (entry.sha256 !== undefined) {
      const actual = hash.digest("hex");
      if (actual !== entry.sha256) {
        throw new Error(
          `restoreSnapshot: "${entry.path}" hash mismatch (expected ${entry.sha256}, got ${actual})`
        );
      }
    }
  });

  // SQLite itself performs and validates the replay (wal-restore.ts).
  const base = validateSnapshotBase(opened.entries);
  const walReplay = await replayWalSegments({
    store,
    dataKey,
    vaultId: opts.vaultId,
    destDir: opts.destDir,
    generation: base.entry.walGeneration!,
    ...(base.walTipTickMs === undefined
      ? {}
      : { walTipTickMs: base.walTipTickMs }),
    ...(opts.pointInTimeMs === undefined
      ? {}
      : { pointInTimeMs: opts.pointInTimeMs }),
    log,
  });

  // The gateway acts on this marker at mount.
  const marker = {
    restoredAt: new Date().toISOString(),
    sourceSeq: row.seq,
    quarantine: ["outbox", "automations", "connections"],
  };
  await fs.writeFile(
    path.join(opts.destDir, "RESTORE_QUARANTINE.json"),
    `${JSON.stringify(marker, null, 2)}\n`
  );

  return {
    seq: row.seq,
    generation: row.generation,
    entries: opened.entries.map((e) => e.path),
    walReplay,
    skippedBlobs,
  };
}

// ─── verifySnapshot ─────

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
  walSegments: number;
  /** Segments sample-unsealed; failures land in `corrupt`. */
  walSampled: number;
}

export async function verifySnapshot(
  opts: VerifySnapshotOptions
): Promise<VerifySnapshotResult> {
  const row =
    opts.seq === undefined
      ? (await opts.provider.listSnapshots(opts.targetId))[0]
      : await opts.provider.getSnapshot(opts.targetId, opts.seq);
  if (!row) throw new Error("verifySnapshot: no snapshot available");

  const store = await opts.provider.openDataPlane(
    opts.targetId,
    "backup",
    "read"
  );
  const missing: string[] = [];
  const corrupt: string[] = [];
  let checkedObjects = 0;

  const manifestHead = await store.head(row.manifestKey);
  checkedObjects++;
  if (!manifestHead) {
    missing.push(row.manifestKey);
    return {
      checkedObjects,
      missing,
      corrupt,
      sampled: 0,
      walSegments: 0,
      walSampled: 0,
    };
  }
  const manifestBytes = await store.get(row.manifestKey);
  const opened = openManifest(
    manifestBytes,
    opts.keyring,
    opts.vaultId,
    row.manifestHash
  );
  if (!READABLE_SNAPSHOT_FORMATS.includes(opened.public.format)) {
    throw new Error(
      `verifySnapshot: unknown authenticated format "${opened.public.format}" — update the gateway first`
    );
  }
  assertManifestMatchesRegistry(opened.public, opened.entries, row);
  const base = validateSnapshotBase(opened.entries);
  const master = masterKeyForEpoch(opts.keyring, opened.public.keyEpoch);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const dedupKey = deriveDedupKey(master, opts.vaultId);

  const chunkHeads = await mapWithConcurrency(
    opened.public.chunkIndex,
    4,
    async (chunk) => ({
      id: chunk.id,
      present: (await store.head(`chunks/${chunk.id}`)) !== null,
    })
  );
  checkedObjects += chunkHeads.length;
  missing.push(
    ...chunkHeads.filter(({ present }) => !present).map(({ id }) => id)
  );

  const sampleCount = Math.min(
    opts.sampleCount ?? 8,
    opened.public.chunkIndex.length
  );
  const sample = sampleWithoutReplacement(
    opened.public.chunkIndex,
    sampleCount
  );
  const corruptSamples = await mapWithConcurrency(sample, 4, async (chunk) => {
    try {
      const ciphertext = await store.get(`chunks/${chunk.id}`);
      // Re-addressing over the raw plaintext proves the object is the content
      // it claims to be, not merely readable (#405).
      const plain = unframeChunkPayload(decrypt(dataKey, ciphertext));
      return computeChunkId(dedupKey, plain) === chunk.id
        ? undefined
        : chunk.id;
    } catch {
      return chunk.id;
    }
  });
  corrupt.push(
    ...corruptSamples.filter((id): id is string => id !== undefined)
  );

  // Existence is NOT "the LIST returned keys": a lost mid-stream segment
  // silently truncates every future restore, so verify PLANS the replay over
  // the listing and counts a hole-truncated plan as missing objects.
  //
  // The per-chain hole check alone lets an entirely-lost stream verify GREEN: a
  // listing with no segments has no hole, nor does one whose newest objects are
  // gone. Only the tick marker separates "idle" from "erased", so verify must
  // run the SAME marked planner restore does.
  let walSegments = 0;
  let walSampled = 0;
  {
    const walTipTickMs = base.walTipTickMs ?? -1;
    const generation = base.entry.walGeneration;
    if (generation !== undefined) {
      const segments: WalSegmentAddress[] = [];
      const closers: WalGroupCloser[] = [];
      await applyAvailableInOrder(
        store.list(walSegmentPrefix("vault", generation)),
        async (obj) => {
          const addr = parseWalSegmentKey(obj.key);
          if (addr) {
            segments.push(addr);
            return;
          }
          const closer = parseWalCloserKey(obj.key);
          if (!closer) return;
          try {
            openWalCloser(
              dataKey,
              opts.vaultId,
              closer,
              await store.get(obj.key)
            );
            closers.push(closer);
          } catch {
            corrupt.push(obj.key);
          }
        }
      );
      const listing: WalStreamListing = { segments, closers };
      walSegments += segments.length;
      const plan = planWalReplay(listing, { generation });
      if (plan.truncatedByHole) {
        missing.push(
          `wal/vault/${generation}: stream hole — replay reaches tick ${plan.lastTickMs} ` +
            `but ${segments.length - plan.segments.length} listed segment(s) lie beyond it`
        );
      }
      const sampleAddresses = sampleWithoutReplacement(
        segments,
        Math.min(4, segments.length)
      );
      walSampled += sampleAddresses.length;
      const corruptAddresses = await mapWithConcurrency(
        sampleAddresses,
        4,
        async (addr) => {
          const key = walSegmentKey(addr);
          try {
            openWalSegment(dataKey, opts.vaultId, addr, await store.get(key));
            return undefined;
          } catch {
            return key;
          }
        }
      );
      corrupt.push(
        ...corruptAddresses.filter((key): key is string => key !== undefined)
      );

      const markers: WalTickMarker[] = [];
      await applyAvailableInOrder(
        store.list(walTickMarkerPrefix(generation)),
        async (obj) => {
          const addr = parseWalTickMarkerKey(obj.key);
          if (!addr) return;
          try {
            markers.push(
              openWalTickMarker(
                dataKey,
                opts.vaultId,
                addr,
                await store.get(obj.key)
              )
            );
          } catch {
            corrupt.push(obj.key);
          }
        }
      );
      const marked = planMarkedReplay({ listing, generation, markers });
      if (
        marked.newestMarkerTickMs >= 0 &&
        marked.cutTickMs < marked.newestMarkerTickMs
      ) {
        missing.push(
          `wal/tick/${generation}: the newest point the producer shipped ` +
            `(tick ${marked.newestMarkerTickMs}) cannot be reassembled — the stream can only ` +
            `be restored at tick ${marked.cutTickMs}; segments are missing`
        );
      }
      // Deleting the markers themselves is invisible above: the plan falls
      // back to the base, every named object is present, and the restore is
      // silently hours stale. `walTipTickMs` — the newest tick the producer
      // watched this store accept — closes that hole.
      if (walTipTickMs >= 0 && marked.cutTickMs < walTipTickMs) {
        missing.push(
          `wal/tick/${generation}: tick marker(s) this snapshot registered are GONE — the producer ` +
            `confirmed the stream reached tick ${walTipTickMs}, but the store can only be replayed ` +
            `to tick ${marked.cutTickMs}. A restore would silently return an earlier state.`
        );
      }
    }
  }

  return {
    checkedObjects,
    missing,
    corrupt,
    sampled: sample.length,
    walSegments,
    walSampled,
  };
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

// ─── Recovery-kit target rows ─────
// Kit authorship goes through `wrapRecoveryKit` only — never add a plaintext
// kit emitter beside a reader that refuses unwrapped kits (#568).

export interface RecoveryKitTarget {
  provider: string;
  targetId: string;
  vaultId: string;
  label: string;
  /** Per-vault DEK, base64. Wrapped owner-held kits only. */
  sealKey?: string;
  /** Ed25519 identity seed, base64 (#726). Wrapped owner-held kits only. */
  identitySeed?: string;
}
