// Home's ambient status line — one line, docked above the band, numeric
// register, small neutral dot (the Binding Layer, invariant 5).
//
// It is the only feedback channel on this screen: no spinner, no toast, no
// badge count, no red dot. What it carries is the vault at a glance — how much
// is in it, and whether the gateway holding it is answering.
//
// Every number on it is a REAL count, assembled from the same tile reads the
// grid above draws (./tile-model#countThings). The sentence itself — and the
// three honesty rules that shape it — lives in ./home-status, which is pure and
// under test; this file is only its frame.
//
// It is a static row above the band rather than the transient host in
// kit/components/StatusLine — that one is the imperative channel a `.catch()`
// handler posts into, and it goes quiet. This never does: it is an ambient
// sentence about the route, which is precisely the thing the shell's status
// line has and mobile did not.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { statusSentence } from "./home-status";
import type { HomeStatusFacts } from "./home-status";

export default function HomeStatusLine(
  props: HomeStatusFacts
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const text = statusSentence(props);
  return (
    <View
      accessibilityLabel={props.settled ? "Home ready" : "Home loading"}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      style={styles.row}
    >
      {/* ONE NEUTRAL DOT, offline included — --net is reserved for "this leaves
          the device", and offline is precisely when nothing does; red on the
          most ordinary state the product has taught members to fear their own
          premise. */}
      <View style={[styles.dot, { backgroundColor: colors.textFaint }]} />
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.text}>
        {text}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // statusDotStyle, :5944 — 5px, not 6.
    dot: { borderRadius: 2.5, height: 5, width: 5 },
    // statusLineStyle, :5941–5943 — a FIXED 30px row, not one that grows with
    // a second line: one clamped line is the honesty adaptation (the sentence
    // itself carries real counts, ./home-status), but the row's own height is
    // the handoff's, unconditionally.
    row: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      height: 30,
      // The shared page margin (R.margin.m, :3356) — one token, not a
      // literal repeated per screen.
      paddingHorizontal: pageMargin,
    },
    text: { ...t("mono"), color: colors.textFaint, flex: 1 },
  });
