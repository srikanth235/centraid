// The note is TERTIARY INK AT THE BODY RUNG, and that pairing is the whole
// component (#765, spec §8): what recedes is its colour, never its size — a
// note is read once and has to be readable. A future edit that "quietens" it
// by dropping to the small rung fails here.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import NoteBlock from "./NoteBlock";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});

const colors = resolveTheme("light").colors;

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

describe(NoteBlock, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("recedes by colour, at the body rung", () => {
    const container = render(
      <NoteBlock text="A standing grant skips this page." />
    );
    const [note] = nodesOf(container, "span");
    const style = styleOf(note ?? null);
    expect(note?.textContent).toBe("A standing grant skips this page.");
    expect(style.color).toBe(colors.textFaint);
    expect(style.fontSize).toBe(resolveTheme("light").type.body.fontSize);
  });

  it("bounds its measure, so a note never becomes a column of text", () => {
    const container = render(<NoteBlock text="x" />);
    expect(styleOf(nodesOf(container, "span")[0] ?? null).maxWidth).toBe(520);
  });
});
