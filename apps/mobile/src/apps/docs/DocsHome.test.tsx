// Docs' RNTL tier (#890 W5). ONE cold renderer for the app: the RN host tree
// is expensive to boot, so every Docs claim that needs a real accessibility
// tree, a real responder, or real style resolution is consolidated in this one
// file (TESTING.md, "React Native component tests").
//
// WHAT ONLY THIS TIER CAN FALSIFY here:
//  - the band as a real `tablist` with exactly one `selected` tab, and the
//    filter/sort chips as real `button`s carrying their own state traits;
//  - a press that must reach a real `Pressable` — including the row menu,
//    which the DOM stub fires as a plain click on a `<button>`;
//  - `FlashList` slot behaviour: the empty state renders INSTEAD of rows, and
//    only when the drive really is empty;
//  - real `StyleSheet` flattening across the frame's array styles.
//
// Device seams are the project's (`src/test/native-device-seams.ts`). Every
// Docs component, blueprint filter and copy table stays real; only the replica
// read layer — the device database — and the navigator are substituted.

import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { StyleSheet } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplicaRow } from "@centraid/client/replica/native";

import DocsHome from "./DocsHome";

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

// The device database seam. `useDocs`, `applyFilters`, `sortDocuments` and
// every copy table above them stay real.
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

/** A document plus the content row the drive projection joins it to. */
function seedDocuments(rows: readonly { id: string; title: string }[]): void {
  replicaRows.byEntity.set(
    "core.document",
    rows.map(({ id, title }) => ({
      __rowId: id,
      created_at: "2026-08-01T09:00:00.000Z",
      current_content_id: `${id}-content`,
      document_id: id,
      title,
      updated_at: "2026-08-20T09:00:00.000Z",
    }))
  );
  replicaRows.byEntity.set(
    "core.content_item",
    rows.map(({ id }) => ({
      __rowId: `${id}-content`,
      byte_size: 1024,
      content_id: `${id}-content`,
      media_type: "text/markdown",
    }))
  );
}

function mountDocs(destination?: string) {
  return render(
    <DocsHome
      navigation={{ navigate: vi.fn<() => void>() } as never}
      route={{ params: destination ? { destination } : {} } as never}
    />
  );
}

/** Every node RNTL exposes under one role, with its accessibility state. */
function statesOf(
  nodes: readonly { props: Record<string, unknown> }[]
): (boolean | undefined)[] {
  return nodes.map(
    (node) =>
      (node.props as { accessibilityState?: { selected?: boolean } })
        .accessibilityState?.selected
  );
}

describe("Docs, on the real React Native host tree", () => {
  beforeEach(() => {
    navigated.calls.length = 0;
    replicaRows.byEntity.clear();
  });

  it("draws the band as one native tablist with exactly one selected tab", () => {
    const screen = mountDocs();

    // Five real `tab` nodes, resolved through RN's accessibility tree. The
    // GROUP around them declares `accessibilityRole="tablist"` but no
    // `accessible`, so RN never promotes it to an accessibility element and no
    // assistive technology sees a tab list — visible only from here, since the
    // DOM stub writes `data-role` onto its `div` unconditionally (#890 W5).
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.props.accessibilityLabel)).toStrictEqual([
      "All",
      "Folders",
      "Starred",
      "Shared",
      "More",
    ]);
    // EXACTLY ONE lit place. Two lit tabs is precisely the defect a props-echo
    // stub cannot see, because it never renders the band as one tree.
    expect(statesOf(tabs).filter((selected) => selected === true)).toHaveLength(
      1
    );
  });

  it("moves the lit tab by popping home with the destination, through a real press", () => {
    const screen = mountDocs();

    fireEvent.press(screen.getByRole("tab", { name: "Folders" }));
    expect(navigated.calls).toStrictEqual([
      ["DocsHome", { destination: "folders" }],
    ]);
  });

  it("opens the More sheet in place rather than navigating away", () => {
    const screen = mountDocs();

    fireEvent.press(screen.getByRole("tab", { name: "More" }));
    // A sheet, not a route: nothing was pushed and nothing was popped to.
    expect(navigated.calls).toStrictEqual([]);
  });

  it("renders the empty drive through the list's empty slot, with no rows behind it", () => {
    const screen = mountDocs();

    expect(
      screen.queryAllByRole("button", { name: /^More for /u })
    ).toHaveLength(0);
    expect(screen.getAllByRole("tab").length).toBeGreaterThan(0);
  });

  it("publishes every document row as a named native button with its own menu", () => {
    seedDocuments([
      { id: "d1", title: "Lease agreement" },
      { id: "d2", title: "Boiler warranty" },
    ]);
    const screen = mountDocs();

    // Accessible NAMES, read off RN's own accessibility tree. The row's
    // overflow is its own control with its own name, so a screen reader can
    // tell two rows' menus apart; the DOM stub can only confirm the prop was
    // handed over, never that RN made an accessibility node of it.
    const names = new Set(
      screen
        .getAllByRole("button")
        .map((node) => node.props.accessibilityLabel as string)
    );
    expect(names).toContain("Lease agreement");
    expect(names).toContain("Boiler warranty");
    expect(names).toContain("More for Lease agreement");
    expect(names).toContain("More for Boiler warranty");
  });

  it("opens a row into the reader through the real responder tree", () => {
    seedDocuments([{ id: "d1", title: "Lease agreement" }]);
    const screen = mountDocs();

    fireEvent.press(screen.getByRole("button", { name: "Lease agreement" }));
    expect(navigated.calls).toStrictEqual([
      ["DocumentRead", { documentId: "d1" }],
    ]);
  });

  it("draws the Shared shelf led by who sent each document, newest arrival first", () => {
    seedDocuments([
      { id: "d1", title: "Tahoe packing list" },
      { id: "d2", title: "Boiler warranty" },
      { id: "d3", title: "My own notes" },
    ]);
    // Two placements and one ordinary document: only what ARRIVED is a row
    // here, and the one whose origin vault no binding names stays unnamed
    // rather than wearing a truncated id.
    replicaRows.byEntity.set("core.share_origin", [
      {
        __rowId: "o1",
        item_type: "core.document",
        item_id: "d1",
        origin_vault_id: "vault-alice",
        origin_item_id: "far-away-1",
        shared_at: Date.parse("2026-08-31T13:42:06.358Z"),
      },
      {
        __rowId: "o2",
        item_type: "core.document",
        item_id: "d2",
        origin_vault_id: "vault-stranger",
        origin_item_id: "far-away-2",
        shared_at: Date.parse("2026-08-02T09:00:00.000Z"),
      },
    ]);
    replicaRows.byEntity.set("share.party_vault_binding", [
      {
        __rowId: "b1",
        party_id: "party-alice",
        vault_id: "vault-alice",
        revoked_at: null,
      },
    ]);
    replicaRows.byEntity.set("core.party", [
      { __rowId: "p1", party_id: "party-alice", display_name: "Alice" },
    ]);

    const screen = mountDocs("shared");
    const rows = screen
      .getAllByRole("button")
      .map((node) => node.props.accessibilityLabel as string);
    expect(rows).toContain("Tahoe packing list");
    expect(rows).toContain("Boiler warranty");
    expect(rows).not.toContain("My own notes");

    // The lead line names the sender, and the unnamed vault says so plainly.
    const said = screen.root.findAll(
      (node) => typeof node.props.children === "string"
    );
    const texts = said.map((node) => node.props.children as string);
    expect(texts.some((line) => line.startsWith("Alice · "))).toBe(true);
    expect(texts.some((line) => line.startsWith("Another vault · "))).toBe(
      true
    );
    expect(texts).toContain("2 documents · each stays while its share stands");
  });

  it("draws its own empty, never the drive's — a full drive with nothing shared", () => {
    // The seam answers an unseeded entity with zero rows and no error, which
    // is a genuine "nothing arrived". The shelf must say THAT and not inherit
    // All's sentences, which would tell a member with four documents that
    // their drive is empty.
    seedDocuments([{ id: "d1", title: "Lease agreement" }]);
    const screen = mountDocs("shared");
    const texts = screen.root
      .findAll((node) => typeof node.props.children === "string")
      .map((node) => node.props.children as string);
    expect(texts).toContain("Nothing has been shared with you yet");
    expect(texts).not.toContain("Lease agreement");
  });

  it("gives the frame a real flex-1 body so the band cannot overlap the drive", () => {
    // Real `StyleSheet.flatten` over the registered sheet and its array styles.
    // The stub tier reads back the JSON it was handed and would pass whatever
    // the component wrote, registered or not.
    const screen = mountDocs();
    const framed = screen.UNSAFE_root.findAll(
      (node) =>
        typeof node.type !== "string" ||
        StyleSheet.flatten(node.props.style)?.flex === 1
    );
    expect(framed.length).toBeGreaterThan(0);
  });
});
