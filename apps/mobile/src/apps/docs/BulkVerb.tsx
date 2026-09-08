// One verb in the drive's bulk bar. Its own module so `DriveList.tsx` stays
// under the file-size limit; it has no other caller and is not part of the kit.

import React from "react";
import { Pressable, Text } from "react-native";

import type { makeStyles } from "./DriveList.styles";

/**
 * One verb in the bulk bar. A text verb, not an icon: the bar carries four of
 * them and a row of unlabelled glyphs would ask the member to guess which one
 * trashes their documents. Disabled while nothing is chosen, and disabled
 * VISIBLY — a verb that vanished until a pick would hide what the mode is for.
 */
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
