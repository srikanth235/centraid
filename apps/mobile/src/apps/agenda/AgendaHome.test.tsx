import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplicaRow } from "@centraid/client/replica/native";

import AgendaHome from "./AgendaHome";

type SeededRow = ReplicaRow & { __rowId: string };

const replicaRows = vi.hoisted(() => ({
  byEntity: new Map<string, SeededRow[]>(),
}));

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

function seedEvent(summary: string, hour: number): void {
  const day = new Date();
  const start = new Date(day);
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  replicaRows.byEntity.set("core.event", [
    {
      __rowId: "e1",
      dtend: end.toISOString(),
      dtstart: start.toISOString(),
      event_id: "e1",
      status: "confirmed",
      summary,
    },
  ]);
}

function mountAgenda() {
  return render(
    <AgendaHome
      navigation={{ navigate: vi.fn<() => void>() } as never}
      route={{ params: {} } as never}
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

describe("Agenda, on the real React Native host tree", () => {
  beforeEach(() => {
    replicaRows.byEntity.clear();
  });

  it("lights exactly one band place and moves it on a real press", () => {
    const screen = mountAgenda();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(1);
    expect(litTabs(tabs)).toHaveLength(1);

    const elsewhere = tabs.find(
      (tab) => tab.props.accessibilityLabel !== litTabs(tabs)[0]
    );
    fireEvent.press(elsewhere!);
    expect(litTabs(screen.getAllByRole("tab"))).toStrictEqual([
      elsewhere!.props.accessibilityLabel,
    ]);
  });

  it("names an event card with its time, not only its words", () => {
    seedEvent("Dentist", 14);
    const screen = mountAgenda();

    const named = screen
      .getAllByRole("button")
      .map((node) => String(node.props.accessibilityLabel))
      .filter((name) => name.startsWith("Dentist"));
    expect(named).not.toHaveLength(0);
    expect(named[0]).toMatch(/^Dentist, \S/u);
  });

  it("keeps Today and New event reachable by name from the day surface", () => {
    const screen = mountAgenda();

    expect(
      screen.getByRole("button", { name: "Go to today" }).props.accessible
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "New event" }).props.accessible
    ).toBe(true);
  });

  it("opens the create sheet in place rather than pushing a route", () => {
    const navigate = vi.fn<() => void>();
    const screen = render(
      <AgendaHome
        navigation={{ navigate } as never}
        route={{ params: {} } as never}
      />
    );

    fireEvent.press(screen.getByRole("button", { name: "New event" }));
    expect(navigate.mock.calls).toStrictEqual([]);
  });

  it("PINS A DEFECT: labels on plain Views never reach the accessibility tree", () => {
    const screen = mountAgenda();

    expect(screen.getAllByRole("tab").length).toBeGreaterThan(1);
    expect(screen.queryAllByRole("tablist")).toHaveLength(0);
    expect(screen.queryAllByLabelText("Now")).toHaveLength(0);
  });
});
