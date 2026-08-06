// Gesture construction lives outside the components on purpose. `Gesture.Pinch()`
// & friends are capitalised factories that then get *mutated* by the builder
// chain (`.onStart(...)`), which is exactly the shape the React compiler rejects
// inside a render body. The compiler only analyses components and hooks, so a
// plain lowercase module-level helper is both legal and identical at runtime —
// the closed-over shared values / callbacks are passed in explicitly, and the
// Reanimated babel plugin still workletises the handler bodies (it keys off the
// `.onStart`/`.onUpdate`/`.onEnd` call chain, not the enclosing function).

import { Gesture } from "react-native-gesture-handler";
import { runOnJS, withTiming } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";

import { ZOOM_FIT, ZOOM_MAX, ZOOM_RUNG, isZoomed } from "./viewer-model";

/** The photograph's offset from centre, in pixels of the laid-out frame. */
export interface PanOffset {
  x: SharedValue<number>;
  y: SharedValue<number>;
}

/**
 * How far the photograph may travel before its own edge would come inside the
 * frame. At `scale` the media is `size × scale` wide inside a `size` window, so
 * exactly half the overflow is available in each direction — and at fit there
 * is no overflow, so the extent is zero and the drag cannot move anything.
 *
 * A `worklet` directive because it is called from the UI thread inside the pan
 * handler; without it the whole gesture would be shipped back to JS per frame.
 */
function panExtent(size: number, scale: number): number {
  "worklet";
  return Math.max(0, (size * scale - size) / 2);
}

function clamp(value: number, extent: number): number {
  "worklet";
  return Math.max(-extent, Math.min(extent, value));
}

/**
 * Pinch-to-zoom, double-tap-to-toggle, and — while zoomed — drag-to-pan,
 * clamped to 1×–5× and to the scaled photograph's own bounds.
 *
 * THE PAN IS NOT DECORATION: the readout promises `240% · drag to pan`, and
 * for the whole of v3 that was a lie — the transform was scale-only, so a
 * magnified photograph could only ever show its own middle. A promise printed
 * in the status line is a contract, so either the drag moves the photograph or
 * the words come off the screen.
 *
 * The pan follows `photo-edit-gestures.ts`'s shape (accumulate on the UI
 * thread, clamp there, and never round-trip per frame) — the difference being
 * that the crop box is React state while this offset stays a shared value: the
 * only reader is the transform itself.
 *
 * `onSettle` carries the resting scale back to the JS thread so the viewer can
 * print an exact readout. A zoom the member cannot read a number for is a state
 * they cannot describe or undo.
 */
export function buildZoomGesture({
  scale,
  startScale,
  offset,
  frame,
  panEnabled,
  onSettle,
}: {
  scale: SharedValue<number>;
  startScale: SharedValue<number>;
  offset: PanOffset;
  /** The laid-out media box. The clamp is in ITS pixels, not the screen's. */
  frame: { width: number; height: number };
  /**
   * Only while zoomed. A pan recogniser that is live at fit ACTIVATES on the
   * horizontal drag and cancels the pager underneath it — the swipe to the next
   * photograph would die to a control that has nothing to move. Driven by the
   * settled JS scale, which is exactly the state the readout is printed from,
   * so the pan is available precisely when the words say it is.
   */
  panEnabled: boolean;
  onSettle?: (scale: number) => void;
}): ReturnType<typeof Gesture.Simultaneous> {
  const start = { x: 0, y: 0 };
  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate(({ scale: nextScale }) => {
      scale.value = Math.max(
        ZOOM_FIT,
        Math.min(ZOOM_MAX, startScale.value * nextScale)
      );
      // Zooming BACK OUT has to reel the photograph in as it goes, or the
      // offset that was legal at 4× strands the frame off-centre at 1.2×.
      offset.x.value = clamp(
        offset.x.value,
        panExtent(frame.width, scale.value)
      );
      offset.y.value = clamp(
        offset.y.value,
        panExtent(frame.height, scale.value)
      );
    })
    .onEnd(() => {
      if (onSettle) runOnJS(onSettle)(scale.value);
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd(() => {
      const next = isZoomed(scale.value) ? ZOOM_FIT : ZOOM_RUNG;
      scale.value = withTiming(next);
      // Returning to fit returns to the CENTRE. Anything else would leave the
      // member at 100% looking at a photograph shoved to one side.
      if (next === ZOOM_FIT) {
        offset.x.value = withTiming(0);
        offset.y.value = withTiming(0);
      }
      if (onSettle) runOnJS(onSettle)(next);
    });
  const pan = Gesture.Pan()
    .enabled(panEnabled)
    // A single finger only: the second finger belongs to the pinch, which runs
    // simultaneously and would otherwise fight this for the same touches.
    .maxPointers(1)
    .onStart(() => {
      start.x = offset.x.value;
      start.y = offset.y.value;
    })
    .onUpdate(({ translationX, translationY }) => {
      offset.x.value = clamp(
        start.x + translationX,
        panExtent(frame.width, scale.value)
      );
      offset.y.value = clamp(
        start.y + translationY,
        panExtent(frame.height, scale.value)
      );
    });
  return Gesture.Simultaneous(pinch, doubleTap, pan);
}

/**
 * The pointer equivalent of the double tap. Lives here, next to the gesture,
 * for the same reason the builders do: writing a shared value from a render
 * body is exactly the mutation the React compiler rejects.
 *
 * Returning to fit re-centres, for the same reason the double tap does.
 */
export function applyZoom(
  scale: SharedValue<number>,
  next: number,
  offset?: PanOffset
): void {
  scale.value = withTiming(next);
  if (offset && !isZoomed(next)) {
    offset.x.value = withTiming(0);
    offset.y.value = withTiming(0);
  }
}

/**
 * The vertical drag, both ways: down leaves the viewer, up opens the info sheet
 * (§7.2). One recogniser rather than two, because two Pans over the same stage
 * would race and the loser would swallow the drag.
 *
 * Neither direction is the only way to its destination — Close and Info are
 * both controls in the bars, so nothing here is reachable by gesture alone.
 */
export function buildDismissGesture(
  onDismiss: () => void,
  onInfo?: () => void
): ReturnType<typeof Gesture.Pan> {
  return Gesture.Pan()
    .activeOffsetY([-24, 24])
    .failOffsetX([-24, 24])
    .onEnd(({ translationY, velocityY }) => {
      if (translationY > 120 || velocityY > 900) runOnJS(onDismiss)();
      else if (onInfo && (translationY < -120 || velocityY < -900))
        runOnJS(onInfo)();
    });
}
