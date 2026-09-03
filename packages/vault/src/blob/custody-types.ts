import type { RemoteBlobTransfer } from "./remote-transfer.js";
import type { ReplicaStore } from "./replica-index.js";
import type { BlobStore } from "./store.js";

export type CustodyState =
  | "pending-offsite"
  | "local-only"
  | "replicated"
  | "remote-only"
  | "missing";

export interface RemoteTier {
  store: BlobStore;
  derivedStore?: BlobStore;
  transfer?: RemoteBlobTransfer;
  storageClassFor?: (
    sha256: string,
    storeClass: ReplicaStore,
    originalHint?: { mediaType: string; byteSize: number }
  ) => string | undefined;
  encryptKey?: Buffer;
  keyFor?: (sha256: string) => Buffer;
  frameSize?: number;
  streamThresholdBytes?: number;
}

export function remoteEncryptionKey(
  remote: RemoteTier,
  sha256: string
): Buffer | undefined {
  return remote.keyFor?.(sha256) ?? remote.encryptKey;
}

export function storeForClass(
  remote: RemoteTier,
  store: "cas" | "derived"
): BlobStore {
  return store === "derived" && remote.derivedStore
    ? remote.derivedStore
    : remote.store;
}

export interface ReconcileResult {
  orphansDeleted: string[];
  replicated: string[];
  missing: string[];
  orphansSkipped: string[];
  orphansGraceHeld: string[];
}

export interface ReconcileOptions {
  skipOrphanDelete?: boolean;
  extraLiveRoots?: ReadonlySet<string>;
  graceWindowMs?: number;
  now?: () => number;
}

export interface BlobSweepStatus {
  lastCompletedAt: string | null;
  lastAttemptedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}
