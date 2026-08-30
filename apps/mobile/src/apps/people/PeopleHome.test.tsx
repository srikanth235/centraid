// People's RNTL tier (#890 W5). ONE cold renderer for the app: the RN host
// tree is expensive to boot, so every People claim needing a real accessibility
// tree, a real responder, or real style resolution is consolidated here
// (TESTING.md, "React Native component tests").
//
// WHAT ONLY THIS TIER CAN FALSIFY here:
//  - the band's real `tab` nodes and the single lit `selected` trait;
//  - the roster row's real accessible NAME and its star's `selected` trait —
//    two controls on one row, told apart by RN, not by a DOM attribute;
//  - a press that must reach a real `Pressable` before a route is asked for;
//  - `FlashList`'s empty slot standing IN PLACE OF rows on first run.
//
// Device seams are the project's (`src/test/native-device-seams.ts`), FlashList
// included. Every People component, blueprint projection and copy table stays
// real; only the replica read layer — the device database — is substituted.

import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { TextInput } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplicaRow } from "@centraid/client/replica/native";

import PeopleHome from "./PeopleHome";

type SeededRow = ReplicaRow & { __rowId: string };

const replicaRows = vi.hoisted(() => ({
  byEntity: new Map<string, SeededRow[]>(),
}));

// The navigator, not a device service and not a component under test: People's
// frame reads `useNavigation` from the container this file deliberately does
// not stand up, so the destinations it asks for are observable as calls.
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

vi.mock(import("../../kit/hooks/useReplicaQuery"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useReplicaQuery: (_appId: string, request: { entity?: string }) => ({
      connection: "current" as const,
      error: undefined,
      loading: false,
      refresh: async () => undefined,
      rows: replicaRows.byEntity.get(request.entity ?? "") ?? [],
    }),
  };
});

/** A profile and the party row the roster projection reads its name from. */
function seedPeople(rows: readonly { id: string; name: string }[]): void {
  replicaRows.byEntity.set(
    "people.profile",
    rows.map(({ id, name }, index) => ({
      __rowId: id,
      created_at: `2026-08-0${index + 1}T09:00:00.000Z`,
      party_id: id,
      role: name === "" ? "" : "friend",
    }))
  );
  replicaRows.byEntity.set(
    "core.party",
    rows.map(({ id, name }) => ({
      __rowId: `${id}-party`,
      display_name: name,
      party_id: id,
    }))
  );
}

function mountPeople(
  navigate = vi.fn<() => void>(),
  destination?: "search" | "touch"
) {
  return render(
    <PeopleHome
      navigation={{ navigate } as never}
      route={{ params: destination ? { destination } : {} } as never}
    />
  );
}

function litTabs(
  tabs: readonly { props: Record<string, unknown> }[]
): string[] {
  return tabs
    .filter(
      (tab) =>
        (tab.props as { accessibilityState?: { selected?: boolean } })
          .accessibilityState?.selected === true
    )
    .map((tab) => tab.props.accessibilityLabel as string);
}

describe("People, on the real React Native host tree", () => {
  beforeEach(() => {
    navigated.calls.length = 0;
    replicaRows.byEntity.clear();
  });

  it("lights exactly one band place and moves it on a real press", () => {
    const screen = mountPeople();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(1);
    // Two lit places is the defect a props-echo stub cannot see: it renders
    // each tab as its own `div` and never holds the band as one tree.
    expect(litTabs(tabs)).toHaveLength(1);

    // A band tap POPS home with the destination named — it never pushes a
    // second copy — and the press has to traverse the real responder tree to
    // get there.
    fireEvent.press(screen.getByRole("tab", { name: "Touch" }));
    expect(navigated.calls).toStrictEqual([
      ["PeopleHome", { destination: "touch" }],
    ]);
  });

  it("gives every roster row its own name and its star its own selected trait", () => {
    seedPeople([
      { id: "p1", name: "Ada Lovelace" },
      { id: "p2", name: "Grace Hopper" },
    ]);
    const screen = mountPeople();

    const names = new Set(
      screen
        .getAllByRole("button")
        .map((node) => String(node.props.accessibilityLabel))
    );
    expect(names).toContain("Open Ada Lovelace");
    expect(names).toContain("Open Grace Hopper");

    // The star is a second control ON the same row, and it carries a `selected`
    // trait of its own. RN builds both nodes; the stub tier draws one `div`
    // per prop bag and cannot say which control a screen reader would reach.
    const stars = screen
      .getAllByRole("button")
      .filter(
        (node) =>
          (node.props as { accessibilityState?: { selected?: boolean } })
            .accessibilityState?.selected !== undefined
      );
    expect(stars.length).toBeGreaterThan(0);
  });

  it("asks for the person route through the real responder tree", () => {
    seedPeople([{ id: "p1", name: "Ada Lovelace" }]);
    const navigate = vi.fn<(...args: unknown[]) => void>();
    const screen = mountPeople(navigate as never);

    fireEvent.press(screen.getByRole("button", { name: "Open Ada Lovelace" }));
    expect(navigate.mock.calls).toStrictEqual([["Person", { personId: "p1" }]]);
  });

  it("stands the first-run block IN PLACE OF the roster, not above it", () => {
    // The empty slot is list behaviour: an empty roster shows the display head
    // and its one commit, with no row nodes behind it.
    const screen = mountPeople();

    expect(
      screen.getByText("Add the people you keep up with").props.children
    ).toBe("Add the people you keep up with");
    expect(
      screen
        .getAllByRole("button")
        .filter((node) =>
          String(node.props.accessibilityLabel).startsWith("Open ")
        )
    ).toHaveLength(0);
  });

  it("names the search field so it can be reached without sight", () => {
    const screen = mountPeople(vi.fn<() => void>(), "search");

    // `TextInput` is a native host component; the name below is the one RN
    // publishes for it, not a DOM `aria-label` written onto an `<input>`.
    const field = screen.UNSAFE_getAllByType(TextInput);
    expect(field.length).toBeGreaterThan(0);
    expect(
      field.every((node) => typeof node.props.accessibilityLabel === "string")
    ).toBe(true);
  });
});
