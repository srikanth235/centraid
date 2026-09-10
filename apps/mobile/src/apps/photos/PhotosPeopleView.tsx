// People roster (#712): a card opens that person's photographs, never Face
// review. Empty roster: signage, not consent.

import React, { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import {
  ENRICHMENT_PRIORITISED_NOTE,
  ENRICHMENT_QUEUED_NOTE,
  prioritiseAnswerFor,
} from "@centraid/blueprints/apps/photos/enrichment-consent";
import type { PageQuery } from "@centraid/core/page";
import { identityColor, tileFinish } from "@centraid/design";

import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useSeatPages } from "../../kit/hooks/useSeatPages";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { spacing, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { buildPeopleShelf } from "./people-model";
import PeopleEmptyState from "./PeopleEmptyState";
import { usePhotoEntity } from "./photo-entity-reads";
import PhotosScreen from "./PhotosScreen";

/** One cluster row per face region the clusterer has grouped. */
const FACE_CLUSTERS: PageQuery = {
  name: "phone.photos.face-clusters",
  select: "region_id, cluster_id, computed_at",
  from: "media_face_cluster",
  order: { sortColumn: "cluster_id", pkColumn: "region_id", descending: false },
};

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

  const faces = usePhotoEntity("faceRegions");
  const parties = usePhotoEntity("parties");
  const clusters = useSeatPages("photos", FACE_CLUSTERS, {
    entity: "media.face_cluster",
    rowIdColumn: "region_id",
  });
  const policies = usePhotoEntity("enrichPolicies");

  const [enrichBusy, setEnrichBusy] = useState(false);
  const [prioritised, setPrioritised] = useState(false);
  const enrichPolicy = policies.rows.find((row) => row.domain === "photos");
  const enrichTier = policies.loading
    ? null
    : ((enrichPolicy?.tier as string | undefined) ?? "off");
  const prioritiseAnswer = prioritiseAnswerFor(enrichTier);
  // THE ONE WRITE — front of the queue, never whether. Gated here, never by
  // a disabled prop alone.
  const prioritise = async (): Promise<void> => {
    if (!session || enrichBusy || prioritised) return;
    if (!prioritiseAnswer.available) return;
    setEnrichBusy(true);
    try {
      const result = await session.write("photos", {
        action: "request-enrichment",
        input: { entity_type: "media.asset" },
      });
      if (
        surfaceWriteOutcome(result, { queuedMessage: ENRICHMENT_QUEUED_NOTE })
      ) {
        setPrioritised(true);
        postStatus(ENRICHMENT_PRIORITISED_NOTE);
      }
    } catch (error) {
      surfaceWriteFailure(error, "Faces were not prioritised");
    } finally {
      setEnrichBusy(false);
    }
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
          <PeopleEmptyState
            prioritise={prioritiseAnswer}
            busy={enrichBusy}
            prioritised={prioritised}
            onPrioritise={() => void prioritise()}
          />
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
