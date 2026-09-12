// THE SEVENTH ROOM (#1015, R-NY-14). What is pinned here is what a stage may
// no longer decide: the ground's colour, that there is always a visible way
// out, that every way out is the SAME act, and that the ground stays
// full-bleed while the chrome carries the insets.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import type { StubDrag } from "../../test/react-native-stub";
import { pageMargin, targetMin } from "../theme";
import { StageRoom } from "./index";
import type { StageChrome, StageRoomProps } from "./index";
import { styles as roomStyles } from "./rooms.styles";
import { stageSwipeOutcome } from "./stage-gesture";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
// The stage runs UNDER the notch, so the inset is a real number here: a zero
// inset cannot tell "the chrome is inset" apart from "nothing is inset".
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 59 }),
}));
// The recogniser records the one thing a drag ends in, so the test can finish
// a real drag on the room and watch what it does. A gesture is still a control.
// Hoisted, because a `vi.mock` factory runs before every other binding here.
const gesture = vi.hoisted(() => ({
  drag: undefined as ((event: StubDrag) => void) | undefined,
}));

vi.mock(import("react-native-gesture-handler"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.gestureHandlerStub(
    gesture
  ) as unknown as typeof import("react-native-gesture-handler");
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

/** A caller's chrome, reduced to the one control every stage owes a member. */
const closeControl = ({ close }: StageChrome): React.JSX.Element => (
  <button onClick={close} type="button">
    Close
  </button>
);

/** The ground itself — inside the gesture detector, which is the outer node. */
const ground = (container: HTMLElement): HTMLElement =>
  container.firstElementChild?.firstElementChild as HTMLElement;

describe(StageRoom, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("takes its ground from the theme, never from a literal", () => {
    const style = styleOf(ground(render(<StageRoom onClose={noop} />)));
    // The resolved `--stage`, not a hex written down in this tree: the source
    // of the value is the theme, and the room's own sheet carries no colour.
    expect(style.backgroundColor).toBeTypeOf("string");
    expect(style.backgroundColor).not.toBe("");
    expect(JSON.stringify(roomStyles.stage)).not.toMatch(/#|rgb/u);
  });

  it("runs full-bleed: the ground takes no gutter and no safe-area inset", () => {
    // A SafeAreaView here would letterbox the media. The inset belongs to the
    // controls on the stage, never to the stage.
    const style = styleOf(ground(render(<StageRoom onClose={noop} />)));
    expect(style.paddingTop).toBeUndefined();
    expect(style.paddingHorizontal).toBeUndefined();
    expect(roomStyles.stage).toStrictEqual({ flex: 1 });
  });

  it("draws its own close key when a caller brings no chrome", () => {
    // A stage with no visible way out is a black screen, so the room draws
    // one rather than trusting a caller to.
    const container = render(<StageRoom onClose={noop} />);
    const key = nodesOf(container, "button")[0];
    expect(key?.getAttribute("aria-label")).toBe("Close");
    // A DECLARATION, not a measured target (the stub renders no native
    // layout): the room asks for the touch floor rather than leaving it open.
    expect(styleOf(key).minHeight).toBe(targetMin.coarse);
    // Below the notch, and on the page gutter — the room's one inset.
    expect(styleOf(key?.parentElement).paddingTop).toBe(59);
    expect(roomStyles.stageHead.paddingHorizontal).toBe(pageMargin);
  });

  it("that key performs the room's close act", () => {
    const closed: string[] = [];
    const container = render(
      <StageRoom onClose={() => closed.push("close")} />
    );
    press(nodesOf(container, "button")[0]);
    expect(closed).toStrictEqual(["close"]);
  });

  it("hands a caller's chrome the SAME close act, and draws no key of its own", () => {
    // So a chrome cannot invent a second way back — the whole reason `close`
    // is handed rather than left to the caller's own navigation.
    const closed: string[] = [];
    let handed: StageChrome | undefined;
    const container = render(
      <StageRoom
        chrome={(stage) => {
          handed = stage;
          return closeControl(stage);
        }}
        onClose={() => closed.push("close")}
      />
    );
    expect(nodesOf(container, "button")).toHaveLength(1);
    handed?.close();
    expect(closed).toStrictEqual(["close"]);
  });

  it("leaves on a swipe down — the same act the close control performs", () => {
    const acts: string[] = [];
    render(
      <StageRoom
        chrome={closeControl}
        onClose={() => acts.push("close")}
        onSwipeUp={() => acts.push("up")}
      />
    );
    gesture.drag?.({ translationY: 160, velocityY: 0 });
    expect(acts).toStrictEqual(["close"]);
    gesture.drag?.({ translationY: -160, velocityY: 0 });
    expect(acts).toStrictEqual(["close", "up"]);
    // A steadying nudge is not an act — the photograph stays.
    gesture.drag?.({ translationY: 20, velocityY: 100 });
    expect(acts).toStrictEqual(["close", "up"]);
  });

  it("does nothing upward for a stage with no second act", () => {
    // Not a silent close: a stage whose caller has nothing above it must not
    // borrow the dismiss for the other direction.
    const acts: string[] = [];
    render(<StageRoom onClose={() => acts.push("close")} />);
    gesture.drag?.({ translationY: -160, velocityY: 0 });
    expect(acts).toStrictEqual([]);
  });

  it("paints the media, then the chrome, then the overlay", () => {
    // Paint order is what puts the chrome ON the stage: `zIndex` alone is not
    // enough on every Android surface, and the stage's own sheets go over both.
    const container = render(
      <StageRoom
        chrome={() => <span data-slot="chrome" />}
        onClose={noop}
        overlay={<span data-slot="overlay" />}
      >
        <span data-slot="media" />
      </StageRoom>
    );
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-slot]")].map(
        (node) => node.dataset.slot
      )
    ).toStrictEqual(["media", "chrome", "overlay"]);
  });

  it("draws nothing of its own over a caller's stage", () => {
    // R-NY-14: no PlaceHeader, no band, no room state. The photograph IS the
    // screen, so the ground's only children are the three the caller handed
    // it — anything else the room drew would be a second ground on top of the
    // media. (The props type is the other half: a `title` or `band` written
    // here does not compile.)
    const props: StageRoomProps = {
      chrome: () => <span data-slot="chrome" />,
      children: <span data-slot="media" />,
      onClose: noop,
      overlay: <span data-slot="overlay" />,
    };
    const stage = ground(render(<StageRoom {...props} />));
    expect([...stage.children].map((node) => node.tagName)).toStrictEqual([
      "SPAN",
      "SPAN",
      "SPAN",
    ]);
  });
});

describe(stageSwipeOutcome, () => {
  it("leaves the stage on a long drag down or a flick down", () => {
    expect(stageSwipeOutcome(160, 0)).toBe("dismiss");
    expect(stageSwipeOutcome(10, 1200)).toBe("dismiss");
  });

  it("hands the caller its second act on the same drag upward", () => {
    expect(stageSwipeOutcome(-160, 0)).toBe("up");
    expect(stageSwipeOutcome(-10, -1200)).toBe("up");
  });

  it("does nothing at all for the member steadying the photograph", () => {
    // The threshold is the whole safety: a stage that left on a 20pt nudge
    // would lose the photograph on every scroll that was not one.
    expect(stageSwipeOutcome(20, 100)).toBeNull();
    expect(stageSwipeOutcome(-20, -100)).toBeNull();
    expect(stageSwipeOutcome(0, 0)).toBeNull();
  });

  it("leaves rather than opens when a flick asks for both", () => {
    // Down is the act the stage PROMISES, so it wins the tie.
    expect(stageSwipeOutcome(160, -1200)).toBe("dismiss");
  });
});
