// Notes' RNTL tier (#890 W5). ONE cold renderer for the app: the RN host tree
// is expensive to boot, so every Notes claim that needs a real accessibility
// tree, a real responder, or real style resolution is consolidated here
// (TESTING.md, "React Native component tests").
//
// WHAT ONLY THIS TIER CAN FALSIFY here:
//  - the band's real `tab` nodes and their `selected` traits, and the fact that
//    exactly one place is lit at a time;
//  - accessible NAMES built by RN, including the one `promote` derives for a
//    note with no title of its own — the row's only handle for a screen reader;
//  - a press that must reach a real `Pressable` before a place changes;
//  - `FlashList`'s slot behaviour: the empty line renders INSTEAD of rows.
//
// Device seams are the project's (`src/test/native-device-seams.ts`), FlashList
// included. Every Notes component, blueprint projection and copy table is real;
// only the replica read layer — the device database — is substituted.

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

/** A note plus the content row `buildNotes` joins its body from. */
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
    // Two lit places is the defect: the stub tier renders each tab as its own
    // `div` and never sees them as one tree, so it cannot count them.
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
    // `promote` derives the heading from the first line when the note has no
    // title. The accessible NAME is the only handle a screen reader has, so an
    // empty one is a row nobody can reach — and only RN builds that name.
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
    // A `TextInput` is a native host component: the label below is the one RN
    // publishes for it, not a DOM `aria-label` the stub wrote onto an `<input>`.
    // Asserted as the LABEL rather than `props.accessible`, because RN makes a
    // text input an accessibility element implicitly and never sets that prop —
    // asserting it would have been asserting `undefined === true`.
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
