// HEALTH LINE — one standing sentence about the route you are on (#765).
//
// WHY NOT `StatusLine`. That component is this app's TRANSIENT channel: an
// external store, a note posted imperatively by a `.catch()` handler, a TTL,
// and `null` the rest of the time. A per-route health line is the opposite
// contract — it is always there, it says the same thing until the facts
// change, and nothing posts to it. Extending the transient host with a
// "permanent note" mode would give one mounted element two lifetimes, and the
// first thing to break would be the rule that makes the transient host worth
// having (ONE line, reused, never stacked). So: same anatomy, own component.
//
// The anatomy it does share is `HomeStatusLine`'s, which is where the shape
// was settled: a hairline above, a small NEUTRAL dot (never `net` — red on an
// ambient line teaches a member to fear the ordinary state), the numeric
// register, one clamped line. What it adds is the inline verb the reference's
// status line carries, published by the caller only in ready/full
// (`healthLineFor` in ./health-line applies that rule).

import React, { useMemo } from "react";
import { Pressable, View } from "react-native";

import { useTheme } from "../theme";
import { styles } from "./HealthLine.styles";
import { Text } from "./NativeText";

export type HealthTone = "neutral" | "seam";

export interface HealthLineProps {
  text: string;
  action?: string;
  onAction?: () => void;
  /** `seam` marks the one page whose standing state is about other people's
   *  machines reaching this one (Devices). It moves the DOT, nothing else. */
  tone?: HealthTone;
  accessibilityLabel?: string;
}

export default function HealthLine({
  text,
  action,
  onAction,
  tone = "neutral",
  accessibilityLabel,
}: HealthLineProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      action: { color: colors.text },
      dot: {
        backgroundColor: tone === "seam" ? colors.seam : colors.textFaint,
      },
      row: { backgroundColor: colors.bg, borderTopColor: colors.line },
      text: { color: colors.textFaint },
    }),
    [colors, tone]
  );
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      style={[styles.row, ink.row]}
    >
      <View style={[styles.dot, ink.dot]} />
      <Text
        ellipsizeMode="tail"
        numberOfLines={1}
        style={[styles.text, ink.text]}
      >
        {text}
      </Text>
      {action && onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={styles.action}
        >
          <Text style={[styles.actionText, ink.action]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
