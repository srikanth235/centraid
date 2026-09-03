import type { BlobRange, BlobStat } from "./store.js";

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface TemporaryMultipartUpload {
  tempId: string;
  uploadId: string;
  initiatedAt: string;
}

export interface RemoteBlobTransfer {
  beginShaUpload?: (sha256: string, storageClass?: string) => Promise<string>;
  uploadShaPart?: (
    sha256: string,
    uploadId: string,
    partNumber: number,
    bytes: Buffer
  ) => Promise<string>;
  completeShaUpload?: (
    sha256: string,
    uploadId: string,
    parts: readonly MultipartPart[]
  ) => Promise<void>;
  abortShaUpload?: (sha256: string, uploadId: string) => Promise<void>;
  beginTemporaryUpload: (tempId: string) => Promise<string>;
  uploadTemporaryPart: (
    tempId: string,
    uploadId: string,
    partNumber: number,
    bytes: Buffer
  ) => Promise<string>;
  completeTemporaryUpload: (
    tempId: string,
    uploadId: string,
    parts: readonly MultipartPart[]
  ) => Promise<void>;
  abortTemporaryUpload: (tempId: string, uploadId: string) => Promise<void>;
  listTemporaryUploads?: () => Promise<TemporaryMultipartUpload[]>;
  putTemporary: (tempId: string, bytes: Buffer) => Promise<void>;
  putTemporaryStream: (
    tempId: string,
    source: NodeJS.ReadableStream,
    approxSize: number
  ) => Promise<void>;
  statTemporary: (tempId: string) => Promise<BlobStat | null>;
  getTemporary?: (tempId: string, range?: BlobRange) => Promise<Buffer | null>;
  copyTemporaryToSha: (
    tempId: string,
    sha256: string,
    storageClass?: string
  ) => Promise<void>;
  deleteTemporary: (tempId: string) => Promise<void>;
  presignTemporaryPut: (
    tempId: string,
    expiresSeconds?: number
  ) => Promise<URL>;
  presignTemporaryPart: (
    tempId: string,
    uploadId: string,
    partNumber: number,
    expiresSeconds?: number
  ) => Promise<URL>;
  presignShaGet: (sha256: string, expiresSeconds?: number) => Promise<URL>;
}
