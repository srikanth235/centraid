// One place's photographs, opened by tapping a card on `PlacesView.tsx`
// (Photos v4 handoff §14).
//
// The same tap-a-card-opens-a-filtered-timeline pattern `PhotosPeopleView`
// established for People, via `PhotoStateView`'s "person" mode. `PhotoStateView`
// has no "place" mode and is owned by another agent mid-flight — rather than
// grow a file that is not this issue's to edit, the filter lives here,
// grouping by the same 0.1°-proximity key `PlacesView` and `PlacesMap` use, so
// all three name the same place the same way.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import { spacing, t, useTheme } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import PhotoTimeline from "./PhotoTimeline";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

export default function PlaceDetail({
  route,
  navigation,
}: PhotosScreenProps<"PlaceDetail">): React.JSX.Element {
  const { colors } = useTheme();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const { assets: timelineAssets } = usePhotoTimeline();
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const placeById = useMemo(
    () => new Map(places.rows.map((row) => [String(row.place_id), row])),
    [places.rows]
  );
  const { placeKey, placeName } = route.params;

  const assets = useMemo(
    () =>
      timelineAssets.filter((asset) => {
        if (asset.deleted || !asset.placeId) return false;
        const row = placeById.get(asset.placeId);
        if (!row) return false;
        const latitude = Number(row.latitude ?? row.lat);
        const longitude = Number(row.longitude ?? row.lon ?? row.lng);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
          return false;
        return `${latitude.toFixed(1)}:${longitude.toFixed(1)}` === placeKey;
      }),
    [timelineAssets, placeById, placeKey]
  );

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top"]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Places"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.copy}>
          <Text
            style={[styles.title, { color: colors.text }]}
            numberOfLines={1}
          >
            {placeName}
          </Text>
          <Text
            style={[styles.meta, { color: colors.textSoft }]}
            numberOfLines={1}
          >
            {assets.length} {assets.length === 1 ? "photograph" : "photographs"}
          </Text>
        </View>
      </View>
      <ReplicaStatusBar />
      {assets.length ? (
        <PhotoTimeline
          sections={sectionPhotoAssets(
            assets.map((asset) => ({
              ...asset,
              archived: false,
              deleted: false,
            }))
          )}
          selection={EMPTY_SELECTION}
          onSelectionChange={NOOP_SELECTION_CHANGE}
          onOpen={(asset) =>
            navigation.navigate("PhotoLightbox", { assetId: asset.id })
          }
          refreshing={refreshing}
          onRefresh={refreshNow}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            No photographs at {placeName} yet.
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// A place's shelf carries no selection/restore action (it is a read of the
// library, the same reason `PhotoStateView`'s "person" mode never renders one)
// — kept as module-level constants so they are stable across renders instead
// of allocating a new empty Set/no-op on every one.
const EMPTY_SELECTION = new Set<string>();
const NOOP_SELECTION_CHANGE = (): void => {};

const styles = StyleSheet.create({
  copy: { flex: 1, marginLeft: spacing[2] + 2 },
  empty: { alignItems: "center", flex: 1, justifyContent: "center" },
  header: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 56,
    paddingHorizontal: spacing[4] - 2,
  },
  meta: { ...t("control"), marginTop: 2 },
  safe: { flex: 1 },
  title: t("bodyStrong"),
});
