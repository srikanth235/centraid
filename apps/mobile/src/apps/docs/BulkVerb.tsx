import React from "react";
import { Pressable, Text } from "react-native";

import type { makeStyles } from "./DriveList.styles";

export default function BulkVerb({
  label,
  onPress,
  disabled,
  destructive,
  styles,
}: {
  label: string;
  onPress: (event: { nativeEvent: { pageX: number; pageY: number } }) => void;
  disabled?: boolean;
  destructive?: boolean;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={styles.bulkVerb}
    >
      <Text
        style={[
          styles.bulkVerbLabel,
          destructive ? styles.bulkVerbNet : undefined,
          disabled ? styles.bulkVerbOff : undefined,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
