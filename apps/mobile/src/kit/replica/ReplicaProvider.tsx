import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Network from "expo-network";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, InteractionManager } from "react-native";

import { replicaStorageDirectory } from "../../../modules/centraid-storage";
import { coalesceWork } from "../../lib/coalesce";
import type { CoalescedWork } from "../../lib/coalesce";
import { scheduleDailyBriefNotification } from "../../lib/daily-brief";
import { resolveGatewayBase } from "../../lib/gateway";
import {
  syncDueNotifications,
  syncNotifications,
} from "../../lib/notifications-core";
import { registerReplicaPushWake } from "../../lib/replica/background-sync";
import { requireMobileOfflineGateway } from "../../lib/replica/mobile-gateway-compatibility";
import { MobileGatewayCompatibilityError } from "../../lib/replica/mobile-gateway-compatibility-core";
import { NativeMultiplexChangeFeed } from "../../lib/replica/native-multiplex-change-feed";
import { createNativeReplicaSession } from "../../lib/replica/native-session";
import type { NativeReplicaSession } from "../../lib/replica/native-session";
import { isReplicaStorageFullError } from "../../lib/replica/replica-storage-error";
import { describeSyncError } from "../../lib/replica/seat-sync-error";
import { clearPinnedThumbnailPack } from "../../lib/replica/thumbnail-pack";
import type { ReplicaVaultScope } from "../../lib/replica/vault-source";
import {
  nativeRowSyncAllowed,
  nativeSyncAllowed,
} from "../../lib/upload/native-policy";
import {
  LAST_BASE,
  LAST_GATEWAY,
  LAST_VAULT,
  getActiveVaultLink,
  hydrateVaultLinks,
  subscribeVaultLinks,
} from "../../lib/vault-links";
import type { VaultLink } from "../../lib/vault-links";
import { Store } from "../../storage";
import { mountFailureValue } from "./mount-failure";
import { planMount } from "./mount-plan";
import {
  createBootstrapTracker,
  createFreshnessStore,
  createRevokedNoticeStore,
  REPLICA_LOADING,
} from "./replica-context";
import type {
  PublishReplicaValue,
  ReplicaContextValue,
} from "./replica-context";
import {
  deleteReplicaDatabaseFamily,
  discardRestoredReplicaCache,
  fetcher,
  loadFreshness,
  refreshCachedScopes,
  removeCachedScope,
  resolveIdentity,
  startCompatibilityWall,
  vaultScopes,
} from "./replica-mount";
import { openMountSeat } from "./replica-seat-mount";
import {
  attemptedReachability,
  loadRevokedNotices,
  settledReachability,
} from "./replica-status";

export { REPLICA_UNPAIRED_MESSAGE } from "./replica-mount";

export type { ReplicaReachability } from "./replica-status";
export type {
  ReplicaBootstrapProgress,
  ReplicaContextValue,
  ReplicaScopeFreshness,
} from "./replica-context";

const ReplicaContext = createContext<ReplicaContextValue>(REPLICA_LOADING);

/** Long enough for a wifi/cellular handoff to settle, short enough to feel live. */
const NETWORK_FLAP_WINDOW_MS = 1_500;

/**
 * Quiet window before a freshness stamp reaches AsyncStorage and the context.
 * Only the newest stamp matters and losing an unwritten one costs a replay,
 * not data, so a busy frame pays one disk write and one rebuild, not one per
 * advancing scope (matches native-change-feed.ts).
 */
const FRESHNESS_COMMIT_WINDOW_MS = 1_000;

/** RN's scheduler owns "the UI is usable now" — never substitute a timeout. */
function afterInteractions(): Promise<void> {
  return new Promise((resolve) => {
    InteractionManager.runAfterInteractions(() => resolve());
  });
}

export function ReplicaProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [active, setActive] = useState<VaultLink | undefined>();
  const activeRef = useRef<VaultLink | undefined>(undefined);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let unsubscribe = (): void => undefined;
    void hydrateVaultLinks().then(() => {
      const update = (): void => {
        const vault = getActiveVaultLink();
        activeRef.current = vault;
        setActive(vault);
      };
      update();
      setHydrated(true);
      unsubscribe = subscribeVaultLinks(update);
    });
    return () => unsubscribe();
  }, []);

  const gatewayKey = active?.gatewayId ?? (hydrated ? "unpaired" : "loading");
  const activeVaultId = active?.vaultId;
  /**
   * THE MOUNT IS KEYED ON THE VAULT, NOT JUST THE GATEWAY (#996 wave 3, R12).
   *
   * A seat opens ONE file, so switching vaults IS a remount — the previous
   * mount's handle closes and the next vault's opens. The provider used to key
   * on the gateway alone and re-plan only when the activated vault fell
   * outside the mounted four; there is no "inside the four" any more, and a
   * bare re-key of the write target would leave the Space just opened
   * unreadable until relaunch. Retracting the published session happens for
   * free: the key moves, `built` no longer matches, and consumers read
   * `ready: false` before any read can land on a closing session. Outboxes are
   * per-vault SQLite files, so no queued write is at risk in the swap.
   */
  const mountKey = `${gatewayKey}\u0000${activeVaultId ?? ""}`;
  const [retryNonce, setRetryNonce] = useState(0);
  const [built, setBuilt] = useState<{
    mountKey: string;
    value: ReplicaContextValue;
  }>();

  useEffect(() => {
    if (!hydrated || gatewayKey === "loading") return undefined;
    let cancelled = false;
    let session: NativeReplicaSession | undefined;
    let seat: { close: () => Promise<void> } | undefined;
    let multiplex: NativeMultiplexChangeFeed | undefined;
    let networkSubscription: { remove: () => void } | undefined;
    let reachabilityWork: CoalescedWork | undefined;
    let freshnessWork: CoalescedWork | undefined;
    let flushFreshness = async (): Promise<void> => undefined;
    // A seat opened but not yet owned by a session: torn down on cancel.
    const looseSeats: Array<{ close: () => Promise<void> }> = [];
    // Every mid-mount update goes through here: a torn-down mount publishes
    // nothing, and a mount whose gateway key has moved on never overwrites its
    // successor.
    const publish: PublishReplicaValue = (patch) => {
      if (cancelled) return;
      setBuilt((current) =>
        current?.mountKey === mountKey
          ? { mountKey, value: patch(current.value) }
          : current
      );
    };

    void (async () => {
      try {
        // Opening a replica per scope runs migrations synchronously — yield first.
        await afterInteractions();
        if (cancelled) return;
        // PHASE A decides what to open from disk alone (`planMount`): a device
        // holding a (gateway, vault) tuple opens that replica offline, with no
        // await on the network. `resolveIdentity` is for a fresh install only.
        // "unpaired" is a DISK fact, never a network verdict — keep it that way.
        const [cachedBase, lastGatewayId, lastVaultId] = await Promise.all([
          Store.hydrate(LAST_BASE, "http://127.0.0.1"),
          Store.hydrate(LAST_GATEWAY, ""),
          Store.hydrate(LAST_VAULT, ""),
        ]);
        const plan = planMount({
          link: activeRef.current,
          cachedBase,
          lastIdentity: { gatewayId: lastGatewayId, vaultId: lastVaultId },
        });
        const identity: Awaited<ReturnType<typeof resolveIdentity>> =
          plan.kind === "open"
            ? {
                auth: {
                  baseUrl: plan.baseUrl,
                  gatewayId: plan.gatewayId,
                  vaultId: plan.vaultId,
                },
                gatewayId: plan.gatewayId,
                online: false,
              }
            : await resolveIdentity(activeRef.current);
        if (cancelled) return;
        // Started beside the mount, never ahead of it — the function says why.
        const wall = startCompatibilityWall(identity);
        const storageLocation = replicaStorageDirectory();
        const scopes = await vaultScopes(identity, storageLocation);
        // THE ONE OPEN FILE. `resolveIdentity` and `planMount` have already
        // settled which vault this mount is for, and `vaultScopes` guarantees
        // it is in the list.
        const openScope = scopes.find(
          (scope) => scope.vaultId === identity.auth.vaultId
        )!;
        // BEFORE any stamp or cursor is read. A restored container carries the
        // previous device's resume cursors over an empty replica; resuming from
        // one loses every change beneath it, silently.
        await discardRestoredReplicaCache(identity.gatewayId, scopes);
        // At most ONCE per mount, from whichever moment first sees the gateway
        // reachable: gating on `identity.online` alone leaves a device that
        // mounted offline unregistered for push until it relaunches online.
        let sentEventualWork = false;
        const sendEventualWork = (baseUrl: string): void => {
          if (sentEventualWork) return;
          sentEventualWork = true;
          void afterInteractions().then(() => {
            if (cancelled) return;
            void registerReplicaPushWake(baseUrl);
            void scheduleDailyBriefNotification();
            for (const scope of scopes) {
              void syncDueNotifications(baseUrl, scope.vaultId);
              void syncNotifications(baseUrl, scope.vaultId);
            }
          });
        };
        if (identity.online) sendEventualWork(identity.auth.baseUrl);
        if (cancelled) return;
        let connected = identity.online;
        // Reports, never decides (docs/traps/unreachable-vault.md).
        const noteGatewayOutcome = (reachable: boolean): void => {
          if (cancelled || reachable === connected) return;
          reachabilityWork?.signal();
        };
        const revokedScopeIds = new Set<string>();
        const reclaimRevokedReplica = (scope: ReplicaVaultScope): void => {
          // THE OPEN SCOPE'S FILE IS DELETED BY ITS OWN PURGE (#996, W5).
          // `session.purge()` unlinks it through the seat, which closes the
          // handle first — a file cannot be replaced under an open SQLite
          // connection — so there is no second handle for this to reclaim.
          // A vault this seat is NOT holding open has no handle at all, so its
          // file is deletable outright — which is the whole reason one open
          // file is simpler than four: revocation of a closed vault is a file
          // deletion and nothing else.
          deleteReplicaDatabaseFamily(scope.databaseName);
        };
        const bootstrap = createBootstrapTracker(publish);
        const freshness = createFreshnessStore({
          storage: AsyncStorage,
          gatewayId: identity.gatewayId,
          initial: await loadFreshness(identity.gatewayId, scopes),
          publish,
        });
        freshnessWork = coalesceWork(
          freshness.commit,
          FRESHNESS_COMMIT_WINDOW_MS
        );
        const updateScopeFreshness = (vaultId: string): void => {
          freshness.stamp(vaultId);
          freshnessWork?.signal();
        };
        // Teardown is the last reliable moment to land a stamp, exactly as
        // backgrounding is for the feed's resume cursor.
        flushFreshness = freshness.commit;
        const revoked = createRevokedNoticeStore({
          storage: AsyncStorage,
          gatewayId: identity.gatewayId,
          initial: await loadRevokedNotices(AsyncStorage, identity.gatewayId),
          publish,
        });
        multiplex = new NativeMultiplexChangeFeed({
          gatewayAuth: {
            baseUrl: identity.auth.baseUrl,
            gatewayId: identity.gatewayId,
          },
          storage: AsyncStorage,
          onStreamOutcome: noteGatewayOutcome,
          onScopeUpdated: updateScopeFreshness,
          onScopeRevoked: (vaultId) => {
            revokedScopeIds.add(vaultId);
            void (async () => {
              try {
                const scope = scopes.find(
                  (candidate) => candidate.vaultId === vaultId
                );
                // Announce BEFORE the purge: the label is about to be erased
                // along with the rows, and a member told nothing is a vault
                // that vanished silently.
                if (scope) revoked.note(scope);
                // The purge closes the handle and unlinks the file, so a vault
                // this phone may never see again costs nothing on disk.
                if (vaultId === openScope.vaultId) await session?.purge();
                if (scope) reclaimRevokedReplica(scope);
              } finally {
                bootstrap.forget(vaultId);
                clearPinnedThumbnailPack(vaultId);
                freshness.forget(vaultId);
                await removeCachedScope(identity.gatewayId, vaultId).catch(
                  () => undefined
                );
                publish((value) => ({
                  ...value,
                  scopes: (value.scopes ?? []).filter(
                    (scope) => scope.vaultId !== vaultId
                  ),
                  bootstrapProgress: bootstrap.current(),
                }));
              }
            })().catch(() => undefined);
          },
        });
        // THE FILE BEFORE THE SESSION (#996, W5): the outbox is a table in it,
        // and a write made before the first bootstrap has to be durable.
        const openedSeat = await openMountSeat({
          gatewayId: identity.gatewayId,
          vaultId: openScope.vaultId,
          baseUrl: identity.auth.baseUrl,
          storageLocation,
        });
        if (!openedSeat) {
          // No durable directory, or a file that would not open: nothing
          // holds a copy or a queue, so there is no session either.
          //
          // `setBuilt`, NOT `publish` (#1011) — `publish` patches an entry for
          // this mount key that does not exist yet, so this branch announced
          // nothing and the provider kept `REPLICA_LOADING` for the life of
          // the app: a paired phone drawing skeletons, silently.
          setBuilt({
            mountKey,
            value: mountFailureValue({
              reachability: "device-offline",
              refresh: async () => setRetryNonce((current) => current + 1),
              error: "This phone has no storage for an offline copy.",
            }),
          });
          return;
        }
        looseSeats.push(openedSeat);
        session = await createNativeReplicaSession({
          seat: openedSeat,
          gatewayAuth: { ...identity.auth, vaultId: openScope.vaultId },
          fetcher: fetcher(openScope.vaultId),
          changeFeed: multiplex.scope(openScope.vaultId),
          // Every row this session hands back says which vault it came from
          // and whether the member may write there. One answer now, but it is
          // still the row's answer — eighteen screens ask it about a row.
          scope: {
            vaultId: openScope.vaultId,
            label: openScope.label,
            canWrite: openScope.canWrite,
          },
          appState: AppState,
          isConnected: () => connected,
          isNetworkWorkAllowed: nativeSyncAllowed,
          isRowSyncAllowed: nativeRowSyncAllowed,
          // A vault the member does not own is one a queued write may have to
          // wait for somebody at, so its pending rows carry the waiting-on
          // label from admission (`waiting-on.ts`). `personal` is the founding
          // marker; an older cache omits it and reads as their own, which is
          // the answer that promises nothing.
          ...(openScope.personal === false ? { origin: {} } : {}),
          onGatewayOutcome: noteGatewayOutcome,
          // Out of room parks this seat's feed; the phone, not the vault, is
          // what ran out.
          onStorageFull: () =>
            publish((value) => ({ ...value, storageFull: true })),
        });
        looseSeats.splice(looseSeats.indexOf(openedSeat), 1);
        seat = openedSeat;
        publish((value) => ({ ...value, seat: openedSeat }));
        if (revokedScopeIds.has(openScope.vaultId)) {
          await session.purge();
          reclaimRevokedReplica(openScope);
        }
        const liveScopes = scopes.filter(
          (scope) => !revokedScopeIds.has(scope.vaultId)
        );
        if (cancelled) {
          await session.close();
          return;
        }
        // Read now the local replica is open: it refuses a mount, never disk.
        const mounted = session;
        let features = await wall(() => mounted.close());
        // Durable coverage, read at mount and after every pull. Without it a
        // relaunch after a kill mid-backfill renders a truncated library with
        // nothing saying so: the in-process bootstrap that would have reported
        // pages died with the old process (docs/mobile-offline.md).
        const refreshCoverage = async (): Promise<void> => {
          // COVERAGE IS THE SEAT'S WATERMARK NOW (#996, W5). It was a shaped
          // store's per-scope `coverage` column, written by a windowed
          // bootstrap that could stop half-way. A seat's copy is a FILE: it is
          // either the one the gateway sent or it is not there, so "complete"
          // is "this file has arrived" and nothing else can be half-true.
          const watermark = session?.watermark();
          if (!watermark) return;
          const coverage = "complete" as const;
          publish((value) => ({
            ...value,
            coverage,
            // Only the open vault has a coverage answer at all. A closed
            // vault's file is whatever the last mount left it at, and
            // asserting a stale `complete` over it would be the one label a
            // truncated library must never carry.
            scopes: (value.scopes ?? []).map((scope) =>
              scope.vaultId === openScope.vaultId
                ? { ...scope, coverage }
                : scope
            ),
          }));
        };
        const refreshReachability = async (
          network: Network.NetworkState
        ): Promise<void> => {
          const deviceOnline = network.isConnected === true;
          const liveBase = deviceOnline
            ? await resolveGatewayBase().catch(() => undefined)
            : undefined;
          if (cancelled) return;
          connected = liveBase !== undefined;
          if (!liveBase)
            console.error(
              `[centraid] replica: no gateway base — device=${deviceOnline}`
            );
          if (liveBase) {
            Store.set(LAST_BASE, liveBase);
            multiplex?.updateGatewayBase(liveBase);
            session?.updateGatewayBase(liveBase);
            session?.notifyReachable();
            // THE WALL, RE-RAISED. The mount fails open offline, so this is the
            // one moment skew is provable: a gateway just answered. Incompatible
            // flips to the blocking disposition rather than pulling against a
            // contract this build cannot speak; the same answer settles the flags.
            try {
              features =
                (await requireMobileOfflineGateway({
                  baseUrl: liveBase,
                  online: true,
                })) ?? features;
            } catch (wallError) {
              if (wallError instanceof MobileGatewayCompatibilityError) {
                publish((value) => ({
                  ...value,
                  compatibility: wallError.disposition,
                }));
                return;
              }
              throw wallError;
            }
            // Phase A asks the gateway nothing, so only this pass notices a scope
            // granted since launch. Priming does not remount — `mountedScopes`
            // picks it up next mount.
            void refreshCachedScopes(identity.gatewayId, liveBase);
            // The other trigger: a device that mounted offline can only register
            // for push here.
            sendEventualWork(liveBase);
          }
          publish((value) => ({
            ...value,
            ...(liveBase ? { gatewayBase: liveBase } : {}),
            ...(features ? { features } : {}),
            online: value.online === true && connected,
            // The one pass that runs whatever the radio said: re-read the
            // pause so a resume from the storage screen clears the state.
            storageFull: session?.storageFull === true,
            reachability: attemptedReachability(
              deviceOnline,
              liveBase !== undefined,
              value.online === true
            ),
          }));
          if (liveBase) {
            const outcome = await session
              ?.pullForeground()
              .catch(() => undefined);
            // `syncing` above is set OPTIMISTICALLY, so every pass reaching here
            // MUST settle: an unconditional settle is what stops a pull that
            // never lands from pinning "Syncing recent changes…" on screen.
            //
            // A pull the transfer rules refused is NOT a landed pull: reading
            // the refusal as freshness paints a settled, silent `current` over
            // data that was never fetched.
            const policyBlocked = outcome?.policyBlocked === true;
            const landed = outcome?.landed === true;
            // THE PULL'S VERDICT IS NOT THE SESSION'S CONNECTIVITY ORACLE
            // (#1011). `connected` gates whether the session may TRY, and it
            // was overwritten with whether the last try SUCCEEDED: one
            // transient failure latched it false, only a radio event raises it
            // again, and the phone stopped asking for log pages at all — an
            // empty library over a full vault, for the life of the mount. The
            // `/info` answer in this same pass is what earns "reachable"
            // (docs/traps/unreachable-vault.md); the pull's verdict still
            // settles what the member is SHOWN, below.
            connected = liveBase !== undefined;
            if (!landed)
              console.error(
                `[centraid] replica: pull did not land — blocked=${policyBlocked}` +
                  (session?.lastSyncError === undefined
                    ? ""
                    : `, reason=${describeSyncError(session.lastSyncError)}`)
              );
            if (landed) updateScopeFreshness(openScope.vaultId);
            await refreshCoverage();
            publish((value) => ({
              ...value,
              // The gateway answered `/info`; the rules, not the radio,
              // stopped the pull, so connectivity stands.
              online: policyBlocked ? connected : landed,
              reachability: settledReachability(landed, policyBlocked),
            }));
          }
        };
        const refresh = async (): Promise<void> => {
          await refreshReachability(await Network.getNetworkStateAsync());
        };
        setBuilt({
          mountKey,
          value: {
            session,
            // THE SEAT TRAVELS IN THIS OBJECT, not in a `publish` before it.
            // `publish` patches an EXISTING entry for this mount key, so every
            // call made before this first `setBuilt` is a no-op — the seat
            // published at open was dropped, `replica.seat?.page` stayed
            // undefined, and `useSeatRead` reads that as no session at all:
            // every app screen drew "not connected" and every Home tile read 0
            // over a fully bootstrapped copy.
            seat: openedSeat,
            gatewayBase: identity.auth.baseUrl,
            vaultId: activeRef.current?.vaultId ?? identity.auth.vaultId,
            scopes: liveScopes.map((scope) => ({
              ...scope,
              ...(freshness.get(scope.vaultId)
                ? { updatedAt: freshness.get(scope.vaultId) }
                : {}),
            })),
            bootstrapProgress: bootstrap.current(),
            ...(revoked.current().length > 0
              ? { revokedNotices: revoked.current() }
              : {}),
            dismissRevokedNotice: revoked.forget,
            ready: true,
            ...(features ? { features } : {}),
            online: connected,
            // `device-offline`, not `gateway-asleep`: phase A has read only disk,
            // so no verdict about the gateway exists yet. `gateway-asleep` here
            // flashes a red "Wake help" row on every cold start; silence wins.
            reachability: connected ? "current" : "device-offline",
            refresh,
          },
        });
        // A handoff emits several states in a row and only the settled one is
        // actionable, so they collapse into one pass. Manual refresh stays direct.
        let latestNetwork: Network.NetworkState | undefined;
        reachabilityWork = coalesceWork(async () => {
          const network =
            latestNetwork ?? (await Network.getNetworkStateAsync());
          await refreshReachability(network);
        }, NETWORK_FLAP_WINDOW_MS);
        networkSubscription = Network.addNetworkStateListener((network) => {
          latestNetwork = network;
          reachabilityWork?.signal();
        });
        void refreshCoverage();
        void afterInteractions().then(() => {
          if (!cancelled) void refresh();
        });
      } catch (error) {
        if (!cancelled) {
          const compatibility =
            error instanceof MobileGatewayCompatibilityError
              ? error.disposition
              : undefined;
          setBuilt({
            mountKey,
            value: {
              ...mountFailureValue({
                reachability: "gateway-asleep",
                refresh: async () => setRetryNonce((current) => current + 1),
                error: error instanceof Error ? error.message : String(error),
              }),
              ...(compatibility ? { compatibility } : {}),
              ...(isReplicaStorageFullError(error)
                ? { storageFull: true }
                : {}),
            },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      reachabilityWork?.cancel();
      freshnessWork?.cancel();
      // Cancel drops the timer, not the stamps: land them before the mount goes.
      void flushFreshness();
      networkSubscription?.remove();
      void session?.close();
      void seat?.close().catch(() => undefined);
      multiplex?.close();
      for (const held of looseSeats) void held.close().catch(() => undefined);
    };
  }, [mountKey, gatewayKey, hydrated, retryNonce]);

  const base = built?.mountKey === mountKey ? built.value : REPLICA_LOADING;
  const value = {
    ...base,
    ...(active?.vaultId ? { vaultId: active.vaultId } : {}),
  };
  return (
    <ReplicaContext.Provider value={value}>{children}</ReplicaContext.Provider>
  );
}

export function useReplica(): ReplicaContextValue {
  return useContext(ReplicaContext);
}
