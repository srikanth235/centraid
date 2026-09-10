// THE PENDING RESTART JOURNEY, RENDERED — the iOS-compatible half of the
// airplane-mode device proof (docs/mobile-offline.md, "Performance
// guardrails"). Maestro's airplane control is Android-only, so the Android
// lane owns the OS lifecycle and the touch, and this file owns the same
// contract on infrastructure iOS CI can actually run.
//
// It is a JOURNEY, not a component test: nothing about the outbox is faked.
// One real `node:sqlite` file on disk carries the exact `NativeReplicaSession`
// `ReplicaProvider.tsx` mounts — since #996 wave 3 that IS what it mounts, one
// open file and no facade over it. The rendered Tally cover records the
// expense through `TallyAddScreen` and reads it back through `TallyHome`'s
// Waiting place; the restart closes the handle, drops the process-memory read
// plane, and rebuilds the session over the same file — which is what a killed
// app does.
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
//  4. THE PENDING EXPENSE ITSELF SURVIVES, THROUGH THE PRODUCTION READ PATH —
//     the session's own, overlay and all.
//     The row Waiting draws is an outbox row; the EXPENSE is an optimistic
//     projection, and it is the mounted reader's overlay that carries it. The
//     phone draws no surface over that read (Tally's reads are gateway RPCs —
//     `tally-reads.ts` says why), so the claim is asserted at the reader the
//     app mounts rather than at a screen that does not exist.
//
// WHAT THIS FILE DELIBERATELY DOES NOT CLAIM: reconnect. The gateway is
// unreachable from the first render to the last, so settlement-on-reconnect
// stays where `tests/quality/offline-reconnect.integration.test.ts` owns it.

import path from "node:path";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSE_OUTCOMES,
  CONTRIB_SECTIONS,
} from "@centraid/blueprints/apps/tally/compose-copy";
import { OFFLINE_NOTICE } from "@centraid/blueprints/apps/tally/view-copy";
// @vitest-environment jsdom
import { EMPTY_BAG, valuate } from "@centraid/core/money";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openNodeNativeSeat } from "../../lib/replica/native-seat.test-fixtures";
import { createNativeReplicaSession } from "../../lib/replica/native-session";
import type {
  NativeChangeFeed,
  NativeReplicaSession,
} from "../../lib/replica/native-session";

// The shared block stub, plus the one primitive it does not wire: it forwards
// `onPress` and drops every other handler, and a journey that TYPES needs
// `onChangeText` to reach the draft. Overridden here rather than in the shared
// stub, because a composer is the only surface that needs it.
// The vault lockup every app frame draws. Stubbed for the same reason as in
// `PhotosScreen.test.tsx`: this journey's claim is Tally's pending-write
// behaviour, and mounting the real header pulls the active-vault read and its
// native storage into a project with no setup file to seam them.
vi.mock(import("../../screens/home/VaultBar"), () => ({
  default: (): React.JSX.Element => React.createElement("view"),
}));

vi.mock(import("@shopify/flash-list"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.flashListStub() as unknown as typeof import("@shopify/flash-list");
});

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
// The composer's date chip opens the platform picker (#1015, tally/findings
// #5), whose source ships as Flow and cannot be parsed by this tier's bundler.
// It is a device service and draws nothing this journey asserts.
vi.mock(
  import("@react-native-community/datetimepicker"),
  () =>
    ({
      default: () => null,
    }) as unknown as typeof import("@react-native-community/datetimepicker")
);
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

// The read door, replaced wholesale — the neighbouring read-plane suite's own
// shape (`tally-store.test.ts`). This journey is about the WRITE rail across a
// restart, so the reads answer whatever the test hands them.
const answers = vi.hoisted(() => ({
  dashboard: vi.fn<() => Promise<unknown>>(),
}));
vi.mock(
  import("./tally-reads"),
  () =>
    ({
      EXPORT_WINDOW: 2000,
      attachTallyReadPlane: () => undefined,
      tallyActivity: () => answers.dashboard(),
      tallyDashboard: () => answers.dashboard(),
      tallyExport: () => answers.dashboard(),
      tallyFriend: () => answers.dashboard(),
      tallyGroup: () => answers.dashboard(),
      tallyHistory: () => answers.dashboard(),
      tallySearch: () => answers.dashboard(),
    }) as unknown as typeof import("./tally-reads")
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
      // News is suppressed while the line carries an action (#1015, S3);
      // nothing here posts one, so the line reads quiet.
      readStatus: () => null,
      showUndoStatus: (message: string) => posted.push(message),
    }) as never
);

const { WAITING_OWN_SCOPE } = await import("./tally-seat-copy");
const { openTally, resetTallyVault } = await import("./tally-store");
const { default: TallyAddScreen } = await import("./TallyAddScreen");
const { default: TallyHome } = await import("./TallyHome");

const VAULT = "personal";
const SPENT = "Airplane dinner at the Ship";

/** The dashboard this phone last landed while the gateway still answered. The
 *  composer divides between the people it names, so a seat with no landed
 *  spine has nobody to divide between — which is exactly why the journey
 *  lands one before the gateway goes away. */
const DASHBOARD = {
  currency: "USD",
  friends: [{ party_id: "ana", name: "Ana", initials: "AN", balances: [] }],
  groups: [],
  me: "owner",
  owe: valuate(EMPTY_BAG, "USD"),
  owed: valuate(EMPTY_BAG, "USD"),
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
let facade: NativeReplicaSession | undefined;

/**
 * The vault's own `tally_expense`, which a seat's file holds directly (#996
 * W5). It used to be a SHAPED bootstrap — a catalog, a shape and a projection
 * of the table into `replica_row` — and the seat has the table.
 */
const SEAT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tally_expense (
    expense_id TEXT PRIMARY KEY,
    description TEXT,
    amount_minor INTEGER,
    currency TEXT,
    spent_on TEXT,
    deleted_at TEXT,
    row_version INTEGER NOT NULL DEFAULT 1
  ) STRICT;
`;

/**
 * One process's worth of session over the file on disk.
 *
 * Every door is the offline one: the fetcher REJECTS rather than resolving an
 * empty answer, so a write that reached the network would fail loudly instead
 * of passing as queued, and `isConnected` is false for the whole journey.
 */
async function mountProcess(): Promise<NativeReplicaSession> {
  let minted = 0;
  return createNativeReplicaSession({
    scope: { vaultId: VAULT, label: "Personal", canWrite: true },
    gatewayAuth: {
      baseUrl: "http://127.0.0.1:1",
      gatewayId: "offline-gateway",
      vaultId: VAULT,
    },
    fetcher: () =>
      Promise.reject(new Error("the offline journey must not reach a gateway")),
    changeFeed: inertFeed(),
    seat: await openNodeNativeSeat({
      path: replicaFile,
      schema: SEAT_SCHEMA,
    }),
    isConnected: () => false,
    digest: () => Promise.resolve("digest"),
    idFactory: () => `intent-${(minted += 1)}`,
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
    // No seeding: the seat's file IS the vault's tables, created when the
    // fixture adopts it. A shaped bootstrap had to be poured in first.
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
    // with it, and the session is rebuilt over the same file —
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
    expect(after.map((change) => change.intentId)).toStrictEqual(
      before.map((change) => change.intentId)
    );
    expect(after[0]).toMatchObject({
      appId: "tally",
      action: "add-expense",
      status: "queued",
    });
  });

  it("recovers the pending expense itself, from the outbox in the seat's file", async () => {
    await recordExpense();
    unmount();
    await restartProcess();

    // The session the app mounts, over the FILE the killed process left. The
    // expense is an OPTIMISTIC projection and the seat's file is where it
    // lives — `seat_outbox`, in the same database as the rows it is about
    // (#996, R24). Nothing else could have carried it across the restart:
    // process memory died with the process and no read can land offline.
    const projection = await facade!.pendingProjection();
    const upsert = projection.find(
      (mutation) =>
        mutation.op === "upsert" && mutation.entity === "tally.expense"
    );
    expect(upsert?.op === "upsert" ? upsert.values : {}).toMatchObject({
      description: SPENT,
      amount_minor: 1234,
    });
    const [pending] = await facade!.pendingChanges();
    // Queued is a fact about the WRITE, and the sheet reads it from there.
    expect(pending?.status).toBe("queued");
  });
});
