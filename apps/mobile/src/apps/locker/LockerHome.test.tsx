import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LockerRow } from "@centraid/blueprints/apps/locker/types";

import LockerHome from "./LockerHome";

const vaultState = vi.hoisted(() => ({
  current: null as unknown,
}));
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

vi.mock(import("./locker-store"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enrolLockerDevice: vi.fn<() => Promise<void>>(async () => undefined),
    onLockerAppState: vi.fn<() => void>(),
    openLocker: vi.fn<() => Promise<void>>(async () => undefined),
    readLockerVault: () => vaultState.current as never,
    searchLocker: vi.fn<() => Promise<void>>(async () => undefined),
    showMoreLockerItems: vi.fn<() => Promise<void>>(async () => undefined),
    subscribeLockerVault: () => () => undefined,
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

function item(id: string, title: string): LockerRow {
  return { item_id: id, title, type: "login" };
}

function vault(
  phase: "locked" | "open" | "setup",
  rows: readonly LockerRow[] = []
) {
  return {
    accessError: "",
    accessWindow: null,
    bag: {
      generated: "",
      revealed: {},
      revealedAt: {},
      searchResults: [],
      searchTerm: "",
    },
    busy: false,
    credentialId: null,
    denied: null,
    importBatches: null,
    importNote: "",
    lastReadAt: "2026-08-30T09:00:00.000Z",
    limit: 50,
    loaded: phase === "open",
    masked: false,
    openBatchId: null,
    permitBusy: false,
    permitError: "",
    reading: false,
    readError: "",
    reauth: false,
    rows: [...rows],
    session: { configured: phase !== "setup", phase },
    stale: false,
    surfaceBusy: false,
    truncated: false,
  };
}

function mountLocker(destination?: "gen" | "items" | "search" | "watch") {
  return render(
    <LockerHome
      navigation={{ navigate: vi.fn<() => void>() } as never}
      route={{ params: destination ? { destination } : {} } as never}
    />
  );
}

describe("Locker, on the real React Native host tree", () => {
  beforeEach(() => {
    navigated.calls.length = 0;
    vaultState.current = vault("open");
  });

  it("withdraws every item from the tree behind a lock, rather than dimming them", () => {
    vaultState.current = vault("open", [item("i1", "Bank login")]);
    const open = mountLocker();
    expect(
      open
        .getAllByRole("button")
        .map((node) => String(node.props.accessibilityLabel))
    ).toContain("Bank login");

    vaultState.current = vault("locked", [item("i1", "Bank login")]);
    const locked = mountLocker();
    expect(
      locked
        .getAllByRole("button")
        .map((node) => String(node.props.accessibilityLabel))
    ).not.toContain("Bank login");
  });

  it("takes the band away with the content behind a lock", () => {
    vaultState.current = vault("locked");
    const screen = mountLocker();

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("lights exactly one band place once the vault is open", () => {
    const screen = mountLocker();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(1);
    expect(
      tabs.filter(
        (tab) =>
          (tab.props as { accessibilityState?: { selected?: boolean } })
            .accessibilityState?.selected === true
      )
    ).toHaveLength(1);
  });

  it("pops home with the destination instead of pushing a second window", () => {
    const screen = mountLocker();

    fireEvent.press(screen.getByRole("tab", { name: "Review" }));
    expect(navigated.calls).toStrictEqual([
      ["LockerHome", { destination: "watch" }],
    ]);
  });

  it("names each item row and gives its act a name of its own", () => {
    vaultState.current = vault("open", [
      item("i1", "Bank login"),
      item("i2", "Router admin"),
    ]);
    const screen = mountLocker();

    const names = screen
      .getAllByRole("button")
      .map((node) => String(node.props.accessibilityLabel));
    expect(names).toContain("Bank login");
    expect(names).toContain("Router admin");
    expect(new Set(names).size).toBe(names.length);
  });
});
