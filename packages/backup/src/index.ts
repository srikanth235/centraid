// Provider seam (PROTOCOL.md).
export {
  BackupProviderError,
  CODE_STATUS,
  HOME_PROFILE_CAPABILITIES,
  PROVIDER_PROFILES,
  STORE_CLASSES,
} from "./provider.js";
export type {
  AccountStatus,
  BackupDiscovery,
  BackupProvider,
  BackupProviderErrorCode,
  BackupProviderErrorDetails,
  ProviderAuditEvent,
  ProviderAuditPage,
  ProviderAuditQuery,
  ProviderCapabilities,
  ProviderCapabilityFlag,
  ProviderEventKind,
  ProviderInventoryObject,
  ProviderInventoryPage,
  ProviderInventoryQuery,
  ProviderPolicy,
  ProviderPolicyDeclaration,
  ProviderProfile,
  Retention,
  S3Grant,
  SnapshotRegistration,
  SnapshotRow,
  StoreClass,
  StoreUsageReport,
  TargetInfo,
  Usage,
  UsageByStore,
} from "./provider.js";
export { MIN_POLICY_RPO_SECONDS } from "./provider-observability.js";

// Data plane.
export { assertSafeKey, FsObjectStore } from "./object-store.js";
export type { ObjectListEntry, ObjectStore } from "./object-store.js";
export { S3ObjectStore } from "./s3-store.js";
export type { S3ObjectStoreOptions } from "./s3-store.js";

// Layer-1 generic grant path (PROTOCOL.md § Credential grant) — for a
// consumer (e.g. a `cas` store client) that wants a grant without pulling in
// the snapshot engine or `BackupProvider`.
export {
  requestCasGrant,
  requestDerivedGrant,
  requestStorageGrant,
} from "./cas-grant.js";
export type {
  RequestCasGrantOptions,
  RequestDerivedGrantOptions,
  RequestStorageGrantOptions,
} from "./cas-grant.js";

// Parts (FORMAT.md § Parts — fixed-size, /1 boundaries kept in /2).
export { PART_BYTES, partBuffer, partStream } from "./parts.js";

// Entropy-gated chunk payload framing (FORMAT.md § Chunk payload framing — /2, #405 §1).
export {
  ALGO_DEFLATE,
  ALGO_STORE,
  ALGO_ZSTD,
  frameChunkPayload,
  unframeChunkPayload,
  zstdAvailable,
} from "./compress.js";

// WAL segments (FORMAT.md § WAL segments — /1, #408).
export {
  isWalGeneration,
  lastCommitBoundary,
  scanWalPrefix,
  validateCommittedWal,
  newWalGeneration,
  openWalCloser,
  openWalSegment,
  openWalTickMarker,
  parseWalCloserKey,
  parseWalSegmentKey,
  parseWalTickMarkerKey,
  planMarkedReplay,
  planWalReplay,
  reachedPosition,
  sealWalCloser,
  sealWalSegment,
  sealWalTickMarker,
  WAL_DB_FILES,
  WAL_HEADER_BYTES,
  walDbPrefix,
  walGroupCloserKey,
  walPageSize,
  walSalts,
  walSegmentKey,
  walSegmentPrefix,
  walTickMarkerKey,
  walTickMarkerPrefix,
  walTickMarkerRootPrefix,
} from "./wal-format.js";
export type {
  MarkedReplayResult,
  WalDbName,
  WalGroupCloser,
  WalReplayPlan,
  WalPrefixScan,
  WalSegmentAddress,
  WalStreamListing,
  WalStreamPosition,
  WalTickMarker,
  WalTickMarkerAddress,
} from "./wal-format.js";
export { replayWalSegments } from "./wal-restore.js";
export type { ReplayWalOptions, WalReplayOutcome } from "./wal-restore.js";

// Crypto + keyring (FORMAT.md § Key custody, § Encryption).
export {
  activeMasterKey,
  chunkId,
  createKeyring,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  deriveNonce,
  encrypt,
  encryptWithNonce,
  loadKeyring,
  masterKeyForEpoch,
  rotateKeyring,
  saveKeyring,
  validateKeyring,
} from "./crypto.js";
export type { Keyring, KeyringEpoch } from "./crypto.js";

// Manifest (FORMAT.md § Manifest).
export {
  canonicalJson,
  isSafeEntryPath,
  openManifest,
  READABLE_SNAPSHOT_FORMATS,
  sealManifest,
  sha256Hex,
  SNAPSHOT_FORMAT_V1,
  SNAPSHOT_FORMAT_V2,
  verifyManifest,
} from "./manifest.js";
export type {
  ManifestEntry,
  ManifestEntryKind,
  ManifestPublic,
  SealedPayload,
  StoredManifest,
} from "./manifest.js";

// Engine (snapshot / restore / verify / recovery kit).
export {
  assertCompatibleAppMeta,
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "./engine.js";
export type {
  CreateSnapshotOptions,
  EngineLogger,
  RecoveryKitTarget,
  RestoreCurrentVersions,
  RestoreResult,
  RestoreSnapshotOptions,
  SourceEntry,
  VerifySnapshotOptions,
  VerifySnapshotResult,
} from "./engine.js";

// Recovery kit reader + password wrapper (#439, #555). A kit is always
// password-wrapped; the reader refuses anything else.
export {
  parseRecoveryKit,
  recoveryKitFingerprint,
  wrapRecoveryKit,
  RECOVERY_KIT_SCRYPT,
} from "./recovery-kit.js";
export type {
  RecoveryKitDocument,
  WrappedRecoveryKitDocument,
} from "./recovery-kit.js";

// The password wrap under the kit (#439, generalised for #630): scrypt →
// AES-256-GCM over canonical JSON. Shared so the vault's portable-export
// custody kit is the SAME wrap, not a second copy of the crypto.
export {
  PASSWORD_WRAP_SCRYPT,
  unwrapPasswordDocument,
  wrapPasswordDocument,
} from "./password-wrap.js";
export type { WrappedPasswordDocument } from "./password-wrap.js";

// Targeted blob re-pin (#439) — materialize specific shas from a
// snapshot, for the adopt-time inventory reconcile.
export { materializeSnapshotBlobs } from "./materialize.js";
export type {
  MaterializeSnapshotBlobsOptions,
  MaterializeSnapshotBlobsResult,
} from "./materialize.js";

// Providers.
export {
  LocalBackupProvider,
  openLocalBackupProvider,
} from "./local-provider.js";
export type { LocalBackupProviderOptions } from "./local-provider.js";
export {
  openRemoteBackupProvider,
  RemoteBackupProvider,
} from "./remote-provider.js";
export type { RemoteBackupProviderOptions } from "./remote-provider.js";

// Conformance kit (PROTOCOL.md § Conformance).
export { providerConformanceCases } from "./conformance.js";
export type { ConformanceCase, ConformanceHarness } from "./conformance.js";
