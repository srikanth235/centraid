import { Feather } from "@expo/vector-icons";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as Notifications from "expo-notifications";
// governance: allow-repo-hygiene file-size-limit cohesive Photos cover (timeline + memory hero + four-view switch + glass bottom bar + drawer/switcher wiring); decompose the views in a follow-up (#498)
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import GlassBar from "../../kit/components/GlassBar";
import HomeKey from "../../kit/components/HomeKey";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { family, useTheme } from "../../kit/theme";
import { refreshPinnedThumbnailPack } from "../../lib/replica/thumbnail-pack";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import type { PhotosScreenProps } from "../../navigation";
import SpacesSwitcher from "../../screens/home/SpacesSwitcher";
import { Store } from "../../storage";
import {
  IN_CLOUD_MESSAGE,
  InCloudOriginalError,
  liveVideoUri,
  openDeviceOriginal,
} from "./device-media";
import type { DeviceOriginal } from "./device-media";
import { imageSource } from "./media-source";
import PhotosAskView from "./PhotosAskView";
import PhotosCollectionsView from "./PhotosCollectionsView";
import PhotosCreateView from "./PhotosCreateView";
import PhotosDrawer from "./PhotosDrawer";
import PhotoTimeline from "./PhotoTimeline";
import { onThisDay } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

// The bottom-nav active tint is the ochre accent from the design (#B47B3F),
// distinct from the theme's blue `accent` used elsewhere on this screen.
const NAV_ACTIVE = "#B47B3F";

type PhotosView = "photos" | "collections" | "create" | "ask";

// Icon-only destinations inside the glass pill — the mini-app's OWN sections and
// nothing else. Leaving Photos for the Centraid springboard is a separate,
// system-tinted key detached to the LEFT of the pill (never a "home" tab in
// here: in a super-app a house glyph is ambiguous — it reads as either this
// app's home or the launcher's). The pill's first tab, `photos`, IS this app's
// home (its full library); the active tab wears a raised disc. `create` is the
// detached "+" FAB on the RIGHT — the screen's one primary action.
const PILL_ITEMS: Array<{
  key: string;
  icon: keyof typeof Feather.glyphMap;
  label: string;
  view: PhotosView;
}> = [
  { key: "photos", icon: "image", label: "Library", view: "photos" },
  {
    key: "collections",
    icon: "layers",
    label: "Collections",
    view: "collections",
  },
  { key: "ask", icon: "message-circle", label: "Ask", view: "ask" },
];

export default function PhotosHome({
  navigation,
}: PhotosScreenProps<"PhotosHome">): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { session, gatewayBase, vaultId, refresh } = useReplica();
  const timeline = usePhotoTimeline();
  const [view, setView] = useState<PhotosView>("photos");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [selection, setSelection] = useState(new Set<string>());
  const [backingUp, setBackingUp] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const memories = useMemo(() => onThisDay(timeline.assets), [timeline.assets]);
  const hero = memories[0];
  const refreshLibrary = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!gatewayBase) return;
    void refreshPinnedThumbnailPack(
      timeline.assets.flatMap((asset) => {
        if (!asset.contentId || asset.source === "device") return [];
        return (asset.scopeIds ?? []).map((scopeId) => ({
          contentId: asset.contentId!,
          scopeId,
          uri: `${gatewayBase}/centraid/_gateway/blobs/${encodeURIComponent(
            scopeId
          )}/${encodeURIComponent(asset.contentId!)}?variant=${
            asset.kind === "video" ? "poster" : "thumb"
          }`,
          capturedAt: asset.capturedAt,
          favorite: asset.favorite,
        }));
      })
    );
  }, [gatewayBase, timeline.assets]);

  useEffect(() => {
    if (memories.length === 0) return;
    const key = `photos.onThisDay.${new Date().toISOString().slice(0, 10)}`;
    void Store.hydrate(key, false).then(async (scheduled) => {
      if (scheduled) return;
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) return;
      const fireAt = new Date();
      fireAt.setHours(18, 0, 0, 0);
      if (fireAt <= new Date()) fireAt.setTime(Date.now() + 60_000);
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "On this day",
          body: `${memories.length} moments from years past`,
          data: { route: "Photos" },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
        },
      });
      Store.set(key, true);
    });
  }, [memories]);

  const backupSelection = async (): Promise<void> => {
    if (!session || !gatewayBase) {
      Alert.alert(
        "Desktop unavailable",
        "Pair or reconnect a gateway before starting backup."
      );
      return;
    }
    const selected = timeline.assets.filter(
      (asset) => selection.has(asset.id) && asset.localId
    );
    setBackingUp(true);
    // Assets whose originals never came down from iCloud. Never dropped on the
    // floor: they stay selected and are named in an alert once the run ends.
    const inCloud = new Set<string>();
    try {
      // Device reads and paired Live Photo writes stay serial: the run is
      // deliberately bounded for mobile memory and preserves capture order.
      const backupNext = async (index: number): Promise<void> => {
        const asset = selected[index];
        if (asset === undefined) return;
        let original: DeviceOriginal;
        try {
          original = await openDeviceOriginal(asset.localId!);
        } catch (error) {
          if (!(error instanceof InCloudOriginalError)) throw error;
          inCloud.add(asset.id);
          return backupNext(index + 1);
        }
        // A Live Photo's paired MOV is a distinct durable upload; the canonical
        // HEIC remains the visible asset until the vault grows a compound-media
        // edge. Resolved first because the still's capture group depends on it.
        const companion = await liveVideoUri(original.asset);
        await backupDeviceMedia(session, gatewayBase, {
          localUri: original.uri,
          ...(vaultId ? { targetVaultId: vaultId } : {}),
          filename: asset.filename,
          mediaType: asset.kind === "video" ? "video/mp4" : "image/jpeg",
          plaintextSize: new File(original.uri).size,
          kind: asset.kind,
          capturedAt: asset.capturedAt,
          // The capture's true UTC offset isn't in MediaLibrary metadata, so we
          // record none rather than fabricating the device's current offset —
          // sectioning falls back to the viewing device's local day (matching
          // BackupHealth, which also passes no offset).
          captureGroupId: companion ? `live:${asset.localId}` : undefined,
          width: asset.width,
          height: asset.height,
          durationS: asset.durationS,
        });
        if (companion) {
          const companionFile = new File(companion);
          await backupDeviceMedia(session, gatewayBase, {
            localUri: companion,
            ...(vaultId ? { targetVaultId: vaultId } : {}),
            // The Next API hands back an extracted file, not a paired asset, so
            // the companion's name comes from that file and its dimensions and
            // duration are simply not on offer.
            filename: companionFile.name,
            mediaType: "video/quicktime",
            plaintextSize: companionFile.size,
            kind: "video",
            capturedAt: asset.capturedAt,
            captureGroupId: `live:${asset.localId}`,
          });
        }
        return backupNext(index + 1);
      };
      await backupNext(0);
      // Anything still in iCloud stays selected so a retry is one tap.
      setSelection(inCloud);
      if (inCloud.size) {
        Alert.alert(
          "Some originals are in iCloud",
          `${inCloud.size} of ${selected.length} selected items are ${IN_CLOUD_MESSAGE}, so their bytes never reached the vault. They are still selected — download the originals in the Photos app, then back up again.`
        );
      } else {
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
      }
    } catch (error) {
      Alert.alert(
        "Backup paused",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setBackingUp(false);
    }
  };

  const addToAlbum = (): void => {
    const albums = collections.rows.slice(0, 6);
    if (!albums.length) {
      navigation.navigate("PhotosLibrary");
      return;
    }
    Alert.alert("Add to album", `${selection.size} selected`, [
      ...albums.map((album) => ({
        text: String(album.name ?? "Album"),
        onPress: () =>
          void (async () => {
            const assets = timeline.assets.filter(
              (item) => selection.has(item.id) && item.assetId
            );
            const addNext = async (index: number): Promise<void> => {
              const asset = assets[index];
              if (asset === undefined) return;
              await session?.write("photos", {
                action: "add-to-album",
                input: {
                  album_id: String(album.collection_id),
                  asset_id: asset.assetId!,
                },
              });
              return addNext(index + 1);
            };
            await addNext(0);
            setSelection(new Set());
          })(),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  const yearsAgo = hero
    ? new Date().getFullYear() - new Date(hero.capturedAt).getFullYear()
    : 0;
  const selecting = selection.size > 0;

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top"]}
    >
      {selecting ? (
        <View style={styles.header}>
          <Pressable onPress={() => setSelection(new Set())}>
            <Feather name="x" size={23} color={colors.ink} />
          </Pressable>
          <Text style={[styles.selectionTitle, { color: colors.ink }]}>
            {selection.size} selected
          </Text>
          <View style={styles.headerActions}>
            <Pressable onPress={addToAlbum}>
              <Feather name="folder-plus" size={21} color={colors.accent} />
            </Pressable>
            <Pressable
              disabled={backingUp}
              onPress={() => void backupSelection()}
            >
              <Feather name="upload-cloud" size={22} color={colors.accent} />
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.searchRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Menu"
            onPress={() => setDrawerOpen(true)}
            style={styles.menuBtn}
          >
            <Feather name="menu" size={23} color={colors.ink2} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search photos and moments"
            onPress={() => navigation.navigate("PhotosSearch")}
            style={[styles.searchPill, { backgroundColor: colors.bgSunken }]}
          >
            <Feather name="search" size={17} color={colors.ink3} />
            <Text style={[styles.searchPlaceholder, { color: colors.ink3 }]}>
              Search photos &amp; moments
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Ask about your photos"
            onPress={() => setView("ask")}
            style={styles.sparkleBtn}
          >
            <Feather name="star" size={22} color={colors.accent} />
          </Pressable>
        </View>
      )}
      <ReplicaStatusBar />

      <View style={styles.body}>
        {view === "photos" ? (
          <>
            {hero && !selecting ? (
              <Pressable
                style={styles.heroWrap}
                onPress={() =>
                  navigation.navigate("PhotoLightbox", { assetId: hero.id })
                }
              >
                <Image
                  source={imageSource(hero.uri)}
                  contentFit="cover"
                  style={styles.heroImage}
                />
                <View style={styles.heroShade} />
                <View
                  style={[
                    styles.memoryPill,
                    { backgroundColor: "rgba(0,0,0,.32)" },
                  ]}
                >
                  <Feather name="star" size={12} color="#fff" />
                  <Text style={styles.memoryPillText}>Memory</Text>
                </View>
                <View style={styles.heroCopy}>
                  <Text style={styles.heroEyebrow}>ON THIS DAY</Text>
                  <Text style={styles.heroTitle}>
                    {yearsAgo > 0
                      ? `${yearsAgo} year${yearsAgo === 1 ? "" : "s"} ago`
                      : "Today"}
                    {memories.length > 1 ? ` · ${memories.length} moments` : ""}
                  </Text>
                </View>
              </Pressable>
            ) : null}

            {!selecting && timeline.assets.length ? (
              <View style={styles.timelineHeading}>
                <View>
                  <Text style={[styles.timelineTitle, { color: colors.ink }]}>
                    Timeline
                  </Text>
                  <Text style={[styles.timelineMeta, { color: colors.ink2 }]}>
                    {timeline.assets.length} items · pinch to change density
                  </Text>
                </View>
                <View style={styles.protectedStatus}>
                  <Feather name="shield" size={13} color={colors.accent} />
                  <Text
                    style={[styles.protectedText, { color: colors.accent }]}
                  >
                    Private
                  </Text>
                </View>
              </View>
            ) : null}

            {timeline.loading ? (
              <View style={styles.center}>
                <Text style={[styles.body2, { color: colors.ink2 }]}>
                  Opening your library…
                </Text>
              </View>
            ) : timeline.sections.length === 0 ? (
              <View style={styles.center}>
                <Feather name="image" size={40} color={colors.accent} />
                <Text style={[styles.emptyTitle, { color: colors.ink }]}>
                  Your library starts here
                </Text>
                <Text style={[styles.body2, { color: colors.ink2 }]}>
                  Camera-roll photos appear instantly; long-press any item to
                  back it up.
                </Text>
              </View>
            ) : (
              <PhotoTimeline
                sections={timeline.sections}
                selection={selection}
                refreshing={refreshing}
                onRefresh={() => void refreshLibrary()}
                onSelectionChange={setSelection}
                onOpen={(asset) =>
                  navigation.navigate("PhotoLightbox", { assetId: asset.id })
                }
              />
            )}
          </>
        ) : view === "collections" ? (
          <PhotosCollectionsView navigation={navigation} />
        ) : view === "create" ? (
          <PhotosCreateView />
        ) : (
          <PhotosAskView navigation={navigation} />
        )}
      </View>

      {selecting ? null : (
        <View
          style={[
            styles.bottomWrap,
            { paddingBottom: Math.max(insets.bottom, 8) },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.barRow}>
            {/* Detached, teal, LEFT — leave Photos for the Centraid springboard.
                The shared grid key (never a house): "back to your apps", not a tab
                in the pill, so the two navigation axes — move within vs. leave —
                never share a control. */}
            <HomeKey variant="bar" onPress={() => navigation.goBack()} />

            <GlassBar radius={32} style={styles.pill}>
              <View style={styles.pillRow}>
                {PILL_ITEMS.map((item) => {
                  const active = view === item.view;
                  return (
                    <Pressable
                      key={item.key}
                      style={styles.pillItem}
                      onPress={() => setView(item.view)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={item.label}
                    >
                      <View
                        style={[
                          styles.segment,
                          active && {
                            backgroundColor:
                              scheme === "dark"
                                ? "rgba(255,255,255,0.13)"
                                : "#ffffff",
                          },
                        ]}
                      >
                        <Feather
                          name={item.icon}
                          size={22}
                          color={active ? NAV_ACTIVE : colors.ink3}
                        />
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </GlassBar>

            {/* Detached primary action — a high-contrast disc, distinct from the
                glass pill, echoing the reference's stand-alone "+". */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create"
              accessibilityState={{ selected: view === "create" }}
              onPress={() => setView("create")}
              style={({ pressed }) => [
                styles.fab,
                { backgroundColor: colors.ink },
                view === "create" && {
                  borderColor: NAV_ACTIVE,
                  borderWidth: 2,
                },
                pressed && styles.fabPressed,
              ]}
            >
              <Feather name="plus" size={26} color={colors.bg} />
            </Pressable>
          </View>
        </View>
      )}

      <PhotosDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onHome={() => {
          setDrawerOpen(false);
          navigation.goBack();
        }}
        onSwitchVault={() => {
          setDrawerOpen(false);
          setSpacesOpen(true);
        }}
        onSettings={() => {
          setDrawerOpen(false);
          navigation.navigate("Settings", { screen: "Settings" });
        }}
      />

      <SpacesSwitcher
        open={spacesOpen}
        onClose={() => setSpacesOpen(false)}
        onPairDesktop={() => {
          setSpacesOpen(false);
          navigation.navigate("Settings", { screen: "Settings" });
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // The glass pill + detached FAB share one row: the pill takes the remaining
  // width (flex), the FAB is a fixed disc to its right with a gap between.
  barRow: { alignItems: "center", flexDirection: "row", gap: 12 },
  body: { flex: 1 },
  body2: {
    fontFamily: family.sansRegular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 12,
    maxWidth: 290,
    textAlign: "center",
  },
  // Floating bar, inset from the screen edges and anchored above the home
  // indicator — the timeline reserves paddingBottom for it. `stretch` lets the
  // inner row span the full inset width so the pill can flex beside the FAB.
  bottomWrap: {
    alignItems: "stretch",
    bottom: 0,
    left: 0,
    paddingHorizontal: 16,
    position: "absolute",
    right: 0,
  },
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  emptyTitle: { fontFamily: family.displayBold, fontSize: 21, marginTop: 18 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: 18,
  },
  headerActions: { flexDirection: "row", gap: 22 },
  heroCopy: { bottom: 15, left: 16, position: "absolute", right: 16 },
  heroEyebrow: {
    color: "#fff",
    fontFamily: family.monoMedium,
    fontSize: 11,
    letterSpacing: 1,
    opacity: 0.9,
  },
  heroImage: { ...StyleSheet.absoluteFill },
  heroShade: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(10,14,24,.28)",
  },
  heroTitle: {
    color: "#fff",
    fontFamily: family.displayBold,
    fontSize: 21,
    letterSpacing: -0.4,
    marginTop: 6,
  },
  heroWrap: {
    borderRadius: 16,
    height: 176,
    marginBottom: 4,
    marginHorizontal: 16,
    marginTop: 8,
    overflow: "hidden",
  },
  memoryPill: {
    alignItems: "center",
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    position: "absolute",
    right: 12,
    top: 11,
  },
  memoryPillText: {
    color: "#fff",
    fontFamily: family.sansMedium,
    fontSize: 12,
  },
  menuBtn: {
    alignItems: "flex-start",
    height: 44,
    justifyContent: "center",
    width: 24,
  },
  // Every item — the Home segment and the three app tabs — shares this 60pt
  // height and centres its icon+label, so all four baselines line up across the
  // pill instead of the Home segment floating at a different offset.
  // Detached primary-action disc, sized like the reference's "+" button.
  fab: {
    alignItems: "center",
    borderRadius: 28,
    elevation: 8,
    height: 56,
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { height: 6, width: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    width: 56,
  },
  fabPressed: { opacity: 0.85 },
  // Active-item selection: a concentric "segment" that echoes the enclosure — a
  // rounded rect filling the item's cell, inset evenly (via pillItem padding) so it
  // reads as a smaller copy of the pill nested inside it (iOS segmented-control
  // idiom), not a circle fighting the stadium. Radius 29 = half the 58pt inset
  // height, so its rounded ends carry the same full curve as the enclosure.
  segment: {
    alignItems: "center",
    borderRadius: 29,
    flex: 1,
    justifyContent: "center",
  },
  pill: { flex: 1 },
  // pillItem is the tap target + the even inset around the segment (3pt top/bottom
  // keeps the segment hugging the enclosure with only a hairline gap; 4pt sides give
  // the gap between segments). Stretch (not center) so the segment fills the height.
  pillItem: { flex: 1, paddingHorizontal: 4, paddingVertical: 3 },
  pillRow: {
    alignItems: "stretch",
    flexDirection: "row",
    height: 64,
    paddingHorizontal: 6,
  },
  protectedStatus: { alignItems: "center", flexDirection: "row", gap: 5 },
  protectedText: { fontFamily: family.sansMedium, fontSize: 11 },
  safe: { flex: 1 },
  searchPill: {
    alignItems: "center",
    borderRadius: 22,
    flex: 1,
    flexDirection: "row",
    gap: 9,
    height: 44,
    paddingHorizontal: 16,
  },
  searchPlaceholder: { fontFamily: family.sansRegular, fontSize: 15 },
  searchRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingBottom: 10,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  selectionTitle: { fontFamily: family.sansBold, fontSize: 15 },
  sparkleBtn: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 32,
  },
  timelineHeading: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 7,
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  timelineMeta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 2 },
  timelineTitle: { fontFamily: family.displayBold, fontSize: 17 },
});
