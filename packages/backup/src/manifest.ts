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
import { decrypt, encrypt, type Keyring, masterKeyForEpoch, deriveDataKey } from './crypto.js';

export type ManifestEntryKind = 'db' | 'blob' | 'git-bundle' | 'seal-key';

export interface ManifestEntry {
  path: string;
  kind: ManifestEntryKind;
  size: number;
  /**
   * Source mtime (ms since epoch) at snapshot time. FORMAT.md's example
   * sealed-payload entry doesn't show this field, but it lives entirely
   * inside the encrypted sealed payload — providers never parse it, and
   * FORMAT.md's own additive-field posture ("engines MUST read format N and
   * N-1") covers a new optional field within one format version. The engine
   * needs it for the incremental fast path (§ engine.ts createSnapshot):
   * same path + size + mtime as the previous snapshot means the file is
   * provably unchanged, so its chunk refs can be reused without a re-read.
   */
  mtimeMs: number;
  chunks: string[];
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

export const SNAPSHOT_FORMAT = 'centraid-snapshot/1';

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
  const sealedBytes = encrypt(dataKey, new TextEncoder().encode(canonicalJson(payload)));
  const manifest: StoredManifest = {
    format: SNAPSHOT_FORMAT,
    keyEpoch: opts.keyEpoch,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    generation: opts.generation,
    prevManifestHash: opts.prevManifestHash,
    chunkIndex: opts.chunkIndex,
    appMeta: opts.appMeta,
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
  return value as StoredManifest;
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
  const plainBytes = decrypt(dataKey, new Uint8Array(Buffer.from(parsed.sealedPayload, 'base64')));
  const payload = JSON.parse(new TextDecoder().decode(plainBytes)) as SealedPayload;
  if (!Array.isArray(payload.entries))
    throw new Error('manifest: sealed payload missing "entries"');
  for (const entry of payload.entries) {
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`manifest: entry path rejected (path traversal?): "${entry.path}"`);
    }
  }
  const { sealedPayload: _sealedPayload, ...pub } = parsed;
  return { public: pub, entries: payload.entries };
}
