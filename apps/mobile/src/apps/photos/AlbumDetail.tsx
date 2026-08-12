// One album (Photos v4 handoff §14, §18).
//
// An album REFERS to a photograph where it lives; it never moves or copies
// anything. That is why "Remove" here is an outlined control and not a filled
// red one: it removes a reference, and the photograph stays in the library.
//
// The grid is the same justified timeline every other shelf uses — an album is
// a shelf, not a different way of looking at photographs.

import React, { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Pressable, Switch, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import ShareSheet from "../../kit/share/ShareSheet";
import { useTheme } from "../../kit/theme";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import {
  listCommonsResidents,
  retainCommonsItem,
} from "../../lib/replica/placement-transport";
import type { PhotosScreenProps } from "../../navigation";
import { Store } from "../../storage";
import { makeStyles } from "./AlbumDetail.styles";
import {
  NO_DOWNLOAD_REASON,
  batchAddToAlbum,
  batchFavorite,
  batchTrash,
  vaultAssets,
} from "./photos-selection-writes";
import PhotosScreen from "./PhotosScreen";
import PhotoTimeline from "./PhotoTimeline";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import { useCopyToVault } from "./use-copy-to-vault";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

const KEEP_ORIGINALS_KEY = "photos.keepOriginalAlbums";

export default function AlbumDetail({
  route,
  navigation,
}: PhotosScreenProps<"AlbumDetail">): React.JSX.Element {
  const { colors, radii } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
  const [residentAlbumId, setResidentAlbumId] = useState<string>();
  const [name, setName] = useState("");
  const [keepOriginals, setKeepOriginals] = useState(false);
  // Which album's "keep originals" pin has finished hydrating. Derived rather
  // than a second boolean so switching albums can't leave a stale `true` behind
  // (and so nothing has to be reset synchronously from the effect below).
  const [pinsHydratedFor, setPinsHydratedFor] = useState<string>();
  const album = collections.rows.find(
    (row) => row.collection_id === route.params.albumId
  );
  const albumVaultId = String(
    album?.__centraidScopeId ?? replica.vaultId ?? ""
  );
  const commonsAlbum = residentAlbumId === route.params.albumId;
  useEffect(() => {
    let active = true;
    if (!replica.gatewayBase || !albumVaultId) return;
    void listCommonsResidents(replica.gatewayBase, albumVaultId)
      .then((items) => {
        if (active)
          setResidentAlbumId(
            items.some(
              (item) =>
                item.itemType === "core.collection" &&
                item.itemId === route.params.albumId
            )
              ? route.params.albumId
              : undefined
          );
      })
      .catch(() => {
        if (active) setResidentAlbumId(undefined);
      });
    return () => {
      active = false;
    };
  }, [albumVaultId, replica.gatewayBase, route.params.albumId]);

  const saveAlbumToMyVault = async (): Promise<void> => {
    if (!replica.gatewayBase || !albumVaultId || !commonsAlbum) return;
    try {
      await retainCommonsItem(replica.gatewayBase, {
        actorVaultId: albumVaultId,
        itemType: "core.collection",
        itemId: route.params.albumId,
      });
      setResidentAlbumId(undefined);
      postStatus("Saved to my vault. This copy survives if the share ends.");
    } catch (error) {
      surfaceWriteFailure(error, "Album not saved to your vault");
    }
  };
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
  // CAN THIS MEMBER CHANGE THIS ALBUM? Rename, Delete, Share, Make cover and
  // Remove all used to render unconditionally and then `return` on a missing
  // session — a silent no-op, which §1 forbids outright: a control that looks
  // available and does nothing teaches a member that the app is broken, and
  // they have no way to learn otherwise. Two different truths block the write
  // and a member can act on the difference, so each states its own sentence.
  const scopeWritable = album ? album.__centraidCanWrite !== false : true;
  const writeBlockedReason = session
    ? scopeWritable
      ? null
      : READ_ONLY_VAULT_REASON
    : "Not connected to a gateway, so this album cannot be changed here.";
  const canChangeAlbum = writeBlockedReason === null;
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
    // Belt and braces, exactly as the viewer's bar does it: the control is
    // already disabled AND its press handler returns early — this guard is
    // what stops any other caller from reaching the write.
    if (!canChangeAlbum) return;
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
        input: {
          album_id: route.params.albumId,
          asset_id: asset.assetId!,
          ...(entry ? { entry_id: String(entry.entry_id) } : {}),
        },
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
    if (!canChangeAlbum) return;
    const selected = assets.find((item) => selection.has(item.id));
    if (!selected?.assetId || !selected.contentId || !album || !session) return;
    try {
      const result = await session.write("photos", {
        action: "set-album-cover",
        input: { album_id: route.params.albumId, asset_id: selected.assetId },
      });
      if (surfaceWriteOutcome(result)) setSelection(new Set());
    } catch (error) {
      surfaceWriteFailure(error, "Album cover not changed");
    }
  };
  const deleteAlbum = (): void => {
    if (!canChangeAlbum) return;
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
  };
  const rename = async (): Promise<void> => {
    if (!canChangeAlbum || !name.trim() || !album || !session) return;
    try {
      const result = await session.write("photos", {
        action: "rename-album",
        input: { album_id: route.params.albumId, title: name.trim() },
      });
      if (surfaceWriteOutcome(result)) {
        setRenameOpen(false);
        setName("");
      }
    } catch (error) {
      surfaceWriteFailure(error, "Album not renamed");
    }
  };
  const selectedVaultAssets = vaultAssets(assets, selection);
  // One handler for the third selection target, shared by every Photos shelf
  // (`use-copy-to-vault.ts`) so the picker moment and the refusal grammar
  // cannot drift between them.
  const copyToVault = useCopyToVault(
    () => selectedVaultAssets,
    () => setSelection(new Set())
  );
  /** Add to ANOTHER album. The phone has no room for an inline popover, so
   *  the album list is the platform's own list-of-choices (§6's phone note
   *  reaches the same answer on the web with a sheet). */
  const addToAnotherAlbum = (): void => {
    const others = collections.rows.filter(
      (row) => String(row.collection_id) !== route.params.albumId
    );
    if (!others.length) {
      postStatus("No other album to add these to yet.");
      return;
    }
    Alert.alert("Add to album", `${selection.size} selected`, [
      ...others.slice(0, 6).map((other) => ({
        text: String(other.name ?? "Album"),
        onPress: () => {
          const albumId = String(other.collection_id);
          const position = entries.rows.filter(
            (row) => String(row.collection_id) === albumId
          ).length;
          runSelection(
            () =>
              batchAddToAlbum(
                session!,
                selectedVaultAssets,
                albumId,
                position,
                emit
              ),
            "Photos not added"
          )();
        },
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  const emit = (result: NativeWriteResult): void => {
    surfaceWriteOutcome(result);
  };
  const runSelection = (
    run: () => Promise<void>,
    failure: string
  ): (() => void) => {
    return () => {
      void run()
        .then(() => setSelection(new Set()))
        .catch((error: unknown) => surfaceWriteFailure(error, failure));
    };
  };
  // The five, wired to the writes this screen already performs. `Download`
  // has no phone surface behind it yet, so it renders disabled with the
  // sentence that says so rather than doing nothing.
  const selectionBar = {
    count: selection.size,
    shelf: "normal" as const,
    copyLabel: copyToVault.copyLabel,
    readOnlyReason: writeBlockedReason,
    favorite: canChangeAlbum
      ? {
          run: runSelection(
            () => batchFavorite(session!, selectedVaultAssets, emit),
            "Photos not favorited"
          ),
        }
      : { unavailableReason: writeBlockedReason! },
    addToAlbum: canChangeAlbum
      ? { run: () => addToAnotherAlbum() }
      : { unavailableReason: writeBlockedReason! },
    // Share uses the same ceremony-free commons destination list everywhere.
    share: copyToVault.handler,
    download: { unavailableReason: NO_DOWNLOAD_REASON },
    trash: canChangeAlbum
      ? {
          run: () =>
            Alert.alert(
              `Move ${selection.size} to trash?`,
              "The device original is never deleted by this action.",
              [
                { text: "Cancel" },
                {
                  text: "Trash",
                  style: "destructive" as const,
                  onPress: runSelection(
                    () => batchTrash(session!, selectedVaultAssets, emit),
                    "Photos not trashed"
                  ),
                },
              ]
            ),
        }
      : { unavailableReason: writeBlockedReason! },
  };
  return (
    <PhotosScreen current="collections" selection={selectionBar}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Photos"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
          style={styles.headerBtn}
        >
          <Icon name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.copy}>
          <Text style={styles.title} numberOfLines={1}>
            {String(album?.name ?? "Album")}
          </Text>
          <Text style={styles.meta}>
            {assets.length} {assets.length === 1 ? "photograph" : "photographs"}
          </Text>
        </View>
        {selection.size ? (
          <View style={styles.selectionActions}>
            {selection.size === 1 ? (
              <Pressable
                accessibilityLabel="Make this photograph the album cover"
                accessibilityRole="button"
                accessibilityState={{ disabled: !canChangeAlbum }}
                accessibilityHint={writeBlockedReason ?? undefined}
                disabled={!canChangeAlbum}
                onPress={() => {
                  if (!canChangeAlbum) return;
                  void setCover();
                }}
                style={styles.outlineBtn}
              >
                <Text
                  style={[
                    styles.outlineBtnText,
                    !canChangeAlbum && { color: colors.textDisabled },
                  ]}
                >
                  Make cover
                </Text>
              </Pressable>
            ) : null}
            {/* Destructive, so OUTLINED: a filled red control would be the
                loudest thing on a page of photographs, for an action that only
                removes a reference. */}
            <Pressable
              accessibilityLabel={`Remove ${selection.size} from this album`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canChangeAlbum }}
              accessibilityHint={writeBlockedReason ?? undefined}
              disabled={!canChangeAlbum}
              onPress={() => {
                if (!canChangeAlbum) return;
                void remove();
              }}
              style={[
                styles.outlineBtn,
                canChangeAlbum ? styles.destructive : styles.disabledOutline,
              ]}
            >
              <Text
                style={[
                  styles.outlineBtnText,
                  canChangeAlbum
                    ? styles.destructiveText
                    : { color: colors.textDisabled },
                ]}
              >
                Remove
              </Text>
            </Pressable>
          </View>
        ) : (
          // Rename and Delete both WRITE. Each stays visible when the
          // member may not write — hiding either answers "why can I not
          // do this?" with silence — and each is disabled, inert, and
          // explained by the one line under this row.
          <View style={styles.actions}>
            {/* THE WAY INTO THE PICKER (§10). Until this control existed the
                picker had no entry point on the phone at all: an album could
                only grow by selecting photographs somewhere else and adding
                them from there, which is the reverse of how a member curates
                an album. Same disabled-with-the-reason treatment as every
                other write on this row. */}
            <Pressable
              accessibilityLabel="Add photographs to this album"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canChangeAlbum }}
              accessibilityHint={writeBlockedReason ?? undefined}
              disabled={!canChangeAlbum}
              onPress={() => {
                if (!canChangeAlbum) return;
                navigation.navigate("PhotoPicker", {
                  albumId: route.params.albumId,
                });
              }}
              style={styles.headerBtn}
            >
              <Icon
                name="plus"
                size={20}
                color={canChangeAlbum ? colors.text : colors.textDisabled}
              />
            </Pressable>
            {commonsAlbum ? (
              <Pressable
                accessibilityLabel="Save to my vault"
                accessibilityRole="button"
                onPress={() => void saveAlbumToMyVault()}
                style={styles.headerBtn}
              >
                <Icon name="copy" size={20} color={colors.text} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="Rename album"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canChangeAlbum }}
              accessibilityHint={writeBlockedReason ?? undefined}
              disabled={!canChangeAlbum}
              onPress={() => {
                if (!canChangeAlbum) return;
                setName(String(album?.name ?? ""));
                setRenameOpen(true);
              }}
              style={styles.headerBtn}
            >
              <Icon
                name="edit-2"
                size={19}
                color={canChangeAlbum ? colors.text : colors.textDisabled}
              />
            </Pressable>
            <Pressable
              accessibilityLabel="Delete album"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canChangeAlbum }}
              accessibilityHint={writeBlockedReason ?? undefined}
              disabled={!canChangeAlbum}
              onPress={deleteAlbum}
              style={styles.headerBtn}
            >
              <Icon
                name="trash-2"
                size={20}
                color={canChangeAlbum ? colors.danger : colors.textDisabled}
              />
            </Pressable>
          </View>
        )}
      </View>
      <ReplicaStatusBar />
      {/* The refusal, STATED — in `--net` mono, on the surface, once for the
          whole row of controls above. Never a tooltip, never a hint alone. */}
      {writeBlockedReason ? (
        <Text style={[styles.blockedReason, { color: colors.net }]}>
          {writeBlockedReason}
        </Text>
      ) : null}
      <View style={styles.keepRow}>
        <View style={styles.keepCopy}>
          <Text style={styles.keepTitle}>Keep originals on device</Text>
          <Text style={styles.meta}>Excluded from Free up vault</Text>
        </View>
        <Switch
          accessibilityLabel="Keep this album's originals on device"
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
          <Text style={styles.emptyTitle}>Nothing in this album yet.</Text>
          <Text style={styles.emptyBody}>
            An album refers to a photograph where it lives; it never moves or
            copies anything.
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
          accessibilityLabel="Close rename album dialog"
          accessibilityRole="button"
          style={styles.backdrop}
          onPress={() => setRenameOpen(false)}
        />
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>Rename album</Text>
          <TextInput
            accessibilityLabel="Album name"
            autoFocus
            value={name}
            onChangeText={setName}
            style={styles.input}
          />
          {/* The dialog's ONE filled element — the thing it exists to do. */}
          <Pressable
            accessibilityLabel="Save album name"
            accessibilityRole="button"
            onPress={() => void rename()}
            style={[
              styles.save,
              { backgroundColor: colors.accentFill, borderRadius: radii.md },
            ]}
          >
            <Text style={styles.saveText}>Save</Text>
          </Pressable>
        </View>
      </Modal>
      <ShareSheet
        visible={copyToVault.picking}
        onClose={() => copyToVault.dismiss()}
        {...copyToVault.sheetProps}
      />
    </PhotosScreen>
  );
}
