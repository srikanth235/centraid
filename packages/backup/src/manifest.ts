/*
 * Manifest build/seal/open (FORMAT.md § Manifest): a PUBLIC envelope readable
 * without a key, wrapping a SEALED entry list. `manifestHash` is SHA-256 over
 * the EXACT stored bytes, so one manifest always serializes byte-identically —
 * hence `canonicalJson`.
 */

import { createHash } from "node:crypto";

import {
  decrypt,
  deriveNonce,
  encryptWithNonce,
  masterKeyForEpoch,
  deriveDataKey,
} from "./crypto.js";
import type { Keyring } from "./crypto.js";

export type ManifestEntryKind = "db" | "blob" | "git-bundle" | "seal-key";

export interface ManifestEntry {
  path: string;
  kind: ManifestEntryKind;
  size: number;
  /** Sealed, so no provider parses it. Same path + size + mtime means chunk
   * refs can be reused unread. */
  mtimeMs: number;
  chunks: string[];
  /** /1, `db` only: plaintext SHA-256, re-derived after restore. */
  sha256?: string;
  /** /1, `db` only: restore replays `wal/{db}/{walGeneration}/` on it. */
  walGeneration?: string;
  /** /1, `db` only: the tick this base was cloned at — the instant every
   * replayed segment layers on. */
  baseTickMs?: number;
  /**
   * /1, `db` only: a FLOOR on what the store owes us. A restore that cannot
   * reach it reads a store that LOST acknowledged objects — otherwise silent.
   * From CONFIRMED uploads only, so it never claims a marker the store lacks.
   */
  walTipTickMs?: number;
}

export interface SealedPayload {
  entries: ManifestEntry[];
}

export interface ManifestPublic {
  format: string;
  keyEpoch: number;
  createdAt: string;
  generation: number;
  prevManifestHash: string | null;
  chunkIndex: { id: string; size: number }[];
  appMeta: Record<string, string>;
}

export interface StoredManifest extends ManifestPublic {
  sealedPayload: string;
}

function manifestPublicBytes(publicEnvelope: ManifestPublic): Uint8Array {
  return new TextEncoder().encode(canonicalJson(publicEnvelope));
}

/** Base-plus-WAL (#408); its chunk objects seal RAW part bytes. */
export const SNAPSHOT_FORMAT_V1 = "centraid-snapshot/1";
/** `/2` (#405) frames chunk plaintext as `[algo-id][body]`, so `/1` and `/2`
 * readers misread each other. No dual-format reader: the bump IS it. */
export const SNAPSHOT_FORMAT_V2 = "centraid-snapshot/2";
/** v0 has ONE readable format: reject every other string. */
export const READABLE_SNAPSHOT_FORMATS: readonly string[] = [
  SNAPSHOT_FORMAT_V2,
];

export interface SnapshotRegistryIdentity {
  format: string;
  generation: number;
  prevManifestHash: string | null;
  appMeta: Record<string, string>;
  totalBytes: number;
  objectCount: number;
}

export interface SnapshotBase {
  entry: ManifestEntry;
  baseTickMs: number;
  walTipTickMs?: number;
}

/** Keys sorted recursively, no insignificant whitespace, array order kept;
 * `undefined` dropped, so an explicitly-undefined optional still matches. */
export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stringifyCanonical(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${stringifyCanonical(obj[k])}`
    );
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
    format: SNAPSHOT_FORMAT_V2,
    keyEpoch: opts.keyEpoch,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    generation: opts.generation,
    prevManifestHash: opts.prevManifestHash,
    chunkIndex: opts.chunkIndex,
    appMeta: opts.appMeta,
  };
  const aad = manifestPublicBytes(publicEnvelope);
  // Deterministic nonce (#408) from the payload's own hash: a retry re-uploads
  // an identical object, and (key, nonce) never repeats with new plaintext.
  const nonceIdentity = sha256Hex(
    new TextEncoder().encode(
      canonicalJson({ publicEnvelope, payloadHash: sha256Hex(payloadBytes) })
    )
  );
  const nonce = deriveNonce(
    dataKey,
    `centraid-backup:manifest-nonce:${nonceIdentity}`
  );
  const sealedBytes = encryptWithNonce(dataKey, nonce, payloadBytes, aad);
  const manifest: StoredManifest = {
    ...publicEnvelope,
    sealedPayload: Buffer.from(sealedBytes).toString("base64"),
  };
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const manifestHash = sha256Hex(bytes);
  return { bytes, manifestHash, manifest };
}

/** Verify against the registered hash BEFORE parsing anything. */
export function verifyManifest(
  bytes: Uint8Array,
  expectedHash: string
): boolean {
  return sha256Hex(bytes) === expectedHash;
}

function validateStoredManifest(value: unknown): StoredManifest {
  if (typeof value !== "object" || value === null)
    throw new Error("manifest: not an object");
  const v = value as Record<string, unknown>;
  if (typeof v["format"] !== "string")
    throw new Error('manifest: missing "format"');
  if (typeof v["keyEpoch"] !== "number")
    throw new Error('manifest: missing "keyEpoch"');
  if (typeof v["createdAt"] !== "string")
    throw new Error('manifest: missing "createdAt"');
  if (typeof v["generation"] !== "number")
    throw new Error('manifest: missing "generation"');
  if (
    v["prevManifestHash"] !== null &&
    typeof v["prevManifestHash"] !== "string"
  ) {
    throw new Error('manifest: bad "prevManifestHash"');
  }
  if (!Array.isArray(v["chunkIndex"]))
    throw new Error('manifest: missing "chunkIndex"');
  if (typeof v["appMeta"] !== "object" || v["appMeta"] === null) {
    throw new Error('manifest: missing "appMeta"');
  }
  if (typeof v["sealedPayload"] !== "string")
    throw new Error('manifest: missing "sealedPayload"');
  if (!Number.isSafeInteger(v["keyEpoch"]) || (v["keyEpoch"] as number) < 1) {
    throw new Error('manifest: bad "keyEpoch"');
  }
  if (
    !Number.isSafeInteger(v["generation"]) ||
    (v["generation"] as number) < 1
  ) {
    throw new Error('manifest: bad "generation"');
  }
  if (!Number.isFinite(Date.parse(v["createdAt"] as string))) {
    throw new Error('manifest: bad "createdAt"');
  }
  const chunkIds = new Set<string>();
  for (const chunk of v["chunkIndex"] as unknown[]) {
    if (typeof chunk !== "object" || chunk === null)
      throw new Error("manifest: bad chunkIndex");
    const c = chunk as Record<string, unknown>;
    if (typeof c["id"] !== "string" || !/^[0-9a-f]{64}$/u.test(c["id"])) {
      throw new Error("manifest: bad chunk id");
    }
    if (!Number.isSafeInteger(c["size"]) || (c["size"] as number) < 0) {
      throw new Error("manifest: bad chunk size");
    }
    if (chunkIds.has(c["id"] as string))
      throw new Error("manifest: duplicate chunk id");
    chunkIds.add(c["id"] as string);
  }
  for (const valueLocal of Object.values(
    v["appMeta"] as Record<string, unknown>
  )) {
    if (typeof valueLocal !== "string")
      throw new Error("manifest: appMeta values must be strings");
  }
  return value as StoredManifest;
}

const ENTRY_KINDS = new Set<ManifestEntryKind>([
  "db",
  "blob",
  "git-bundle",
  "seal-key",
]);

function validateManifestEntry(
  value: unknown,
  chunkIds: Set<string>
): ManifestEntry {
  if (typeof value !== "object" || value === null)
    throw new Error("manifest: bad entry");
  const entry = value as Record<string, unknown>;
  if (typeof entry["path"] !== "string" || !isSafeEntryPath(entry["path"])) {
    throw new Error(
      `manifest: entry path rejected (path traversal?): "${String(entry["path"])}"`
    );
  }
  if (
    typeof entry["kind"] !== "string" ||
    !ENTRY_KINDS.has(entry["kind"] as ManifestEntryKind)
  ) {
    throw new Error(`manifest: bad entry kind for "${entry["path"]}"`);
  }
  if (!Number.isSafeInteger(entry["size"]) || (entry["size"] as number) < 0) {
    throw new Error(`manifest: bad entry size for "${entry["path"]}"`);
  }
  if (
    typeof entry["mtimeMs"] !== "number" ||
    !Number.isFinite(entry["mtimeMs"]) ||
    entry["mtimeMs"] < 0
  ) {
    throw new Error(`manifest: bad entry mtime for "${entry["path"]}"`);
  }
  if (!Array.isArray(entry["chunks"])) {
    throw new Error(`manifest: bad entry chunks for "${entry["path"]}"`);
  }
  for (const chunkId of entry["chunks"]) {
    if (typeof chunkId !== "string" || !chunkIds.has(chunkId)) {
      throw new Error(
        `manifest: entry "${entry["path"]}" references an unknown chunk`
      );
    }
  }
  return value as ManifestEntry;
}

/** Registry rows are routing metadata, not authority. */
export function assertManifestMatchesRegistry(
  publicEnvelope: ManifestPublic,
  entries: ManifestEntry[],
  row: SnapshotRegistryIdentity
): void {
  const mismatches: string[] = [];
  if (row.format !== publicEnvelope.format) mismatches.push("format");
  if (row.generation !== publicEnvelope.generation)
    mismatches.push("generation");
  if (row.prevManifestHash !== publicEnvelope.prevManifestHash)
    mismatches.push("prevManifestHash");
  if (canonicalJson(row.appMeta) !== canonicalJson(publicEnvelope.appMeta))
    mismatches.push("appMeta");
  if (row.objectCount !== publicEnvelope.chunkIndex.length)
    mismatches.push("objectCount");
  if (row.totalBytes !== entries.reduce((sum, entry) => sum + entry.size, 0)) {
    mismatches.push("totalBytes");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `manifest: registry row disagrees with authenticated manifest (${mismatches.join(", ")})`
    );
  }
}

export function validateSnapshotBase(entries: ManifestEntry[]): SnapshotBase {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path))
      throw new Error(`manifest /1: duplicate entry path "${entry.path}"`);
    paths.add(entry.path);
  }
  const dbEntries = entries.filter((entry) => entry.kind === "db");
  // The vault is the ONE database a snapshot carries; a second `db` entry is a
  // producer from another protocol, never something to restore beside it.
  if (dbEntries.length !== 1 || dbEntries[0]!.path !== "vault.db") {
    throw new Error("manifest /1: exactly one vault.db entry is required");
  }
  const entry = dbEntries[0]!;
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256))
    throw new Error(`manifest /1: ${entry.path} is missing a valid sha256`);
  if (
    typeof entry.walGeneration !== "string" ||
    !/^[0-9a-f]{32}$/u.test(entry.walGeneration)
  ) {
    throw new Error(
      `manifest /1: ${entry.path} is missing a valid WAL generation`
    );
  }
  if (!Number.isSafeInteger(entry.baseTickMs) || entry.baseTickMs! < 0)
    throw new Error(`manifest /1: ${entry.path} is missing a valid base tick`);
  if (
    entry.walTipTickMs !== undefined &&
    (!Number.isSafeInteger(entry.walTipTickMs) ||
      entry.walTipTickMs < entry.baseTickMs!)
  ) {
    throw new Error(`manifest /1: ${entry.path} has an invalid WAL tip`);
  }
  return {
    entry,
    baseTickMs: entry.baseTickMs!,
    ...(entry.walTipTickMs === undefined
      ? {}
      : { walTipTickMs: entry.walTipTickMs }),
  };
}

export function isSafeEntryPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/u.test(p)) return false;
  const segments = p.split(/[\\/]/u);
  return segments.every((seg) => seg !== ".." && seg !== ".");
}

/** Throws on tamper, wrong key, hash mismatch or a hostile entry path. */
export function openManifest(
  bytes: Uint8Array,
  keyring: Keyring,
  vaultId: string,
  expectedHash?: string
): { public: ManifestPublic; entries: ManifestEntry[] } {
  if (expectedHash !== undefined && !verifyManifest(bytes, expectedHash)) {
    throw new Error(
      "manifest hash mismatch — object does not match the registered manifestHash"
    );
  }
  const parsed = validateStoredManifest(
    JSON.parse(new TextDecoder().decode(bytes))
  );
  const master = masterKeyForEpoch(keyring, parsed.keyEpoch);
  const dataKey = deriveDataKey(master, vaultId);
  const { sealedPayload: _sealedPayload, ...pub } = parsed;
  // The public envelope is GCM AAD: a provider cannot rewrite it around an
  // unchanged sealed payload.
  const aad = manifestPublicBytes(pub);
  const plainBytes = decrypt(
    dataKey,
    new Uint8Array(Buffer.from(parsed.sealedPayload, "base64")),
    aad
  );
  const payload = JSON.parse(new TextDecoder().decode(plainBytes)) as {
    entries?: unknown;
  };
  if (!Array.isArray(payload.entries))
    throw new Error('manifest: sealed payload missing "entries"');
  const chunkIds = new Set(parsed.chunkIndex.map((chunk) => chunk.id));
  const entries = payload.entries.map((entry) =>
    validateManifestEntry(entry, chunkIds)
  );
  return { public: pub, entries };
}
