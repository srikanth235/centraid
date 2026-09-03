// Trash (handoff Part 2 §Trash; spec §4.3, §14). Soft delete, and each
// document carries its OWN purge date — the row's state slot prints it
// (`purged in N days`), never one global countdown. Restoring one puts its
// folder and its star back exactly as they were.
//
// There is NO destroy verb. The `Delete forever` / `Empty trash` ask stands
// as an ask (`TRASH_ASK`), and while it stands the shelf says once, plainly,
// why destruction is scheduled (`TRASH_FALLBACK`).
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import {
  TRASH_ASK,
  TRASH_FALLBACK,
} from "@centraid/blueprints/apps/docs/drive-copy";
import { TRASH } from "@centraid/blueprints/apps/docs/shelves";
import { captionFor } from "@centraid/blueprints/apps/docs/view-copy";

import { Text } from "../../kit/components/NativeText";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { trashStatus } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";
import DriveList from "./DriveList";
import { useDocs } from "./useDocs";

export default function DocsTrash(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const drive = useDocs();
  const docs = useMemo(
    () => drive.documents.filter((doc) => doc.trashed),
    [drive.documents]
  );
  return (
    <DocsScreen current="more">
      <DocsShelfHeader title="Trash" backTo="All" />
      <ReplicaStatusBar />
      <DriveList
        shelf={TRASH}
        docs={docs}
        folders={drive.folders}
        loading={drive.loading}
        connection={drive.connection}
        {...(drive.error ? { error: drive.error } : {})}
        {...(drive.unavailableReason
          ? { unavailableReason: drive.unavailableReason }
          : {})}
        offline={drive.offline}
        refresh={drive.refresh}
        caption={captionFor(TRASH, { offline: drive.offline })}
        status={trashStatus(docs.length)}
      />
      <View style={styles.ask}>
        <Text style={styles.askEyebrow}>{TRASH_ASK.eyebrow}</Text>
        <Text style={styles.askTitle}>{TRASH_ASK.title}</Text>
        <Text style={styles.askBody}>{TRASH_FALLBACK}</Text>
      </View>
    </DocsScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    ask: {
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 4,
      marginHorizontal: 18,
      marginVertical: 8,
      padding: 12,
    },
    askBody: { ...t("small"), color: colors.textSoft },
    askEyebrow: { ...t("eyebrow"), color: colors.textFaint },
    askTitle: { ...t("bodyStrong"), color: colors.text },
  });
