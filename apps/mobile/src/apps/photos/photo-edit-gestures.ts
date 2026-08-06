// The crop box's two gestures, built outside any render body.
//
// Same rule as `lightbox-gestures.ts`: `Gesture.Pan()` is a factory whose
// builder chain MUTATES the object, which is exactly the shape the React
// compiler rejects inside a component. A module-level lowercase helper is legal
// and identical at runtime, and the Reanimated babel plugin still workletises
// the handler bodies because it keys off the `.onUpdate` / `.onEnd` chain.
//
// The crop rectangle itself is plain React state, NOT a shared value: it is
// read by the save path, by the status line and by the ratio buttons, and a
// rectangle that only exists on the UI thread would have to be mirrored back to
// all three. The gestures therefore accumulate a delta on the UI thread and
// hand the finished move to JS once, which is also why a drag cannot flood the
// bridge with a state update per frame.

import { Gesture } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

/**
 * Drag to move the crop box, pinch to grow or shrink it. Deltas arrive in
 * FRACTIONS of the frame, so the callers never see pixels and the model stays
 * resolution-free.
 *
 * `onMove` fires continuously (a drag the box does not follow is a broken
 * control); `onScale` fires once at the end of a pinch with the total factor,
 * because a per-frame rescale about the centre compounds rounding into drift.
 */
export function buildCropGesture(
  frame: { width: number; height: number },
  onMove: (dx: number, dy: number) => void,
  onScale: (factor: number) => void
): ReturnType<typeof Gesture.Simultaneous> {
  const drag = Gesture.Pan()
    .minDistance(4)
    .onChange(({ changeX, changeY }) => {
      if (frame.width <= 0 || frame.height <= 0) return;
      runOnJS(onMove)(changeX / frame.width, changeY / frame.height);
    });
  const pinch = Gesture.Pinch().onEnd(({ scale }) => {
    // Pinching APART enlarges the subject, which means the crop box holds LESS
    // of the frame — the factor is inverted on purpose.
    if (scale > 0) runOnJS(onScale)(1 / scale);
  });
  return Gesture.Simultaneous(drag, pinch);
}
