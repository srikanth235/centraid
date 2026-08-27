// What `useReplica()` publishes, and the three small stores that keep it true.
//
// The provider owns one long mount: opening drivers, raising the compatibility
// wall, wiring the multiplex feed. The bookkeeping AROUND that mount — which
// source was last stamped fresh, which revoked scope still owes the member an
// explanation, how far each bootstrap has walked — is not part of opening
// anything, and it is what made the provider unreadable. It lives here, with
// storage injected rather than imported, so each store is a plain object a test
// can drive.

import type { ReplicaCoverage } from "@centraid/client/replica/native";

import type {
  MobileCompatibilityDisposition,
  MobileGatewayFeatures,
} from "../../lib/replica/mobile-gateway-compatibility-core";
import type { MountedReplicaScope } from "../../lib/replica/multi-vault-reader";
import type { MultiVaultReplicaSession } from "../../lib/replica/multi-vault-session";
import type { AsyncStorageLike } from "../../lib/replica/native-change-feed";
import { freshnessKey } from "./replica-mount";
import { dismissRevokedNotice, recordRevokedNotice } from "./replica-status";
import type {
  ReplicaReachability,
  ReplicaRevokedNotice,
} from "./replica-status";

export interface ReplicaScopeFreshness extends MountedReplicaScope {
  updatedAt?: string;
  /** Durable per-source coverage; `partial` survives a kill mid-backfill. */
  coverage?: ReplicaCoverage;
}

export interface ReplicaBootstrapProgress {
  vaultId: string;
  vaultLabel: string;
  phase: "first-page" | "backfill";
  pages: number;
}

export interface ReplicaContextValue {
  session?: MultiVaultReplicaSession;
  gatewayBase?: string;
  /** Visible VaultLink filter / default write target; not a session identity. */
  vaultId?: string;
  scopes?: readonly ReplicaScopeFreshness[];
  ready: boolean;
  online: boolean;
  reachability?: ReplicaReachability;
  /** Conservative aggregate over the mounted sources: one partial keeps it
   *  partial. Read from durable status, so a library truncated by a kill
   *  mid-backfill is still labelled partial after an offline relaunch. */
  coverage?: ReplicaCoverage;
  bootstrapProgress?: readonly ReplicaBootstrapProgress[];
  /** Scopes revoked while this phone held them, until the member dismisses. */
  revokedNotices?: readonly ReplicaRevokedNotice[];
  dismissRevokedNotice?: (vaultId: string) => void;
  refresh?: () => Promise<void>;
  /** C1(b) is a blocking wall: no route-specific degraded modes on skew. */
  compatibility?: MobileCompatibilityDisposition;
  /** `undefined` is UNKNOWN, not off — a gated surface stays visible until a
   *  gateway answers. */
  features?: MobileGatewayFeatures;
  error?: string;
  /** The `out of room` state (#708): the driver hit SQLITE_FULL/ENOSPC. */
  storageFull?: boolean;
}

export const REPLICA_LOADING: ReplicaContextValue = {
  scopes: [],
  ready: false,
  online: false,
  reachability: "device-offline",
};

/** Merge a patch into the published value, if this mount still owns it. */
export type PublishReplicaValue = (
  patch: (value: ReplicaContextValue) => ReplicaContextValue
) => void;

/** Per-source freshness: the in-memory truth, and the durable stamps behind it. */
export interface ReplicaFreshnessStore {
  get: (vaultId: string) => string | undefined;
  /** This source just pulled; stamp it and schedule the write. */
  stamp: (vaultId: string) => void;
  forget: (vaultId: string) => void;
  /** Land every stamp taken since the last commit. */
  commit: () => Promise<void>;
}

/**
 * One frame can advance every mounted scope, so stamps accumulate and land
 * together: a thousand-change frame costs one write per scope and one context
 * rebuild, not one of each per change. Losing an uncommitted stamp costs a
 * replay, never data — which is why the debounce is safe at all.
 */
export function createFreshnessStore(input: {
  storage: AsyncStorageLike;
  gatewayId: string;
  initial: Map<string, string>;
  publish: PublishReplicaValue;
}): ReplicaFreshnessStore {
  const freshness = input.initial;
  const pending = new Map<string, string>();
  return {
    get: (vaultId) => freshness.get(vaultId),
    forget: (vaultId) => {
      freshness.delete(vaultId);
      pending.delete(vaultId);
    },
    stamp: (vaultId) => {
      const updatedAt = new Date().toISOString();
      freshness.set(vaultId, updatedAt);
      pending.set(vaultId, updatedAt);
    },
    commit: async () => {
      if (pending.size === 0) return;
      const landed = [...pending];
      pending.clear();
      await Promise.all(
        landed.map(([vaultId, updatedAt]) =>
          input.storage
            .setItem(freshnessKey(input.gatewayId, vaultId), updatedAt)
            .catch(() => undefined)
        )
      );
      input.publish((value) => ({
        ...value,
        scopes: (value.scopes ?? []).map((scope) => {
          const updatedAt = landed.find(
            ([vaultId]) => vaultId === scope.vaultId
          )?.[1];
          return updatedAt ? { ...scope, updatedAt } : scope;
        }),
      }));
    },
  };
}

export interface ReplicaRevokedNoticeStore {
  /** A scope is about to be purged; record the trace while the label exists. */
  note: (scope: { vaultId: string; label: string }) => void;
  forget: (vaultId: string) => void;
  current: () => readonly ReplicaRevokedNotice[];
}

/**
 * Purging a revoked scope is silent by construction — rows, cursor and mount
 * all go — so the notice is written BEFORE the purge and outlives the process:
 * the relaunch after a purge is exactly when a member asks what happened.
 */
export function createRevokedNoticeStore(input: {
  storage: AsyncStorageLike;
  gatewayId: string;
  initial: readonly ReplicaRevokedNotice[];
  publish: PublishReplicaValue;
}): ReplicaRevokedNoticeStore {
  let notices: readonly ReplicaRevokedNotice[] = [...input.initial];
  const settle = (next: readonly ReplicaRevokedNotice[]): void => {
    notices = [...next];
    input.publish((value) => ({ ...value, revokedNotices: notices }));
  };
  return {
    current: () => notices,
    note: (scope) => {
      void recordRevokedNotice(input.storage, input.gatewayId, {
        vaultId: scope.vaultId,
        label: scope.label,
        at: new Date().toISOString(),
      }).then(settle, () => undefined);
    },
    forget: (vaultId) => {
      void dismissRevokedNotice(input.storage, input.gatewayId, vaultId).then(
        settle,
        () => undefined
      );
    },
  };
}

export interface ReplicaBootstrapTracker {
  report: (
    scope: MountedReplicaScope,
    progress: { phase: "first-page" | "backfill" | "complete"; pages: number }
  ) => void;
  forget: (vaultId: string) => void;
  current: () => ReplicaBootstrapProgress[];
}

/** Live bootstrap progress per scope; `complete` retires the row. */
export function createBootstrapTracker(
  publish: PublishReplicaValue
): ReplicaBootstrapTracker {
  const progress = new Map<string, ReplicaBootstrapProgress>();
  return {
    current: () => [...progress.values()],
    forget: (vaultId) => {
      progress.delete(vaultId);
    },
    report: (scope, next) => {
      if (next.phase === "complete") progress.delete(scope.vaultId);
      else
        progress.set(scope.vaultId, {
          vaultId: scope.vaultId,
          vaultLabel: scope.label,
          phase: next.phase,
          pages: next.pages,
        });
      publish((value) => ({
        ...value,
        bootstrapProgress: [...progress.values()],
      }));
    },
  };
}
