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
  vaultId?: string;
  scopes?: readonly ReplicaScopeFreshness[];
  ready: boolean;
  online: boolean;
  reachability?: ReplicaReachability;
  coverage?: ReplicaCoverage;
  bootstrapProgress?: readonly ReplicaBootstrapProgress[];
  revokedNotices?: readonly ReplicaRevokedNotice[];
  dismissRevokedNotice?: (vaultId: string) => void;
  refresh?: () => Promise<void>;
  compatibility?: MobileCompatibilityDisposition;
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

export type PublishReplicaValue = (
  patch: (value: ReplicaContextValue) => ReplicaContextValue
) => void;

export interface ReplicaFreshnessStore {
  get: (vaultId: string) => string | undefined;
  stamp: (vaultId: string) => void;
  forget: (vaultId: string) => void;
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
  note: (scope: { vaultId: string; label: string }) => void;
  forget: (vaultId: string) => void;
  current: () => readonly ReplicaRevokedNotice[];
}

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
