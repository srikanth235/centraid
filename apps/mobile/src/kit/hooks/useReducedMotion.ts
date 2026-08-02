import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export { motionDuration } from "./reduced-motion";

/** Native counterpart to prefers-reduced-motion for every animated surface. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduced(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
