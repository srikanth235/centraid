import { useFocusEffect } from "@react-navigation/native";
import { FlashList } from "@shopify/flash-list";
import type { ListRenderItemInfo } from "@shopify/flash-list";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import React, { memo, useCallback, useMemo, useState } from "react";
import { Alert, Modal, Pressable, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import {
  revalidateBackedUp,
  selectFreeUpCandidates,
} from "../../kit/storage/free-up-space";
import type { DeviceByteProbe } from "../../kit/storage/free-up-space";
import { useTheme } from "../../kit/theme";
import { sha256OfFile } from "../../lib/upload/enqueue";
import { expoFileSource } from "../../lib/upload/expo-native";
import { createNativeDigest } from "../../lib/upload/native-digest";
import type { PhotosScreenProps } from "../../navigation";
import { Store } from "../../storage";
import {
  IN_CLOUD_MESSAGE,
  InCloudOriginalError,
  openDeviceOriginal,
} from "./device-media";
import { protectedAssetIdsFromPins } from "./photos-library-pins";
import { styles } from "./PhotosLibrary.styles";
import PhotosScreen from "./PhotosScreen";
import type { PhotoAsset } from "./timeline-source";
import { usePhotoTimeline } from "./timeline-source";

const KEEP_ORIGINALS_KEY = "photos.keepOriginalAlbums";

type AlbumRow = {
  album: ReturnType<typeof useReplicaQuery>["rows"][number];
  cover: PhotoAsset | undefined;
  count: number;
};

/**
 * One album tile. Memoized and hoisted out of the screen body so a state change
 * anywhere on the page (refresh flag, dialog open, pin hydration) does not
 * re-render — and re-decode the cover of — every album in the grid.
 */
const AlbumCard = memo(
  ({
    row: { album, cover, count },
    colors,
    onOpen,
  }: {
    row: AlbumRow;
    colors: ReturnType<typeof useTheme>["colors"];
    onOpen: (collectionId: string) => void;
  }) => (
    <Pressable
      accessibilityLabel={`Open album ${String(album.name ?? "Untitled")}, ${count} photos`}
      accessibilityRole="button"
      onPress={() => onOpen(String(album.collection_id))}
      style={styles.albumCard}
    >
      {cover ? (
        <Image
          source={imageSource(cover.uri)}
          {...gridImageProps(cover.uri)}
          recyclingKey={cover.id}
          style={styles.albumCover}
        />
      ) : (
        <View
          style={[styles.albumCover, { backgroundColor: colors.bgSunken }]}
        />
      )}
      <Text
        numberOfLines={1}
        style={[styles.albumTitle, { color: colors.text }]}
      >
        {String(album.name ?? "Album")}
      </Text>
      <Text style={[styles.rowMeta, { color: colors.textFaint }]}>
        {count} {count === 1 ? "photograph" : "photographs"}
      </Text>
    </Pressable>
  )
);

AlbumCard.displayName = "AlbumCard";

export default function PhotosLibrary({
  navigation,
}: PhotosScreenProps<"PhotosLibrary">): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const { assets } = usePhotoTimeline();
  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const entries = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection_entry" }), [])
  );
  const [keptAlbums, setKeptAlbums] = useState<string[]>([]);
  const [pinsReady, setPinsReady] = useState(false);
  const [freeing, setFreeing] = useState(false);
  const [newAlbum, setNewAlbum] = useState(false);
  const [title, setTitle] = useState("");
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setPinsReady(false);
      void Store.hydrate<string[]>(KEEP_ORIGINALS_KEY, []).then((albumIds) => {
        if (active) {
          setKeptAlbums(albumIds);
          setPinsReady(true);
        }
      });
      return () => {
        active = false;
      };
    }, [])
  );
  // The keep-pin exclusion is only trustworthy once the collection_entry rows
  // have actually loaded — an empty set mid-load would wrongly treat pinned
  // album originals as eligible for deletion.
  const pinsHydrated = pinsReady && !entries.loading;
  const protectedAssets = useMemo(
    () => protectedAssetIdsFromPins(entries.rows, keptAlbums, assets),
    [assets, entries.rows, keptAlbums]
  );
  const freeCandidates = useMemo(
    () => selectFreeUpCandidates(assets, protectedAssets),
    [assets, protectedAssets]
  );
  const eligibleCount = useMemo(
    () =>
      freeCandidates.reduce(
        (total, candidate) => total + candidate.localIds.length,
        0
      ),
    [freeCandidates]
  );
  const eligibleBytes = useMemo(
    () =>
      freeCandidates.reduce(
        (total, candidate) => total + candidate.fileSize,
        0
      ),
    [freeCandidates]
  );
  const duplicateCount = assets.filter((asset) => asset.duplicateHint).length;
  // Memoized because it is the list's `data`: an array rebuilt on every render
  // is a new identity, which makes the windowed list treat every album as a
  // changed row. The build itself is also a full entries × albums pass.
  const albumRows = useMemo(
    () =>
      [...collections.rows]
        .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
        .map((album) => {
          const assetIds = new Set(
            entries.rows
              .filter((entry) => entry.collection_id === album.collection_id)
              .map((entry) => String(entry.target_id))
          );
          const albumAssets = assets.filter(
            (asset) => asset.assetId && assetIds.has(asset.assetId)
          );
          const cover =
            albumAssets.find(
              (asset) => asset.contentId === album.cover_content_id
            ) ?? albumAssets[0];
          return { album, cover, count: albumAssets.length };
        }),
    [assets, collections.rows, entries.rows]
  );
  const openAlbum = useCallback(
    (collectionId: string): void => {
      navigation.navigate("AlbumDetail", { albumId: collectionId });
    },
    [navigation]
  );
  const renderAlbum = useCallback(
    ({ item }: ListRenderItemInfo<AlbumRow>) => (
      <AlbumCard row={item} colors={colors} onOpen={openAlbum} />
    ),
    [colors, openAlbum]
  );

  const createAlbum = async (): Promise<void> => {
    if (!session || !title.trim()) return;
    try {
      const result = await session.write("photos", {
        action: "create-album",
        input: { title: title.trim() },
      });
      if (surfaceWriteOutcome(result)) {
        setNewAlbum(false);
        setTitle("");
      }
    } catch (error) {
      surfaceWriteFailure(error, "Album not created");
    }
  };
  // Re-hash the CURRENT bytes of one device copy. A photo edited in place after
  // backup keeps its ph:// id but holds new bytes; this is what catches that.
  const probeDeviceBytes: DeviceByteProbe = async (localId) => {
    try {
      const original = await openDeviceOriginal(localId);
      return await sha256OfFile(
        expoFileSource,
        original.uri,
        createNativeDigest
      );
    } catch (error) {
      if (!(error instanceof InCloudOriginalError)) throw error;
      // Reported as its own outcome below. Calling it "already gone" would be a
      // lie about a photo that is very much still there, just not here.
      return "in-cloud";
    }
  };
  const confirmFreeSpace = async (): Promise<void> => {
    setFreeing(true);
    try {
      // Revalidate at delete time, never trusting the settle-time map alone.
      const result = await revalidateBackedUp(freeCandidates, probeDeviceBytes);
      if (result.deletableLocalIds.length)
        await MediaLibrary.Asset.delete(
          result.deletableLocalIds.map(
            (localId) => new MediaLibrary.Asset(localId)
          )
        );
      const lines = [
        `${result.deletableLocalIds.length} originals removed (${(result.eligibleBytes / 1024 / 1024 / 1024).toFixed(2)} GB).`,
      ];
      if (result.changedCount)
        lines.push(
          `${result.changedCount} changed since backup — kept on device.`
        );
      if (result.missingCount)
        lines.push(`${result.missingCount} already gone.`);
      if (result.inCloudCount)
        lines.push(
          `${result.inCloudCount} ${IN_CLOUD_MESSAGE} — their bytes could not be checked, so they were kept.`
        );
      postStatus(
        lines.length
          ? lines.join(" ")
          : result.changedCount || result.missingCount || result.inCloudCount
            ? "Vault freed with exclusions."
            : "Vault freed."
      );
    } catch (error) {
      postStatus(
        `Free up vault paused: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setFreeing(false);
    }
  };
  const freeSpace = (): void => {
    if (!pinsHydrated) {
      postStatus(
        "Checking device pins — try again when protected albums finish loading."
      );
      return;
    }
    if (!freeCandidates.length) {
      postStatus(
        "Nothing to free — no verified backups are eligible right now."
      );
      return;
    }
    Alert.alert(
      "Free up vault",
      `${eligibleCount} verified originals (${(eligibleBytes / 1024 / 1024 / 1024).toFixed(2)} GB) are eligible. Bytes are re-hashed at delete time and anything changed since backup is kept. Albums pinned to this device are excluded. This is the only action here that touches device originals.`,
      [
        { text: "Cancel" },
        {
          text: "Delete from device",
          style: "destructive",
          onPress: () => void confirmFreeSpace(),
        },
      ]
    );
  };
  return (
    // The band is the way out now (§F, proto:4953-4954), so the head carries
    // NO back chevron: this surface is the band's `Library` destination, and a
    // destination that also owns a back arrow gives a member two answers to
    // "where does this go".
    <PhotosScreen current="library">
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Library</Text>
        <Pressable
          accessibilityLabel="Create album"
          accessibilityRole="button"
          onPress={() => setNewAlbum(true)}
          style={styles.headerBtn}
        >
          <Icon name="plus" size={22} color={colors.text} />
        </Pressable>
      </View>
      <ReplicaStatusBar />
      {/* One windowed list for the whole page: the album grid is the data and
        everything around it is header/footer. A plain ScrollView mounted every
        album cover at once, and nesting a list inside a ScrollView would have
        done the same thing while adding a scroll conflict. */}
      <FlashList
        data={albumRows}
        numColumns={2}
        keyExtractor={(row) => String(row.album.__rowId)}
        renderItem={renderAlbum}
        refreshing={refreshing}
        onRefresh={refreshNow}
        contentContainerStyle={styles.content}
        ListEmptyComponent={
          <View style={styles.pageSection}>
            <Text style={[styles.empty, { color: colors.textSoft }]}>
              No albums yet — tap + to create one.
            </Text>
          </View>
        }
        ListHeaderComponent={
          <View style={styles.pageSection}>
            <Text style={[styles.section, { color: colors.textSoft }]}>
              Your library
            </Text>
            <Pressable
              accessibilityLabel="Open favorite photos"
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("PhotoStateView", { mode: "favorites" })
              }
            >
              <Row
                icon="heart"
                title="Favorites"
                meta={`${assets.filter((asset) => asset.favorite).length}`}
                colors={colors}
              />
            </Pressable>
            <Pressable
              accessibilityLabel="Open archived photos"
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("PhotoStateView", { mode: "archive" })
              }
            >
              <Row
                icon="archive"
                title="Archive"
                meta={`${assets.filter((asset) => asset.archived).length}`}
                colors={colors}
              />
            </Pressable>
            <Pressable
              accessibilityLabel="Open photo trash"
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("PhotoStateView", { mode: "trash" })
              }
            >
              <Row
                icon="trash-2"
                title="Trash"
                meta={`${assets.filter((asset) => asset.deleted).length} · vault purge policy`}
                colors={colors}
              />
            </Pressable>
            <Pressable
              accessibilityLabel="Review proposed people"
              accessibilityRole="button"
              onPress={() => navigation.navigate("FaceReview")}
            >
              <Row
                icon="users"
                title="People"
                meta={`${new Set(faces.rows.map((row) => row.party_id).filter(Boolean)).size} people · ${faces.rows.filter((row) => row.review_state === "proposed").length} proposals`}
                colors={colors}
              />
            </Pressable>
            <Pressable
              accessibilityLabel="Review possible duplicate photos"
              accessibilityRole="button"
              onPress={() => navigation.navigate("DuplicateReview")}
            >
              <Row
                icon="copy"
                title="Duplicates review"
                meta={`${duplicateCount} similarity hints`}
                colors={colors}
              />
            </Pressable>
            <Pressable
              accessibilityLabel="Open photo places map"
              accessibilityRole="button"
              onPress={() => navigation.navigate("PlacesMap")}
            >
              <Row
                icon="map-pin"
                title="Places"
                meta={`${places.rows.length} saved places`}
                colors={colors}
              />
            </Pressable>
            <Text style={[styles.section, { color: colors.textSoft }]}>
              Albums
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.pageSection}>
            <Text style={[styles.section, { color: colors.textSoft }]}>
              Backup &amp; storage
            </Text>
            <Pressable
              accessibilityLabel="Open backup health"
              accessibilityRole="button"
              onPress={() =>
                // Cross-stack since #712: Backup health is a frame
                // screen in Settings now, not a Photos route.
                navigation.navigate("Settings", { screen: "BackupHealth" })
              }
            >
              <Row
                icon="cloud"
                title="Backup health"
                meta="Rules, queue, errors, storage policy"
                colors={colors}
              />
            </Pressable>
            <Pressable
              accessibilityLabel="Free offline thumbnail vault"
              accessibilityRole="button"
              accessibilityState={{ disabled: !pinsHydrated || freeing }}
              disabled={!pinsHydrated || freeing}
              onPress={freeSpace}
            >
              <Row
                icon="hard-drive"
                title="Free up vault"
                meta={
                  freeing
                    ? "Re-hashing device originals…"
                    : pinsHydrated
                      ? `${eligibleCount} verified originals · ${(eligibleBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
                      : "Checking protected albums…"
                }
                colors={colors}
              />
            </Pressable>
          </View>
        }
      />
      <Modal
        transparent
        animationType="fade"
        visible={newAlbum}
        onRequestClose={() => setNewAlbum(false)}
      >
        <Pressable
          accessibilityLabel="Close create album dialog"
          accessibilityRole="button"
          style={[styles.backdrop, { backgroundColor: colors.scrim }]}
          onPress={() => setNewAlbum(false)}
        />
        <View
          style={[
            styles.dialog,
            { backgroundColor: colors.bgElev, borderColor: colors.line },
          ]}
        >
          <Text style={[styles.dialogTitle, { color: colors.text }]}>
            New album
          </Text>
          <TextInput
            accessibilityLabel="Album name"
            autoFocus
            value={title}
            onChangeText={setTitle}
            placeholder="Album name"
            placeholderTextColor={colors.textFaint}
            style={[
              styles.albumInput,
              { borderColor: colors.lineStrong, color: colors.text },
            ]}
          />
          {/* The dialog's ONE filled element — the thing it exists to do. */}
          <Pressable
            accessibilityLabel="Create album"
            accessibilityRole="button"
            style={[styles.create, { backgroundColor: colors.accentFill }]}
            onPress={() => void createAlbum()}
          >
            <Text style={[styles.createText, { color: colors.textInv }]}>
              Create
            </Text>
          </Pressable>
        </View>
      </Modal>
    </PhotosScreen>
  );
}

function Row({
  icon,
  title,
  meta,
  colors,
}: {
  icon: string;
  title: string;
  meta: string;
  colors: ReturnType<typeof useTheme>["colors"];
}): React.JSX.Element {
  return (
    <View style={[styles.row, { borderBottomColor: colors.line }]}>
      {/* The row's mark is a quiet outlined tile, not a tinted fill: a page of
          nine rows would otherwise carry nine filled elements (§18). */}
      <View
        style={[
          styles.icon,
          { backgroundColor: colors.bgSunken, borderColor: colors.line },
        ]}
      >
        <Icon name={icon} size={19} color={colors.textSoft} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.rowMeta, { color: colors.textFaint }]}>
          {meta}
        </Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.textGhost} />
    </View>
  );
}
