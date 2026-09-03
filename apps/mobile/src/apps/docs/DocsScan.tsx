import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import { SCAN_HANDOFF_BODY, SCAN_PDF_WITHHELD } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";

export default function DocsScan({
  navigation,
}: DocsScreenProps<"DocsScan">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <DocsScreen current="more">
      <DocsShelfHeader title="Scan a document" backTo="All" />
      <View style={styles.page}>
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={styles.title}>
            Documents born on this phone
          </Text>
          <Text style={styles.body}>{SCAN_HANDOFF_BODY}</Text>
          <Text style={styles.body}>
            Text is read on this device only, behind its own consent, and you
            review it before anything is saved. The scan is a document; a number
            on it is a credential and belongs in Locker — nothing reads one out
            of the image.
          </Text>
          <Button
            label="Open the camera"
            variant="primary"
            onPress={() => navigation.navigate("Scan")}
            style={styles.action}
          />
        </View>
        <Text style={styles.caption}>{SCAN_PDF_WITHHELD}</Text>
        <Text style={styles.status}>
          One capture · lands as an image document with its text
        </Text>
      </View>
    </DocsScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: { alignSelf: "flex-start", marginTop: 8 },
    body: { ...t("body"), color: colors.textSoft },
    caption: { ...t("small"), color: colors.textFaint, paddingTop: 8 },
    page: { flex: 1, paddingHorizontal: 18, paddingTop: 8 },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 8,
      padding: 16,
    },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 6 },
    title: { ...t("title"), color: colors.text },
  });
