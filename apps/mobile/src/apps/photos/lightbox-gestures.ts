// Builders live outside components: the chain mutates the factory, which the
// React compiler rejects in a render body (also `applyZoom`).

import { Gesture } from "react-native-gesture-handler";
import { runOnJS, withTiming } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";

import { ZOOM_FIT, ZOOM_MAX, ZOOM_RUNG, isZoomed } from "./viewer-model";

export interface PanOffset {
  x: SharedValue<number>;
  y: SharedValue<number>;
}

function panExtent(size: number, scale: number): number {
  "worklet";
  return Math.max(0, (size * scale - size) / 2);
}

function clamp(value: number, extent: number): number {
  "worklet";
  return Math.max(-extent, Math.min(extent, value));
}

/** The drag is a contract: the readout prints `drag to pan`. */
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
  frame: { width: number; height: number };
  /** Only while zoomed: live at fit, it kills the pager swipe. */
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
      if (next === ZOOM_FIT) {
        offset.x.value = withTiming(0);
        offset.y.value = withTiming(0);
      }
      if (onSettle) runOnJS(onSettle)(next);
    });
  const pan = Gesture.Pan()
    .enabled(panEnabled)
    // One finger: the second belongs to the simultaneous pinch.
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

/** One recogniser for both directions: two Pans here would race. */
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
