// Provider seam (PROTOCOL.md).
export { BackupProviderError, CODE_STATUS } from './provider.js';
export type {
  AccountStatus,
  BackupDiscovery,
  BackupProvider,
  BackupProviderErrorCode,
  BackupProviderErrorDetails,
  ProviderCapabilities,
  ProviderCapabilityFlag,
  Retention,
  S3Grant,
  SnapshotRegistration,
  SnapshotRow,
  StoreClass,
  StoreUsageReport,
  TargetInfo,
  Usage,
  UsageByStore,
} from './provider.js';

// Data plane.
export { assertSafeKey, FsObjectStore } from './object-store.js';
export type { ObjectStore } from './object-store.js';
export { S3ObjectStore } from './s3-store.js';
export type { S3ObjectStoreOptions } from './s3-store.js';

// Layer-1 generic grant path (PROTOCOL.md § Credential grant) — for a
// consumer (e.g. a `cas` store client) that wants a grant without pulling in
// the snapshot engine or `BackupProvider`.
export { requestCasGrant, requestStorageGrant } from './cas-grant.js';
export type { RequestCasGrantOptions, RequestStorageGrantOptions } from './cas-grant.js';

// Chunking (FORMAT.md § Chunking).
export { CHUNKER_PARAMS, chunkBuffer, chunkStream, findCut, GEAR } from './chunker.js';

// Crypto + keyring (FORMAT.md § Key custody, § Encryption).
export {
  activeMasterKey,
  chunkId,
  createKeyring,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  encrypt,
  loadKeyring,
  masterKeyForEpoch,
  rotateKeyring,
  saveKeyring,
} from './crypto.js';
export type { Keyring, KeyringEpoch } from './crypto.js';

// Manifest (FORMAT.md § Manifest).
export {
  canonicalJson,
  isSafeEntryPath,
  openManifest,
  sealManifest,
  sha256Hex,
  SNAPSHOT_FORMAT,
  verifyManifest,
} from './manifest.js';
export type {
  ManifestEntry,
  ManifestEntryKind,
  ManifestPublic,
  SealedPayload,
  StoredManifest,
} from './manifest.js';

// Engine (snapshot / restore / verify / recovery kit).
export { createSnapshot, restoreSnapshot, verifySnapshot, writeRecoveryKit } from './engine.js';
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
  WriteRecoveryKitOptions,
} from './engine.js';

// Providers.
export { LocalBackupProvider, openLocalBackupProvider } from './local-provider.js';
export type { LocalBackupProviderOptions } from './local-provider.js';
export { openRemoteBackupProvider, RemoteBackupProvider } from './remote-provider.js';
export type { RemoteBackupProviderOptions } from './remote-provider.js';

// Conformance kit (PROTOCOL.md § Conformance).
export { providerConformanceCases } from './conformance.js';
export type { ConformanceCase, ConformanceHarness } from './conformance.js';
