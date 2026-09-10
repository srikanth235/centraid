// The chevron a PUSHED Photos screen draws (#1015, S2).
//
// The band is not an exit: on People, Places, Trash, Archive, Favorites,
// Duplicates and Memories it highlights `More`, a destination none of them was
// reached from, so a member reading the band is told the wrong place. Album
// detail and the lightbox have carried a chevron all along, so the omission
// was never a house rule — it was seven screens missing one.
//
// `to` NAMES THE DESTINATION, never "Back": the accessible name a screen
// reader speaks is the place the tap returns to.

import React from "react";
import { Pressable } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import Icon from "../../kit/components/Icon";
import { useTheme } from "../../kit/theme";

export default function PhotosBackControl({
  to,
  onPress,
  style,
}: {
  to: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={`Back to ${to}`}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={style}
    >
      <Icon name="chevron-left" size={26} color={colors.text} />
    </Pressable>
  );
}
