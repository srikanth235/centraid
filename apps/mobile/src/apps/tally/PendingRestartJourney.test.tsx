// THE PENDING RESTART JOURNEY, RENDERED — the iOS-compatible half of the
// airplane-mode device proof (docs/mobile-offline.md, "Performance
// guardrails"). Maestro's airplane control is Android-only, so the Android
// lane owns the OS lifecycle and the touch, and this file owns the same
// contract on infrastructure iOS CI can actually run.
//
// It is a JOURNEY, not a component test: nothing about the outbox is faked.
// One real `node:sqlite` file on disk carries a real `NativeReplicaSession`,
// a real `MultiVaultReplicaReader` and the exact `MultiVaultReplicaSession`
// facade `ReplicaProvider.tsx` mounts. The rendered Tally cover records the
// expense through `TallyAddScreen` and reads it back through `TallyHome`'s
// Waiting place; the restart closes every handle, drops the process-memory
// read plane, and rebuilds all three over the same file — which is what a
// killed app does and what `multi-vault-reader.test.ts`'s own restart
// companion does one layer below the interface.
//
// FOUR CLAIMS, and the reason each one is here:
//
//  1. RECORDING NEVER NEEDS THE GATEWAY. `tally-writes.ts` sends every act
//     through `session.write`, so an unreachable gateway settles the write as
//     QUEUED and the commit says so in §6's own sentence, rather than leaving
//     an awaited promise hanging on a drain that will not run.
//  2. WAITING IS THE SURFACE THAT IS TRUE OFFLINE. Tally's reads are gateway
//     RPCs, so no ledger lands while disconnected; the queued row, its chip
//     and the offline notice are what the seat can honestly draw.
//  3. THE SAME WRITE SURVIVES THE PROCESS — the same durable intent id, not a
//     re-minted twin. After the restart the outbox is the only thing left: the
//     store's payload died with the process and the dashboard read cannot land
//     offline, so the row can have come from nowhere else.
//  4. THE PENDING EXPENSE ITSELF SURVIVES, THROUGH THE PRODUCTION READER.
//     The row Waiting draws is an outbox row; the EXPENSE is an optimistic
//     projection, and it is the mounted reader's overlay that carries it. The
//     phone draws no surface over that read (Tally's reads are gateway RPCs —
//     `tally-gateway.ts` says why), so the claim is asserted at the reader the
//     app mounts rather than at a screen that does not exist.
//
// WHAT THIS FILE DELIBERATELY DOES NOT CLAIM: reconnect. The gateway is
// unreachable from the first render to the last, so settlement-on-reconnect
// stays where `tests/quality/offline-reconnect.integration.test.ts` owns it.

// @vitest-environment jsdom
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

// The shared block stub, plus the one primitive it does not wire: it forwards
// `onPress` and drops every other handler, and a journey that TYPES needs
// `onChangeText` to reach the draft. Overridden here rather than in the shared
// stub, because a composer is the only surface that needs it.
vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const stub = await import("../../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    // The pending-changes ticker polls only while the app is foregrounded.
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

// Hermes has no WebCrypto, so the production hashes come from `expo-crypto`'s
// native module. The session takes both by injection here; this keeps the
// module out of the graph for the frame's own `resolveAppMeta` import.
vi.mock(import("expo-crypto") as Promise<unknown>, () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: () => Promise.resolve("digest"),
  randomUUID: () => "journey-id",
}));

// The frame asks the wire client for one thing — the app's icon and colour.
// The rest of that module is the phone's whole gateway transport, and none of
// it belongs in a journey whose premise is that no gateway answers.
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

// The gateway door, replaced wholesale — the neighbouring read-plane suite's
// own shape (`tally-store.test.ts`). Tally's reads are RPCs, so "the gateway
// is unreachable" IS these handlers rejecting.
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
  () => ({ postStatus: (message: string) => posted.push(message) }) as never
);

const { WAITING_OWN_SCOPE } = await import("./tally-seat-copy");
const { openTally, resetTallyVault } = await import("./tally-store");
const { default: TallyAddScreen } = await import("./TallyAddScreen");
const { default: TallyHome } = await import("./TallyHome");

const VAULT = "personal";
const SPENT = "Airplane dinner at the Ship";

/** The shape the seat's writes project into. Copied from the reader suite's
 *  own journey shape rather than shared: a fixture two suites edit together is
 *  a fixture neither one owns. Payers and splits are entities of their own, so
 *  an expense with nowhere to put them reads back unpaid. */
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

/** The dashboard this phone last landed while the gateway still answered. The
 *  composer divides between the people it names, so a seat with no landed
 *  spine has nobody to divide between — which is exactly why the journey
 *  lands one before the gateway goes away. */
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

/**
 * One process's worth of session, reader and facade over the file on disk.
 *
 * Every door is the offline one: the fetcher REJECTS rather than resolving an
 * empty answer, so a write that reached the network would fail loudly instead
 * of passing as queued, and `isConnected` is false for the whole journey.
 */
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

/** Flush the microtasks a rendered write and the pending-changes ticker each
 *  leave behind, inside `act` so React commits what they resolve. */
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

/** React tracks a controlled input's value on the node itself, so assigning
 *  `.value` and firing `input` is swallowed as a no-op. The prototype setter is
 *  what an actual keystroke goes through. */
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

/** A control by the words it wears. Tally draws several of its verbs as
 *  `Text accessibilityRole="button"` rather than a Pressable, so the lookup
 *  spans both shapes and matches an accessible name or the visible label. */
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

/** The composer, driven the way a member drives it. */
const addScreen = (): React.JSX.Element => (
  <TallyAddScreen
    navigation={{ goBack: () => undefined } as never}
    route={{ key: "add", name: "TallyAdd", params: undefined } as never}
  />
);

/** One expense, recorded the way a member records it: two typed fields and
 *  the commit. Every other field is the composer's own default. */
async function recordExpense(): Promise<void> {
  render(addScreen());
  type("What was it", SPENT);
  type("How much", "12.34");
  await settle();
  act(() => control("Add expense").click());
  await settle();
}

/** The process boundary. The store is module memory and dies with the
 *  process; the SQLite file is all that crosses. */
async function restartProcess(): Promise<void> {
  await facade!.close();
  resetTallyVault();
  facade = await mountProcess();
  replica.session = facade;
}

/** Waiting — the band place that draws this device's own outbox. */
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
    // The spine that landed while the gateway still answered. It is process
    // memory, and the restart below is where that matters.
    answers.dashboard.mockResolvedValue(DASHBOARD);
    await act(async () => {
      await openTally();
    });
    // From here the gateway is unreachable, and every read says so.
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
    // The write rail settles an unreachable drain as QUEUED rather than
    // leaving the awaited promise open, so the commit is a sentence and not a
    // spinner. §6's own line, and not a paraphrase of it.
    expect(posted).toStrictEqual([COMPOSE_OUTCOMES.added]);
  });

  it("draws the queued row in Waiting, from the durable outbox", async () => {
    await recordExpense();
    unmount();

    render(waitingScreen());
    await settle();
    const drawn = container!.textContent ?? "";
    // In flight is where a write of the member's own belongs — never under
    // "Waiting on you", which is a steward's question.
    expect(drawn).toContain(CONTRIB_SECTIONS.inFlight);
    expect(drawn).toContain("QUEUED");
    // The one exception is named, and recording is not it.
    expect(drawn).toContain(OFFLINE_NOTICE);
  });

  it("still draws the same queued write after the process is rebuilt", async () => {
    await recordExpense();
    const before = await facade!.pendingChanges();
    unmount();

    // THE RESTART. Every handle closes, the process-memory read plane goes
    // with it, and session, reader and facade are rebuilt over the same file —
    // which is all a killed app leaves behind.
    await restartProcess();

    render(waitingScreen());
    await settle();
    const drawn = container!.textContent ?? "";
    // The outbox row, its status, and the sentence that says where it is.
    expect(drawn).toContain("QUEUED");
    expect(drawn).toContain(
      "on a device, not in the vault yet · it lands when the gateway answers"
    );
    // And the surface still says whose writes these are, rather than implying
    // it is showing everybody's.
    expect(drawn).toContain(WAITING_OWN_SCOPE);
    // THE SAME WRITE, not a fresh one: a restart that re-minted the intent
    // would draw an identical row over a different durable id, and the vault
    // would eventually apply two expenses for one press.
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

    // The reader the app mounts, over the file the killed process left. The
    // expense is an OPTIMISTIC projection, so the overlay is what carries it —
    // description, queued status and the vault it belongs to.
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
