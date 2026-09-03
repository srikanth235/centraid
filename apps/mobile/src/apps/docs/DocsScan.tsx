// Scan (Docs handoff Part 2 §14; #821) — "where documents are born on
// a phone", framed by Docs and HANDED OFF to the frame's own Scan cover
// (`src/screens/Scan.tsx`).
//
// That cover is the one honest camera entrance this phone already has: it
// owns the camera permission, the per-device OCR consent gate (#712), the
// on-device extraction with the member's review, and the `docs / upload`
// producer that lands the capture as an image document with its extracted
// text. Duplicating any of that here would be a second camera flow to keep
// honest — so this screen says what a Docs scan IS and where it lands, then
// opens the cover with the Docs destination one tap away.
//
// The spec's "3 pages · lands as one PDF" is NOT promised: multi-page
// capture assembled into one PDF has no machinery on this seat, and a status
// line may not claim a landing shape nothing produces
// (`SCAN_PDF_WITHHELD`; INTEGRATION-NOTES.md → choices).
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
