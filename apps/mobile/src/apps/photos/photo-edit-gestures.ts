import { Gesture } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

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
    if (scale > 0) runOnJS(onScale)(1 / scale);
  });
  return Gesture.Simultaneous(drag, pinch);
}
