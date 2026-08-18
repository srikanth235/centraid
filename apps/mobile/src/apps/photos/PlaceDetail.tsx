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

import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

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
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const { placeKey, placeName } = route.params;
  const [naming, setNaming] = useState(false);
  const [typed, setTyped] = useState("");

  const assets = useMemo(
    () => assetsAtPlace(timelineAssets, places.rows, placeKey),
    [timelineAssets, places.rows, placeKey]
  );

  // WHICH ROW THIS SCREEN COULD NAME (issue #816). Null once the place has a
  // name a person would recognise — and after the write it becomes null on its
  // own, because the replica pushes the renamed row and this recomputes. The
  // phrase is never cached anywhere: the head reads the row at render.
  const unnamedPlaceId = useMemo(
    () => unnamedPlaceAt(timelineAssets, places.rows, placeKey),
    [timelineAssets, places.rows, placeKey]
  );

  // WHAT THIS SCREEN CALLS THE PLACE. Read from the rows, with the name the
  // card carried as the fallback — the route parameter is a copy made when the
  // card was tapped, and a screen that kept printing it would show "A place
  // with no name yet" over a place the member had just named on this screen.
  const heading = useMemo(
    () => placeNameAt(timelineAssets, places.rows, placeKey) ?? placeName,
    [timelineAssets, places.rows, placeKey, placeName]
  );

  /** Name this place. `kind` carries the member's one declaration: this is home,
   *  which is what anchors a relative phrase for every place the vault cannot
   *  name. */
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
      {/* THE NAMING CONVERSATION (issue #816). It stands under the head that
          shows the fallback phrase and nowhere else: a place the member named
          has nothing to answer, and `unnamedPlaceAt` is what knows. Two
          answers, offered together — a typed name, or the one-tap declaration
          that this is home. They are siblings rather than one flow because
          "This is home" is the answer that makes every OTHER unnamed place
          legible ("3.4 km NE of Home"), and it should cost one press. */}
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
              <Pressable
                accessibilityLabel="Save place name"
                accessibilityRole="button"
                onPress={() => void namePlace(typed)}
              >
                <Text style={[styles.ask, { color: colors.accentText }]}>
                  Save
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                accessibilityLabel="Name this place"
                accessibilityRole="button"
                onPress={() => setNaming(true)}
              >
                <Text style={[styles.ask, { color: colors.accentText }]}>
                  Name this place?
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel="This is home"
                accessibilityRole="button"
                onPress={() => void namePlace("Home", "home")}
              >
                <Text style={[styles.ask, { color: colors.accentText }]}>
                  This is home
                </Text>
              </Pressable>
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

// A place's shelf carries no selection/restore action (it is a read of the
// library, the same reason `PhotoStateView`'s "person" mode never renders one)
// — kept as module-level constants so they are stable across renders instead
// of allocating a new empty Set/no-op on every one.
const EMPTY_SELECTION = new Set<string>();
const NOOP_SELECTION_CHANGE = (): void => {};

const styles = StyleSheet.create({
  // A question in the same register as the count above it, not a button: this
  // is a thing to answer when a member feels like it, and a filled control
  // would make an unnamed place read as a chore.
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
    // 44 is the target floor, and a text field a thumb can miss is worse than
    // no field at all.
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
