// Public surface of the durable upload queue (#419 M0.4).
//
// The device assembly lives in `native-queue.ts` and is imported separately —
// it pulls in op-sqlite and expo-file-system, so importing it from here would
// drag native modules into every consumer (and into the test rig).

export {
  FRAME_BYTES,
  FRAMES_PER_PART,
  PART_PLAINTEXT_BYTES,
  SEAL_VERSION,
  frameCountFor,
  partCountFor,
  sealedSizeFor,
} from './cbsf';
export { UploadCryptoUnavailableError, webCryptoUploadCrypto, type UploadCrypto } from './crypto';
export {
  enqueueLocalFile,
  sha256OfFile,
  type EnqueueDeps,
  type EnqueueInput,
  type StreamingDigest,
} from './enqueue';
export { bytesFileSource, type FileSource, type FileSourceOpener } from './file-source';
export {
  DirectTransferError,
  httpDirectTransferClient,
  type DirectBeginResult,
  type DirectTransferClient,
  type SettlementReceipt,
} from './gateway-client';
export { IncrementalSha256 } from './incremental-sha256';
export {
  UploadQueueStore,
  type NewUpload,
  type UploadItem,
  type UploadItemState,
  type UploadPart,
  type UploadPartState,
} from './store';
export {
  UploadDrainer,
  type DrainProgress,
  type DrainSummary,
  type PartPutter,
  type UploadDrainerDeps,
  type UploadPolicy,
} from './uploader';
