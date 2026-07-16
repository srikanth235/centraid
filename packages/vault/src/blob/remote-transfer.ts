import type { BlobRange, BlobStat } from './store.js';

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

/** Provider-side multipart state, including uploads not yet durable locally. */
export interface TemporaryMultipartUpload {
  tempId: string;
  uploadId: string;
  initiatedAt: string;
}

/**
 * Remote operations that intentionally do not fit the tiny content-addressed
 * BlobStore seam: restartable temporary multipart uploads, atomic-ish
 * temp-to-final promotion, and short-lived direct-upload URLs (#414).
 */
export interface RemoteBlobTransfer {
  /** Restartable multipart upload whose destination is the final CAS SHA key. */
  beginShaUpload?(sha256: string): Promise<string>;
  uploadShaPart?(
    sha256: string,
    uploadId: string,
    partNumber: number,
    bytes: Buffer,
  ): Promise<string>;
  completeShaUpload?(
    sha256: string,
    uploadId: string,
    parts: readonly MultipartPart[],
  ): Promise<void>;
  abortShaUpload?(sha256: string, uploadId: string): Promise<void>;
  beginTemporaryUpload(tempId: string): Promise<string>;
  uploadTemporaryPart(
    tempId: string,
    uploadId: string,
    partNumber: number,
    bytes: Buffer,
  ): Promise<string>;
  completeTemporaryUpload(
    tempId: string,
    uploadId: string,
    parts: readonly MultipartPart[],
  ): Promise<void>;
  abortTemporaryUpload(tempId: string, uploadId: string): Promise<void>;
  /** Enumerate every in-progress upload under this vault's temp prefix. */
  listTemporaryUploads?(): Promise<TemporaryMultipartUpload[]>;
  putTemporary(tempId: string, bytes: Buffer): Promise<void>;
  putTemporaryStream(
    tempId: string,
    source: NodeJS.ReadableStream,
    approxSize: number,
  ): Promise<void>;
  statTemporary(tempId: string): Promise<BlobStat | null>;
  /** Bounded read used only to re-key a hash-unknown encrypted temp object. */
  getTemporary?(tempId: string, range?: BlobRange): Promise<Buffer | null>;
  copyTemporaryToSha(tempId: string, sha256: string): Promise<void>;
  deleteTemporary(tempId: string): Promise<void>;
  presignTemporaryPut(tempId: string, expiresSeconds?: number): Promise<URL>;
  presignTemporaryPart(
    tempId: string,
    uploadId: string,
    partNumber: number,
    expiresSeconds?: number,
  ): Promise<URL>;
  presignShaGet(sha256: string, expiresSeconds?: number): Promise<URL>;
}
