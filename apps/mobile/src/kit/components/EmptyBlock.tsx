// EMPTY — the two forms of "there is nothing here" (#765, spec §8).
//
// `routine` picks the register. The default is FIRST-RUN (the reference's own
// default), the once-in-a-lifetime screen: display title, reading body, one
// filled commit. `routine` is the everyday state of a populated screen and
// deliberately quieter — title rung, body rung, an outlined verb — because an
// empty consent surface is the healthy state, not an incident.
//
// Both titles and bodies are the caller's words.

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

/** `title`, `body` and `routine` are the shared copy contract. */
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
              // The one filled commit a first meeting is allowed; the routine
              // form spends nothing.
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
