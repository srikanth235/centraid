import React, { useMemo } from "react";
import { View } from "react-native";

import type { ActionData, EmptyCopy } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import Button from "./Button";
import { styles } from "./EmptyBlock.styles";
import { Text } from "./NativeText";

export interface EmptyBlockAction extends ActionData {
  onPress: () => void;
}

export interface EmptyBlockProps extends EmptyCopy {
  action?: EmptyBlockAction;
  action2?: EmptyBlockAction;
}

export default function EmptyBlock({
  title,
  body,
  action,
  action2,
  routine,
}: EmptyBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  const firstRun = routine !== true;
  const ink = useMemo(
    () => ({ body: { color: colors.textSoft }, title: { color: colors.text } }),
    [colors]
  );
  return (
    <View style={[styles.block, firstRun ? styles.blockFirstRun : undefined]}>
      <Text
        accessibilityRole="header"
        style={[firstRun ? styles.titleFirstRun : styles.title, ink.title]}
      >
        {title}
      </Text>
      <Text style={[firstRun ? styles.bodyFirstRun : styles.body, ink.body]}>
        {body}
      </Text>
      {action || action2 ? (
        <View style={styles.actions}>
          {action ? (
            <Button
              label={action.label}
              onPress={() => action.onPress()}
              variant={firstRun ? "primary" : "secondary"}
            />
          ) : null}
          {action2 ? (
            <Button
              label={action2.label}
              onPress={() => action2.onPress()}
              variant="secondary"
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
