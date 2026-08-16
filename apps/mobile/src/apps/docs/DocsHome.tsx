// governance: allow-repo-hygiene file-size-limit (#731) Docs home owns the folder-follow/share/Save surface and its local query state; splitting the acceptance-critical actions would duplicate the resident/Commons invariants.
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";

import { SAVED_TO_MY_VAULT } from "@centraid/blueprints/apps/_shared/shared-copy";
import { OnlineOnlyError } from "@centraid/client/replica/native";
import { apps as BUILTIN_APPS } from "@centraid/design";

import AppMark from "../../kit/components/AppMark";
import HomeKey from "../../kit/components/HomeKey";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import ShareSheet from "../../kit/share/ShareSheet";
import { useTheme } from "../../kit/theme";
import {
  listCommonsResidents,
  retainCommonsItem,
} from "../../lib/replica/placement-transport";
import { backupDocument } from "../../lib/upload/media-producer";
import type { DocsScreenProps } from "../../navigation";
import { countLocalOnly, DOCS_CUSTODY_SHELF_SUFFIX } from "./docs-custody";
import { driveItemKey, FILTERS } from "./docs-library-shelves";
import type { LibraryFilter, ViewMode } from "./docs-library-shelves";
import type { NativeDocument, NativeFolder } from "./docs-model";
import { styles } from "./DocsHome.styles";
import DocsItemActions from "./DocsItemActions";
import { GridItem, ListItem } from "./DocsLibraryItems";
import type { DriveItem } from "./DocsLibraryItems";
import { useDocsLibrary } from "./useDocsLibrary";

// One shared identity for the "vault unavailable" case: a fresh `[]` per render
// would make FlatList re-diff a list it already knows is empty.
const NO_ITEMS: DriveItem[] = [];
const DOCS_APP = BUILTIN_APPS.find((app) => app.id === "docs");
// GridItem/ListItem are plain function components shared with other Docs
// screens; memoising them here is what stops every cell re-rendering when only
// the search box or the refresh flag changed.
const MemoGridItem = memo(GridItem);
MemoGridItem.displayName = "MemoGridItem";
const MemoListItem = memo(ListItem);
MemoListItem.displayName = "MemoListItem";

export default function DocsHome({
  route,
  navigation,
}: DocsScreenProps<"DocsHome">): React.JSX.Element {
  const { colors } = useTheme();
  const { session, gatewayBase, vaultId, refresh } = useReplica();
  const drive = useDocsLibrary();
  const folderId = route.params?.folderId;
  const [query, setQuery] = useState("");
  // Search results carry the query they were produced for, so a result can only
  // ever be shown against its own query — clearing them when the box empties is
  // then a derivation rather than a state update from the effect body, and a
  // stale hit list can't survive into the next query's debounce window.
  const [searched, setSearched] = useState<{
    query: string;
    ids?: Set<string>;
    error?: string;
  }>();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [view, setView] = useState<ViewMode>("list");
  const [addOpen, setAddOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedItem, setSelectedItem] = useState<DriveItem>();
  const [shareOpen, setShareOpen] = useState(false);
  const refreshLibrary = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const needle = query.trim();
    if (!needle || !session) return;
    let active = true;
    const timeout = setTimeout(
      () =>
        void session
          .search("docs", {
            entity: "core.document",
            query: needle,
            limit: 100,
          })
          .then((result) => {
            if (!active) return;
            setSearched({
              query: needle,
              ids: new Set(
                result.rows
                  .map((row) => String(row.values.document_id))
                  .map((id, index) => {
                    const scopeId =
                      result.rows[index]?.values.__centraidScopeId;
                    return typeof scopeId === "string"
                      ? `${scopeId}:${id}`
                      : id;
                  })
              ),
            });
          })
          .catch((error: unknown) => {
            if (!active) return;
            // An OnlineOnlyError is an expected degradation (e.g. an indexed
            // title too large to rank offline): fall back to the unfiltered
            // library rather than a scary error or a blank "no matches". A
            // real transport/protocol failure is surfaced instead of swallowed.
            setSearched({
              query: needle,
              ...(error instanceof OnlineOnlyError
                ? {}
                : { error: "Search is unavailable right now." }),
            });
          }),
      160
    );
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [query, session]);

  // A folder path resolver for search hits: a root-level search surfaces
  // documents living in subfolders (issue: search was ANDed with the current
  // folder), so each match shows where it lives.
  const folderById = useMemo(
    () => new Map(drive.folders.map((folder) => [folder.id, folder])),
    [drive.folders]
  );
  const folderPathOf = useCallback(
    (document: NativeDocument): string => {
      if (!document.folderId) return "Docs";
      const names: string[] = [];
      const seen = new Set<string>();
      let current: NativeFolder | undefined = folderById.get(document.folderId);
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        names.unshift(current.name);
        current = current.parentId
          ? folderById.get(current.parentId)
          : undefined;
      }
      return names.length ? names.join(" / ") : "Docs";
    },
    [folderById]
  );

  // Results only count while they still describe what is in the box.
  const current = searched?.query === query.trim() ? searched : undefined;
  const matches = current?.ids;
  const searchError = current?.error;
  // When a search is active the folder scope is dropped so a hit in any
  // subfolder surfaces; otherwise documents are scoped to the open folder.
  const searching = matches !== undefined;
  const documents = useMemo(() => {
    const inScope = drive.documents.filter((document) =>
      searching
        ? matches.has(document.id)
        : folderId
          ? document.folderId === folderId
          : !document.folderId
    );
    const visible = inScope.filter((document) => {
      if (filter === "trash") return document.trashed;
      if (document.trashed) return false;
      return filter !== "starred" || document.starred;
    });
    const sorted = [...visible].sort((a, b) =>
      b.modifiedAt.localeCompare(a.modifiedAt)
    );
    return filter === "recent" ? sorted.slice(0, 8) : sorted;
  }, [drive.documents, filter, folderId, matches, searching]);
  const folders = useMemo(
    () =>
      drive.folders.filter(
        (folder) =>
          filter === "all" &&
          !searching &&
          (folderId ? folder.parentId === folderId : !folder.parentId)
      ),
    [drive.folders, filter, folderId, searching]
  );
  // The per-shelf altitude (docs/blueprint-seats.md "Byte custody
  // vocabulary"): the population fact, as a count, over the same set of
  // documents the "N documents" count above already describes.
  const localOnlyCount = useMemo(() => countLocalOnly(documents), [documents]);
  // Memoised: this array is the list's `data`, and rebuilding it inline gave
  // FlatList a new identity on every keystroke and refresh toggle.
  const items = useMemo<DriveItem[]>(
    () => [
      ...folders.map((folder) => ({ kind: "folder" as const, folder })),
      ...documents.map((document) => ({
        kind: "document" as const,
        document,
        ...(searching ? { location: folderPathOf(document) } : {}),
      })),
    ],
    [documents, folderPathOf, folders, searching]
  );
  const parent = folderId
    ? drive.folders.find((folder) => folder.id === folderId)
    : undefined;
  const parentActorVaultId = parent?.sourceVaultId ?? vaultId;
  const parentItemId = parent?.rawId ?? parent?.id;
  const [residentFolderId, setResidentFolderId] = useState<string>();
  const commonsFolder = Boolean(
    parentItemId && residentFolderId === parentItemId
  );
  useEffect(() => {
    let active = true;
    if (!gatewayBase || !parentActorVaultId || !parentItemId) return;
    void listCommonsResidents(gatewayBase, parentActorVaultId)
      .then((residentItems) => {
        if (active)
          setResidentFolderId(
            residentItems.some(
              (item) =>
                item.itemType === "docs.folder" && item.itemId === parentItemId
            )
              ? parentItemId
              : undefined
          );
      })
      .catch(() => {
        if (active) setResidentFolderId(undefined);
      });
    return () => {
      active = false;
    };
  }, [gatewayBase, parentActorVaultId, parentItemId]);

  const saveFolderToMyVault = async (): Promise<void> => {
    if (!gatewayBase || !parentActorVaultId || !parentItemId || !commonsFolder)
      return;
    try {
      await retainCommonsItem(gatewayBase, {
        actorVaultId: parentActorVaultId,
        itemType: "docs.folder",
        itemId: parentItemId,
      });
      setResidentFolderId(undefined);
      postStatus(SAVED_TO_MY_VAULT);
    } catch (error) {
      surfaceWriteFailure(error, "Folder not saved to your vault");
    }
  };

  const pick = async (): Promise<void> => {
    setAddOpen(false);
    if (!session || !gatewayBase) {
      postStatus("Gateway unavailable — reconnect before adding a document.");
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (result.canceled) return;
    const uploadNext = async (index: number): Promise<void> => {
      const asset = result.assets[index];
      if (!asset) return;
      await backupDocument(session, gatewayBase, {
        localUri: asset.uri,
        ...(vaultId ? { targetVaultId: vaultId } : {}),
        title: asset.name,
        mediaType: asset.mimeType ?? "application/octet-stream",
        plaintextSize: asset.size ?? new File(asset.uri).size,
        ...(folderId ? { folderId } : {}),
      });
      return uploadNext(index + 1);
    };
    try {
      await uploadNext(0);
      postStatus("Import started — files are in the durable transfer queue.");
    } catch (error) {
      postStatus(
        `Import needs attention: ${error instanceof Error ? error.message : "The durable queue will retry after reconnecting."}`
      );
    }
  };
  const createFolder = async (): Promise<void> => {
    if (!session || !folderName.trim()) return;
    try {
      const result = await session.write("docs", {
        action: "create-folder",
        input: { name: folderName.trim() },
      });
      setFolderName("");
      setAddOpen(false);
      if (
        surfaceWriteOutcome(result, {
          onParked: () =>
            navigation.navigate("Settings", { screen: "Approvals" }),
          queuedMessage:
            "The folder will appear everywhere after the gateway reconnects.",
          failureTitle: "Folder not created",
        }) &&
        result.status === "executed"
      ) {
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
      }
    } catch (error) {
      setAddOpen(false);
      surfaceWriteFailure(error, "Folder not created");
    }
  };
  const selectFilter = (next: LibraryFilter): void => {
    void Haptics.selectionAsync();
    setFilter(next);
  };
  const grid = view === "grid";
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<DriveItem>): React.JSX.Element =>
      grid ? (
        <MemoGridItem
          item={item}
          navigation={navigation}
          colors={colors}
          onMenu={setSelectedItem}
        />
      ) : (
        <MemoListItem
          item={item}
          navigation={navigation}
          colors={colors}
          onMenu={setSelectedItem}
        />
      ),
    [colors, grid, navigation]
  );
  const listData = drive.connection === "unavailable" ? NO_ITEMS : items;

  return (
    // There is one page for the shell and every app in it — no per-app
    // surface tone (docs/traps/design-tokens.md).
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        {folderId ? (
          // In a folder: chevron = up one level, still inside Docs.
          <Pressable
            accessibilityLabel="Up to parent folder"
            onPress={() => navigation.goBack()}
          >
            <Icon name="chevron-left" size={26} color={colors.text} />
          </Pressable>
        ) : (
          // At the root: the shared teal grid = leave Docs for your apps.
          <HomeKey variant="leave" onPress={() => navigation.goBack()} />
        )}
        {DOCS_APP ? (
          <AppMark
            color={DOCS_APP.color}
            iconKey={DOCS_APP.iconKey}
            size={32}
            testID="docs-app-mark"
          />
        ) : null}
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.text }]}>
            {parent?.name ?? "Docs"}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSoft }]}>
            Private document library
          </Text>
        </View>
        <View style={styles.headerActions}>
          {parent ? (
            <Pressable
              accessibilityLabel={
                commonsFolder ? "Save to my vault" : "Share folder"
              }
              accessibilityRole="button"
              onPress={() =>
                commonsFolder ? void saveFolderToMyVault() : setShareOpen(true)
              }
              style={styles.shareFolder}
            >
              <Icon name="share" size={17} color={colors.accent} />
              <Text style={[styles.shareFolderText, { color: colors.accent }]}>
                {commonsFolder ? "Save to my vault" : "Share folder"}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Add document or folder"
            onPress={() => setAddOpen(true)}
          >
            <Icon name="plus" size={24} color={colors.accent} />
          </Pressable>
        </View>
      </View>
      <ReplicaStatusBar />

      <View style={[styles.search, { backgroundColor: colors.bgSunken }]}>
        <Icon name="search" size={17} color={colors.textSoft} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search documents offline"
          placeholderTextColor={colors.textFaint}
          style={[styles.input, { color: colors.text }]}
        />
        {query ? (
          <Pressable
            accessibilityLabel="Clear search"
            onPress={() => setQuery("")}
          >
            <Icon name="x" size={17} color={colors.textSoft} />
          </Pressable>
        ) : null}
      </View>

      {folderId ? null : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterScroll}
          contentContainerStyle={styles.filters}
        >
          {FILTERS.map((item) => {
            const active = filter === item.key;
            const count =
              item.key === "starred"
                ? drive.documents.filter(
                    (document) => document.starred && !document.trashed
                  ).length
                : item.key === "trash"
                  ? drive.documents.filter((document) => document.trashed)
                      .length
                  : undefined;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => selectFilter(item.key)}
                style={[
                  styles.filter,
                  { backgroundColor: active ? colors.text : colors.bgSunken },
                ]}
              >
                <Icon
                  name={item.icon}
                  size={14}
                  color={active ? colors.bg : colors.textSoft}
                />
                <Text
                  style={[
                    styles.filterText,
                    { color: active ? colors.bg : colors.textSoft },
                  ]}
                >
                  {item.label}
                  {count ? ` ${count}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <View style={styles.libraryHeader}>
        <View>
          <Text style={[styles.libraryTitle, { color: colors.text }]}>
            {filter === "all"
              ? folderId
                ? (parent?.name ?? "Folder")
                : "All documents"
              : FILTERS.find((item) => item.key === filter)?.label}
          </Text>
          <Text style={[styles.libraryMeta, { color: colors.textSoft }]}>
            {documents.length} documents
            {folders.length ? ` · ${folders.length} folders` : ""}
            {localOnlyCount
              ? ` · ${localOnlyCount} ${DOCS_CUSTODY_SHELF_SUFFIX}`
              : ""}
          </Text>
        </View>
        <View style={[styles.viewSwitch, { backgroundColor: colors.bgSunken }]}>
          {(["list", "grid"] as ViewMode[]).map((mode) => (
            <Pressable
              key={mode}
              accessibilityLabel={`${mode} view`}
              onPress={() => setView(mode)}
              style={[
                styles.viewButton,
                view === mode && { backgroundColor: colors.bgElev },
              ]}
            >
              <Icon
                name={mode === "list" ? "list" : "grid"}
                size={16}
                color={view === mode ? colors.text : colors.textFaint}
              />
            </Pressable>
          ))}
        </View>
      </View>

      <FlatList
        key={view}
        data={listData}
        numColumns={grid ? 2 : 1}
        columnWrapperStyle={grid ? styles.gridRow : undefined}
        keyExtractor={driveItemKey}
        contentContainerStyle={[styles.list, grid && styles.gridList]}
        // No getItemLayout: styles.row and styles.gridCard set minHeight, not
        // height — a wrapped metadata line or a two-line grid title makes a
        // cell taller, and a wrong offset here would misplace every row below.
        // ~550pt of list is left below the header, search box, filter strip and
        // library header. List rows are 68pt → 8 visible, so 9 covers the first
        // paint; grid cards are 164 + 10pt gap → ~3 rows, and initialNumToRender
        // counts items, so 3 rows × 2 columns = 8 (rounded to a full row + one).
        initialNumToRender={grid ? 8 : 9}
        maxToRenderPerBatch={grid ? 8 : 9}
        windowSize={7}
        removeClippedSubviews
        refreshing={refreshing}
        onRefresh={() => void refreshLibrary()}
        ListHeaderComponent={
          <ReplicaStateCard
            connection={drive.connection}
            error={drive.error}
            unavailableReason={drive.unavailableReason}
            noun="Docs"
            onRetry={() => void refreshLibrary()}
          />
        }
        ListEmptyComponent={
          drive.connection === "unavailable" || drive.error ? null : (
            <View style={styles.emptyWrap}>
              <Icon
                name={filter === "trash" ? "trash-2" : "file-text"}
                size={32}
                color={colors.accent}
              />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                {drive.loading
                  ? "Opening your drive…"
                  : searchError
                    ? searchError
                    : query
                      ? "No matching documents"
                      : drive.connection === "offline"
                        ? "No documents are cached here"
                        : "Nothing here yet"}
              </Text>
              <Text style={[styles.empty, { color: colors.textSoft }]}>
                {searchError
                  ? "Reconnect and try your search again."
                  : drive.connection === "offline"
                    ? "Reconnect to check the vault or pull newer documents."
                    : filter === "trash"
                      ? "Deleted documents will remain recoverable here."
                      : "Import a file, or create a folder."}
              </Text>
            </View>
          )
        }
        renderItem={renderItem}
      />

      <Modal
        transparent
        animationType="fade"
        visible={addOpen}
        onRequestClose={() => setAddOpen(false)}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.scrim }]}
          onPress={() => setAddOpen(false)}
        />
        <View style={[styles.dialog, { backgroundColor: colors.bgElev }]}>
          <Text style={[styles.dialogTitle, { color: colors.text }]}>
            Add to Docs
          </Text>
          <Pressable
            style={[styles.addRow, { borderBottomColor: colors.line }]}
            onPress={() => void pick()}
          >
            <View
              style={[styles.addIcon, { backgroundColor: colors.bgSunken }]}
            >
              <Icon name="upload-cloud" size={20} color={colors.accent} />
            </View>
            <View style={styles.addCopy}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>
                Import documents
              </Text>
              <Text style={[styles.meta, { color: colors.textSoft }]}>
                Choose files from this device
              </Text>
            </View>
          </Pressable>
          {folderId ? null : (
            <>
              <Text style={[styles.newFolderLabel, { color: colors.textSoft }]}>
                NEW FOLDER
              </Text>
              <TextInput
                value={folderName}
                onChangeText={setFolderName}
                placeholder="Folder name"
                placeholderTextColor={colors.textFaint}
                style={[
                  styles.folderInput,
                  { borderColor: colors.lineStrong, color: colors.text },
                ]}
              />
              <Pressable
                disabled={!folderName.trim()}
                style={[
                  styles.create,
                  {
                    backgroundColor: folderName.trim()
                      ? colors.accent
                      : colors.bgSunken,
                  },
                ]}
                onPress={() => void createFolder()}
              >
                <Text
                  style={[
                    styles.createText,
                    {
                      color: folderName.trim()
                        ? colors.textInv
                        : colors.textFaint,
                    },
                  ]}
                >
                  Create folder
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </Modal>
      <DocsItemActions
        key={
          selectedItem?.kind === "folder"
            ? `folder:${selectedItem.folder.id}`
            : selectedItem?.kind === "document"
              ? `document:${selectedItem.document.id}`
              : "closed"
        }
        item={selectedItem}
        folders={drive.folders}
        onClose={() => setSelectedItem(undefined)}
        onParked={() =>
          navigation.navigate("Settings", { screen: "Approvals" })
        }
        onChanged={refreshLibrary}
      />
      <ShareSheet
        visible={shareOpen}
        onClose={() => setShareOpen(false)}
        sourceVaultId={parent?.sourceVaultId ?? vaultId ?? ""}
        noun={parent?.name ?? "Folder"}
        itemType="docs.folder"
        itemIds={parent ? [parent.rawId ?? parent.id] : []}
        appLabel="Docs"
        onDone={(outcome) => postStatus(outcome.message)}
      />
    </TopSafeArea>
  );
}
