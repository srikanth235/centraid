import { Feather } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import { family, useTheme } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import PhotoTimeline from "./PhotoTimeline";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

export default function DuplicateReview({
  navigation,
}: PhotosScreenProps<"DuplicateReview">): React.JSX.Element {
  const { colors } = useTheme();
  const timeline = usePhotoTimeline();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const hints = useMemo(
    () => timeline.assets.filter((asset) => asset.duplicateHint),
    [timeline.assets]
  );
  const sections = useMemo(() => sectionPhotoAssets(hints), [hints]);
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
          <Feather name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.text }]}>
            Duplicates review
          </Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            Similarity only—nothing is auto-merged.
          </Text>
        </View>
        <Text style={[styles.count, { color: colors.textSoft }]}>
          {hints.length}
        </Text>
      </View>
      <ReplicaStatusBar />
      {sections.length ? (
        <PhotoTimeline
          sections={sections}
          selection={new Set()}
          onSelectionChange={() => undefined}
          onOpen={(asset) =>
            navigation.navigate("PhotoLightbox", { assetId: asset.id })
          }
          refreshing={refreshing}
          onRefresh={refreshNow}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            No dHash similarity hints.
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1, marginLeft: 10 },
  count: { fontFamily: family.monoMedium, fontSize: 11 },
  empty: { alignItems: "center", flex: 1, justifyContent: "center" },
  header: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 56,
    paddingHorizontal: 14,
  },
  meta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  safe: { flex: 1 },
  title: { fontFamily: family.displayBold, fontSize: 17 },
});
