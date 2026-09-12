// The stage's one recogniser (#1015, R-NY-14).
//
// Built OUTSIDE the room's render body: the builder chain mutates the factory,
// which the React compiler rejects inside a component. One Pan for both
// directions, because two would race for the same drag: down leaves the stage,
// up hands the caller its second act (the lightbox's info sheet) when it has
// one. A horizontal drag fails it, so a pager on the stage keeps its swipe.

import { Gesture } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

/** What a finished vertical drag on the stage asks for. */
export type StageSwipe = "dismiss" | "up" | null;

/**
 * A drag past 120pt, or a flick past 900pt/s, is an act; anything shorter is
 * the member steadying the photograph. Down wins over up on a tie because it
 * is the one the stage promises.
 */
export function stageSwipeOutcome(
  translationY: number,
  velocityY: number
): StageSwipe {
  "worklet";
  if (translationY > 120 || velocityY > 900) return "dismiss";
  if (translationY < -120 || velocityY < -900) return "up";
  return null;
}

export function buildStageDismiss(
  onDismiss: () => void,
  onSwipeUp?: () => void
): ReturnType<typeof Gesture.Pan> {
  return Gesture.Pan()
    .activeOffsetY([-24, 24])
    .failOffsetX([-24, 24])
    .onEnd(({ translationY, velocityY }) => {
      const outcome = stageSwipeOutcome(translationY, velocityY);
      if (outcome === "dismiss") runOnJS(onDismiss)();
      else if (outcome === "up" && onSwipeUp) runOnJS(onSwipeUp)();
    });
}
