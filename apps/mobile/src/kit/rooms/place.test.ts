// WHERE A SCREEN IS, AS A VALUE (#1015, S1/S2 — audit B7). `place.ts` is
// framework-free, so its own test is too: no jsdom, no React Native stub.
// The rooms that RENDER a `PlaceRef` are pinned in `rooms.test.tsx`.
import { describe, expect, it } from "vitest";

import { currentPlace, parentPlace, placeStack } from "./place";

const stack = placeStack([
  { key: "DocsHome", title: "All" },
  { key: "DocsFolder", title: "Taxes" },
  { key: "DocumentViewer", title: "2024 return" },
]);

describe(parentPlace, () => {
  it("names the parent the screen actually descends from", () => {
    expect(parentPlace(stack)?.title).toBe("Taxes");
    expect(currentPlace(stack)?.title).toBe("2024 return");
  });

  it("has no parent at the root, and says so rather than guessing", () => {
    expect(parentPlace(stack.slice(0, 1))).toBeUndefined();
  });
});
