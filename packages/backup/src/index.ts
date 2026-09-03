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

export { assertSafeKey, FsObjectStore } from "./object-store.js";
export type { ObjectListEntry, ObjectStore } from "./object-store.js";
export { S3ObjectStore } from "./s3-store.js";
export type { S3ObjectStoreOptions } from "./s3-store.js";

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

export { PART_BYTES, partBuffer, partStream } from "./parts.js";

export {
  ALGO_DEFLATE,
  ALGO_STORE,
  ALGO_ZSTD,
  frameChunkPayload,
  unframeChunkPayload,
  zstdAvailable,
} from "./compress.js";

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

export {
  PASSWORD_WRAP_SCRYPT,
  unwrapPasswordDocument,
  wrapPasswordDocument,
} from "./password-wrap.js";
export type { WrappedPasswordDocument } from "./password-wrap.js";

export { materializeSnapshotBlobs } from "./materialize.js";
export type {
  MaterializeSnapshotBlobsOptions,
  MaterializeSnapshotBlobsResult,
} from "./materialize.js";

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

export { providerConformanceCases } from "./conformance.js";
export type { ConformanceCase, ConformanceHarness } from "./conformance.js";
