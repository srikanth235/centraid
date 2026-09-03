import { createHash } from "node:crypto";

export const BLOB_URI_PREFIX = "blob:sha256-";

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

export function assertSha(sha: string): string {
  if (!SHA_HEX.test(sha)) throw new Error(`not a sha256 hex key: ${sha}`);
  return sha;
}

export function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface BlobRange {
  start: number;
  end?: number;
}

export interface BlobStat {
  size: number;
}

export interface BlobStore {
  readonly kind: string;
  put: (sha256: string, bytes: Buffer, storageClass?: string) => Promise<void>;
  get: (sha256: string, range?: BlobRange) => Promise<Buffer | null>;
  has: (sha256: string) => Promise<boolean>;
  delete: (sha256: string) => Promise<void>;
  list: () => Promise<string[]>;
  stat: (sha256: string) => Promise<BlobStat | null>;
  putStream?: (
    sha256: string,
    source: NodeJS.ReadableStream,
    approxSize: number,
    storageClass?: string
  ) => Promise<void>;
}

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
