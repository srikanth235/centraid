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
import { Modal, Pressable, View } from "react-native";

import type { ShelfId } from "@centraid/blueprints/apps/docs/shelves";
import type { Folder } from "@centraid/blueprints/apps/docs/types";
import { actionStatus } from "@centraid/blueprints/apps/docs/view-copy";
import { emptyStateView } from "@centraid/blueprints/apps/docs/view-state";

import AnchoredMenu from "../../kit/components/AnchoredMenu";
import type { MenuAnchor, MenuGroup } from "../../kit/components/AnchoredMenu";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { NEWEST_FIRST_ANCHORING } from "../../kit/components/list-anchoring";
import { Text, TextInput } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import { readOnlyRouteReason } from "../../kit/replica/row-provenance";
import GrantSheet from "../../kit/share/GrantSheet";
import { useTheme } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import BulkVerb from "./BulkVerb";
import { buildDocMenu } from "./doc-menu";
import DocRow, { DocGridTile } from "./DocRow";
import { openElsewhere } from "./docs-export";
import type { MobileDriveDoc } from "./docs-projection";
import { makeStyles } from "./DriveList.styles";
import { useDocsWrite } from "./useDocs";
import { useDocsGrantAudiences } from "./useDocsGrantAudiences";

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
  /** The row's lead line per document id — the matched passage on Search, the
   *  sender on Shared. See `DocRow`'s `reason` for why there is only one. */
  reasons?: Readonly<Record<string, string>>;
  empty?: {
    query?: string;
    filtered?: boolean;
    folderName?: string;
    driveIsEmpty?: boolean;
  };
  /** What to say instead, for a shelf the shared empty-copy table does not
   *  carry. Without it such a shelf silently inherits All's sentences, which
   *  would tell a member with nothing shared that their DRIVE is empty. */
  emptyCopy?: { title: string; body: string };
  /** Whatever the shelf draws above the rows (filter chips, a search field). */
  header?: React.ReactNode;
  /** Render plain rows instead of a virtualized list — for a short section
   *  embedded in a screen that already scrolls (Folders' deleted-folder
   *  block). A virtualized list inside a ScrollView measures nothing. */
  embedded?: boolean;
  /** The shelf's own `Select` control owns the mode, so the flag is
   *  CONTROLLED: the button that turns it on lives in the app bar, which is
   *  the shelf's chrome and not this list's. */
  selecting?: boolean;
  onSelectingChange?: (active: boolean) => void;
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
  reasons,
  empty,
  emptyCopy,
  header,
  embedded,
  selecting = false,
  onSelectingChange,
}: DriveListProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const navigation = useNavigation<DocsShellNavigation>();
  const write = useDocsWrite(navigation);
  const { gatewayBase, vaultId } = useReplica();
  // `null` while the People roster is not an answer at all — the row draws no
  // Share verb then, rather than one that fails when pressed.
  const audiences = useDocsGrantAudiences();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [sharing, setSharing] = useState<MobileDriveDoc | null>(null);
  const [renaming, setRenaming] = useState<MobileDriveDoc | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  // Where the bulk Move-to card hangs from; `undefined` sends it to the top
  // trailing corner rather than refusing to open (AnchoredMenu's own rule).
  const [moveAnchor, setMoveAnchor] = useState<MenuAnchor | undefined>(
    undefined
  );
  const [movingOpen, setMovingOpen] = useState(false);

  // DERIVED, not cleared by an effect: leaving the mode empties the choice by
  // definition, and an effect that reset state on a prop change would be the
  // same fact stored twice with a frame's disagreement between them.
  const pickedSet = useMemo(
    () => new Set(selecting ? picked : []),
    [picked, selecting]
  );
  const pickedDocs = useMemo(
    () => docs.filter((doc) => pickedSet.has(doc.document_id)),
    [docs, pickedSet]
  );
  const leaveSelection = (): void => {
    setPicked([]);
    setMovingOpen(false);
    onSelectingChange?.(false);
  };
  const togglePick = (doc: MobileDriveDoc): void =>
    setPicked((current) =>
      current.includes(doc.document_id)
        ? current.filter((id) => id !== doc.document_id)
        : [...current, doc.document_id]
    );

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

  /**
   * The same verb over a chosen set. Serial rather than `Promise.all`: the
   * write door is one queue and the drain lock single-files intents anyway, so
   * a burst buys nothing and costs the ability to report how far it got.
   *
   * The status counts what SETTLED, never what was asked. A write that parked
   * for a steward or was refused returns nothing from the door, so it is not
   * in the sentence and not in the Undo.
   */
  const actMany = async (
    action: string,
    targets: readonly MobileDriveDoc[],
    label: string,
    input: (doc: MobileDriveDoc) => Record<string, string>,
    undo?: (doc: MobileDriveDoc) => {
      action: string;
      input: Record<string, string>;
    }
  ): Promise<void> => {
    const settled: MobileDriveDoc[] = [];
    // Serial BY CONTRACT: the sentence afterwards counts what actually
    // landed, so a failure partway has to stop counting rather than race the
    // rest of the batch.
    for (const doc of targets) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const result = await write(action, input(doc));
      if (result) settled.push(doc);
    }
    leaveSelection();
    if (settled.length === 0) return;
    postStatus(
      actionStatus(label, settled.length),
      undo
        ? {
            action: {
              label: "Undo",
              run: () =>
                void (async () => {
                  // Serial for the same reason the forward pass is: an Undo
                  // that races can reorder writes the member made in one
                  // gesture.
                  for (const doc of settled) {
                    const step = undo(doc);
                    // oxlint-disable-next-line no-await-in-loop -- see above
                    await write(step.action, step.input);
                  }
                })(),
            },
          }
        : undefined
    );
  };

  /**
   * The row's Download. Stages the EXACT stored bytes and hands them to the
   * OS — the same `docs-export` path the facts panel's "Open elsewhere" uses,
   * because they are one act with two names, and the phone's file space is the
   * share sheet. Nothing is converted.
   */
  const handOver = async (doc: MobileDriveDoc): Promise<void> => {
    try {
      await openElsewhere(doc, gatewayBase, vaultId);
      // The name shadows the `error` PROP on purpose: inside this handler the
      // only error that matters is the one the hand-over threw.
      // oxlint-disable-next-line no-shadow -- see above
    } catch (error) {
      postStatus(
        error instanceof Error
          ? error.message
          : "This document could not be handed over."
      );
    }
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
    return buildDocMenu({ ...doc, canShare: audiences !== null }, folders, {
      share: () => setSharing(doc),
      open: () => navigation.navigate("DocumentRead", { documentId: id }),
      download: () => void handOver(doc),
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

  // The bulk Move-to card. The same label set the per-row submenu offers, from
  // the same `folders` prop — a folder is a label on a document, so moving a
  // chosen set is retagging each of them. No `checked` rung: a set can straddle
  // several folders, and a tick would be answering "which folder is this in?"
  // for documents that disagree.
  const bulkMoveGroups: MenuGroup[] = [
    {
      key: "move",
      rows: [
        {
          key: "move:top",
          label: "No folder",
          onSelect: () =>
            void actMany(
              "move",
              pickedDocs,
              "Moved to a different folder",
              (doc) => ({ document_id: doc.document_id }),
              (doc) => ({
                action: "move",
                input: {
                  document_id: doc.document_id,
                  ...(doc.folder_id ? { folder_id: doc.folder_id } : {}),
                },
              })
            ),
        },
        ...folders.map((folder) => ({
          key: `move:${folder.folder_id}`,
          label: folder.name,
          onSelect: () =>
            void actMany(
              "move",
              pickedDocs,
              "Moved to a different folder",
              (doc) => ({
                document_id: doc.document_id,
                folder_id: folder.folder_id,
              }),
              // Each document goes back to ITS OWN folder, not to one shared
              // origin: an Undo that filed the whole set under wherever the
              // first one came from would be a second move wearing the word.
              (doc) => ({
                action: "move",
                input: {
                  document_id: doc.document_id,
                  ...(doc.folder_id ? { folder_id: doc.folder_id } : {}),
                },
              })
            ),
        })),
      ],
    },
  ];

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

  // Choosing from a set is a LIST act: a tile is a preview, and a tick over a
  // preview reads as a fact about the document rather than a pick. The
  // remembered grid preference is untouched — it comes back on the way out.
  const arrangement = selecting ? "list" : view;

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
          title={emptyCopy?.title ?? emptyView.title}
          body={emptyCopy?.body ?? emptyView.body}
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
            maintainVisibleContentPosition={NEWEST_FIRST_ANCHORING}
            data={docs as MobileDriveDoc[]}
            keyExtractor={(doc) => doc.document_id}
            numColumns={arrangement === "grid" ? 2 : 1}
            renderItem={({ item, index }) => {
              const open = (doc: MobileDriveDoc): void =>
                navigation.navigate("DocumentRead", {
                  documentId: doc.document_id,
                });
              if (arrangement === "grid") {
                return (
                  <DocGridTile
                    doc={item}
                    offline={offline}
                    onOpen={open}
                    onMenu={openMenu}
                  />
                );
              }
              const reason = reasons?.[item.document_id];
              return (
                <DocRow
                  doc={item}
                  offline={offline}
                  first={index === 0}
                  {...(reason ? { reason } : {})}
                  onOpen={open}
                  onMenu={openMenu}
                  selecting={selecting}
                  selected={pickedSet.has(item.document_id)}
                  onToggleSelect={togglePick}
                />
              );
            }}
          />
        </View>
      )}
      {/* In selection the bar REPLACES the caption and the status: those two
          describe the set being read, and the member is no longer reading it.
          Docked in normal flow, never floating over the rows — a bar that
          covered the last row would hide something choosable. */}
      {selecting ? (
        <View style={styles.bulkBar}>
          <Text style={styles.bulkCount}>
            {pickedDocs.length === 0
              ? "Choose documents"
              : `${pickedDocs.length} chosen`}
          </Text>
          <BulkVerb
            label="Star"
            disabled={pickedDocs.length === 0}
            onPress={() =>
              void actMany(
                "star",
                pickedDocs.filter((doc) => !doc.starred),
                "Starred",
                (doc) => ({ document_id: doc.document_id }),
                (doc) => ({
                  action: "unstar",
                  input: { document_id: doc.document_id },
                })
              )
            }
            styles={styles}
          />
          <BulkVerb
            label="Move to"
            disabled={pickedDocs.length === 0}
            onPress={(event) => {
              setMoveAnchor({
                x: event.nativeEvent.pageX,
                y: event.nativeEvent.pageY,
                width: 1,
                height: 1,
              });
              setMovingOpen(true);
            }}
            styles={styles}
          />
          <BulkVerb
            label="Trash"
            destructive
            disabled={pickedDocs.length === 0}
            onPress={() =>
              void actMany(
                "trash",
                pickedDocs,
                "Moved to trash",
                (doc) => ({ document_id: doc.document_id }),
                (doc) => ({
                  action: "restore",
                  input: { document_id: doc.document_id },
                })
              )
            }
            styles={styles}
          />
          <BulkVerb label="Done" onPress={leaveSelection} styles={styles} />
        </View>
      ) : (
        <>
          {caption ? <Text style={styles.caption}>{caption}</Text> : null}
          {status ? <Text style={styles.status}>{status}</Text> : null}
        </>
      )}

      <AnchoredMenu
        visible={menu !== null}
        anchor={menu?.anchor}
        groups={menuGroups}
        onClose={() => setMenu(null)}
      />

      <AnchoredMenu
        visible={movingOpen}
        anchor={moveAnchor}
        groups={bulkMoveGroups}
        onClose={() => setMovingOpen(false)}
      />

      {/* OBJECT-FIRST entry: the row already names the document, so the one
          shared kit opens over it and asks only who. Its outcomes go to the
          seat's status line — the sheet paints none of its own. */}
      {sharing && audiences ? (
        <GrantSheet
          visible
          onClose={() => setSharing(null)}
          audiences={audiences}
          subject={{
            subjectType: "core.document",
            subjectId: sharing.document_id,
            ...(sharing.title ? { label: sharing.title } : {}),
          }}
          onStatus={postStatus}
        />
      ) : null}

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
