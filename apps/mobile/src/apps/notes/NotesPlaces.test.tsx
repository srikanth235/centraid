// The More sheet is a list of places, not a hand-wired map (#922 E.4).
// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { CAPTURE, TAGS } from "@centraid/blueprints/apps/notes/shelves";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import type { NotesMoreRow } from "./notes-band";
import { MoreSheet } from "./NotesPlaces";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@shopify/flash-list"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.flashListStub() as unknown as typeof import("@shopify/flash-list");
});
vi.mock(import("../../kit/components/Icon"), () => ({
  default: () => null,
}));

const ROWS: readonly NotesMoreRow[] = [
  { icon: "Camera", label: "Capture", shelf: CAPTURE },
  { icon: "Tag", label: "Tags", meta: "how a note is seen", shelf: TAGS },
];

describe("Notes More sheet", () => {
  it("draws every place through the seat list", () => {
    const { container, unmount } = mountBlock(
      <MoreSheet onPick={() => undefined} rows={ROWS} />
    );
    const list = nodesOf(container, "div").find(
      (node) => node.dataset.role === "list"
    );
    expect(list?.dataset.label).toBe("More places");
    expect(container.textContent).toContain("Capture");
    expect(container.textContent).toContain("Tags");
    expect(container.textContent).toContain("how a note is seen");
    unmount();
  });
});
