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
    expect(litTabs(tabs)).toHaveLength(1);

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

    const field = screen.UNSAFE_getAllByType(TextInput);
    expect(field.length).toBeGreaterThan(0);
    expect(
      field.every((node) => typeof node.props.accessibilityLabel === "string")
    ).toBe(true);
  });
});
