// Built outside any render body: gesture builder chains MUTATE, which the
// React compiler rejects inside a component (see lightbox-gestures.ts). The
// crop rectangle stays React state; gestures send one finished move to JS.

import { Gesture } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

/** Deltas are FRACTIONS of the frame; `onMove` fires continuously, `onScale`
 *  once per pinch with the total factor (rescaling per frame drifts). */
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
    // Pinch apart shrinks the box's frame share: inverted.
    if (scale > 0) runOnJS(onScale)(1 / scale);
  });
  return Gesture.Simultaneous(drag, pinch);
}
