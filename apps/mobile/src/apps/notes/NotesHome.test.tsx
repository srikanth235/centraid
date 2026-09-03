import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplicaRow } from "@centraid/client/replica/native";

import NotesHome from "./NotesHome";

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

function seedNotes(
  rows: readonly { body: string; id: string; title: string }[]
) {
  replicaRows.byEntity.set(
    "knowledge.note",
    rows.map(({ id, title }) => ({
      __rowId: id,
      body_content_id: `${id}-body`,
      created_at: "2026-08-01T09:00:00.000Z",
      note_id: id,
      title,
      updated_at: "2026-08-20T09:00:00.000Z",
    }))
  );
  replicaRows.byEntity.set(
    "core.content_item",
    rows.map(({ body, id }) => ({
      __rowId: `${id}-body`,
      content_id: `${id}-body`,
      content_uri: `data:text/markdown,${encodeURIComponent(body)}`,
      media_type: "text/markdown",
    }))
  );
}

function mountNotes() {
  return render(
    <NotesHome
      navigation={{ navigate: vi.fn<() => void>() } as never}
      route={{ params: {} } as never}
    />
  );
}

function selectedTabNames(
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

describe("Notes, on the real React Native host tree", () => {
  beforeEach(() => {
    replicaRows.byEntity.clear();
  });

  it("lights exactly one band place, and moves it on a real press", () => {
    const screen = mountNotes();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(1);
    expect(selectedTabNames(tabs)).toHaveLength(1);

    const other = tabs.find(
      (tab) => tab.props.accessibilityLabel !== selectedTabNames(tabs)[0]
    );
    fireEvent.press(other!);
    expect(selectedTabNames(screen.getAllByRole("tab"))).toStrictEqual([
      other!.props.accessibilityLabel,
    ]);
  });

  it("gives an untitled note a spoken handle rather than an empty name", () => {
    seedNotes([
      { body: "Milk, bread, a new kettle", id: "n1", title: "" },
      { body: "Body text", id: "n2", title: "Kitchen list" },
    ]);
    const screen = mountNotes();

    const names = new Set(
      screen
        .getAllByRole("button")
        .map((node) => node.props.accessibilityLabel as string)
    );
    expect(names).toContain("Open Kitchen list");
    expect(names).toContain("Open Milk, bread, a new kettle");
    expect(names).not.toContain("Open ");
  });

  it("keeps the capture door reachable by name from every place", () => {
    const screen = mountNotes();

    expect(
      screen.getByRole("button", { name: "New note" }).props.accessible
    ).toBe(true);
  });

  it("shows the search field only in Search, and names it", () => {
    const screen = mountNotes();
    expect(screen.queryByLabelText("Search notes")).toBeNull();

    fireEvent.press(screen.getByRole("tab", { name: "Search" }));
    expect(screen.getByLabelText("Search notes").props.accessibilityLabel).toBe(
      "Search notes"
    );
  });

  it("renders the empty library through the list's empty slot, with no rows behind it", () => {
    const screen = mountNotes();

    expect(
      screen
        .getAllByRole("button")
        .filter((node) =>
          String(node.props.accessibilityLabel).startsWith("Open ")
        )
    ).toHaveLength(0);
  });
});
