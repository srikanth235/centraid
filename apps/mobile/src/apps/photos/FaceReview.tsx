import React, { memo, useCallback, useMemo } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { ReplicaRow } from "@centraid/client/replica/native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { family, useTheme } from "../../kit/theme";
import { optimisticValues } from "../../lib/replica/optimistic";
import type { PhotosScreenProps } from "../../navigation";

export default function FaceReview({
  navigation,
}: PhotosScreenProps<"FaceReview">): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const names = useMemo(
    () =>
      new Map(
        parties.rows.map((row) => [
          String(row.party_id),
          String(row.display_name ?? "Unknown person"),
        ])
      ),
    [parties.rows]
  );
  const proposals = useMemo(
    () => faces.rows.filter((row) => !row.confirmed_by_party_id),
    [faces.rows]
  );
  const confirmedPeople = useMemo(
    () =>
      parties.rows
        .map((party) => ({
          party,
          count: faces.rows.filter(
            (face) =>
              face.confirmed_by_party_id &&
              String(face.party_id) === String(party.party_id)
          ).length,
        }))
        .filter(({ count }) => count > 0),
    [faces.rows, parties.rows]
  );
  const act = useCallback(
    async (
      action: "confirm-face" | "reject-face",
      regionId: string,
      partyId?: string
    ): Promise<void> => {
      const region = faces.rows.find(
        (row) => String(row.region_id) === regionId
      );
      if (!region) return;
      if (!session) return;
      try {
        const result = await session.write("photos", {
          action,
          input: {
            region_id: regionId,
            ...(partyId ? { party_id: partyId } : {}),
          },
          optimistic:
            action === "reject-face"
              ? [
                  {
                    op: "delete",
                    entity: "media.face_region",
                    rowId: regionId,
                  },
                ]
              : [
                  {
                    op: "upsert",
                    entity: "media.face_region",
                    rowId: regionId,
                    values: optimisticValues(region, {
                      party_id: partyId ?? null,
                      confirmed_by_party_id: partyId ?? null,
                    }),
                  },
                ],
        });
        surfaceWriteOutcome(result);
      } catch (error) {
        surfaceWriteFailure(error, "Face review not saved");
      }
    },
    [faces.rows, session]
  );
  // One callback shared by every row rather than a per-row arrow, so the
  // memoized row only re-renders when its own face changes.
  const confirmFace = useCallback(
    (regionId: string, partyId: string): void => {
      void act("confirm-face", regionId, partyId);
    },
    [act]
  );
  const rejectFace = useCallback(
    (regionId: string): void => {
      void act("reject-face", regionId);
    },
    [act]
  );
  const renderProposal = useCallback(
    ({
      item,
    }: ListRenderItemInfo<
      ReplicaRow & { __rowId: string }
    >): React.JSX.Element => (
      <FaceProposalRow
        row={item}
        name={item.party_id ? names.get(String(item.party_id)) : undefined}
        colors={colors}
        onConfirm={confirmFace}
        onReject={rejectFace}
      />
    ),
    [colors, confirmFace, names, rejectFace]
  );
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top"]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Photos"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          People review
        </Text>
        <Text style={[styles.count, { color: colors.textSoft }]}>
          {proposals.length}
        </Text>
      </View>
      <ReplicaStatusBar />
      <FlatList
        data={proposals}
        keyExtractor={faceKey}
        contentContainerStyle={styles.list}
        refreshing={refreshing}
        onRefresh={refreshNow}
        ListHeaderComponent={
          <View>
            <Text style={[styles.section, { color: colors.textSoft }]}>
              CONFIRMED PEOPLE
            </Text>
            {confirmedPeople.length ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.people}
              >
                {confirmedPeople.map(({ party, count }) => (
                  <View
                    key={String(party.party_id)}
                    style={[
                      styles.personCard,
                      { backgroundColor: colors.bgSunken },
                    ]}
                  >
                    <View
                      style={[
                        styles.personAvatar,
                        { backgroundColor: colors.bgElev },
                      ]}
                    >
                      <Icon name="user" size={22} color={colors.accent} />
                    </View>
                    <Text
                      numberOfLines={1}
                      style={[styles.personName, { color: colors.text }]}
                    >
                      {String(
                        party.display_name ?? party.name ?? "Unknown person"
                      )}
                    </Text>
                    <Text style={[styles.meta, { color: colors.textSoft }]}>
                      {count} photos
                    </Text>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Text style={[styles.emptyPeople, { color: colors.textSoft }]}>
                Confirmed people will appear here.
              </Text>
            )}
            <Text style={[styles.section, { color: colors.textSoft }]}>
              FACE PROPOSALS
            </Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.textSoft }]}>
            No face proposals need review.
          </Text>
        }
        // No getItemLayout: the header carousel's height depends on whether any
        // people are confirmed yet, so item offsets are not knowable up front.
        // A proposal row is 70pt tall (styles.row minHeight, both texts short),
        // so ~9 rows fill the ~650pt left under the header chrome and the
        // CONFIRMED PEOPLE strip; ±2 viewports of retained cells absorbs a
        // flick through a large unreviewed backlog without holding it all.
        initialNumToRender={9}
        maxToRenderPerBatch={9}
        windowSize={5}
        renderItem={renderProposal}
      />
    </SafeAreaView>
  );
}

// `__rowId` is the replica's own row identity, unique per face region.
const faceKey = (row: ReplicaRow & { __rowId: string }): string => row.__rowId;

const FaceProposalRow = memo(
  ({
    row,
    name,
    colors,
    onConfirm,
    onReject,
  }: {
    row: ReplicaRow & { __rowId: string };
    name: string | undefined;
    colors: ReturnType<typeof useTheme>["colors"];
    onConfirm: (regionId: string, partyId: string) => void;
    onReject: (regionId: string) => void;
  }): React.JSX.Element => {
    const partyId = row.party_id ? String(row.party_id) : undefined;
    const regionId = String(row.region_id);
    return (
      <View style={[styles.row, { borderBottomColor: colors.line }]}>
        <View style={[styles.avatar, { backgroundColor: colors.bgSunken }]}>
          <Icon name="user" size={20} color={colors.accent} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.name, { color: colors.text }]}>
            {partyId ? name : "Unmatched face"}
          </Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            {Math.round(Number(row.confidence ?? 0) * 100)}% confidence
          </Text>
        </View>
        {partyId ? (
          <Pressable
            accessibilityLabel={`Confirm ${name ?? "person"} for this face`}
            accessibilityRole="button"
            onPress={() => onConfirm(regionId, partyId)}
          >
            <Icon name="check" size={21} color="#2f9d6a" />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityLabel="Reject this face proposal"
          accessibilityRole="button"
          onPress={() => onReject(regionId)}
        >
          <Icon name="x" size={21} color={colors.danger} />
        </Pressable>
      </View>
    );
  }
);
FaceProposalRow.displayName = "FaceProposalRow";

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    borderRadius: 21,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  copy: { flex: 1, marginLeft: 12 },
  count: { fontFamily: family.monoMedium, fontSize: 11 },
  empty: {
    fontFamily: family.sansRegular,
    fontSize: 14,
    padding: 40,
    textAlign: "center",
  },
  emptyPeople: {
    fontFamily: family.sansRegular,
    fontSize: 13,
    paddingVertical: 14,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 50,
    paddingHorizontal: 14,
  },
  list: { paddingHorizontal: 18 },
  meta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 4 },
  name: { fontFamily: family.sansMedium, fontSize: 14 },
  people: { gap: 10, paddingVertical: 8 },
  personAvatar: {
    alignItems: "center",
    borderRadius: 24,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  personCard: { borderRadius: 14, padding: 12, width: 128 },
  personName: { fontFamily: family.sansMedium, fontSize: 12, marginTop: 8 },
  row: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 14,
    minHeight: 70,
  },
  safe: { flex: 1 },
  section: {
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 1,
    marginTop: 18,
  },
  title: { fontFamily: family.sansBold, fontSize: 18 },
});
