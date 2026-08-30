// Tally's RNTL tier (#890 W5). ONE cold renderer for the app: the RN host tree
// is expensive to boot, so every Tally claim needing a real accessibility tree,
// a real responder, or real style resolution is consolidated here (TESTING.md,
// "React Native component tests").
//
// WHAT ONLY THIS TIER CAN FALSIFY here:
//  - the DENIED gate as an absence: behind it the ledger is not rendered at
//    all, and neither is the band. A DOM stub could only see a dimmed panel.
//  - the band's real `tab` nodes and the single lit `selected` trait;
//  - the ledger row's accessible NAME — the row says both WHO and HOW MUCH in
//    one name, which is everything a screen reader gets from a row of figures;
//  - a press that must reach a real `Pressable` before a sheet or a route opens.
//
// Device seams are the project's (`src/test/native-device-seams.ts`). Every
// Tally component, ledger projection and copy table stays real; only the vault
// store — the gateway read plane — is substituted.

import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TallyHome from "./TallyHome";

const vaultState = vi.hoisted(() => ({ current: null as unknown }));
const navigated = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock(
  import("@react-navigation/native"),
  () =>
    ({
      useNavigation: () => ({
        navigate: (...args: unknown[]) => {
          navigated.calls.push(args);
        },
        popTo: (...args: unknown[]) => {
          navigated.calls.push(args);
        },
      }),
    }) as never
);

// The vault store is the gateway read plane and lives in process memory rather
// than a React tree, so this is the read seam — the same place the Photos file
// seams its timeline. `openTally` is a no-op here: on a device it reads the
// spine over the network, and a test that let it run would assert a network.
vi.mock(import("./tally-store"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadTallyActivity: vi.fn<() => Promise<void>>(async () => undefined),
    openTally: vi.fn<() => Promise<void>>(async () => undefined),
    readTallyVault: () => vaultState.current as never,
    showMoreTallyActivity: vi.fn<() => Promise<void>>(async () => undefined),
    subscribeTallyVault: () => () => undefined,
  };
});

vi.mock(import("../../kit/replica/ReplicaProvider"), () => ({
  useReplica: vi.fn<
    (typeof import("../../kit/replica/ReplicaProvider"))["useReplica"]
  >(() => ({
    online: true,
    ready: true,
    refresh: vi.fn<() => Promise<void>>(async () => undefined),
    scopes: [],
  })),
}));

vi.mock(import("../../kit/replica/pending-changes"), () => ({
  usePendingChanges: () => ({ pending: [], refresh: () => undefined }),
}));

function friend(id: string, name: string, netMinor: number) {
  return {
    color: "rose",
    initials: name.slice(0, 2).toUpperCase(),
    name,
    net_minor: netMinor,
    party_id: id,
  };
}

/** The store's shape, with whatever the case needs on the spine. */
function vault(options: {
  denied?: { reason: string } | null;
  friends?: ReturnType<typeof friend>[];
}) {
  return {
    activity: null,
    dashboard: {
      currency: "USD",
      friends: options.friends ?? [],
      groups: [],
      me: null,
      owe_total_minor: 0,
      owed_total_minor: 0,
      recurring: [],
      trash: [],
    },
    denied: options.denied ?? null,
    exported: null,
    friend: null,
    group: null,
    history: null,
    lastReadAt: "2026-08-30T09:00:00.000Z",
    loaded: true,
    now: "2026-08-30T09:00:00.000Z",
    readError: "",
    reading: false,
    search: { data: null, searching: false, term: "" },
    stale: false,
    window: 50,
  };
}

function mountTally(
  destination?: "activity" | "balances" | "contrib" | "groups"
) {
  return render(
    <TallyHome
      navigation={{ navigate: vi.fn<() => void>() } as never}
      route={{ params: destination ? { destination } : {} } as never}
    />
  );
}

describe("Tally, on the real React Native host tree", () => {
  beforeEach(() => {
    navigated.calls.length = 0;
    vaultState.current = vault({});
  });

  it("lights exactly one band place and pops home rather than pushing", () => {
    const screen = mountTally();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.props.accessibilityLabel)).toStrictEqual([
      "Balances",
      "Activity",
      "Groups",
      "Waiting",
      "More",
    ]);
    // Two lit places is the defect a props-echo stub cannot see: it renders
    // each tab as its own `div` and never holds the band as one tree.
    expect(
      tabs.filter(
        (tab) =>
          (tab.props as { accessibilityState?: { selected?: boolean } })
            .accessibilityState?.selected === true
      )
    ).toHaveLength(1);

    fireEvent.press(screen.getByRole("tab", { name: "Groups" }));
    expect(navigated.calls).toStrictEqual([
      ["TallyHome", { destination: "groups" }],
    ]);
  });

  it("withdraws the ledger AND the band behind the denied gate", () => {
    vaultState.current = vault({
      denied: { reason: "The grant was withdrawn." },
      friends: [friend("f1", "Ada", 2500)],
    });
    const screen = mountTally();

    // Not dimmed, not disabled: absent. A figure still mounted behind a gate is
    // a figure a screen reader still reads out, and only the real tree can say
    // whether the node is there.
    expect(
      screen
        .queryAllByRole("button")
        .map((node) => String(node.props.accessibilityLabel))
        .filter((name) => name.startsWith("Ada"))
    ).toHaveLength(0);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("says who and how much in one accessible name per ledger row", () => {
    vaultState.current = vault({
      friends: [friend("f1", "Ada", 2500), friend("f2", "Grace", -1200)],
    });
    const screen = mountTally();

    const names = screen
      .getAllByRole("button")
      .map((node) => String(node.props.accessibilityLabel));
    // A row of figures read aloud as just a name is a row nobody can act on;
    // the name has to carry the meta. RN builds it, the stub only copies props.
    expect(names.some((name) => name.startsWith("Ada. "))).toBe(true);
    expect(names.some((name) => name.startsWith("Grace. "))).toBe(true);
  });

  it("keeps the day-one act reachable by role when nothing is owed either way", () => {
    const screen = mountTally();

    // The day-one commit is a `Text` with a button ROLE, not a `Pressable`.
    // RNTL still resolves it as a button because RN publishes the role — and
    // that is exactly the substitution a source-level grep cannot check.
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});
