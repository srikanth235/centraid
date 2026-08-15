// Home's v10 Origin health ribbon. Quiet is deliberately ignorable; attention
// and urgent earn one rule and one action, never a filled warning plate.
//
// It is the only feedback channel on this screen: no spinner, no toast, no
// badge count, no red dot. What it carries is the vault at a glance — how much
// is in it, and whether the gateway holding it is answering.
//
// Every number on it is read from the durable upload queue. Backup language is
// added only when the custody rollup has actually been computed.
//
// It is a static row above the band rather than the transient host in
// kit/components/StatusLine — that one is the imperative channel a `.catch()`
// handler posts into, and it goes quiet. This never does: it is an ambient
// sentence about the route, which is precisely the thing the shell's status
// line has and mobile did not.

import React, { useMemo } from "react";
import { Pressable, StyleSheet } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { OriginHealthSignal } from "./origin-health";

export default function HomeStatusLine({
  signal,
  onOpen,
}: {
  signal: OriginHealthSignal;
  onOpen: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const loud = signal.tone !== "quiet";
  const toneColor = signal.tone === "urgent" ? colors.net : colors.attention;
  return (
    <Pressable
      accessibilityRole={signal.destination ? "button" : "text"}
      accessibilityLabel={[signal.copy, signal.action]
        .filter(Boolean)
        .join(". ")}
      disabled={!signal.destination}
      onPress={onOpen}
      style={[
        styles.row,
        loud ? styles.rowLoud : styles.rowQuiet,
        loud ? { borderLeftColor: toneColor } : undefined,
      ]}
    >
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        style={[styles.copy, loud ? styles.copyLoud : styles.copyQuiet]}
      >
        {signal.copy}
      </Text>
      {signal.action ? (
        <Text style={[styles.action, { color: toneColor }]}>
          {signal.action}
        </Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: {
      ...t("bodyStrong"),
      flexShrink: 0,
      textDecorationLine: "underline",
    },
    copy: { flex: 1, minWidth: 0 },
    copyLoud: { ...t("small"), color: colors.text },
    copyQuiet: { ...t("band"), color: colors.textFaint },
    row: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: pageMargin,
    },
    rowLoud: {
      borderLeftWidth: 2,
      minHeight: 40,
      paddingVertical: 8,
    },
    rowQuiet: { height: 32 },
  });
