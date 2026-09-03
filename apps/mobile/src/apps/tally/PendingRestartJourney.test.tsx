import path from "node:path";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PENDING_OVERLAY_FIELDS } from "@centraid/blueprints/apps/_shared/pending-overlay";
import {
  COMPOSE_OUTCOMES,
  CONTRIB_SECTIONS,
} from "@centraid/blueprints/apps/tally/compose-copy";
import { OFFLINE_NOTICE } from "@centraid/blueprints/apps/tally/view-copy";
import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "../../lib/replica/multi-vault-reader";
import type { MountedReplicaScope } from "../../lib/replica/multi-vault-reader";
import { MultiVaultReplicaSession } from "../../lib/replica/multi-vault-session";
import type { NativeChangeFeed } from "../../lib/replica/native-session";
import { createNativeReplicaSession } from "../../lib/replica/native-session";
import { NodeSqliteDriver } from "../../lib/replica/node-sqlite-driver";

vi.mock(import("../../screens/home/VaultBar"), () => ({
  default: (): React.JSX.Element => React.createElement("view"),
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const stub = await import("../../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove: () => undefined }),
    },
    TextInput: (props: {
      accessibilityLabel?: string;
      onChangeText?: (next: string) => void;
      placeholder?: string;
      value?: string;
    }) =>
      ReactModule.createElement("input", {
        "aria-label": props.accessibilityLabel,
        onChange: (event: { target: { value: string } }) =>
          props.onChangeText?.(event.target.value),
        placeholder: props.placeholder,
        value: props.value ?? "",
      }),
  } as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
vi.mock(
  import("react-native-safe-area-context"),
  () =>
    ({
      useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
    }) as never
);
vi.mock(
  import("@react-navigation/native"),
  () =>
    ({
      useNavigation: () => ({
        navigate: () => undefined,
        popTo: () => undefined,
      }),
    }) as never
);

vi.mock(import("expo-crypto") as Promise<unknown>, () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: () => Promise.resolve("digest"),
  randomUUID: () => "journey-id",
}));

vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      resolveAppMeta: (row: { iconKey?: string }) => ({
        color: "#4f46e5",
        colorKey: "indigo",
        desc: "",
        iconKey: row.iconKey ?? "Coin",
        id: "tally",
        name: "Tally",
      }),
    }) as never
);

const answers = vi.hoisted(() => ({
  dashboard: vi.fn<() => Promise<unknown>>(),
}));
vi.mock(
  import("./tally-gateway"),
  () =>
    ({
      EXPORT_WINDOW: 2000,
      tallyActivity: () => answers.dashboard(),
      tallyDashboard: () => answers.dashboard(),
      tallyExport: () => answers.dashboard(),
      tallyFriend: () => answers.dashboard(),
      tallyGroup: () => answers.dashboard(),
      tallyHistory: () => answers.dashboard(),
      tallySearch: () => answers.dashboard(),
    }) as unknown as typeof import("./tally-gateway")
);

const replica = vi.hoisted(() => ({
  online: false,
  ready: true,
  session: undefined as unknown,
  vaultId: "personal" as string | undefined,
}));
vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () => ({ useReplica: () => replica }) as never
);

const posted = vi.hoisted(() => [] as string[]);
vi.mock(
  import("../../kit/components/status-line"),
  () =>
    ({
      postStatus: (message: string) => posted.push(message),
      showUndoStatus: (message: string) => posted.push(message),
    }) as never
);

const { WAITING_OWN_SCOPE } = await import("./tally-seat-copy");
const { openTally, resetTallyVault } = await import("./tally-store");
const { default: TallyAddScreen } = await import("./TallyAddScreen");
const { default: TallyHome } = await import("./TallyHome");

const VAULT = "personal";
const SPENT = "Airplane dinner at the Ship";

const TALLY_SHAPE = {
  shapeId: "tally-default",
  appId: "tally",
  purpose: "dpv:ServiceProvision",
  entities: [
    {
      entity: "tally.expense",
      primaryKey: "expense_id",
      columns: [
        "expense_id",
        "group_id",
        "split_method",
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
      columns: ["__centraid_row_id", "expense_id", "party_id", "share_minor"],
    },
    {
      entity: "tally.expense_payer",
      primaryKey: "__centraid_row_id",
      columns: ["__centraid_row_id", "expense_id", "party_id", "paid_minor"],
    },
  ],
};

const DASHBOARD = {
  currency: "USD",
  friends: [{ party_id: "ana", name: "Ana", initials: "AN", net_minor: 0 }],
  groups: [],
  me: "owner",
  owe_total_minor: 0,
  owed_total_minor: 0,
  recurring: [],
  trash: [],
};

function inertFeed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let workspace = "";
let replicaFile = "";
let readerSerial = 0;
let facade: MultiVaultReplicaSession | undefined;

function seedReplica(): void {
  const store = new ReplicaSqliteStore(
    new NodeSqliteDriver(replicaFile),
    VAULT
  );
  store.bootstrap({
    protocolVersion: 1,
    vaultId: VAULT,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${VAULT}`, seq: 1 },
    shapes: [
      {
        ...TALLY_SHAPE,
        entities: TALLY_SHAPE.entities.map((entity) => ({
          ...entity,
          columns: [...entity.columns],
        })),
      },
    ],
    rows: [],
  });
  store.close();
}

async function mountProcess(): Promise<MultiVaultReplicaSession> {
  readerSerial += 1;
  const scope: MountedReplicaScope = {
    vaultId: VAULT,
    label: "Personal",
    canWrite: true,
    databaseName: replicaFile,
  };
  let minted = 0;
  const native = await createNativeReplicaSession({
    gatewayAuth: {
      baseUrl: "http://127.0.0.1:1",
      gatewayId: "offline-gateway",
      vaultId: VAULT,
    },
    fetcher: () =>
      Promise.reject(new Error("the offline journey must not reach a gateway")),
    changeFeed: inertFeed(),
    driver: new NodeSqliteDriver(replicaFile),
    isConnected: () => false,
    digest: () => Promise.resolve("digest"),
    idFactory: () => `intent-${(minted += 1)}`,
  });
  const reader = new MultiVaultReplicaReader(
    new NodeSqliteDriver(path.join(workspace, `reader-${readerSerial}.db`)),
    [scope]
  );
  return new MultiVaultReplicaSession({
    reader,
    sessions: new Map([[VAULT, native]]),
    scopes: [scope],
    focusedVaultId: () => VAULT,
    createId: () => `placement-${readerSerial}`,
    sendPlacement: () =>
      Promise.reject(new Error("the offline journey must not place")),
    isConnected: () => false,
  });
}

function render(node: React.JSX.Element): void {
  act(() => {
    root = createRoot(container!);
    root.render(node);
  });
}

function unmount(): void {
  act(() => root?.unmount());
  root = undefined;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await Promise.resolve();
  });
}

function field(label: string): HTMLInputElement {
  const input = container!.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  );
  expect(input, `no field labelled ${label}`).not.toBeNull();
  return input!;
}

function type(label: string, value: string): void {
  const input = field(label);
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function control(label: string): HTMLElement {
  const button = [
    ...container!.querySelectorAll<HTMLElement>('button, [data-role="button"]'),
  ].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
  );
  expect(button, `no control labelled ${label}`).toBeDefined();
  return button!;
}

const addScreen = (): React.JSX.Element => (
  <TallyAddScreen
    navigation={{ goBack: () => undefined } as never}
    route={{ key: "add", name: "TallyAdd", params: undefined } as never}
  />
);

async function recordExpense(): Promise<void> {
  render(addScreen());
  type("What was it", SPENT);
  type("How much", "12.34");
  await settle();
  act(() => control("Add expense").click());
  await settle();
}

async function restartProcess(): Promise<void> {
  await facade!.close();
  resetTallyVault();
  facade = await mountProcess();
  replica.session = facade;
}

const waitingScreen = (): React.JSX.Element => (
  <TallyHome
    navigation={{ navigate: () => undefined, popTo: () => undefined } as never}
    route={
      {
        key: "home",
        name: "TallyHome",
        params: { destination: "contrib" },
      } as never
    }
  />
);

describe("a Tally expense recorded with the gateway out of reach", () => {
  beforeEach(async () => {
    workspace = tempDirSync("centraid-tally-restart-");
    replicaFile = path.join(workspace, `${VAULT}.db`);
    readerSerial = 0;
    seedReplica();
    posted.length = 0;
    resetTallyVault();
    container = document.createElement("div");
    document.body.append(container);
    facade = await mountProcess();
    replica.session = facade;
    replica.online = false;
    replica.vaultId = VAULT;
    answers.dashboard.mockResolvedValue(DASHBOARD);
    await act(async () => {
      await openTally();
    });
    answers.dashboard.mockRejectedValue(new Error("gateway is unreachable"));
  });

  afterEach(async () => {
    unmount();
    container?.remove();
    container = undefined;
    await facade?.close();
    facade = undefined;
    replica.session = undefined;
    resetTallyVault();
    document.body.replaceChildren();
  });

  it("queues the write and says so in the commit's own words", async () => {
    await recordExpense();
    expect(posted).toStrictEqual([COMPOSE_OUTCOMES.added]);
  });

  it("draws the queued row in Waiting, from the durable outbox", async () => {
    await recordExpense();
    unmount();

    render(waitingScreen());
    await settle();
    const drawn = container!.textContent ?? "";
    expect(drawn).toContain(CONTRIB_SECTIONS.inFlight);
    expect(drawn).toContain("QUEUED");
    expect(drawn).toContain(OFFLINE_NOTICE);
  });

  it("still draws the same queued write after the process is rebuilt", async () => {
    await recordExpense();
    const before = await facade!.pendingChanges();
    unmount();

    await restartProcess();

    render(waitingScreen());
    await settle();
    const drawn = container!.textContent ?? "";
    expect(drawn).toContain("QUEUED");
    expect(drawn).toContain(
      "on a device, not in the vault yet · it lands when the gateway answers"
    );
    expect(drawn).toContain(WAITING_OWN_SCOPE);
    const after = await facade!.pendingChanges();
    expect(after.map((change) => change.id)).toStrictEqual(
      before.map((change) => change.id)
    );
    expect(after[0]).toMatchObject({
      label: "tally: add-expense",
      status: "queued",
      vaultId: VAULT,
    });
  });

  it("recovers the pending expense itself through the mounted reader", async () => {
    await recordExpense();
    unmount();
    await restartProcess();

    const found = await facade!.read("tally", {
      entity: "tally.expense",
      where: [{ column: "description", op: "eq", value: SPENT }],
    });
    expect(found.rows[0]?.values).toMatchObject({
      description: SPENT,
      amount_minor: 1234,
      [PENDING_OVERLAY_FIELDS.status]: "queued",
      __centraidScopeId: VAULT,
    });
  });
});
// @vitest-environment jsdom
