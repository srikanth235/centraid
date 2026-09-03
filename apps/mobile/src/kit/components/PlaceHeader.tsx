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
  primary?: PlaceVerb;
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
