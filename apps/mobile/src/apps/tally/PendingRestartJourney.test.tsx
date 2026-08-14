// @vitest-environment jsdom
import path from "node:path";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { ReplicaProvider } from "../../kit/replica/ReplicaProvider";
import type { NativeChangeFeed } from "../../lib/replica/native-session";
import { createNativeReplicaSession } from "../../lib/replica/native-session";
import { NodeSqliteDriver } from "../../lib/replica/node-sqlite-driver";
import TallyHome from "./TallyHome";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const journey = vi.hoisted(() => ({
  mountedFile: "",
  replicaFile: "",
  storage: new Map<string, string>(),
  openMountedDriver: undefined as (() => unknown) | undefined,
  openReplicaDriver: undefined as (() => unknown) | undefined,
}));

vi.mock(
  import("@react-native-async-storage/async-storage"),
  () =>
    ({
      default: {
        getItem: (key: string) =>
          Promise.resolve(journey.storage.get(key) ?? null),
        removeItem: (key: string) => {
          journey.storage.delete(key);
          return Promise.resolve();
        },
        setItem: (key: string, value: string) => {
          journey.storage.set(key, value);
          return Promise.resolve();
        },
      },
    }) as never
);
vi.mock(import("expo-network"), () => ({
  addNetworkStateListener: () => ({ remove: () => undefined }),
  getNetworkStateAsync: () => Promise.resolve({ isConnected: false }),
}));
vi.mock(import("expo-crypto") as Promise<unknown>, () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: () => Promise.resolve("digest"),
  randomUUID: () => "unused-provider-id",
}));
vi.mock(import("expo-battery") as Promise<unknown>, () => ({
  BatteryState: { CHARGING: 1, FULL: 2 },
  getBatteryStateAsync: () => Promise.resolve(2),
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const element = (
    tag: string,
    props: Record<string, unknown> & { children?: React.ReactNode } = {}
  ): React.JSX.Element => {
    const { children, ...rest } = props;
    return ReactModule.createElement(tag, rest, children);
  };
  return {
    AppState: {
      addEventListener: () => ({ remove: () => undefined }),
      currentState: "active",
    },
    FlatList: ({
      data = [],
      renderItem,
    }: {
      data?: readonly unknown[];
      renderItem: (value: { item: unknown; index: number }) => React.ReactNode;
    }) =>
      element("div", {
        children: data.map((item, index) => renderItem({ item, index })),
      }),
    InteractionManager: {
      runAfterInteractions: (callback: () => void) => {
        callback();
        return { cancel: () => undefined };
      },
    },
    Modal: ({
      children,
      visible,
    }: {
      children?: React.ReactNode;
      visible?: boolean;
    }) => (visible ? element("div", { children, role: "dialog" }) : null),
    Pressable: ({
      accessibilityLabel,
      children,
      disabled,
      onPress,
    }: {
      accessibilityLabel?: string;
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      element("button", {
        "aria-label": accessibilityLabel,
        children,
        disabled,
        onClick: disabled ? undefined : onPress,
        type: "button",
      }),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    Switch: () => element("input", { type: "checkbox" }),
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as never;
});

vi.mock(import("../../../modules/centraid-storage"), () => ({
  replicaStorageDirectory: () => path.dirname(journey.replicaFile),
}));
vi.mock(import("../../../modules/centraid-network-status"), () => ({
  getCellularRoamingStatus: () => Promise.resolve(false),
}));
vi.mock(
  import("../../storage"),
  () =>
    ({
      Store: {
        get: <T,>(_key: string, fallback: T): T => fallback,
        hydrate: <T,>(_key: string, fallback: T) => Promise.resolve(fallback),
        set: () => undefined,
      },
    }) as never
);
vi.mock(import("../../lib/gateway"), () => ({
  resolveGatewayBase: () => Promise.reject(new Error("offline")),
}));
vi.mock(
  import("../../lib/vault-links"),
  () =>
    ({
      LAST_BASE: "replica.lastBase",
      LAST_GATEWAY: "replica.lastGateway",
      LAST_VAULT: "replica.lastVault",
      getActiveVaultLink: () => ({
        desktopName: "Offline desktop",
        deviceId: "device",
        gatewayId: "offline-gateway",
        id: "link",
        vaultId: "personal",
      }),
      hydrateVaultLinks: () => Promise.resolve(),
      subscribeVaultLinks: () => () => undefined,
    }) as never
);
vi.mock(import("../../kit/replica/replica-mount"), () => ({
  fetcher: () => () =>
    Promise.reject(new Error("offline journey must not fetch")),
  freshnessKey: (_gatewayId: string, vaultId: string) => `fresh:${vaultId}`,
  loadFreshness: () => Promise.resolve(new Map()),
  mountedScopes: () =>
    Promise.resolve([
      {
        canWrite: true,
        databaseName: journey.replicaFile,
        label: "Personal",
        personal: true,
        vaultId: "personal",
      },
    ]),
  refreshCachedScopes: () => Promise.resolve(),
  removeCachedScope: () => Promise.resolve(),
  resolveIdentity: () =>
    Promise.resolve({
      auth: {
        baseUrl: "http://127.0.0.1:1",
        gatewayId: "offline-gateway",
        vaultId: "personal",
      },
      gatewayId: "offline-gateway",
      online: false,
    }),
}));
vi.mock(
  import("../../lib/replica/op-sqlite-driver"),
  () =>
    ({
      openMountedReplicaReaderDriver: () =>
        Promise.resolve(journey.openMountedDriver!()),
      openNativeReplicaDriver: () =>
        Promise.resolve(journey.openReplicaDriver!()),
    }) as never
);
vi.mock(import("../../lib/replica/native-hash"), () => ({
  nativeReplicaDigest: () => Promise.resolve("digest"),
  nativeReplicaIdFactory: () => "unused-provider-id",
}));
vi.mock(
  import("../../lib/replica/native-multiplex-change-feed"),
  () =>
    ({
      NativeMultiplexChangeFeed: class {
        close(): void {}
        scope(): NativeChangeFeed {
          return inertFeed();
        }
        updateGatewayBase(): void {}
      },
    }) as never
);
vi.mock(import("../../lib/replica/mobile-gateway-compatibility"), () => ({
  // `undefined` is the wall's "no gateway answered" answer: this journey is
  // offline, so it learns no feature flags either.
  requireMobileOfflineGateway: () => Promise.resolve(undefined),
}));
vi.mock(import("../../lib/replica/background-sync"), () => ({
  registerReplicaPushWake: () => Promise.resolve(),
}));
vi.mock(import("../../lib/daily-brief"), () => ({
  scheduleDailyBriefNotification: () => Promise.resolve(),
}));
vi.mock(import("../../lib/notifications-core"), () => ({
  syncDueNotifications: () => Promise.resolve(),
  syncNotifications: () => Promise.resolve(),
}));
vi.mock(import("../../lib/replica/thumbnail-pack"), () => ({
  clearPinnedThumbnailPack: () => undefined,
}));
vi.mock(
  import("../../kit/components/HomeKey"),
  () => ({ default: () => null }) as never
);
vi.mock(
  import("../../kit/components/NativeText"),
  () =>
    ({
      Text: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("span", null, children),
      TextInput: ({
        accessibilityLabel,
        placeholder,
        value,
      }: {
        accessibilityLabel?: string;
        placeholder?: string;
        value?: string;
      }) =>
        React.createElement("input", {
          "aria-label": accessibilityLabel,
          placeholder,
          readOnly: true,
          value: value ?? "",
        }),
    }) as never
);
vi.mock(
  import("../../kit/components/TopSafeArea"),
  () =>
    ({
      default: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("main", null, children),
    }) as never
);
vi.mock(
  import("../../kit/replica/ReplicaStateCard"),
  () => ({ default: () => null }) as never
);
vi.mock(
  import("../../kit/replica/ReplicaStatusBar"),
  () => ({ default: () => null }) as never
);
vi.mock(
  import("../../kit/components/status-line"),
  () => ({ postStatus: () => undefined }) as never
);
vi.mock(
  import("../../kit/share/ShareSheet"),
  () => ({ default: () => null }) as never
);
vi.mock(
  import("../../kit/theme"),
  () =>
    ({
      family: {
        monoMedium: "mono",
        sansMedium: "sans",
        sansRegular: "sans",
      },
      radii: { lg: 12, md: 8 },
      t: () => ({}),
      useTheme: () => ({
        colors: {
          accent: "rebeccapurple",
          bg: "white",
          bgElev: "white",
          bgSunken: "whitesmoke",
          line: "gainsboro",
          text: "black",
          textFaint: "gray",
          textSoft: "dimgray",
        },
      }),
    }) as never
);
vi.mock(
  import("../../navigation"),
  () =>
    ({
      rootNavigationRef: {
        isReady: () => false,
        navigate: () => undefined,
      },
    }) as never
);
vi.mock(
  import("./TallyRecurringTemplates"),
  () => ({ default: () => null }) as never
);

function inertFeed(): NativeChangeFeed {
  return {
    resume: () => Promise.resolve(),
    setActive: () => undefined,
    setShapeIds: () => Promise.resolve(),
    subscribe: () => () => undefined,
  };
}

function seedReplica(replicaFile: string): void {
  const store = new ReplicaSqliteStore(
    new NodeSqliteDriver(replicaFile),
    "personal"
  );
  store.bootstrap({
    protocolVersion: 1,
    vaultId: "personal",
    schemaEpoch: "1",
    cursor: { epoch: "native-render", seq: 1 },
    shapes: [
      {
        shapeId: "tally-default",
        appId: "tally",
        purpose: "dpv:ServiceProvision",
        entities: [
          {
            entity: "core.vault",
            primaryKey: "vault_id",
            columns: ["vault_id", "owner_party_id", "base_currency"],
          },
          {
            entity: "tally.group",
            primaryKey: "group_id",
            columns: ["group_id", "circle_id"],
          },
          {
            entity: "social.circle",
            primaryKey: "circle_id",
            columns: ["circle_id", "name"],
          },
          {
            entity: "social.circle_member",
            primaryKey: "__centraid_row_id",
            columns: ["__centraid_row_id", "circle_id", "party_id"],
          },
          {
            entity: "tally.expense",
            primaryKey: "expense_id",
            columns: [
              "expense_id",
              "group_id",
              "description",
              "amount_minor",
              "original_amount_minor",
              "original_currency",
              "settlement_currency",
              "rate_scaled",
              "rate_scale",
              "rate_source",
              "rate_date",
              "paid_by",
              "category",
              "spent_on",
              "deleted_at",
            ],
          },
          {
            entity: "tally.expense_split",
            primaryKey: "__centraid_row_id",
            columns: [
              "__centraid_row_id",
              "expense_id",
              "party_id",
              "share_minor",
            ],
          },
          {
            entity: "tally.recurring_expense",
            primaryKey: "template_id",
            columns: ["template_id", "group_id", "description"],
          },
          {
            entity: "schedule.recurrence_exception",
            primaryKey: "exception_id",
            columns: ["exception_id", "template_id"],
          },
        ],
      },
    ],
    rows: [
      {
        shapeId: "tally-default",
        entity: "core.vault",
        rowId: "personal",
        rowVersion: 1,
        values: {
          base_currency: "USD",
          owner_party_id: "owner",
          vault_id: "personal",
        },
      },
      {
        shapeId: "tally-default",
        entity: "tally.group",
        rowId: "group-offline",
        rowVersion: 1,
        values: { circle_id: "circle", group_id: "group-offline" },
      },
      {
        shapeId: "tally-default",
        entity: "social.circle",
        rowId: "circle",
        rowVersion: 1,
        values: { circle_id: "circle", name: "Offline group" },
      },
      {
        shapeId: "tally-default",
        entity: "social.circle_member",
        rowId: "circle-owner",
        rowVersion: 1,
        values: {
          __centraid_row_id: "circle-owner",
          circle_id: "circle",
          party_id: "owner",
        },
      },
    ],
  });
  store.close();
}

async function enqueueThenClose(replicaFile: string): Promise<void> {
  const session = await createNativeReplicaSession({
    gatewayAuth: {
      baseUrl: "http://127.0.0.1:1",
      gatewayId: "offline-gateway",
      vaultId: "personal",
    },
    changeFeed: inertFeed(),
    digest: () => Promise.resolve("digest"),
    driver: new NodeSqliteDriver(replicaFile),
    fetcher: () => Promise.reject(new Error("offline journey must not fetch")),
    idFactory: () => "intent-native-render",
    isConnected: () => false,
  });
  await session.write("tally", {
    action: "add-expense",
    input: {
      amount_minor: 1_250,
      category: "food",
      description: "Rendered after native restart",
      group_id: "group-offline",
      original_amount_minor: 1_250,
      original_currency: "USD",
      paid_by: "owner",
      rate_date: "2026-08-11",
      rate_scale: 6,
      rate_scaled: 1_000_000,
      rate_source: "identity",
      settlement_currency: "USD",
      spent_on: "2026-08-11",
      splits: [{ party_id: "owner", share_minor: 1_250 }],
    },
  });
  await session.close();
}

describe("native pending row restart journey", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    const directory = tempDirSync("centraid-native-render-restart-");
    journey.replicaFile = path.join(directory, "personal.db");
    journey.mountedFile = path.join(directory, "mounted.db");
    journey.storage.clear();
    journey.openReplicaDriver = () => new NodeSqliteDriver(journey.replicaFile);
    journey.openMountedDriver = () => new NodeSqliteDriver(journey.mountedFile);
    seedReplica(journey.replicaFile);
    await enqueueThenClose(journey.replicaFile);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the SQLite outbox row through the mounted provider after a cold restart", async () => {
    act(() => {
      root.render(
        <ReplicaProvider>
          <TallyHome
            navigation={
              {
                goBack: () => undefined,
                navigate: () => undefined,
              } as never
            }
            route={{ key: "tally-restart", name: "Tally" } as never}
          />
        </ReplicaProvider>
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Rendered after native restart");
    });

    expect(container.textContent).toContain("Waiting for a connection.");
    expect(container.textContent).toContain("queued");
    expect(container.textContent).toContain("$12.50");
  });
});
