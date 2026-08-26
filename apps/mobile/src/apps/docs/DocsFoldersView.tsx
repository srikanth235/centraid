// The Folders shelf (handoff Part 2 §2; #821).
//
// "A folder is a label on the document, not a place it sits" — the copy says
// it out loud in the status line and the caption. Three blocks:
//
//   1. The folder rows, with counts, each opening `DocsFolder`.
//   2. `Unfiled` — documents never put anywhere. Not an error, and not a
//      folder: the row navigates nowhere special, it opens All filtered by…
//      nothing; on the phone it is a fact block with a count, and the caption
//      (`foldersCaption`) carries its sentence, once.
//   3. The deleted-folder section — documents whose folder tag has nothing on
//      the other end (`folderGone`), with the shared `GONE_FOLDER_NOTE` and
//      the same row menu so they can be refiled from here.
//
// Deliberately cut, as the handoff cuts it: no folder tree in a rail.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { foldersCaption } from "@centraid/blueprints/apps/docs/drive-copy";
import { FOLDERS } from "@centraid/blueprints/apps/docs/shelves";
import {
  emptyStateView,
  GONE_FOLDER_NOTE,
} from "@centraid/blueprints/apps/docs/view-state";

import EmptyBlock from "../../kit/components/EmptyBlock";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import { foldersStatus } from "./docs-copy";
import DriveList from "./DriveList";
import type { UseDocsResult } from "./useDocs";
import { useDocsWrite } from "./useDocs";

export default function DocsFoldersView({
  drive,
}: {
  drive: UseDocsResult;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const navigation = useNavigation<DocsShellNavigation>();
  const write = useDocsWrite(navigation);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");

  const active = useMemo(
    () => drive.documents.filter((doc) => !doc.trashed),
    [drive.documents]
  );
  const countByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const doc of active) {
      if (!doc.folder_id) continue;
      counts.set(doc.folder_id, (counts.get(doc.folder_id) ?? 0) + 1);
    }
    return counts;
  }, [active]);
  const goneDocs = useMemo(
    () => active.filter((doc) => doc.folderGone),
    [active]
  );

  const createFolder = async (): Promise<void> => {
    const name = draft.trim();
    setComposing(false);
    setDraft("");
    if (!name) return;
    await write("create-folder", { name });
  };

  const emptyView = emptyStateView({
    shelf: FOLDERS,
    loaded: !drive.loading,
    count: drive.folders.length,
    suppressed: composing,
  });

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.headRow}>
        <Text style={styles.status}>{foldersStatus(drive.folders.length)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New folder"
          onPress={() => setComposing(true)}
          style={styles.newButton}
        >
          <Icon name="FolderPlus" size={16} color={colors.text} />
          <Text style={styles.newLabel}>New folder</Text>
        </Pressable>
      </View>

      {composing ? (
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Folder name"
            autoFocus
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void createFolder()}
            style={styles.composerField}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => void createFolder()}
            style={styles.saveButton}
          >
            <Text style={styles.saveLabel}>Save</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setComposing(false);
              setDraft("");
            }}
            style={styles.quietButton}
          >
            <Text style={styles.quietLabel}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {drive.loading && drive.folders.length === 0 ? (
        <SkeletonRows accessibilityLabel="Reading folders" />
      ) : emptyView.visible ? (
        <EmptyBlock title={emptyView.title} body={emptyView.body} routine />
      ) : (
        <View style={styles.container}>
          {drive.folders.map((folder, index) => (
            <Pressable
              key={folder.folder_id}
              accessibilityRole="button"
              accessibilityLabel={folder.name}
              onPress={() =>
                navigation.navigate("DocsFolder", {
                  folderId: folder.folder_id,
                  folderName: folder.name,
                })
              }
              style={[styles.row, index === 0 ? undefined : styles.rowRule]}
            >
              <Icon name="Folder" size={18} color={colors.textSoft} />
              <Text numberOfLines={1} style={styles.rowName}>
                {folder.name}
              </Text>
              <Text style={styles.rowCount}>
                {countByFolder.get(folder.folder_id) ?? 0}
              </Text>
            </Pressable>
          ))}
          {/* Unfiled — a count in the count column, never a sentence on a
              row; the caption below carries the prose (drive-copy). */}
          <View style={[styles.row, styles.rowRule]}>
            <Icon name="FileText" size={18} color={colors.textSoft} />
            <Text numberOfLines={1} style={styles.rowName}>
              Unfiled
            </Text>
            <Text style={styles.rowCount}>{drive.unfiledCount}</Text>
          </View>
        </View>
      )}

      <Text style={styles.caption}>{foldersCaption(drive.unfiledCount)}</Text>

      {goneDocs.length > 0 ? (
        <View style={styles.goneSection}>
          <Text style={styles.goneNote}>{GONE_FOLDER_NOTE}</Text>
          <DriveList
            shelf={FOLDERS}
            docs={goneDocs}
            folders={drive.folders}
            loading={false}
            connection={drive.connection}
            offline={drive.offline}
            refresh={drive.refresh}
            embedded
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    caption: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: 18,
      paddingTop: 8,
    },
    composer: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 18,
      paddingVertical: 8,
    },
    composerField: {
      ...t("body"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      flex: 1,
      minHeight: 44,
      paddingHorizontal: 12,
    },
    container: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      marginHorizontal: 18,
      overflow: "hidden",
    },
    goneNote: {
      ...t("small"),
      color: colors.textSoft,
      paddingHorizontal: 18,
      paddingVertical: 8,
    },
    goneSection: { paddingTop: 16 },
    headRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 8,
    },
    newButton: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      flexDirection: "row",
      gap: 6,
      minHeight: 36,
      paddingHorizontal: 10,
    },
    newLabel: { ...t("control"), color: colors.text },
    page: { paddingBottom: 24 },
    quietButton: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 8,
    },
    quietLabel: { ...t("control"), color: colors.textSoft },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: 44,
      paddingHorizontal: 12,
    },
    rowCount: { ...t("mono"), color: colors.textFaint },
    rowName: { ...t("body"), color: colors.text, flex: 1 },
    rowRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    saveButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: radii.md,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 14,
    },
    saveLabel: { ...t("control"), color: colors.onAccent },
    status: {
      ...t("mono"),
      color: colors.textFaint,
      flexShrink: 1,
    },
  });
