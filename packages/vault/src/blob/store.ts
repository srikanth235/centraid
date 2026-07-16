// Blob custody (issue #296): content-addressed byte storage beside vault.db.
// `core_content_item` stays the only truth ABOUT bytes; what changes is what
// `content_uri` may hold — text/* bodies stay inline as data: URIs (the FTS
// triggers decode them in-transaction and cannot do I/O), everything else
// becomes `blob:sha256-<hex>` and the bytes live in a driver behind this
// interface. Identity is the sha256 of the RAW bytes, never of a data: URI —
// media type is metadata, not identity.
//
// Two tiers, one facade (custody.ts): a LOCAL content-addressed store is
// always present (it is the spool every ingress hashes into, the cache every
// egress serves from, and the only tier the synchronous command pipeline may
// touch), and an OPTIONAL remote driver (S3-compatible) replicates behind it.
// The driver contract is deliberately tiny — everything a directory and a
// bucket can both do cheaply. Keys are flat shas; any fan-out layout is a
// driver-internal detail.

import { createHash } from 'node:crypto';

/** `content_uri` scheme for CAS-backed bytes. */
export const BLOB_URI_PREFIX = 'blob:sha256-';

/** 64 lowercase hex chars — the only accepted blob key shape. */
const SHA_HEX = /^[0-9a-f]{64}$/;

export function isBlobUri(uri: unknown): uri is string {
  return typeof uri === 'string' && uri.startsWith(BLOB_URI_PREFIX);
}

export function blobUriFor(sha256: string): string {
  return BLOB_URI_PREFIX + sha256;
}

/** The sha behind a `blob:` URI, or null for any other shape. */
export function shaOfBlobUri(uri: unknown): string | null {
  if (!isBlobUri(uri)) return null;
  const sha = uri.slice(BLOB_URI_PREFIX.length);
  return SHA_HEX.test(sha) ? sha : null;
}

/** Refuse anything that is not a plain lowercase sha256 before it nears a path or key. */
export function assertSha(sha: string): string {
  if (!SHA_HEX.test(sha)) throw new Error(`not a sha256 hex key: ${sha}`);
  return sha;
}

/** sha256 of raw bytes — blob identity (issue #296: never hash the data: URI). */
export function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface BlobRange {
  /** First byte offset, inclusive. */
  start: number;
  /** Last byte offset, inclusive. Omitted = to the end. */
  end?: number;
}

export interface BlobStat {
  size: number;
}

/**
 * The remote-capable driver seam. All methods are async (a bucket is on the
 * network); the local tier additionally exposes a synchronous surface
 * (LocalCas) because the command pipeline is synchronous. `put` is idempotent
 * by construction — same sha, same bytes, same key.
 */
export interface BlobStore {
  readonly kind: string;
  /**
   * `storageClass` (issue #425 Wave 3) is an optional per-write override for the
   * object-creating `x-amz-storage-class` header — it wins over any instance
   * default; absent ⇒ the instance default; both absent ⇒ no header. Local
   * stores ignore it.
   */
  put(sha256: string, bytes: Buffer, storageClass?: string): Promise<void>;
  /** Bytes of one blob (or a byte range of it). Null when absent. */
  get(sha256: string, range?: BlobRange): Promise<Buffer | null>;
  has(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<void>;
  /** Every sha the store holds — the reconciliation sweep's ground truth. */
  list(): Promise<string[]>;
  stat(sha256: string): Promise<BlobStat | null>;
  /**
   * Optional streaming upload (issue #367 §C8): push `source` without the
   * caller materializing the whole blob in memory first. Implementations
   * that can't stream simply omit this — callers fall back to `put`.
   * `approxSize` need not be exact; it only informs the multipart-vs-single
   * decision and part sizing. `storageClass` is the same per-write override as
   * `put` (issue #425 Wave 3), applied to whichever object-creating call the
   * size selects (single PUT or CreateMultipartUpload).
   */
  putStream?(
    sha256: string,
    source: NodeJS.ReadableStream,
    approxSize: number,
    storageClass?: string,
  ): Promise<void>;
}

/** Clamp a requested range against a known size; null = unsatisfiable. */
export function resolveRange(
  size: number,
  range?: BlobRange,
): { start: number; end: number } | null {
  if (!range) return { start: 0, end: size - 1 };
  const start = range.start;
  const end = Math.min(range.end ?? size - 1, size - 1);
  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}
