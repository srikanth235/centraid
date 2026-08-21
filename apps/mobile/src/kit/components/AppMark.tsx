// Native lowering of the Binding Layer app mark.
//
// The chip is a quiet hue wash over the page surface; the identity is the
// single-tone shared icon stroke. `Icon` owns the handoff's 1.6 / 1.75 stroke
// rule, so this component only owns the chip geometry and finish.

import React from "react";
import { StyleSheet, View } from "react-native";

import { iconChipFinish, iconChipRadius } from "@centraid/design";
import type { IconName } from "@centraid/design";

import { useTheme } from "../theme";
import Icon from "./Icon";

export interface AppMarkProps {
  color: string;
  iconKey: IconName;
  /** Quietly recede an app that is known but not installed on this device. */
  muted?: boolean;
  size?: number;
  testID?: string;
}

const DEFAULT_SIZE = 32;

export default function AppMark({
  color,
  iconKey,
  muted = false,
  size = DEFAULT_SIZE,
  testID,
}: AppMarkProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const finish = iconChipFinish(color, colors.bg, scheme);
  const iconSize = Math.min(16, Math.max(14, Math.round(size * 0.55)));

  return (
    <View
      testID={testID}
      style={[
        styles.mark,
        {
          backgroundColor: muted ? colors.bgSunken : finish.backgroundColor,
          borderRadius: iconChipRadius(size),
          height: size,
          width: size,
        },
      ]}
    >
      <Icon
        name={iconKey}
        size={iconSize}
        color={muted ? colors.textFaint : finish.markColor}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    alignItems: "center",
    justifyContent: "center",
    // Keep the mark seated on the page: no gradient, gloss, shadow, or
    // identity-colored chrome beyond the quiet chip wash.
    overflow: "hidden",
  },
});
