// THE KEYBOARD IS THE ROOM'S (#1015, R-A-17; agenda/findings#15).
//
// Both Agenda forms autofocused a text field and then let the keyboard sit
// over their own foot: the first tap on Done or on a chip was spent dismissing
// it, and the Guests rail — the bottom third of the composer — was behind it
// with no inset to scroll it clear. Locker, Photos, Automations and Assistant
// each solved a piece of that separately, which is four contracts for one
// keyboard.
//
// So it is settled once, in the two rooms that hold fields: they avoid it, and
// leaving by any door takes it with them.
// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  keyboardDismissals,
  mountBlock,
  nodesOf,
  press,
} from "../../test/react-native-stub";
import { EditorRoom, SheetRoom } from "./index";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
// `StageRoom` reaches both through the rooms barrel (R-NY-14).
vi.mock(import("react-native-gesture-handler"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.gestureHandlerStub() as unknown as typeof import("react-native-gesture-handler");
});
vi.mock(import("react-native-reanimated"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reanimatedStub() as unknown as typeof import("react-native-reanimated");
});

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

function sourceOf(file: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8");
}

describe("the two rooms that hold fields", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it.each(["EditorRoom.tsx", "SheetRoom.tsx"])(
    "%s avoids the keyboard itself",
    (file) => {
      expect(sourceOf(file)).toContain("KeyboardAvoidingView");
    }
  );

  it("takes the keyboard with it when an editor is left", () => {
    const before = keyboardDismissals.count;
    let left = 0;
    const container = render(
      <EditorRoom
        onDone={() => {
          left += 1;
        }}
        title="Note"
      />
    );
    press(nodesOf(container, "button").at(-1));
    expect(left).toBe(1);
    expect(keyboardDismissals.count).toBe(before + 1);
  });

  it("takes the keyboard with it through either of a sheet's doors", () => {
    const before = keyboardDismissals.count;
    let closed = 0;
    const container = render(
      <SheetRoom
        onClose={() => {
          closed += 1;
        }}
        title="Delete photo?"
        visible
      />
    );
    // The scrim is the first door; the quiet word is the other.
    const buttons = nodesOf(container, "button");
    press(buttons[0]);
    press(buttons.find((node) => node.textContent === "Cancel"));
    expect(closed).toBe(2);
    expect(keyboardDismissals.count).toBe(before + 2);
  });
});
