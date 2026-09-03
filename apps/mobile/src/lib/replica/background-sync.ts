import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundTask from "expo-background-task";
import * as Network from "expo-network";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import type { ReplicaFetcher } from "@centraid/client/replica/native";

import { replicaStorageDirectory } from "../../../modules/centraid-storage";
import { deleteReplicaDatabaseFamily } from "../../kit/replica/replica-mount";
import { authHeader, resolveGatewayBase } from "../gateway";
import { syncDueNotifications, syncNotifications } from "../notifications-core";
import { drainUploadQueueInBackground } from "../upload/boot";
import { nativeSyncAllowed } from "../upload/native-policy";
import { getActiveVaultLink, hydrateVaultLinks } from "../vault-links";
import { selectBackgroundScopes } from "./background-scopes";
import type { CachedBackgroundScope } from "./background-scopes";
import { requireMobileOfflineGateway } from "./mobile-gateway-compatibility";
import { MultiVaultReplicaReader } from "./multi-vault-reader";
import type { MountedReplicaScope } from "./multi-vault-reader";
import { MultiVaultReplicaSession } from "./multi-vault-session";
import { NativeVaultChangeFeed } from "./native-change-feed";
import { nativeReplicaDigest, nativeReplicaIdFactory } from "./native-hash";
import { createNativeReplicaSession } from "./native-session";
import { flushNativeTraces } from "./native-trace";
import { MOBILE_REPLICA_BOOTSTRAP_WINDOW } from "./offline-budgets";
import {
  nativeReplicaDatabasePath,
  openMountedReplicaReaderDriver,
  openNativeReplicaDriver,
} from "./op-sqlite-driver";
import { postPlacement } from "./placement-transport";

const REPLICA_BACKGROUND_TASK = "centraid-replica-background-sync";
const REPLICA_PUSH_TASK = "centraid-replica-push-wake";
const REGISTRATION_STATUS_KEY = "centraid:replica-background-registration";

/**
 * Wall-clock budget for one background pass.
 *
 * iOS gives a `BGAppRefreshTask` on the order of 30 seconds before it expires
 * the task and suspends the process; WorkManager is far more generous, so the
 * tighter platform sets the number. 20 seconds leaves roughly ten for closing
 * sessions, flushing cursors and detaching feeds — the work that must not be
 * cut in half. Stopping early is safe by construction: every queue this pass
 * touches is durable, and the next wake or the next foreground pull resumes
 * exactly where this stopped (docs/mobile-offline.md, "Background work").
 */
const BACKGROUND_PASS_BUDGET_MS = 20_000;

/** Remaining-budget view of one background pass; also the OS expiration hook. */
export interface BackgroundPassDeadline {
  remainingMs: () => number;
  expired: () => boolean;
  /** The platform says time is up NOW (iOS `addExpirationListener`). */
  expire: () => void;
}

export function backgroundPassDeadline(
  budgetMs: number = BACKGROUND_PASS_BUDGET_MS,
  now: () => number = Date.now
): BackgroundPassDeadline {
  const startedAt = now();
  let expiredEarly = false;
  const remainingMs = () =>
    expiredEarly ? 0 : Math.max(0, budgetMs - (now() - startedAt));
  return {
    remainingMs,
    expired: () => remainingMs() <= 0,
    expire: () => {
      expiredEarly = true;
    },
  };
}

/** What one pass actually managed, for the task result and for tests. */
export interface BackgroundSyncOutcome {
  /** Scopes selected for this pass. */
  scopes: number;
  /** Scopes whose pull, intent flush and notification sync all completed. */
  synced: number;
  /** Per-scope failures; one bad scope never cancels the others. */
  failures: Array<{ vaultId: string; reason: string }>;
  /** A stage was skipped because the pass ran out of budget. */
  timedOut: boolean;
}

export interface RunBackgroundReplicaSyncOptions {
  deadline?: BackgroundPassDeadline;
}

/** Registration outcome the settings/status surface can read back. */
export interface ReplicaBackgroundRegistrationStatus {
  at: string;
  backgroundTask: { registered: boolean; reason?: string };
  pushTask: { registered: boolean; reason?: string };
  /** expo-background-task's own verdict; `restricted` means Background App Refresh is off. */
  availability: "available" | "restricted" | "unknown";
}

function fetcher(vaultId: string): ReplicaFetcher {
  return async (baseUrl, pathname, init) => {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authHeader()))
      headers.set(key, value);
    headers.set("x-centraid-vault", vaultId);
    return fetch(new URL(pathname, `${baseUrl}/`), {
      ...init,
      headers,
    } as RequestInit);
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The same reachability primitive the foreground uses (`ReplicaProvider`'s
 * `refreshReachability`): the device radio plus a resolvable gateway base. A
 * headless pass has no provider listening for network changes, so it samples
 * once per stage instead of once per event — hardcoding `true` made every
 * queued write look sendable to a session with no radio behind it.
 */
async function deviceOnline(): Promise<boolean> {
  try {
    return (await Network.getNetworkStateAsync()).isConnected === true;
  } catch {
    // A platform that cannot answer is treated as offline: the durable queues
    // lose nothing by waiting for the next wake.
    return false;
  }
}

/** BGTaskScheduler (iOS) / WorkManager (Android) bounded pull. */
export async function runBackgroundReplicaSync(
  options: RunBackgroundReplicaSyncOptions = {}
): Promise<BackgroundSyncOutcome> {
  const deadline = options.deadline ?? backgroundPassDeadline();
  const outcome: BackgroundSyncOutcome = {
    scopes: 0,
    synced: 0,
    failures: [],
    timedOut: false,
  };
  if (!(await nativeSyncAllowed())) return outcome;
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  if (!active?.gatewayId || !active.vaultId) return outcome;
  const baseUrl = await resolveGatewayBase().catch(() => undefined);
  if (!baseUrl) return outcome;
  await requireMobileOfflineGateway({
    baseUrl,
    online: true,
  });
  const storageLocation = replicaStorageDirectory();
  let scopes: CachedBackgroundScope[] = [];
  try {
    const raw = await AsyncStorage.getItem(
      `centraid:replica-scopes:${active.gatewayId}`
    );
    if (raw) scopes = JSON.parse(raw) as CachedBackgroundScope[];
  } catch {
    // Active scope below remains enough for a bounded recovery pass.
  }
  const selectedScopes = selectBackgroundScopes(scopes, active.vaultId);
  outcome.scopes = selectedScopes.length;
  // Resolving the base above proved the gateway answered; the radio is the
  // other half, and both are re-sampled at the placement/upload boundary.
  let connected = await deviceOnline();
  const sessions = new Map<
    string,
    Awaited<ReturnType<typeof createNativeReplicaSession>>
  >();
  const feeds: NativeVaultChangeFeed[] = [];
  // Kept per vault for the same reason the provider keeps them: a revoked
  // scope's file cannot be deleted while its handle is open, and `purge()`
  // deliberately leaves that handle alive.
  const scopeDrivers = new Map<string, { close: () => void }>();
  let facade: MultiVaultReplicaSession | undefined;
  let looseReader: { close: () => void } | undefined;
  try {
    // Per-scope isolation, not `Promise.all` (#880): one vault whose bootstrap
    // or pull throws used to reject the whole pass, so placements and uploads
    // never drained for ANY vault. Each scope now settles on its own.
    await Promise.all(
      selectedScopes.map(async (scope) => {
        if (deadline.expired()) {
          outcome.timedOut = true;
          return;
        }
        const auth = {
          baseUrl,
          gatewayId: active.gatewayId,
          vaultId: scope.vaultId,
        };
        let feed: NativeVaultChangeFeed | undefined;
        let session:
          | Awaited<ReturnType<typeof createNativeReplicaSession>>
          | undefined;
        let driver:
          | Awaited<ReturnType<typeof openNativeReplicaDriver>>
          | undefined;
        try {
          driver = await openNativeReplicaDriver(
            { gatewayId: active.gatewayId, vaultId: scope.vaultId },
            nativeReplicaDigest,
            storageLocation
          );
          feed = new NativeVaultChangeFeed({
            gatewayAuth: auth,
            storage: AsyncStorage,
          });
          feeds.push(feed);
          session = await createNativeReplicaSession({
            gatewayAuth: auth,
            fetcher: fetcher(scope.vaultId),
            changeFeed: feed,
            driver,
            appState: {
              currentState: "background",
              addEventListener: () => ({ remove: () => undefined }),
            },
            isConnected: () => connected,
            isNetworkWorkAllowed: nativeSyncAllowed,
            bootstrapWindow: MOBILE_REPLICA_BOOTSTRAP_WINDOW,
          });
          sessions.set(scope.vaultId, session);
          scopeDrivers.set(scope.vaultId, driver);
          await session.pullNow();
          await session.flushIntents();
          if (deadline.expired()) {
            outcome.timedOut = true;
            return;
          }
          await syncDueNotifications(baseUrl, scope.vaultId);
          await syncNotifications(baseUrl, scope.vaultId);
          outcome.synced += 1;
        } catch (error) {
          outcome.failures.push({
            vaultId: scope.vaultId,
            reason: reason(error),
          });
          if (session) {
            sessions.delete(scope.vaultId);
            scopeDrivers.delete(scope.vaultId);
            await session.close();
          } else driver?.close();
        }
      })
    );
    // Only scopes whose session opened are mountable; a failed one has no
    // database this pass may attach.
    const mounted = await Promise.all(
      selectedScopes
        .filter((scope) => sessions.has(scope.vaultId))
        .map(
          async (scope): Promise<MountedReplicaScope> => ({
            vaultId: scope.vaultId,
            label: scope.label ?? "Vault",
            // Absent means the gateway predates the ownership wire — fail
            // closed, exactly as the role-era default read as read-only.
            canWrite: scope.canWrite ?? false,
            databaseName: await nativeReplicaDatabasePath(
              { gatewayId: active.gatewayId, vaultId: scope.vaultId },
              nativeReplicaDigest,
              storageLocation
            ),
          })
        )
    );
    if (mounted.length === 0) return outcome;
    connected = await deviceOnline();
    const readerDriver = await openMountedReplicaReaderDriver(
      active.gatewayId,
      nativeReplicaDigest,
      storageLocation
    );
    looseReader = readerDriver;
    facade = new MultiVaultReplicaSession({
      reader: new MultiVaultReplicaReader(readerDriver, mounted),
      sessions,
      scopes: mounted,
      focusedVaultId: () => active.vaultId,
      createId: nativeReplicaIdFactory,
      isConnected: () => connected,
      isNetworkWorkAllowed: nativeSyncAllowed,
      sendPlacement: (input) => postPlacement(baseUrl, input),
      // Parity with the foreground mount (ReplicaProvider): a revoked frame
      // arriving mid-pass purges the scope's rows and leaves a full-size file
      // behind unless the handle is closed and the family deleted. Headless,
      // the driver map IS the handle registry, so reclaiming is those two
      // steps and nothing more.
      reclaimRevokedReplica: (scope) => {
        try {
          scopeDrivers.get(scope.vaultId)?.close();
        } catch {
          // A handle the purge already tore down is one less thing to close.
        }
        scopeDrivers.delete(scope.vaultId);
        deleteReplicaDatabaseFamily(scope.databaseName);
      },
    });
    looseReader = undefined;
    // The device outboxes drain even when a scope above failed: their rows are
    // durable and target their own vault.
    if (deadline.expired()) {
      outcome.timedOut = true;
      return outcome;
    }
    await facade.flushPlacements();
    if (deadline.expired()) {
      outcome.timedOut = true;
      return outcome;
    }
    await drainUploadQueueInBackground(facade);
    return outcome;
  } finally {
    if (facade) await facade.close();
    else
      await Promise.all(
        [...sessions.values()].map((session) => session.close())
      );
    looseReader?.close();
    for (const feed of feeds) feed.setActive(false);
    // #927 OQ1: the phone buffers spans in memory and writes them HERE — the
    // background pass is the one moment disk I/O costs the owner nothing. In
    // the `finally` so a pass that timed out or threw still lands what it
    // recorded; `flushNativeTraces` swallows its own failures, and with
    // tracing off (the default) the ring is empty and this is a no-op.
    await flushNativeTraces();
  }
}

/**
 * `Success`/`Failed` is the whole vocabulary expo-background-task offers — it
 * has no distinct "expired" result — so a pass that ran out of budget with
 * durable progress behind it reports Success, and only a pass where every
 * selected scope failed reports Failed.
 */
function backgroundTaskResult(
  outcome: BackgroundSyncOutcome
): BackgroundTask.BackgroundTaskResult {
  return outcome.failures.length > 0 && outcome.synced === 0
    ? BackgroundTask.BackgroundTaskResult.Failed
    : BackgroundTask.BackgroundTaskResult.Success;
}

TaskManager.defineTask(REPLICA_BACKGROUND_TASK, async () => {
  const deadline = backgroundPassDeadline();
  // iOS hands over its own expiration warning; honoring it stops the next stage
  // instead of being killed inside one.
  const expiration = BackgroundTask.addExpirationListener(() =>
    deadline.expire()
  );
  try {
    return backgroundTaskResult(await runBackgroundReplicaSync({ deadline }));
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    expiration.remove();
  }
});

// Data-only push contains no vault/item metadata: it is merely an earlier wake
// than the deferrable scheduler. Delivery is an optimization, never correctness.
TaskManager.defineTask(REPLICA_PUSH_TASK, async () => {
  const deadline = backgroundPassDeadline();
  try {
    await runBackgroundReplicaSync({ deadline });
  } catch {
    // The OS scheduler and next foreground remain the retry path.
  }
});

/**
 * Persisted OS registration; safe to call on every app boot. The outcome is
 * recorded durably because a refused registration is otherwise invisible:
 * Background App Refresh turned off in Settings looks exactly like a phone that
 * simply has not been woken yet.
 */
export async function registerReplicaBackgroundTasks(): Promise<ReplicaBackgroundRegistrationStatus> {
  const status: ReplicaBackgroundRegistrationStatus = {
    at: new Date().toISOString(),
    backgroundTask: { registered: true },
    pushTask: { registered: true },
    availability: "unknown",
  };
  try {
    await BackgroundTask.registerTaskAsync(REPLICA_BACKGROUND_TASK, {
      minimumInterval: 15,
    });
  } catch (error) {
    status.backgroundTask = { registered: false, reason: reason(error) };
  }
  try {
    await Notifications.registerTaskAsync(REPLICA_PUSH_TASK);
  } catch (error) {
    status.pushTask = { registered: false, reason: reason(error) };
  }
  try {
    status.availability =
      (await BackgroundTask.getStatusAsync()) ===
      BackgroundTask.BackgroundTaskStatus.Restricted
        ? "restricted"
        : "available";
  } catch {
    // Leave `unknown`: an unavailable status API is not a refused registration.
  }
  await AsyncStorage.setItem(
    REGISTRATION_STATUS_KEY,
    JSON.stringify(status)
  ).catch(() => undefined);
  return status;
}

/** Last recorded registration outcome, for a status/settings surface to render. */
export async function getReplicaBackgroundRegistrationStatus(): Promise<
  ReplicaBackgroundRegistrationStatus | undefined
> {
  try {
    const raw = await AsyncStorage.getItem(REGISTRATION_STATUS_KEY);
    return raw
      ? (JSON.parse(raw) as ReplicaBackgroundRegistrationStatus)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Register a data-only wake token only when notification consent already exists. */
export async function registerReplicaPushWake(baseUrl: string): Promise<void> {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  const token = await Notifications.getExpoPushTokenAsync().catch(
    () => undefined
  );
  if (!token?.data) return;
  await fetch(new URL("/centraid/_gateway/push/registrations", baseUrl), {
    method: "POST",
    headers: {
      ...authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      token: token.data,
      platform: Platform.OS === "ios" ? "ios" : "android",
    }),
  }).catch(() => undefined);
}
