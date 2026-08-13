// PLACE HEADER — the bar an operational page draws for itself (#765).
//
// Not `AppHeader`: that one draws a tinted app-identity chip, and a PLACE
// spends no colour on itself — Notifications is not an app with a hue, it is
// somewhere the frame goes. So this bar is ink only: a title, at most one
// filled verb, at most one quiet verb.
//
// There is no meta/count line, deliberately. The reference suppresses the
// app-bar meta entirely at phone width (`barMeta: mob ? '' : …`), because the
// count it would carry is already the first section's own count, one screen
// inch below. A prop for it would be a prop every caller has to remember not
// to pass.
//
// Gating is the caller's, and the rule it should apply is the reference's: the
// filled verb is hidden while loading AND while errored; the quiet verb is
// hidden only while loading.

import React, { useMemo } from "react";
import { View } from "react-native";

import { useTheme } from "../theme";
import Button from "./Button";
import { Text } from "./NativeText";
import { styles } from "./PlaceHeader.styles";

export interface PlaceVerb {
  label: string;
  onPress: () => void;
}

export interface PlaceHeaderProps {
  title: string;
  /** The filled commit. */
  primary?: PlaceVerb;
  /** The quiet verb beside it. */
  secondary?: PlaceVerb;
}

export default function PlaceHeader({
  title,
  primary,
  secondary,
}: PlaceHeaderProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ color: colors.text }), [colors]);
  return (
    <View style={styles.row}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={[styles.title, ink]}
      >
        {title}
      </Text>
      {secondary ? (
        <Button
          label={secondary.label}
          onPress={() => secondary.onPress()}
          style={styles.verb}
          variant="secondary"
        />
      ) : null}
      {primary ? (
        <Button
          label={primary.label}
          onPress={() => primary.onPress()}
          style={styles.verb}
          variant="primary"
        />
      ) : null}
    </View>
  );
}
