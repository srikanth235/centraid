import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { SEARCH_COPY } from "@centraid/blueprints/apps/photos/view-copy";

import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** The honest empty-query state: no request has run yet.
 *
 *  ITS THREE SENTENCES ARE THE TABLE'S (#1015 Wave 3, S11). They were typed
 *  here AND held in `view-copy.ts`'s `SEARCH_COPY.resting`, and the two had
 *  already drifted: the body said "Not only the photographs already loaded"
 *  against the table's "Not only what is loaded here". */
export default function PhotosSearchRestingState(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>{SEARCH_COPY.resting.eyebrow}</Text>
        <Text style={styles.title}>{SEARCH_COPY.resting.title}</Text>
        <Text style={styles.body}>{SEARCH_COPY.resting.body}</Text>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { ...t("reading"), color: colors.textSoft },
    eyebrow: { ...t("eyebrow"), color: colors.textSoft },
    pad: {
      gap: spacing[4],
      paddingBottom: spacing[4],
      paddingTop: spacing[4],
    },
    panel: {
      borderColor: colors.line,
      borderTopWidth: borders.hairline,
      gap: spacing[3],
      paddingTop: spacing[4],
    },
    title: { ...t("display"), color: colors.text },
  });
