import React from "react";
import { StyleSheet, View } from "react-native";

import { iconChipFinish, iconChipRadius } from "@centraid/design";
import type { IconName } from "@centraid/design";

import { useTheme } from "../theme";
import Icon from "./Icon";

export interface AppMarkProps {
  color: string;
  iconKey: IconName;
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
    overflow: "hidden",
  },
});
