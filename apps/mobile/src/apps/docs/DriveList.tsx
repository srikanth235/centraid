// The drive's row set, shared by every shelf that paints documents
// (#821): All, one folder, Recently changed, Starred, Trash and the
// Search results all draw THIS — rows in one container (1px rule, 12 radius,
// `bgElev` ground, per the handoff's row-container recipe), the quick-actions
// menu on `···` and press-and-hold, the honest loading/empty/error states,
// and the caption + status sentences under the set.
//
// The menu's WRITES live here too — star/unstar, rename, refile, trash,
// restore — one implementation with one Undo grammar (`postStatus` + the
// reverse write, only where a reverse write exists), so five shelves cannot
// drift on what a verb does. Outcomes surface through the kit's
// `surfaceWriteOutcome` (parked → Approvals; queued → the one queued
// sentence).

import { useNavigation } from "@react-navigation/native";
import { FlashList } from "@shopify/flash-list";
import React, { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import type { ShelfId } from "@centraid/blueprints/apps/docs/shelves";
import type { Folder } from "@centraid/blueprints/apps/docs/types";
import { actionStatus } from "@centraid/blueprints/apps/docs/view-copy";
import { emptyStateView } from "@centraid/blueprints/apps/docs/view-state";

import AnchoredMenu from "../../kit/components/AnchoredMenu";
import type { MenuAnchor } from "../../kit/components/AnchoredMenu";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { Text, TextInput } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { postStatus } from "../../kit/components/status-line";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import { readOnlyRouteReason } from "../../kit/replica/row-provenance";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import { buildDocMenu } from "./doc-menu";
import DocRow, { DocGridTile } from "./DocRow";
import type { MobileDriveDoc } from "./docs-projection";
import { useDocsWrite } from "./useDocs";

export interface DriveListProps {
  shelf: ShelfId;
  docs: readonly MobileDriveDoc[];
  folders: readonly Folder[];
  loading: boolean;
  connection: "loading" | "unavailable" | "offline" | "syncing" | "current";
  error?: string;
  unavailableReason?: string;
  offline: boolean;
  refresh: () => Promise<void>;
  view?: "list" | "grid";
  /** The sentence under the set (view-copy `captionFor`), said once. */
  caption?: string | null;
  /** The shelf's standing status sentence, at the foot. */
  status?: string | null;
  /** The matched passage per document id, on the Search shelf. */
  snippets?: Readonly<Record<string, string>>;
  empty?: {
    query?: string;
    filtered?: boolean;
    folderName?: string;
    driveIsEmpty?: boolean;
  };
  /** Whatever the shelf draws above the rows (filter chips, a search field). */
  header?: React.ReactNode;
  /** Render plain rows instead of a virtualized list — for a short section
   *  embedded in a screen that already scrolls (Folders' deleted-folder
   *  block). A virtualized list inside a ScrollView measures nothing. */
  embedded?: boolean;
}

interface OpenMenu {
  doc: MobileDriveDoc;
  anchor: MenuAnchor | undefined;
}

export default function DriveList({
  shelf,
  docs,
  folders,
  loading,
  connection,
  error,
  unavailableReason,
  offline,
  refresh,
  view = "list",
  caption,
  status,
  snippets,
  empty,
  header,
  embedded,
}: DriveListProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const navigation = useNavigation<DocsShellNavigation>();
  const write = useDocsWrite(navigation);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [renaming, setRenaming] = useState<MobileDriveDoc | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // One write, one sentence, one reverse write where one exists (§11's
  // `actionStatus` grammar; Undo is an underlined action on the status line).
  const act = async (
    action: string,
    input: Record<string, string>,
    label: string,
    undo?: { action: string; input: Record<string, string> }
  ): Promise<void> => {
    const result = await write(action, input);
    if (!result) return;
    postStatus(
      actionStatus(label, 1),
      undo
        ? {
            action: {
              label: "Undo",
              run: () => void write(undo.action, undo.input),
            },
          }
        : undefined
    );
  };

  const openMenu = (
    doc: MobileDriveDoc,
    anchor: MenuAnchor | undefined
  ): void => setMenu({ doc, anchor });

  // Rebuilt per render rather than memoized: the groups close over `act`,
  // and a menu is open for exactly one gesture — the rebuild is cheaper than
  // a dependency list that would have to lie about it.
  const buildMenuGroups = (): ReturnType<typeof buildDocMenu> => {
    if (!menu) return [];
    const doc = menu.doc;
    const id = doc.document_id;
    return buildDocMenu(doc, folders, {
      open: () => navigation.navigate("DocumentRead", { documentId: id }),
      versions: () =>
        navigation.navigate("DocumentVersions", { documentId: id }),
      properties: () =>
        navigation.navigate("DocumentProperties", { documentId: id }),
      star: () =>
        void act("star", { document_id: id }, "Starred", {
          action: "unstar",
          input: { document_id: id },
        }),
      unstar: () =>
        void act("unstar", { document_id: id }, "Star removed", {
          action: "star",
          input: { document_id: id },
        }),
      rename: () => {
        setRenameDraft(doc.title);
        setRenaming(doc);
      },
      moveTo: (folderId) =>
        void act(
          "move",
          { document_id: id, ...(folderId ? { folder_id: folderId } : {}) },
          "Moved to a different folder",
          {
            action: "move",
            input: {
              document_id: id,
              ...(doc.folder_id ? { folder_id: doc.folder_id } : {}),
            },
          }
        ),
      trash: () =>
        void act("trash", { document_id: id }, "Moved to trash", {
          action: "restore",
          input: { document_id: id },
        }),
      restore: () =>
        void act("restore", { document_id: id }, "Restored from trash", {
          action: "trash",
          input: { document_id: id },
        }),
    });
  };
  const menuGroups = buildMenuGroups();

  const saveRename = async (): Promise<void> => {
    const doc = renaming;
    const title = renameDraft.trim();
    setRenaming(null);
    if (!doc || !title || title === doc.title) return;
    await act("rename", { document_id: doc.document_id, title }, "Renamed", {
      action: "rename",
      input: { document_id: doc.document_id, title: doc.title },
    });
  };

  const readOnlyReason = readOnlyRouteReason(docs);

  const emptyView = emptyStateView({
    shelf,
    loaded: !loading,
    count: docs.length,
    ...(empty?.query ? { query: empty.query } : {}),
    ...(empty?.filtered ? { filtered: true } : {}),
    ...(empty?.folderName ? { folderName: empty.folderName } : {}),
    ...(empty?.driveIsEmpty ? { driveIsEmpty: true } : {}),
  });

  return (
    <View style={embedded ? styles.frameEmbedded : styles.frame}>
      {header}
      <ReplicaStateCard
        connection={connection}
        error={error}
        unavailableReason={unavailableReason}
        noun="Docs"
        onRetry={() => void refresh()}
      />
      {readOnlyReason ? (
        <Text style={styles.readOnly}>{readOnlyReason}</Text>
      ) : null}
      {loading && docs.length === 0 ? (
        <SkeletonRows accessibilityLabel="Reading documents" />
      ) : emptyView.visible ? (
        <EmptyBlock
          title={emptyView.title}
          body={emptyView.body}
          routine={!emptyView.display}
        />
      ) : embedded ? (
        <View style={[styles.container, styles.containerEmbedded]}>
          {docs.map((doc, index) => (
            <DocRow
              key={doc.document_id}
              doc={doc}
              offline={offline}
              first={index === 0}
              onOpen={(opened) =>
                navigation.navigate("DocumentRead", {
                  documentId: opened.document_id,
                })
              }
              onMenu={openMenu}
            />
          ))}
        </View>
      ) : (
        <View style={styles.container}>
          <FlashList
            data={docs as MobileDriveDoc[]}
            keyExtractor={(doc) => doc.document_id}
            numColumns={view === "grid" ? 2 : 1}
            renderItem={({ item, index }) => {
              const open = (doc: MobileDriveDoc): void =>
                navigation.navigate("DocumentRead", {
                  documentId: doc.document_id,
                });
              if (view === "grid") {
                return (
                  <DocGridTile
                    doc={item}
                    offline={offline}
                    onOpen={open}
                    onMenu={openMenu}
                  />
                );
              }
              const snippet = snippets?.[item.document_id];
              return (
                <DocRow
                  doc={item}
                  offline={offline}
                  first={index === 0}
                  {...(snippet ? { snippet } : {})}
                  onOpen={open}
                  onMenu={openMenu}
                />
              );
            }}
          />
        </View>
      )}
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      {status ? <Text style={styles.status}>{status}</Text> : null}

      <AnchoredMenu
        visible={menu !== null}
        anchor={menu?.anchor}
        groups={menuGroups}
        onClose={() => setMenu(null)}
      />

      <Modal
        visible={renaming !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenaming(null)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => setRenaming(null)}
          style={[styles.scrim, { backgroundColor: colors.scrim }]}
        />
        <View style={styles.renamePanel} accessibilityViewIsModal>
          <Text style={styles.renameTitle}>Rename</Text>
          <TextInput
            accessibilityLabel="Document title"
            autoFocus
            value={renameDraft}
            onChangeText={setRenameDraft}
            onSubmitEditing={() => void saveRename()}
            style={styles.renameField}
          />
          <View style={styles.renameActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setRenaming(null)}
              style={styles.quietButton}
            >
              <Text style={styles.quietLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void saveRename()}
              style={[styles.primaryButton, { backgroundColor: colors.accent }]}
            >
              <Text style={[styles.primaryLabel, { color: colors.onAccent }]}>
                Save
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
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
    container: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      flex: 1,
      marginHorizontal: 18,
      overflow: "hidden",
    },
    containerEmbedded: { flex: 0 },
    frame: { flex: 1 },
    frameEmbedded: { flex: 0 },
    primaryButton: {
      alignItems: "center",
      borderRadius: radii.md,
      height: 44,
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    primaryLabel: { ...t("control") },
    quietButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    quietLabel: { ...t("control"), color: colors.textSoft },
    readOnly: {
      ...t("small"),
      color: colors.textSoft,
      paddingBottom: 8,
      paddingHorizontal: 18,
    },
    renameActions: {
      flexDirection: "row",
      gap: 8,
      justifyContent: "flex-end",
    },
    renameField: {
      ...t("body"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      minHeight: 44,
      paddingHorizontal: 12,
    },
    renamePanel: {
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
    renameTitle: { ...t("title"), color: colors.text },
    scrim: { ...StyleSheet.absoluteFill },
    status: {
      ...t("mono"),
      color: colors.textFaint,
      paddingBottom: 4,
      paddingHorizontal: 18,
      paddingTop: 6,
    },
  });
