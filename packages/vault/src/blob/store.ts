// Blob custody (#296). text/* bodies stay inline as data: URIs — FTS triggers
// decode them in-transaction and cannot do I/O — everything else becomes
// `blob:sha256-<hex>`, hashed from the RAW bytes, never from the data: URI.
// Two tiers behind one facade (custody.ts): only the LOCAL store may be
// touched by the synchronous command pipeline. Keep this contract tiny —
// everything a directory and a bucket can both do cheaply, keyed by flat shas.

import { createHash } from "node:crypto";

/** `content_uri` scheme for CAS-backed bytes. */
export const BLOB_URI_PREFIX = "blob:sha256-";

/** 64 lowercase hex chars — the only accepted blob key shape. */
const SHA_HEX = /^[0-9a-f]{64}$/u;

export function isBlobUri(uri: unknown): uri is string {
  return typeof uri === "string" && uri.startsWith(BLOB_URI_PREFIX);
}

export function blobUriFor(sha256: string): string {
  return BLOB_URI_PREFIX + sha256;
}

export function shaOfBlobUri(uri: unknown): string | null {
  if (!isBlobUri(uri)) return null;
  const sha = uri.slice(BLOB_URI_PREFIX.length);
  return SHA_HEX.test(sha) ? sha : null;
}

/** Refuse anything but a plain sha256 before it nears a path or key. */
export function assertSha(sha: string): string {
  if (!SHA_HEX.test(sha)) throw new Error(`not a sha256 hex key: ${sha}`);
  return sha;
}

/** sha256 of raw bytes — blob identity (#296: never hash the data: URI). */
export function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

/** All methods are async (a bucket is on the network); the local tier also
 *  exposes a synchronous `LocalCas` for the command pipeline. `put` is
 *  idempotent by construction. */
export interface BlobStore {
  readonly kind: string;
  /** `storageClass` (#425) overrides the instance default for this write only;
   *  absent ⇒ the instance default, both absent ⇒ no header. Local stores
   *  ignore it. */
  put: (sha256: string, bytes: Buffer, storageClass?: string) => Promise<void>;
  /** Bytes of one blob (or a byte range of it). Null when absent. */
  get: (sha256: string, range?: BlobRange) => Promise<Buffer | null>;
  has: (sha256: string) => Promise<boolean>;
  delete: (sha256: string) => Promise<void>;
  /** Every sha the store holds — the reconciliation sweep's ground truth. */
  list: () => Promise<string[]>;
  stat: (sha256: string) => Promise<BlobStat | null>;
  /** Optional (#367): an implementation that cannot stream omits this and
   *  callers fall back to `put`. `approxSize` need not be exact — it only
   *  informs the multipart-vs-single decision and part sizing. */
  putStream?: (
    sha256: string,
    source: NodeJS.ReadableStream,
    approxSize: number,
    storageClass?: string
  ) => Promise<void>;
}

/** Clamp a requested range against a known size; null = unsatisfiable. */
export function resolveRange(
  size: number,
  range?: BlobRange
): { start: number; end: number } | null {
  if (!range) return { start: 0, end: size - 1 };
  const start = range.start;
  const end = Math.min(range.end ?? size - 1, size - 1);
  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}
