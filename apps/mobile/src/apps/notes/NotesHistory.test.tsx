// Version history on the phone draws through SeatList (#922 E.4). The
// unreadable state is a closed door, not an empty list; a readable chain
// is one list whose header is the status sentence.
// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  HISTORY_UNREADABLE,
  historyStatus,
} from "@centraid/blueprints/apps/notes/view-copy";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import type { NativeNote } from "./notes-model";
import NotesHistory from "./NotesHistory";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@shopify/flash-list"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.flashListStub() as unknown as typeof import("@shopify/flash-list");
});
vi.mock(import("../../kit/hooks/useReplicaQuery"), () => ({
  useReplicaQuery: () => ({
    connection: "current" as const,
    error: undefined,
    loading: false,
    refresh: async () => undefined,
    rows: [
      {
        content_id: "c-head",
        content_uri: "data:text/markdown,The current body",
        media_type: "text/markdown",
      },
    ],
  }),
}));

const NOTE = {
  body: "The current body",
  bodyContentId: "c-head",
  canWrite: true,
  createdAt: "2026-08-01T09:00:00.000Z",
  format: "markdown",
  id: "n1",
  pinned: false,
  rawId: "n1",
  title: "A note",
  trashed: false,
  updatedAt: "2026-08-20T09:00:00.000Z",
} as NativeNote;

const EMPTY_CHAIN = { concepts: [], links: [], schemes: [] };

describe("Notes version history", () => {
  it("names the closed door when the chain could not be read", () => {
    const { container, unmount } = mountBlock(
      <NotesHistory
        chainRows={EMPTY_CHAIN}
        note={NOTE}
        onRestore={() => undefined}
        unreadable
      />
    );
    expect(container.textContent).toContain(HISTORY_UNREADABLE);
    expect(
      nodesOf(container, "div").some((node) => node.dataset.role === "list")
    ).toBe(false);
    unmount();
  });

  it("draws the chain through the seat list, status as the header", () => {
    const { container, unmount } = mountBlock(
      <NotesHistory
        chainRows={EMPTY_CHAIN}
        note={NOTE}
        onRestore={() => undefined}
        unreadable={false}
      />
    );
    const list = nodesOf(container, "div").find(
      (node) => node.dataset.role === "list"
    );
    expect(list?.dataset.label).toBe("Version history");
    expect(container.textContent).toContain(historyStatus(1));
    expect(container.textContent).toContain("The current body");
    unmount();
  });
});
