// Version history on the phone draws through SeatList (#922 E.4): a readable
// chain is one list whose header is the status sentence.
//
// THE CLOSED DOOR IS NO LONGER HERE (#1015). A chain that could not be read is
// a read that failed, and the room draws that over everything else
// (`RoomBody`); `NotesHome.test.tsx` holds that claim now. This file kept a
// second unreadable state whose only trigger was the same condition.
// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { historyStatus } from "@centraid/blueprints/apps/notes/view-copy";

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
vi.mock(import("./useNoteVersions"), () => ({
  useNoteVersions: () => [
    {
      asserted_at: "2026-08-20T09:00:00.000Z",
      body: "The current body",
      content_id: "c-head",
      current: true,
    },
  ],
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

const EMPTY_CHAIN = { revisions: [] };

describe("Notes version history", () => {
  it("draws the chain through the seat list, status as the header", () => {
    const { container, unmount } = mountBlock(
      <NotesHistory
        chainRows={EMPTY_CHAIN}
        note={NOTE}
        onRestore={() => undefined}
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
