// The one confirm (#1015, S7). Five confirm shapes plus "no confirm" across
// nine surfaces; what is pinned here is the noun in the title, the outlined
// destructive verb, and the fact that nothing happens until it is answered.
// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hapticsStub } from "../../test/haptics-stub";
import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import ConfirmSheet, {
  confirmTitle,
  useConfirmDestructive,
} from "./ConfirmSheet";

vi.mock(import("expo-haptics"), () => hapticsStub());

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

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const noop = (): void => undefined;

const words = (container: HTMLElement): string[] =>
  nodesOf(container, "span").map((node) => node.textContent ?? "");

/** The landing buzz, counted through the real channel — the `expo-haptics`
 *  seam above is the only stand-in. Imported inside the test rather than at
 *  the top: a static import here would run the mock factory before
 *  `hapticsStub` itself had been initialised. */
async function landings(): Promise<number> {
  const haptics = await import("expo-haptics");
  return vi.mocked(haptics.notificationAsync).mock.calls.length;
}

/** The sheet's own destructive control, by the verb it prints. */
const verbButton = (container: HTMLElement, verb: string): HTMLElement => {
  const found = nodesOf(container, "button").find((node) =>
    (node.textContent ?? "").includes(verb)
  );
  if (!found) throw new Error(`no control says "${verb}"`);
  return found;
};

describe(confirmTitle, () => {
  it("puts the noun and the count in the question", () => {
    expect(confirmTitle("Delete", "photo")).toBe("Delete photo?");
    expect(confirmTitle("Delete", "photo", 3)).toBe("Delete 3 photos?");
  });
});

describe(ConfirmSheet, () => {
  beforeEach(async () => {
    const haptics = await import("expo-haptics");
    vi.mocked(haptics.notificationAsync).mockClear();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("asks with the noun and does nothing until it is answered", () => {
    const confirmed = vi.fn<() => void>();
    const container = render(
      <ConfirmSheet
        noun="document"
        count={2}
        onClose={noop}
        onConfirm={confirmed}
        verb="Delete"
        visible
      />
    );
    expect(words(container)).toContain("Delete 2 documents?");
    expect(confirmed).not.toHaveBeenCalled();
  });

  it("buzzes when the write resolves, never on the press alone", async () => {
    let land = (): void => undefined;
    const container = render(
      <ConfirmSheet
        noun="photo"
        onClose={noop}
        onConfirm={() =>
          new Promise<void>((resolve) => {
            land = resolve;
          })
        }
        verb="Delete"
        visible
      />
    );
    press(verbButton(container, "Delete"));
    await act(async () => undefined);
    // The sheet is closed and the photo is not gone yet: nothing to feel.
    await expect(landings()).resolves.toBe(0);
    await act(async () => {
      land();
    });
    await expect(landings()).resolves.toBe(1);
  });

  it("stays silent when the write fails — nothing landed", async () => {
    const container = render(
      <ConfirmSheet
        noun="photo"
        onClose={noop}
        onConfirm={() => Promise.reject(new Error("gateway"))}
        verb="Delete"
        visible
      />
    );
    press(verbButton(container, "Delete"));
    await act(async () => undefined);
    await expect(landings()).resolves.toBe(0);
  });

  it("keeps the destructive verb outlined, never the view's filled commit", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "ConfirmSheet.tsx"),
      "utf8"
    );
    expect(source).toContain("dangerous: true");
  });
});

describe(useConfirmDestructive, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("is quiet until something is asked, then carries the question", () => {
    function Host(): React.JSX.Element {
      const { confirmDestructive, confirmSheet } = useConfirmDestructive();
      return (
        <>
          <button
            onClick={() =>
              confirmDestructive({
                noun: "expense",
                onConfirm: noop,
                verb: "Delete",
              })
            }
            type="button"
          >
            ask
          </button>
          {confirmSheet}
        </>
      );
    }
    const container = render(<Host />);
    expect(words(container)).not.toContain("Delete expense?");
    press(nodesOf(container, "button")[0]);
    expect(words(container)).toContain("Delete expense?");
  });
});
