import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import AudiencePlacementSheet from "../../kit/components/AudiencePlacementSheet";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { family, useTheme } from "../../kit/theme";
import { optimisticValues } from "../../lib/replica/optimistic";
import type { PhotosScreenProps } from "../../navigation";
import { Store } from "../../storage";
import PhotoTimeline from "./PhotoTimeline";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

const KEEP_ORIGINALS_KEY = "photos.keepOriginalAlbums";

export default function AlbumDetail({
  route,
  navigation,
}: PhotosScreenProps<"AlbumDetail">): React.JSX.Element {
  const { colors, radii } = useTheme();
  const replica = useReplica();
  const { session } = replica;
  const { refreshing, refreshNow } = useReplicaRefresh();
  const timeline = usePhotoTimeline();
  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const entries = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection_entry" }), [])
  );
  const [selection, setSelection] = useState(new Set<string>());
  const [renameOpen, setRenameOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [name, setName] = useState("");
  const [keepOriginals, setKeepOriginals] = useState(false);
  // Which album's "keep originals" pin has finished hydrating. Derived rather
  // than a second boolean so switching albums can't leave a stale `true` behind
  // (and so nothing has to be reset synchronously from the effect below).
  const [pinsHydratedFor, setPinsHydratedFor] = useState<string>();
  const album = collections.rows.find(
    (row) => row.collection_id === route.params.albumId
  );
  const ids = new Set(
    entries.rows
      .filter((row) => row.collection_id === route.params.albumId)
      .map((row) => String(row.target_id))
  );
  const assets = timeline.assets.filter(
    (asset) => asset.assetId && ids.has(asset.assetId)
  );
  useEffect(() => {
    const albumId = route.params.albumId;
    void Store.hydrate<string[]>(KEEP_ORIGINALS_KEY, []).then((albumIds) => {
      setKeepOriginals(albumIds.includes(albumId));
      setPinsHydratedFor(albumId);
    });
  }, [route.params.albumId]);
  const pinsReady = pinsHydratedFor === route.params.albumId;
  const toggleKeepOriginals = (next: boolean): void => {
    if (!pinsReady) return;
    const current = Store.get<string[]>(KEEP_ORIGINALS_KEY, []);
    Store.set(
      KEEP_ORIGINALS_KEY,
      next
        ? [...new Set([...current, route.params.albumId])]
        : current.filter((albumId) => albumId !== route.params.albumId)
    );
    setKeepOriginals(next);
  };
  const remove = async (): Promise<void> => {
    const selectedAssets = assets.filter((item) => selection.has(item.id));
    const removeNext = async (index: number): Promise<void> => {
      const asset = selectedAssets[index];
      if (!asset) return;
      const entry = entries.rows.find(
        (row) =>
          row.collection_id === route.params.albumId &&
          row.target_id === asset.assetId
      );
      if (!session) return;
      const result = await session.write("photos", {
        action: "remove-from-album",
        input: { album_id: route.params.albumId, asset_id: asset.assetId! },
        ...(entry
          ? {
              optimistic: [
                {
                  op: "delete" as const,
                  entity: "core.collection_entry",
                  rowId: String(entry.entry_id),
                },
              ],
            }
          : {}),
      });
      surfaceWriteOutcome(result);
      return removeNext(index + 1);
    };
    try {
      await removeNext(0);
      setSelection(new Set());
    } catch (error) {
      surfaceWriteFailure(error, "Photos not removed");
    }
  };
  const setCover = async (): Promise<void> => {
    const selected = assets.find((item) => selection.has(item.id));
    if (!selected?.assetId || !selected.contentId || !album || !session) return;
    try {
      const result = await session.write("photos", {
        action: "set-album-cover",
        input: { album_id: route.params.albumId, asset_id: selected.assetId },
        optimistic: [
          {
            op: "upsert",
            entity: "core.collection",
            rowId: route.params.albumId,
            values: optimisticValues(album, {
              cover_content_id: selected.contentId,
            }),
          },
        ],
      });
      if (surfaceWriteOutcome(result)) setSelection(new Set());
    } catch (error) {
      surfaceWriteFailure(error, "Album cover not changed");
    }
  };
  const deleteAlbum = (): void =>
    Alert.alert("Delete album?", "Photos stay in the library.", [
      { text: "Keep" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          if (!session) return;
          void session
            .write("photos", {
              action: "delete-album",
              input: { album_id: route.params.albumId },
              optimistic: [
                {
                  op: "delete",
                  entity: "core.collection",
                  rowId: route.params.albumId,
                },
              ],
            })
            .then((result) => {
              if (surfaceWriteOutcome(result)) navigation.goBack();
            })
            .catch((error: unknown) =>
              surfaceWriteFailure(error, "Album not deleted")
            );
        },
      },
    ]);
  const rename = async (): Promise<void> => {
    if (!name.trim() || !album || !session) return;
    try {
      const result = await session.write("photos", {
        action: "rename-album",
        input: { album_id: route.params.albumId, title: name.trim() },
        optimistic: [
          {
            op: "upsert",
            entity: "core.collection",
            rowId: route.params.albumId,
            values: optimisticValues(album, { name: name.trim() }),
          },
        ],
      });
      if (surfaceWriteOutcome(result)) {
        setRenameOpen(false);
        setName("");
      }
    } catch (error) {
      surfaceWriteFailure(error, "Album not renamed");
    }
  };
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top"]}
    >
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.text }]}>
            {String(album?.name ?? "Album")}
          </Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            {assets.length} items
          </Text>
        </View>
        {selection.size ? (
          <View style={styles.selectionActions}>
            {selection.size === 1 ? (
              <Pressable onPress={() => void setCover()}>
                <Text style={[styles.coverAction, { color: colors.accent }]}>
                  Make cover
                </Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => void remove()}>
              <Text style={[styles.remove, { color: colors.danger }]}>
                Remove
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.actions}>
            <Pressable
              accessibilityLabel="Share album with household"
              accessibilityRole="button"
              onPress={() => setShareOpen(true)}
            >
              <Icon name="users" size={20} color={colors.accent} />
            </Pressable>
            <Pressable
              accessibilityLabel="Rename album"
              accessibilityRole="button"
              onPress={() => {
                setName(String(album?.name ?? ""));
                setRenameOpen(true);
              }}
            >
              <Icon name="edit-2" size={19} color={colors.accent} />
            </Pressable>
            <Pressable
              accessibilityLabel="Delete album"
              accessibilityRole="button"
              onPress={deleteAlbum}
            >
              <Icon name="trash-2" size={20} color={colors.danger} />
            </Pressable>
          </View>
        )}
      </View>
      <ReplicaStatusBar />
      <View style={[styles.keepRow, { borderBottomColor: colors.line }]}>
        <View style={styles.copy}>
          <Text style={[styles.keepTitle, { color: colors.text }]}>
            Keep originals on device
          </Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            Excluded from Free up space
          </Text>
        </View>
        <Switch
          disabled={!pinsReady}
          value={keepOriginals}
          onValueChange={toggleKeepOriginals}
        />
      </View>
      {assets.length ? (
        <PhotoTimeline
          sections={sectionPhotoAssets(assets)}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(asset) =>
            navigation.navigate("PhotoLightbox", { assetId: asset.id })
          }
          refreshing={refreshing}
          onRefresh={refreshNow}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            This album is empty.
          </Text>
        </View>
      )}
      <Modal
        transparent
        animationType="fade"
        visible={renameOpen}
        onRequestClose={() => setRenameOpen(false)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => setRenameOpen(false)}
        />
        <View style={[styles.dialog, { backgroundColor: colors.bgElev }]}>
          <Text style={[styles.dialogTitle, { color: colors.text }]}>
            Rename album
          </Text>
          <TextInput
            autoFocus
            value={name}
            onChangeText={setName}
            style={[
              styles.input,
              { borderColor: colors.lineStrong, color: colors.text },
            ]}
          />
          <Pressable
            onPress={() => void rename()}
            style={[
              styles.save,
              { backgroundColor: colors.accentFill, borderRadius: radii.md },
            ]}
          >
            <Text style={[styles.saveText, { color: colors.textInv }]}>
              Save
            </Text>
          </Pressable>
        </View>
      </Modal>
      <AudiencePlacementSheet
        visible={shareOpen}
        itemType="core.collection"
        itemId={route.params.albumId}
        sourceVaultId={String(
          album?.__centraidScopeId ?? replica.vaultId ?? ""
        )}
        noun="Album"
        onClose={() => setShareOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: 18 },
  backdrop: { backgroundColor: "rgba(0,0,0,.4)", flex: 1 },
  copy: { flex: 1, marginLeft: 10 },
  coverAction: { fontFamily: family.sansBold, fontSize: 13 },
  empty: { alignItems: "center", flex: 1, justifyContent: "center" },
  dialog: {
    borderRadius: 16,
    left: 28,
    padding: 20,
    position: "absolute",
    right: 28,
    top: "34%",
  },
  dialogTitle: { fontFamily: family.sansBold, fontSize: 19 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 56,
    paddingHorizontal: 14,
  },
  meta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 15,
    marginTop: 16,
    padding: 12,
  },
  keepRow: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    marginHorizontal: 16,
    paddingVertical: 10,
  },
  keepTitle: { fontFamily: family.sansMedium, fontSize: 13 },
  remove: { fontFamily: family.sansBold, fontSize: 13 },
  selectionActions: { alignItems: "center", flexDirection: "row", gap: 14 },
  safe: { flex: 1 },
  save: { alignItems: "center", marginTop: 12, padding: 12 },
  saveText: { fontFamily: family.sansBold, fontSize: 13 },
  title: { fontFamily: family.sansBold, fontSize: 18 },
});
