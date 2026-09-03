// People roster, off the band (#712): unnamed cards still render; a person
// card opens that person's photographs, never Face review. Empty roster is
// the consent gate until answered this session.

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

/** Identity colour on a person card; unloaded album covers do not keep one. */
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
    useMemo(() => ({ acceptTruncation: true, entity: "media.face_region" }), [])
  );
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "core.party" }), [])
  );
  const clusters = useReplicaQuery(
    "photos",
    useMemo(
      () => ({ acceptTruncation: true, entity: "media.face_cluster" }),
      []
    )
  );
  const policies = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "enrich.policy" }), [])
  );

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
    // Do not rely on a disabled prop for this write.
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

  // Gate only while unanswered; an answered empty roster uses the plain copy.
  const showGate =
    shelf.people.length === 0 && shelf.unnamed.length === 0 && !enrichAnswered;

  return (
    <PhotosScreen current="more">
      <View style={styles.header}>
        {/* No back chevron — the band is the way out (§F). */}
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
              No people yet — faces are proposed on a photograph you open.
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
              {shelf.pendingTotal} faces are not matched to anyone — face review
              proposes them one at a time.
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
