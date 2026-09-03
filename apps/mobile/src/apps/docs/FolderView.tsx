import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import { crumbsFor } from "@centraid/blueprints/apps/docs/drive-copy";
import { folderShelf } from "@centraid/blueprints/apps/docs/shelves";
import { folderCaption } from "@centraid/blueprints/apps/docs/view-copy";

import AnchoredMenu from "../../kit/components/AnchoredMenu";
import type { MenuAnchor } from "../../kit/components/AnchoredMenu";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import GrantSheet from "../../kit/share/GrantSheet";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps, DocsShellNavigation } from "../../navigation";
import { folderStatus } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DriveList from "./DriveList";
import { useDocs, useDocsWrite } from "./useDocs";
import { useDocsGrantAudiences } from "./useDocsGrantAudiences";

export default function FolderView({
  route,
}: DocsScreenProps<"DocsFolder">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const shellNavigation = useNavigation<DocsShellNavigation>();
  const { folderId, folderName } = route.params;
  const drive = useDocs();
  const write = useDocsWrite(shellNavigation);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(folderName);
  const audiences = useDocsGrantAudiences();
  const [shareOpen, setShareOpen] = useState(false);

  const liveName =
    drive.folders.find((folder) => folder.folder_id === folderId)?.name ??
    folderName;

  const docs = useMemo(
    () =>
      drive.documents.filter(
        (doc) => !doc.trashed && doc.folder_id === folderId
      ),
    [drive.documents, folderId]
  );

  const crumbs = crumbsFor(folderShelf(folderId), { folderName: liveName });
  const leading = crumbs.slice(0, -1);

  const saveRename = async (): Promise<void> => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name === liveName) return;
    await write("rename-folder", { folder_id: folderId, name });
  };

  const deleteFolder = async (): Promise<void> => {
    const result = await write("delete-folder", { folder_id: folderId });
    if (result) {
      postStatus(`Folder deleted · ${liveName}`);
      shellNavigation.goBack();
    }
  };

  return (
    <DocsScreen current="folders">
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to Folders"
          onPress={() => shellNavigation.goBack()}
          style={styles.back}
        >
          <Icon name="chevron-left" size={22} color={colors.text} />
        </Pressable>
        <View style={styles.crumbs}>
          {leading.map((crumb) => (
            <Text key={crumb.label} style={styles.crumbText}>
              {crumb.label}
              {"  /  "}
            </Text>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${liveName} — place menu`}
            onPress={(event) => {
              setMenuAnchor({
                x: event.nativeEvent.pageX,
                y: event.nativeEvent.pageY,
                width: 1,
                height: 1,
              });
              setMenuOpen(true);
            }}
            style={styles.crumbTrailing}
          >
            <Text numberOfLines={1} style={styles.crumbTitle}>
              {liveName}
            </Text>
            <Icon name="ChevronDown" size={14} color={colors.textSoft} />
          </Pressable>
        </View>
      </View>
      <ReplicaStatusBar />

      <DriveList
        shelf={folderShelf(folderId)}
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
        empty={{ folderName: liveName }}
        caption={folderCaption(liveName)}
        status={folderStatus(liveName, docs.length)}
      />

      <AnchoredMenu
        visible={menuOpen}
        anchor={menuAnchor}
        groups={[
          {
            key: "place",
            rows: [
              {
                key: "rename",
                label: "Rename folder",
                onSelect: () => {
                  setDraft(liveName);
                  setRenaming(true);
                },
              },
              ...(audiences
                ? [
                    {
                      key: "share",
                      label: "Share folder",
                      onSelect: () => setShareOpen(true),
                    },
                  ]
                : []),
              {
                key: "delete",
                label: "Delete folder",
                destructive: true,
                onSelect: () => void deleteFolder(),
              },
            ],
          },
        ]}
        onClose={() => setMenuOpen(false)}
      />

      <Modal
        visible={renaming}
        transparent
        animationType="fade"
        onRequestClose={() => setRenaming(false)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => setRenaming(false)}
          style={[styles.scrim, { backgroundColor: colors.scrim }]}
        />
        <View style={styles.panel} accessibilityViewIsModal>
          <Text style={styles.panelTitle}>Rename folder</Text>
          <TextInput
            accessibilityLabel="Folder name"
            autoFocus
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void saveRename()}
            style={styles.field}
          />
          <View style={styles.panelActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setRenaming(false)}
              style={styles.quietButton}
            >
              <Text style={styles.quietLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void saveRename()}
              style={styles.saveButton}
            >
              <Text style={styles.saveLabel}>Save</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* OBJECT-FIRST over the folder this screen is already about. The kit
          owns every sentence; this seat owns the roster and the status line. */}
      {audiences ? (
        <GrantSheet
          visible={shareOpen}
          onClose={() => setShareOpen(false)}
          audiences={audiences}
          subject={{
            subjectType: "docs.folder",
            subjectId: folderId,
            label: liveName,
          }}
          onStatus={postStatus}
        />
      ) : null}
    </DocsScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    back: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    crumbText: { ...t("small"), color: colors.textFaint },
    crumbTitle: { ...t("title"), color: colors.text, flexShrink: 1 },
    crumbTrailing: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      minHeight: 44,
    },
    crumbs: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      minWidth: 0,
    },
    field: {
      ...t("body"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      minHeight: 44,
      paddingHorizontal: 12,
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      minHeight: 44,
      paddingEnd: 18,
      paddingStart: 6,
    },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      borderWidth: borders.hairline,
      bottom: 0,
      gap: 8,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      padding: 16,
      position: "absolute",
    },
    panelActions: {
      flexDirection: "row",
      gap: 8,
      justifyContent: "flex-end",
    },
    panelTitle: { ...t("title"), color: colors.text },
    quietButton: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 10,
    },
    quietLabel: { ...t("control"), color: colors.textSoft },
    saveButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: radii.md,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 18,
    },
    saveLabel: { ...t("control"), color: colors.onAccent },
    scrim: { ...StyleSheet.absoluteFill },
  });
