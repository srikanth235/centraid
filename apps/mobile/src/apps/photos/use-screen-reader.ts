// Is a screen reader running? The viewer's chrome answers to this: a control
// reachable only by an unlabelled full-screen tap is not reachable at all under
// VoiceOver, so the chrome does not hide while a reader is on (#1011).
//
// Lives beside the viewer rather than in `kit/hooks`: it is one screen's rule
// today, and a kit hook nothing else reads is a shared surface on paper only.

import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useScreenReader(): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (active) setOn(enabled);
    });
    // Live: a reader switched on mid-session must bring the chrome back
    // without asking the member to find a tap target they cannot see.
    const subscription = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      setOn
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return on;
}
