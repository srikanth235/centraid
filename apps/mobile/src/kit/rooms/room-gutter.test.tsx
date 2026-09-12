// THE GUTTER IS THE ROOM'S, ONCE (#1015, Round NY). The room's own states sat
// outside every padded body, so the error panel ran edge to edge (Activity,
// simulator pass); and EmptyBlock's own gutter, added to cover that, doubled
// inside a system place's padded body (Needs you's empty queue).
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, styleOf } from "../../test/react-native-stub";
import EmptyBlock from "../components/EmptyBlock";
import { pageMargin } from "../theme";
import { SystemPlace } from "./index";
import RoomBody from "./RoomBody";
import { styles as roomStyles } from "./rooms.styles";

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

const noop = (): void => undefined;
const retry = { label: "Try again", onPress: noop };

/** The room state's own wrapper: the first node the body draws. */
const wrapperInset = (container: HTMLElement): unknown =>
  styleOf(container.firstElementChild as HTMLElement | null).paddingHorizontal;

describe(RoomBody, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("insets the room's error panel by the room gutter", () => {
    const container = render(
      <RoomBody error={{ body: "b", retry, title: "Could not read" }} />
    );
    expect(wrapperInset(container)).toBe(pageMargin);
  });

  it("insets the room's loading and empty states by the room gutter", () => {
    expect(
      wrapperInset(render(<RoomBody loading={{ label: "Reading" }} />))
    ).toBe(pageMargin);
    dispose?.();
    dispose = undefined;
    expect(
      wrapperInset(render(<RoomBody empty={{ body: "b", title: "Nothing" }} />))
    ).toBe(pageMargin);
  });

  it("leaves the screen's own content to its own body", () => {
    const container = render(
      <RoomBody>
        <div data-slot="content" />
      </RoomBody>
    );
    expect(wrapperInset(container)).toBeUndefined();
  });

  it("insets an empty drawn inside a place's body once, not twice", () => {
    // The place's scrolling body carries the gutter (the stub draws a
    // ScrollView without its content style, so it is read from the sheet),
    // and the block drawn inside it adds none.
    expect(roomStyles.placeBody.padding).toBe(pageMargin);
    const container = render(
      <SystemPlace title="Needs you">
        <EmptyBlock body="b" routine title="Nothing is waiting on you" />
      </SystemPlace>
    );
    const block = [...container.querySelectorAll("span")].find(
      (node) => node.textContent === "Nothing is waiting on you"
    )?.parentElement;
    expect(block).toBeDefined();
    expect(styleOf(block).paddingHorizontal).toBeUndefined();
    expect(styleOf(block).padding).toBeUndefined();
  });
});
