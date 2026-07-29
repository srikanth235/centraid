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

/** Pinch-to-zoom plus double-tap-to-toggle, clamped to 1×–5×. */
export function buildZoomGesture(
  scale: SharedValue<number>,
  startScale: SharedValue<number>
): ReturnType<typeof Gesture.Simultaneous> {
  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate(({ scale: nextScale }) => {
      scale.value = Math.max(1, Math.min(5, startScale.value * nextScale));
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd(() => {
      scale.value = withTiming(scale.value > 1 ? 1 : 2.5);
    });
  return Gesture.Simultaneous(pinch, doubleTap);
}

/** Swipe-down-to-dismiss, ignoring horizontal paging drags. */
export function buildDismissGesture(
  onDismiss: () => void
): ReturnType<typeof Gesture.Pan> {
  return Gesture.Pan()
    .activeOffsetY([-24, 24])
    .failOffsetX([-24, 24])
    .onEnd(({ translationY, velocityY }) => {
      if (translationY > 120 || velocityY > 900) runOnJS(onDismiss)();
    });
}
