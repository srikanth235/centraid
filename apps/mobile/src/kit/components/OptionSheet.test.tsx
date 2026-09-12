// THE SINGLE-CHOICE LIST, ON BOTH ITS PLATFORMS (#1015, R-A-16).
//
// `OptionSheet` is two components behind one prop set: `ActionSheetIOS` on
// iOS, an RN `Modal` on Android. What this pins is that the two of them agree
// about the thing a member most needs from a single-choice list — which option
// is already theirs. The iOS branch used to drop `selectedId` on the floor.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import OptionSheet from "./OptionSheet";

const shown = vi.hoisted(() => ({
  calls: [] as { options: string[]; disabled?: number[] }[],
  choose: undefined as ((index: number) => void) | undefined,
}));

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    ActionSheetIOS: {
      showActionSheetWithOptions: (
        config: { options: string[]; disabledButtonIndices?: number[] },
        callback: (index: number) => void
      ) => {
        shown.calls.push({
          options: config.options,
          ...(config.disabledButtonIndices
            ? { disabled: config.disabledButtonIndices }
            : {}),
        });
        shown.choose = callback;
      },
    },
  } as unknown as typeof import("react-native");
});

const LEADS = [
  { id: "0", label: "Same day", detail: "On the day" },
  { id: "2", label: "2 days", detail: "Ahead of the day" },
  { id: "7", label: "1 week", detail: "Ahead of the day" },
];

let dispose: (() => void) | undefined;

const reset = (): void => {
  dispose?.();
  dispose = undefined;
  shown.calls = [];
  shown.choose = undefined;
};

describe("the single-choice sheet", () => {
  afterEach(reset);

  it("marks the member's current choice on iOS", () => {
    // The stub's `Platform.OS` is "ios", so this IS the system-sheet branch.
    const mounted = mountBlock(
      <OptionSheet
        onClose={() => undefined}
        onSelect={() => undefined}
        options={LEADS}
        selectedId="2"
        title="Birthday reminder"
        visible
      />
    );
    dispose = mounted.unmount;
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0]?.options).toStrictEqual([
      "Same day — On the day",
      "2 days — Ahead of the day ✓",
      "1 week — Ahead of the day",
      "Cancel",
    ]);
  });

  it("marks nothing when nothing is chosen yet", () => {
    const mounted = mountBlock(
      <OptionSheet
        onClose={() => undefined}
        onSelect={() => undefined}
        options={LEADS}
        title="Birthday reminder"
        visible
      />
    );
    dispose = mounted.unmount;
    expect(shown.calls[0]?.options.join("|")).not.toContain("✓");
  });

  it("still refuses a listed-but-unchoosable option", () => {
    const chosen: string[] = [];
    const mounted = mountBlock(
      <OptionSheet
        onClose={() => undefined}
        onSelect={(id) => chosen.push(id)}
        options={[LEADS[0]!, { ...LEADS[1]!, disabled: true }]}
        selectedId="0"
        title="Birthday reminder"
        visible
      />
    );
    dispose = mounted.unmount;
    expect(shown.calls[0]?.disabled).toStrictEqual([1]);
    shown.choose?.(1);
    expect(chosen).toStrictEqual([]);
    shown.choose?.(0);
    expect(chosen).toStrictEqual(["0"]);
  });
});

describe("the same sheet on Android", () => {
  afterEach(reset);

  it("marks the current choice and exposes it to the reader", async () => {
    vi.resetModules();
    vi.doMock(import("react-native"), async () => {
      const stub = await import("../../test/react-native-stub");
      return {
        ...stub.reactNativeStub(),
        Platform: {
          OS: "android",
          select: (o: Record<string, unknown>) => o.android,
        },
      } as unknown as typeof import("react-native");
    });
    const { default: AndroidSheet } = await import("./OptionSheet");
    const mounted = mountBlock(
      <AndroidSheet
        onClose={() => undefined}
        onSelect={() => undefined}
        options={LEADS}
        selectedId="2"
        title="Birthday reminder"
        visible
      />
    );
    dispose = mounted.unmount;
    const rows = nodesOf(mounted.container, "button").filter(
      (node) => node.getAttribute("aria-label") !== "Dismiss"
    );
    expect(rows[1]?.textContent).toContain("✓");
    expect(rows[0]?.textContent).not.toContain("✓");
    press(rows[0]);
    vi.doUnmock(import("react-native"));
  });
});
