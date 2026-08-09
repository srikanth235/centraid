import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import type { ReplicaFetcher } from "@centraid/client/replica/native";

import { replicaStorageDirectory } from "../../../modules/centraid-storage";
import { authHeader, resolveGatewayBase } from "../gateway";
import { syncDueNotifications, syncNotifications } from "../notifications-core";
import { drainUploadQueueInBackground } from "../upload/boot";
import { nativeSyncAllowed } from "../upload/native-policy";
import { getActiveVaultLink, hydrateVaultLinks } from "../vault-links";
import { selectBackgroundScopes } from "./background-scopes";
import type { CachedBackgroundScope } from "./background-scopes";
import { borrowedChangeFeed } from "./borrowed-change-feed";
import { requireMobileOfflineGateway } from "./mobile-gateway-compatibility";
import { MultiVaultReplicaReader } from "./multi-vault-reader";
import type { MountedReplicaScope } from "./multi-vault-reader";
import { MultiVaultReplicaSession } from "./multi-vault-session";
import { NativeVaultChangeFeed } from "./native-change-feed";
import { nativeReplicaDigest, nativeReplicaIdFactory } from "./native-hash";
import { createNativeReplicaSession } from "./native-session";
import { MOBILE_REPLICA_BOOTSTRAP_WINDOW } from "./offline-budgets";
import {
  nativeReplicaDatabasePath,
  openMountedReplicaReaderDriver,
  openNativeReplicaDriver,
} from "./op-sqlite-driver";
import { postPlacement } from "./placement-transport";

const REPLICA_BACKGROUND_TASK = "centraid-replica-background-sync";
const REPLICA_PUSH_TASK = "centraid-replica-push-wake";

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

/** BGTaskScheduler (iOS) / WorkManager (Android) bounded pull. */
export async function runBackgroundReplicaSync(): Promise<void> {
  if (!(await nativeSyncAllowed())) return;
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  if (!active?.gatewayId || !active.vaultId) return;
  const baseUrl = await resolveGatewayBase().catch(() => undefined);
  if (!baseUrl) return;
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
  const sessions = new Map<
    string,
    Awaited<ReturnType<typeof createNativeReplicaSession>>
  >();
  const feeds: NativeVaultChangeFeed[] = [];
  let facade: MultiVaultReplicaSession | undefined;
  let looseReader: { close: () => void } | undefined;
  try {
    await Promise.all(
      selectedScopes.map(async (scope) => {
        const auth = {
          baseUrl,
          gatewayId: active.gatewayId,
          vaultId: scope.vaultId,
        };
        const driver = await openNativeReplicaDriver(
          { gatewayId: active.gatewayId, vaultId: scope.vaultId },
          nativeReplicaDigest,
          storageLocation
        );
        const feed = scope.borrowed
          ? borrowedChangeFeed()
          : new NativeVaultChangeFeed({
              gatewayAuth: auth,
              storage: AsyncStorage,
            });
        if (feed instanceof NativeVaultChangeFeed) feeds.push(feed);
        let session:
          | Awaited<ReturnType<typeof createNativeReplicaSession>>
          | undefined;
        try {
          session = await createNativeReplicaSession({
            gatewayAuth: auth,
            fetcher: fetcher(scope.vaultId),
            changeFeed: feed,
            driver,
            appState: {
              currentState: "background",
              addEventListener: () => ({ remove: () => undefined }),
            },
            isConnected: () => true,
            isNetworkWorkAllowed: nativeSyncAllowed,
            bootstrapWindow: MOBILE_REPLICA_BOOTSTRAP_WINDOW,
            ...(scope.borrowed
              ? { borrowedEdgeId: scope.borrowed.edgeId }
              : {}),
          });
          await session.pullNow();
          await session.flushIntents();
          if (!scope.borrowed) {
            await syncDueNotifications(baseUrl, scope.vaultId);
            await syncNotifications(baseUrl, scope.vaultId);
          }
          sessions.set(scope.vaultId, session);
        } catch (error) {
          if (session) await session.close();
          else driver.close();
          throw error;
        }
      })
    );
    const mounted = await Promise.all(
      selectedScopes.map(
        async (scope): Promise<MountedReplicaScope> => ({
          vaultId: scope.vaultId,
          label: scope.label ?? "Vault",
          // Absent means the gateway predates the ownership wire — fail
          // closed, exactly as the role-era default read as read-only.
          canWrite: scope.canWrite ?? false,
          ...(scope.borrowed ? { borrowed: scope.borrowed } : {}),
          databaseName: await nativeReplicaDatabasePath(
            { gatewayId: active.gatewayId, vaultId: scope.vaultId },
            nativeReplicaDigest,
            storageLocation
          ),
        })
      )
    );
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
      isConnected: () => true,
      isNetworkWorkAllowed: nativeSyncAllowed,
      sendPlacement: (input) => postPlacement(baseUrl, input),
    });
    looseReader = undefined;
    await facade.flushPlacements();
    await drainUploadQueueInBackground(facade);
  } finally {
    if (facade) await facade.close();
    else
      await Promise.all(
        [...sessions.values()].map((session) => session.close())
      );
    looseReader?.close();
    for (const feed of feeds) feed.setActive(false);
  }
}

TaskManager.defineTask(REPLICA_BACKGROUND_TASK, async () => {
  try {
    await runBackgroundReplicaSync();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// Data-only push contains no vault/item metadata: it is merely an earlier wake
// than the deferrable scheduler. Delivery is an optimization, never correctness.
TaskManager.defineTask(REPLICA_PUSH_TASK, async () => {
  try {
    await runBackgroundReplicaSync();
  } catch {
    // The OS scheduler and next foreground remain the retry path.
  }
});

/** Persisted OS registration; safe to call on every app boot. */
export async function registerReplicaBackgroundTasks(): Promise<void> {
  await BackgroundTask.registerTaskAsync(REPLICA_BACKGROUND_TASK, {
    minimumInterval: 15,
  }).catch(() => undefined);
  await Notifications.registerTaskAsync(REPLICA_PUSH_TASK).catch(
    () => undefined
  );
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
