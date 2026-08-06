import React from "react";
import { Pressable, View } from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

import { Text } from "../../kit/components/NativeText";

/** Shared visible/collapsed/empty body of every Collections shelf. */
export default function CollectionShelfBody({
  action,
  children,
  collapsed,
  empty,
  emptyActionStyle,
  emptyActionTextStyle,
  emptyStyle,
  emptyTextStyle,
  hasTiles,
  onAction,
  title,
}: {
  action?: string;
  children: React.ReactNode;
  collapsed: boolean;
  empty: string;
  emptyActionStyle?: StyleProp<ViewStyle>;
  emptyActionTextStyle?: StyleProp<TextStyle>;
  emptyStyle?: StyleProp<ViewStyle>;
  emptyTextStyle?: StyleProp<TextStyle>;
  hasTiles: boolean;
  onAction: () => void;
  title: string;
}): React.JSX.Element | null {
  if (collapsed) return null;
  if (hasTiles) return <>{children}</>;
  return (
    <View style={emptyStyle}>
      <Text style={emptyTextStyle}>{empty}</Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action} ${title}`}
          onPress={onAction}
          style={emptyActionStyle}
        >
          <Text style={emptyActionTextStyle}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
