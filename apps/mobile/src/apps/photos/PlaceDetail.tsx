// One place's photographs, opened by tapping a card on `PlacesView.tsx`
// (Photos v4 handoff §14).
//
// The same tap-a-card-opens-a-filtered-timeline pattern `PhotosPeopleView`
// established for People, via `PhotoStateView`'s "person" mode. `PhotoStateView`
// has no "place" mode and is owned by another agent mid-flight — rather than
// grow a file that is not this issue's to edit, the filter lives here,
// grouping by the same 0.1° key `PlacesView` mints for its cards
// (`places-model.ts`), so a card's count and this screen's count cannot
// disagree about which photographs were taken here.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import { spacing, t, useTheme } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import PhotosScreen from "./PhotosScreen";
import PhotoTimeline from "./PhotoTimeline";
import { assetsAtPlace } from "./places-model";
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
  const { placeKey, placeName } = route.params;

  const assets = useMemo(
    () => assetsAtPlace(timelineAssets, places.rows, placeKey),
    [timelineAssets, places.rows, placeKey]
  );

  return (
    // The band, via the shell (issue #712 P8) — and the back chevron STAYS,
    // because `PlacesView` is this screen's genuine parent, exactly the split
    // `DuplicatesShelf` states: the shell owns the band, the screen owns its
    // own head. `current="more"` for the same reason it is on Places.
    <PhotosScreen current="more">
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
    </PhotosScreen>
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
  title: t("bodyStrong"),
});
