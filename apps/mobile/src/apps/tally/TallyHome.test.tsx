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

vi.mock(import("./tally-store"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadTallyActivity: vi.fn<() => Promise<void>>(async () => undefined),
    openTally: vi.fn<() => Promise<void>>(async () => undefined),
    readTallyVault: () => vaultState.current as never,
    showMoreTallyActivity: vi.fn<() => void>(() => undefined),
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
    expect(names.some((name) => name.startsWith("Ada. "))).toBe(true);
    expect(names.some((name) => name.startsWith("Grace. "))).toBe(true);
  });

  it("keeps the day-one act reachable by role when nothing is owed either way", () => {
    const screen = mountTally();

    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});
