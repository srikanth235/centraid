/*
 * Manifest build/seal/open (FORMAT.md § Manifest). The manifest is the one
 * object every restore starts from: a PUBLIC envelope (format, keyEpoch,
 * chunkIndex, appMeta — readable and verifiable without any key) wrapping a
 * SEALED payload (the entry list — paths and per-entry chunk lists, which
 * do carry semantic content).
 *
 * `manifestHash` is SHA-256 over the *exact stored bytes* of the canonical
 * JSON serialization, so any two engines (or engine versions) that build
 * the same logical manifest object must produce byte-identical output —
 * hence `canonicalJson`.
 */

import { createHash } from 'node:crypto';
import {
  decrypt,
  deriveNonce,
  encryptWithNonce,
  type Keyring,
  masterKeyForEpoch,
  deriveDataKey,
} from './crypto.js';

export type ManifestEntryKind = 'db' | 'blob' | 'git-bundle' | 'seal-key';

export interface ManifestEntry {
  path: string;
  kind: ManifestEntryKind;
  size: number;
  /**
   * Source mtime (ms since epoch) at snapshot time. FORMAT.md's example
   * sealed-payload entry doesn't show this field, but it lives entirely
   * inside the encrypted sealed payload — providers never parse it, and
   * it is an optional field within the still-unreleased `/1` format. The
   * engine needs it for the incremental fast path (§ engine.ts createSnapshot):
   * same path + size + mtime as the previous snapshot means the file is
   * provably unchanged, so its chunk refs can be reused without a re-read.
   */
  mtimeMs: number;
  chunks: string[];
  /**
   * /1, `kind: 'db'` only: SHA-256 hex of the base file's plaintext — the
   * capture-time marker the G9 restore-verification job re-derives after a
   * real restore-to-base.
   */
  sha256?: string;
  /**
   * /1, `kind: 'db'` only: the WAL stream generation this base anchors
   * (FORMAT.md § WAL segments). Restore lists `wal/{db}/{walGeneration}/`
   * and replays on top of the base; PITR cuts that list at a tick.
   */
  walGeneration?: string;
  /**
   * /1, `kind: 'db'` only: the tick at which the shipper TRUNCATE-checkpointed
   * and cloned this base.
   *
   * The two `db` entries' values MUST be EQUAL — the databases break their
   * generations together, in one tick — and a manifest whose bases are from
   * two different instants MUST NOT be registered and MUST NOT be restored.
   * A journal base minted after the vault's already contains receipts for rows
   * that live only in the vault's segments; lose one of those and the restore
   * hands back history asserting data it does not have. This field is what
   * makes that pair refusable instead of silently restorable.
   */
  baseTickMs?: number;
  /**
   * /1, `kind: 'db'` only: the newest pair-marker tick the producer WATCHED the
   * provider accept, at the moment this manifest was registered.
   *
   * It is a floor on what the store owes us. A restore or verification that
   * cannot reach it is looking at a store that has LOST objects it once
   * acknowledged — the only way to catch a provider that deletes the marker
   * stream, which is otherwise perfectly silent (no hole, no damage, nothing
   * missing; the restore just quietly falls back to the base pair).
   *
   * Sourced from CONFIRMED uploads, never from local intent: a drain
   * interrupted between a tick's segments and its marker simply yields a lower
   * tip. The manifest can therefore never claim a marker the store does not
   * have, which is what makes the check safe to fail loudly on.
   */
  walTipTickMs?: number;
}

/** The sealed payload's decrypted shape (FORMAT.md's `sealedPayload` plaintext). */
export interface SealedPayload {
  entries: ManifestEntry[];
}

/** The manifest's public envelope, exactly as stored (minus `sealedPayload`'s plaintext). */
export interface ManifestPublic {
  format: string;
  keyEpoch: number;
  createdAt: string;
  generation: number;
  prevManifestHash: string | null;
  chunkIndex: { id: string; size: number }[];
  appMeta: Record<string, string>;
}

/** The full stored object: public envelope + the base64 sealed payload. */
export interface StoredManifest extends ManifestPublic {
  sealedPayload: string;
}

function manifestPublicBytes(publicEnvelope: ManifestPublic): Uint8Array {
  return new TextEncoder().encode(canonicalJson(publicEnvelope));
}

/** The base-plus-WAL format (issue #408). Its chunk objects seal RAW part bytes. */
export const SNAPSHOT_FORMAT_V1 = 'centraid-snapshot/1';
/**
 * `/2` (issue #405 §1) adds entropy-gated compression INSIDE the chunk seal:
 * the sealed plaintext is a framed payload `[algo-id][body]` rather than the
 * bare part. That is a payload-framing change, so the string bumps and `/1`
 * becomes unreadable — a `/1` reader would treat the algo byte as content, and
 * a `/2` reader would treat a `/1` object's first byte as an algo id. v0 is
 * pre-release with no shipped predecessor, so there is no dual-format reader:
 * the bump plus FORMAT.md IS the whole migration story.
 */
export const SNAPSHOT_FORMAT_V2 = 'centraid-snapshot/2';
/** The format new snapshots are written as. */
export const SNAPSHOT_FORMAT = SNAPSHOT_FORMAT_V2;
/** v0 has one readable format at a time: a reader MUST reject every other string. */
export const READABLE_SNAPSHOT_FORMATS: readonly string[] = [SNAPSHOT_FORMAT];

export interface SnapshotRegistryIdentity {
  format: string;
  generation: number;
  prevManifestHash: string | null;
  appMeta: Record<string, string>;
  totalBytes: number;
  objectCount: number;
}

export interface SnapshotBasePair {
  vault: ManifestEntry;
  journal: ManifestEntry;
  baseTickMs: number;
  walTipTickMs?: number;
}

/**
 * Canonical JSON: object keys sorted (recursively), no insignificant
 * whitespace, array order preserved (arrays are semantically ordered).
 * `undefined` values are dropped (matches `JSON.stringify`'s own behavior
 * for object properties) so a manifest built by two code paths that only
 * differ in whether they set an optional field explicitly-undefined still
 * serializes identically.
 */
export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stringifyCanonical(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stringifyCanonical(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`);
}

/** SHA-256 hex of the exact stored bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build + seal a manifest. Returns the exact bytes to write to the data
 * plane (`manifests/{Date.now()}-{hash8}.json`) and the hash to register.
 */
export function sealManifest(opts: {
  keyring: Keyring;
  vaultId: string;
  keyEpoch: number;
  generation: number;
  prevManifestHash: string | null;
  chunkIndex: { id: string; size: number }[];
  appMeta: Record<string, string>;
  entries: ManifestEntry[];
  createdAt?: string;
}): { bytes: Uint8Array; manifestHash: string; manifest: StoredManifest } {
  const master = masterKeyForEpoch(opts.keyring, opts.keyEpoch);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const payload: SealedPayload = { entries: opts.entries };
  const payloadBytes = new TextEncoder().encode(canonicalJson(payload));
  const publicEnvelope: ManifestPublic = {
    format: SNAPSHOT_FORMAT,
    keyEpoch: opts.keyEpoch,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    generation: opts.generation,
    prevManifestHash: opts.prevManifestHash,
    chunkIndex: opts.chunkIndex,
    appMeta: opts.appMeta,
  };
  const aad = manifestPublicBytes(publicEnvelope);
  // Deterministic nonce (issue #408 G7): derived from the payload's own
  // content hash, so the same logical manifest seals to byte-identical
  // output — a retried registration re-uploads the identical object under
  // the identical manifestHash instead of minting a fresh ciphertext. A
  // different payload hashes differently, so the (key, nonce) pair never
  // repeats with different plaintext.
  const nonceIdentity = sha256Hex(
    new TextEncoder().encode(
      canonicalJson({ publicEnvelope, payloadHash: sha256Hex(payloadBytes) }),
    ),
  );
  const nonce = deriveNonce(dataKey, `centraid-backup:manifest-nonce:${nonceIdentity}`);
  const sealedBytes = encryptWithNonce(dataKey, nonce, payloadBytes, aad);
  const manifest: StoredManifest = {
    ...publicEnvelope,
    sealedPayload: Buffer.from(sealedBytes).toString('base64'),
  };
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const manifestHash = sha256Hex(bytes);
  return { bytes, manifestHash, manifest };
}

/** Verify stored manifest bytes against a registered hash — before parsing anything else. */
export function verifyManifest(bytes: Uint8Array, expectedHash: string): boolean {
  return sha256Hex(bytes) === expectedHash;
}

function validateStoredManifest(value: unknown): StoredManifest {
  if (typeof value !== 'object' || value === null) throw new Error('manifest: not an object');
  const v = value as Record<string, unknown>;
  if (typeof v['format'] !== 'string') throw new Error('manifest: missing "format"');
  if (typeof v['keyEpoch'] !== 'number') throw new Error('manifest: missing "keyEpoch"');
  if (typeof v['createdAt'] !== 'string') throw new Error('manifest: missing "createdAt"');
  if (typeof v['generation'] !== 'number') throw new Error('manifest: missing "generation"');
  if (v['prevManifestHash'] !== null && typeof v['prevManifestHash'] !== 'string') {
    throw new Error('manifest: bad "prevManifestHash"');
  }
  if (!Array.isArray(v['chunkIndex'])) throw new Error('manifest: missing "chunkIndex"');
  if (typeof v['appMeta'] !== 'object' || v['appMeta'] === null) {
    throw new Error('manifest: missing "appMeta"');
  }
  if (typeof v['sealedPayload'] !== 'string') throw new Error('manifest: missing "sealedPayload"');
  if (!Number.isSafeInteger(v['keyEpoch']) || (v['keyEpoch'] as number) < 1) {
    throw new Error('manifest: bad "keyEpoch"');
  }
  if (!Number.isSafeInteger(v['generation']) || (v['generation'] as number) < 1) {
    throw new Error('manifest: bad "generation"');
  }
  if (!Number.isFinite(Date.parse(v['createdAt'] as string))) {
    throw new Error('manifest: bad "createdAt"');
  }
  const chunkIds = new Set<string>();
  for (const chunk of v['chunkIndex'] as unknown[]) {
    if (typeof chunk !== 'object' || chunk === null) throw new Error('manifest: bad chunkIndex');
    const c = chunk as Record<string, unknown>;
    if (typeof c['id'] !== 'string' || !/^[0-9a-f]{64}$/.test(c['id'])) {
      throw new Error('manifest: bad chunk id');
    }
    if (!Number.isSafeInteger(c['size']) || (c['size'] as number) < 0) {
      throw new Error('manifest: bad chunk size');
    }
    if (chunkIds.has(c['id'] as string)) throw new Error('manifest: duplicate chunk id');
    chunkIds.add(c['id'] as string);
  }
  for (const value of Object.values(v['appMeta'] as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error('manifest: appMeta values must be strings');
  }
  return value as StoredManifest;
}

const ENTRY_KINDS = new Set<ManifestEntryKind>(['db', 'blob', 'git-bundle', 'seal-key']);

function validateManifestEntry(value: unknown, chunkIds: Set<string>): ManifestEntry {
  if (typeof value !== 'object' || value === null) throw new Error('manifest: bad entry');
  const entry = value as Record<string, unknown>;
  if (typeof entry['path'] !== 'string' || !isSafeEntryPath(entry['path'])) {
    throw new Error(`manifest: entry path rejected (path traversal?): "${String(entry['path'])}"`);
  }
  if (typeof entry['kind'] !== 'string' || !ENTRY_KINDS.has(entry['kind'] as ManifestEntryKind)) {
    throw new Error(`manifest: bad entry kind for "${entry['path']}"`);
  }
  if (!Number.isSafeInteger(entry['size']) || (entry['size'] as number) < 0) {
    throw new Error(`manifest: bad entry size for "${entry['path']}"`);
  }
  if (
    typeof entry['mtimeMs'] !== 'number' ||
    !Number.isFinite(entry['mtimeMs']) ||
    entry['mtimeMs'] < 0
  ) {
    throw new Error(`manifest: bad entry mtime for "${entry['path']}"`);
  }
  if (!Array.isArray(entry['chunks'])) {
    throw new Error(`manifest: bad entry chunks for "${entry['path']}"`);
  }
  for (const chunkId of entry['chunks']) {
    if (typeof chunkId !== 'string' || !chunkIds.has(chunkId)) {
      throw new Error(`manifest: entry "${entry['path']}" references an unknown chunk`);
    }
  }
  return value as ManifestEntry;
}

/** Registry rows are routing metadata, never an authority over the manifest. */
export function assertManifestMatchesRegistry(
  publicEnvelope: ManifestPublic,
  entries: ManifestEntry[],
  row: SnapshotRegistryIdentity,
): void {
  const mismatches: string[] = [];
  if (row.format !== publicEnvelope.format) mismatches.push('format');
  if (row.generation !== publicEnvelope.generation) mismatches.push('generation');
  if (row.prevManifestHash !== publicEnvelope.prevManifestHash) mismatches.push('prevManifestHash');
  if (canonicalJson(row.appMeta) !== canonicalJson(publicEnvelope.appMeta))
    mismatches.push('appMeta');
  if (row.objectCount !== publicEnvelope.chunkIndex.length) mismatches.push('objectCount');
  if (row.totalBytes !== entries.reduce((sum, entry) => sum + entry.size, 0)) {
    mismatches.push('totalBytes');
  }
  if (mismatches.length > 0) {
    throw new Error(
      `manifest: registry row disagrees with authenticated manifest (${mismatches.join(', ')})`,
    );
  }
}

/** Strict semantic contract for a /1 coordinated database base pair. */
export function validateSnapshotBasePair(entries: ManifestEntry[]): SnapshotBasePair {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`manifest /1: duplicate entry path "${entry.path}"`);
    paths.add(entry.path);
  }
  const dbEntries = entries.filter((entry) => entry.kind === 'db');
  const vault = dbEntries.filter((entry) => entry.path === 'vault.db');
  const journal = dbEntries.filter((entry) => entry.path === 'journal.db');
  if (dbEntries.length !== 2 || vault.length !== 1 || journal.length !== 1) {
    throw new Error('manifest /1: exactly one vault.db and one journal.db entry are required');
  }
  const [vaultEntry] = vault;
  const [journalEntry] = journal;
  for (const entry of [vaultEntry!, journalEntry!]) {
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`manifest /1: ${entry.path} is missing a valid sha256`);
    }
    if (typeof entry.walGeneration !== 'string' || !/^[0-9a-f]{32}$/.test(entry.walGeneration)) {
      throw new Error(`manifest /1: ${entry.path} is missing a valid WAL generation`);
    }
    if (!Number.isSafeInteger(entry.baseTickMs) || entry.baseTickMs! < 0) {
      throw new Error(`manifest /1: ${entry.path} is missing a valid base tick`);
    }
    if (
      entry.walTipTickMs !== undefined &&
      (!Number.isSafeInteger(entry.walTipTickMs) || entry.walTipTickMs < entry.baseTickMs!)
    ) {
      throw new Error(`manifest /1: ${entry.path} has an invalid WAL tip`);
    }
  }
  if (vaultEntry!.baseTickMs !== journalEntry!.baseTickMs) {
    throw new Error('manifest /1: database bases are from DIFFERENT ticks');
  }
  if (vaultEntry!.walTipTickMs !== journalEntry!.walTipTickMs) {
    throw new Error('manifest /1: database WAL tips do not match');
  }
  return {
    vault: vaultEntry!,
    journal: journalEntry!,
    baseTickMs: vaultEntry!.baseTickMs!,
    ...(vaultEntry!.walTipTickMs !== undefined ? { walTipTickMs: vaultEntry!.walTipTickMs } : {}),
  };
}

/** Reject path-traversal / absolute entry paths. */
export function isSafeEntryPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  const segments = p.split(/[\\/]/);
  return segments.every((seg) => seg !== '..' && seg !== '.');
}

/**
 * Parse + verify + decrypt a stored manifest. Throws on: bad JSON, hash
 * mismatch (if `expectedHash` given), an unknown key epoch, decryption
 * failure (tamper/wrong key), or a hostile entry path.
 */
export function openManifest(
  bytes: Uint8Array,
  keyring: Keyring,
  vaultId: string,
  expectedHash?: string,
): { public: ManifestPublic; entries: ManifestEntry[] } {
  if (expectedHash !== undefined && !verifyManifest(bytes, expectedHash)) {
    throw new Error('manifest hash mismatch — object does not match the registered manifestHash');
  }
  const parsed = validateStoredManifest(JSON.parse(new TextDecoder().decode(bytes)));
  const master = masterKeyForEpoch(keyring, parsed.keyEpoch);
  const dataKey = deriveDataKey(master, vaultId);
  const { sealedPayload: _sealedPayload, ...pub } = parsed;
  // The public envelope is GCM AAD: a provider cannot rewrite
  // format/generation/appMeta and recompute the registry hash around an
  // unchanged sealed payload.
  const aad = manifestPublicBytes(pub);
  const plainBytes = decrypt(
    dataKey,
    new Uint8Array(Buffer.from(parsed.sealedPayload, 'base64')),
    aad,
  );
  const payload = JSON.parse(new TextDecoder().decode(plainBytes)) as { entries?: unknown };
  if (!Array.isArray(payload.entries))
    throw new Error('manifest: sealed payload missing "entries"');
  const chunkIds = new Set(parsed.chunkIndex.map((chunk) => chunk.id));
  const entries = payload.entries.map((entry) => validateManifestEntry(entry, chunkIds));
  return { public: pub, entries };
}
