// One place's photographs, opened from a PlacesView card (Photos v4 handoff
// §14): groups by the same 0.1° key PlacesView mints for its cards, so a
// card's count and this screen's count cannot disagree.

import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import Tappable from "../../kit/components/Tappable";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import PhotosScreen from "./PhotosScreen";
import PhotoTimeline from "./PhotoTimeline";
import { assetsAtPlace, placeNameAt, unnamedPlaceAt } from "./places-model";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

export default function PlaceDetail({
  route,
  navigation,
}: PhotosScreenProps<"PlaceDetail">): React.JSX.Element {
  const { colors } = useTheme();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const { session } = useReplica();
  const { assets: timelineAssets } = usePhotoTimeline();
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "core.place" }), [])
  );
  const { placeKey, placeName } = route.params;
  const [naming, setNaming] = useState(false);
  const [typed, setTyped] = useState("");

  const assets = useMemo(
    () => assetsAtPlace(timelineAssets, places.rows, placeKey),
    [timelineAssets, places.rows, placeKey]
  );

  // The unnamed row this screen could name (#816); null once the place has a
  // recognisable name — recomputes after the replica pushes the rename.
  const unnamedPlaceId = useMemo(
    () => unnamedPlaceAt(timelineAssets, places.rows, placeKey),
    [timelineAssets, places.rows, placeKey]
  );

  // Read from live rows first; the route param is a copy made at tap time —
  // printing it would show the fallback phrase over a just-named place.
  const heading = useMemo(
    () => placeNameAt(timelineAssets, places.rows, placeKey) ?? placeName,
    [timelineAssets, places.rows, placeKey, placeName]
  );

  /** Name this place; `kind: "home"` anchors relative phrases for every
   *  place the vault cannot name. */
  const namePlace = async (name: string, kind?: "home"): Promise<void> => {
    const trimmed = name.trim();
    if (!session || !unnamedPlaceId || !trimmed) return;
    try {
      const result = await session.write("photos", {
        action: "name-place",
        input: {
          place_id: unnamedPlaceId,
          name: trimmed,
          ...(kind ? { kind } : {}),
        },
      });
      if (surfaceWriteOutcome(result)) {
        setNaming(false);
        setTyped("");
      }
    } catch (error) {
      surfaceWriteFailure(error, "Place not named");
    }
  };

  return (
    // Shell owns the band (#712); the back chevron STAYS because PlacesView
    // is this screen's genuine parent.
    <PhotosScreen current="more">
      <View style={styles.header}>
        <Tappable
          accessibilityLabel="Back to Places"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Tappable>
        <View style={styles.copy}>
          <Text
            style={[styles.title, { color: colors.text }]}
            numberOfLines={1}
          >
            {heading}
          </Text>
          <Text
            style={[styles.meta, { color: colors.textSoft }]}
            numberOfLines={1}
          >
            {assets.length} {assets.length === 1 ? "photograph" : "photographs"}
          </Text>
        </View>
      </View>
      {/* The naming UI (#816), only under an unnamed place: a typed name or
          the one-tap "This is home" — home makes every OTHER unnamed place
          legible, so it costs one press. */}
      {unnamedPlaceId ? (
        <View style={styles.naming}>
          {naming ? (
            <>
              <TextInput
                accessibilityLabel="Place name"
                autoFocus
                onChangeText={setTyped}
                onSubmitEditing={() => void namePlace(typed)}
                placeholder="Place name"
                returnKeyType="done"
                style={[
                  styles.input,
                  { borderColor: colors.line, color: colors.text },
                ]}
                value={typed}
              />
              <Tappable
                accessibilityLabel="Save place name"
                accessibilityRole="button"
                onPress={() => void namePlace(typed)}
              >
                <Text style={[styles.ask, { color: colors.accentText }]}>
                  Save
                </Text>
              </Tappable>
            </>
          ) : (
            <>
              <Tappable
                accessibilityLabel="Name this place"
                accessibilityRole="button"
                onPress={() => setNaming(true)}
              >
                <Text style={[styles.ask, { color: colors.accentText }]}>
                  Name this place?
                </Text>
              </Tappable>
              <Tappable
                accessibilityLabel="This is home"
                accessibilityRole="button"
                onPress={() => void namePlace("Home", "home")}
              >
                <Text style={[styles.ask, { color: colors.accentText }]}>
                  This is home
                </Text>
              </Tappable>
            </>
          )}
        </View>
      ) : null}
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
            No photographs at {heading} yet.
          </Text>
        </View>
      )}
    </PhotosScreen>
  );
}

// Module-level so they are stable across renders instead of allocating a new
// empty Set/no-op per render.
const EMPTY_SELECTION = new Set<string>();
const NOOP_SELECTION_CHANGE = (): void => {};

const styles = StyleSheet.create({
  ask: t("control"),
  copy: { flex: 1, marginLeft: spacing[2] + 2 },
  empty: { alignItems: "center", flex: 1, justifyContent: "center" },
  header: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 56,
    paddingHorizontal: spacing[4] - 2,
  },
  input: {
    ...t("body"),
    borderBottomWidth: borders.hairline,
    flex: 1,
    minHeight: 44,
  },
  meta: { ...t("control"), marginTop: 2 },
  naming: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[4] - 2,
  },
  title: t("bodyStrong"),
});
