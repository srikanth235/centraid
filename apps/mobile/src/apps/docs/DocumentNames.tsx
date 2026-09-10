// Who this document names (Docs handoff Part 2 §12; #821) — the
// `names` capability's product screen, rendered HONESTLY EMPTY.
//
// The sample shows two links, each carrying the passage it was read from —
// "the first cross-app link in the product". The capability that would write
// those links ("Find the people a document names") is OFF with no runner and
// no consent record, so this seat holds no link and no passage; the rail's
// own sentence for that state is the one drawn here (`RAIL_NOTES.namesOff`:
// "Docs has not looked. One consent, running on this device"). Nothing is
// invented — not a person, not a passage, not a count.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { DCAPS } from "@centraid/blueprints/apps/docs/capabilities";
import { RAIL_NOTES } from "@centraid/blueprints/apps/docs/document-copy";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import PushedPage from "../../kit/rooms/PushedPage";
import { borders, pageMargin, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import { namesStatus } from "./docs-copy";
import { useDocsRoom } from "./docs-room";
import { useDocument } from "./useDocs";

export default function DocumentNames({
  route,
  navigation,
}: DocsScreenProps<"DocumentNames">): React.JSX.Element {
  const room = useDocsRoom("all");
  const { documentId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const capability = DCAPS.find((entry) => entry.id === "names");
  const { doc, loading } = useDocument(documentId);

  return (
    <PushedPage
      backTo={room.backTo}
      band={room.band}
      chrome={room.chrome}
      onBack={room.handleBack}
      overlay={room.overlay}
      title={room.title}
    >
      {loading && !doc ? (
        <SkeletonRows accessibilityLabel="Reading this document" />
      ) : (
        <View style={styles.page}>
          {doc ? (
            <Text numberOfLines={1} style={styles.docTitle}>
              {doc.title}
            </Text>
          ) : null}
          <View style={styles.panel}>
            <Text style={styles.eyebrow}>Off</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {RAIL_NOTES.namesOff}
            </Text>
            <Text style={styles.body}>{capability?.what ?? ""}</Text>
            <Text style={styles.body}>
              Each link it wrote would point at a People record and carry the
              exact passage it was read from — the evidence is the feature.
            </Text>
            <Button
              label="What Docs may read"
              onPress={() => navigation.navigate("DocsCapabilities")}
              style={styles.action}
            />
          </View>
          <Text style={styles.status}>{namesStatus(0)}</Text>
        </View>
      )}
    </PushedPage>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: { alignSelf: "flex-start", marginTop: 8 },
    body: { ...t("body"), color: colors.textSoft },
    docTitle: { ...t("title"), color: colors.text, paddingBottom: 10 },
    eyebrow: { ...t("eyebrow"), color: colors.textFaint },
    page: { flex: 1, paddingHorizontal: pageMargin, paddingTop: 8 },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 8,
      padding: 16,
    },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 8 },
    title: { ...t("title"), color: colors.text },
  });
