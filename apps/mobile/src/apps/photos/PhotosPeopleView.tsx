// The people roster (Photos v4 handoff §3.1, §14, proto:4432-4433). Split out
// of `PhotosCollectionsView` (which now serves Albums only) because People
// stopped being a shelf on that screen.
//
// People is OFF THE BAND (issue #712): it used to be a band destination
// `PhotosHome` rendered inline, which cost the band a fifth slot for a shelf
// most visits never open. It is now a pushed route like `PlacesView` and
// `FaceReview` — reached from Collections' own People section heading
// (`PhotosCollectionsView.tsx`'s `open()`) and from the Library shelf list's
// People row alongside `FaceReview` — so it draws its own band via
// `PhotosScreen`, `current="more"`, the same as every other More-reachable
// shelf.
//
// Three rules this view exists to hold the line on:
//
//   1. Everyone shows, including unnamed people. README:217 and proto:3760
//      are explicit: an unconfirmed-but-grouped party reads as "Unnamed",
//      never as a silently dropped card — hiding it would lose a match the
//      member already made by confirming a face onto that party.
//   2. Tapping a card opens THAT PERSON'S PHOTOGRAPHS (`PhotoStateView`,
//      mode "person"), never Face review. Face review is proposal triage;
//      a person card is a browsable identity, and the two are not the same
//      destination even though both start from `media.face_region`.
//   3. THE CONSENT GATE (issue #712 C2). The face-detection consent moment
//      used to sit behind a "Face detection" row + modal on PhotosLibrary —
//      built, correct, and nearly unreachable. An empty People shelf IS the
//      gate's natural body: a member who opens People and sees nothing has
//      exactly the question "why is this empty, and can I do something about
//      it" the gate answers. So when the roster is empty AND the question
//      has not been answered this session, the gate renders in the empty
//      state instead of a modal reached from elsewhere. Once answered (either
//      way) or once the roster has faces to show, the empty state reverts to
//      the plain "no people yet" copy — the gate is a way IN to the question,
//      not a permanent fixture of an empty shelf.

import React, { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import {
  CLOUD_ANSWER,
  CLOUD_PANEL,
  deviceAnswerFor,
  ENRICHMENT_DECLINED_NOTE,
  ENRICHMENT_NOTE,
  ENRICHMENT_QUEUED_NOTE,
  ENRICHMENT_REQUESTED_NOTE,
  ON_DEVICE_PANEL,
} from "@centraid/blueprints/apps/photos/enrichment-consent";
import { identityColor, tileFinish } from "@centraid/design";

import { ConsentGate } from "../../kit/components/ConsentGate";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { spacing, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { buildPeopleShelf } from "./people-model";
import PhotosScreen from "./PhotosScreen";

/** A party's identity colour, lowered to the solid tile finish — the same
 *  treatment `PhotosCollectionsView` used, kept because a person's card
 *  keeps its identity colour (a party HAS an identity in this system) while
 *  an unloaded album cover does not. */
function tintFor(key: string): string {
  return tileFinish(identityColor(key), "solid").backgroundColor;
}

export default function PhotosPeopleView({
  navigation,
}: PhotosScreenProps<"PhotosPeople">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session } = useReplica();

  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const clusters = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_cluster" }), [])
  );
  // The tier comes from the replica's `enrich.policy` mirror, the same read
  // PhotosLibrary.tsx used before this gate moved — the shared
  // `deviceAnswerFor` decides whether the on-device promise is even true for
  // this vault, so web and native cannot disagree about it.
  const policies = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "enrich.policy" }), [])
  );

  // ---- the consent question, re-homed from PhotosLibrary's footer row ----
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichAnswered, setEnrichAnswered] = useState<
    "device" | "declined" | null
  >(null);
  const enrichPolicy = policies.rows.find((row) => row.domain === "photos");
  const enrichTier = policies.loading
    ? null
    : ((enrichPolicy?.tier as string | undefined) ?? "off");
  const deviceAnswer = deviceAnswerFor(enrichTier);
  const runOnDevice = async (): Promise<void> => {
    // Belt and braces: the button is already unavailable in both of these
    // cases. A write this consequential does not rely on a disabled prop.
    if (!session || enrichBusy || enrichAnswered) return;
    if (!deviceAnswer.available) return;
    setEnrichBusy(true);
    try {
      const result = await session.write("photos", {
        action: "request-enrichment",
        input: { entity_type: "media.asset" },
      });
      if (
        surfaceWriteOutcome(result, { queuedMessage: ENRICHMENT_QUEUED_NOTE })
      ) {
        setEnrichAnswered("device");
        postStatus(ENRICHMENT_REQUESTED_NOTE);
      }
    } catch (error) {
      surfaceWriteFailure(error, "Face detection was not asked for");
    } finally {
      setEnrichBusy(false);
    }
  };
  const declineEnrichment = (): void => {
    setEnrichAnswered("declined");
    postStatus(ENRICHMENT_DECLINED_NOTE);
  };

  const shelf = useMemo(
    () =>
      buildPeopleShelf({
        faces: faces.rows.map((row) => ({
          ...row,
          region_id: String(row.region_id),
        })),
        parties: parties.rows.map((row) => ({
          ...row,
          party_id: String(row.party_id),
          display_name:
            row.display_name == null ? null : String(row.display_name),
        })),
        clusters: clusters.rows.map((row) => ({
          region_id: String(row.region_id),
          cluster_id: String(row.cluster_id),
        })),
        policies: policies.rows.map((row) => ({
          domain: row.domain == null ? null : String(row.domain),
          tier: row.tier == null ? null : String(row.tier),
        })),
        policiesLoading: policies.loading,
      }),
    [clusters.rows, faces.rows, parties.rows, policies.loading, policies.rows]
  );

  // The gate is the empty state's body only while the question is still open
  // — an empty roster the member has already answered (either way) falls
  // back to the plain copy below instead of re-asking.
  const showGate =
    shelf.people.length === 0 && shelf.unnamed.length === 0 && !enrichAnswered;

  return (
    // The band, via the shell (issue #712). This screen used to be rendered
    // inline by `PhotosHome` with People marked current on the band itself;
    // now that People is off the band, it draws the shell like every other
    // pushed shelf, `current="more"` — same call `PlacesView` and
    // `PhotoStateView`'s "person" mode already make.
    <PhotosScreen current="more">
      <View style={styles.header}>
        {/* No back chevron, same reasoning as `PlacesView`'s: the band below
            is the way out, and a second spelling of "leave" in the head is
            the duplicate affordance §F's one-navigation rule forbids. */}
        <Text style={styles.title}>People</Text>
      </View>
      <FlatList
        data={shelf.people}
        keyExtractor={(item) => item.partyId}
        numColumns={3}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.row}
        ListEmptyComponent={
          showGate ? (
            <View style={styles.gate}>
              <ConsentGate
                domain="photos"
                onDevicePanel={ON_DEVICE_PANEL}
                onDevice={deviceAnswer}
                netPanel={CLOUD_PANEL}
                net={CLOUD_ANSWER}
                note={ENRICHMENT_NOTE}
                busy={enrichBusy}
                answered={enrichAnswered}
                onRunOnDevice={() => void runOnDevice()}
                onDecline={declineEnrichment}
              />
            </View>
          ) : (
            <Text style={styles.empty}>
              No people yet. Faces are proposed on a photograph you open, and a
              name is only ever yours to confirm.
            </Text>
          )
        }
        ListFooterComponent={
          <View>
            {shelf.unnamed.length > 0 ? (
              <View style={styles.unnamedSection}>
                <Text style={styles.sectionTitle}>
                  Groups waiting for a name
                </Text>
                {shelf.unnamed.map((group) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Unnamed group, ${group.count} photographs`}
                    key={group.clusterId}
                    style={styles.unnamedCard}
                    onPress={() => navigation.navigate("FaceReview")}
                  >
                    <Text style={styles.name}>Unnamed group</Text>
                    <Text style={styles.count}>{group.count} photographs</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Text style={styles.note}>
              {shelf.pendingTotal} faces are not matched to anyone. Face review
              proposes them one at a time, and nothing is named until you name
              it.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name ?? "Unnamed"}, ${item.count} photographs`}
            style={styles.card}
            onPress={() =>
              navigation.navigate("PhotoStateView", {
                mode: "person",
                partyId: item.partyId,
                personName: item.name ?? "Unnamed",
              })
            }
          >
            <View
              style={[
                styles.avatar,
                { backgroundColor: tintFor(item.partyId) },
              ]}
            />
            <Text numberOfLines={2} style={styles.name}>
              {item.name ?? "Unnamed"}
            </Text>
            <Text style={styles.count}>{item.count}</Text>
          </Pressable>
        )}
      />
    </PhotosScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    avatar: { aspectRatio: 1, borderRadius: radii.pill, width: "72%" },
    card: { alignItems: "center", gap: spacing[1], width: "33.33%" },
    count: { ...t("mono"), color: colors.textFaint },
    empty: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[5],
      textAlign: "center",
    },
    gate: { paddingHorizontal: spacing[3], paddingTop: spacing[3] },
    grid: { paddingBottom: spacing[6], paddingTop: spacing[3] },
    header: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: 48,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    name: {
      ...t("control"),
      color: colors.text,
      textAlign: "center",
    },
    note: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[4],
    },
    row: {
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    sectionTitle: { ...t("control"), color: colors.text },
    title: { ...t("title"), color: colors.text, flex: 1 },
    unnamedCard: {
      borderColor: colors.line,
      borderWidth: 1,
      gap: spacing[1],
      padding: spacing[3],
    },
    unnamedSection: {
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[4],
    },
  });
