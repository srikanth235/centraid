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

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.props.accessibilityLabel)).toStrictEqual([
      "All",
      "Folders",
      "Starred",
      "Shared",
      "More",
    ]);
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
    replicaRows.byEntity.set("core.share_origin", [
      {
        __rowId: "o1",
        target_type: "core.document",
        target_id: "d1",
        origin_vault_id: "vault-alice",
        origin_item_id: "far-away-1",
        shared_at: Date.parse("2026-08-31T13:42:06.358Z"),
      },
      {
        __rowId: "o2",
        target_type: "core.document",
        target_id: "d2",
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
    seedDocuments([{ id: "d1", title: "Lease agreement" }]);
    const screen = mountDocs("shared");
    const texts = screen.root
      .findAll((node) => typeof node.props.children === "string")
      .map((node) => node.props.children as string);
    expect(texts).toContain("Nothing has been shared with you yet");
    expect(texts).not.toContain("Lease agreement");
  });

  it("gives the frame a real flex-1 body so the band cannot overlap the drive", () => {
    const screen = mountDocs();
    const framed = screen.UNSAFE_root.findAll(
      (node) =>
        typeof node.type !== "string" ||
        StyleSheet.flatten(node.props.style)?.flex === 1
    );
    expect(framed.length).toBeGreaterThan(0);
  });
});
