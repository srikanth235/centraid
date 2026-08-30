// The picker, phone-shaped (Photos v4 §10). Pushed screen, not a modal card.
//
// 1. ITS SELECTION IS ITS OWN SET — no `selection` to `PhotosScreen`; the
//    five-target bar belongs to the library, not "add these to an album".
// 2. ADDING REFERS, copies nothing — the web picker's sentence, verbatim.
//
// No search field: phone search is gateway-only (`PhotosSearch.tsx`) and
// has a genuine unreachable state. A silent miss is pretence (§9).

import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import Tappable from "../../kit/components/Tappable";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { PhotosScreenProps } from "../../navigation";
import { batchAddToAlbum, vaultAssets } from "./photos-selection-writes";
import PhotosScreen from "./PhotosScreen";
import PhotoTimeline from "./PhotoTimeline";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

const REFERS_NOT_COPIES = "An album refers to a photograph where it lives.";

const NOTHING_LEFT = "Everything in your library is already in this album.";

export default function PhotoPicker({
  route,
  navigation,
}: PhotosScreenProps<"PhotoPicker">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session } = useReplica();
  const timeline = usePhotoTimeline();
  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const entries = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection_entry" }), [])
  );
  const [picked, setPicked] = useState(new Set<string>());
  const [adding, setAdding] = useState(false);

  const albumId = route.params.albumId;
  const album = collections.rows.find(
    (row) => String(row.collection_id) === albumId
  );
  const albumTitle = String(album?.name ?? "Album");
  const alreadyIn = useMemo(
    () =>
      new Set(
        entries.rows
          .filter((row) => String(row.collection_id) === albumId)
          .map((row) => String(row.target_id))
      ),
    [albumId, entries.rows]
  );
  // Trashed photographs are not offered: adding would put a deleted reference into a curated album.
  const candidates = useMemo(
    () =>
      timeline.assets.filter(
        (asset) =>
          asset.assetId !== undefined &&
          !asset.deleted &&
          !alreadyIn.has(asset.assetId)
      ),
    [alreadyIn, timeline.assets]
  );
  const sections = useMemo(() => sectionPhotoAssets(candidates), [candidates]);
  const chosen = vaultAssets(candidates, picked);

  const blockedReason = session
    ? album === undefined
      ? "This album is not in the copy this device holds yet."
      : album.__centraidCanWrite === false
        ? READ_ONLY_VAULT_REASON
        : adding
          ? "The last add is still running."
          : null
    : "Not connected to a gateway, so nothing can be added here.";
  const canAdd = blockedReason === null && picked.size > 0;

  const emit = (result: NativeWriteResult): void => {
    surfaceWriteOutcome(result);
  };
  const add = (): void => {
    if (!canAdd || !session) return;
    setAdding(true);
    // New references land after existing ones so the member's ordering is preserved.
    const firstPosition = entries.rows.filter(
      (row) => String(row.collection_id) === albumId
    ).length;
    void batchAddToAlbum(session, chosen, albumId, firstPosition, emit)
      .then(() => {
        setPicked(new Set());
        navigation.goBack();
      })
      .catch((error: unknown) => surfaceWriteFailure(error, "Photos not added"))
      .finally(() => setAdding(false));
  };

  return (
    // No `selection` to the shell — this picked set is its own (proto:3963).
    <PhotosScreen current="collections">
      <View style={styles.header}>
        <Tappable
          accessibilityLabel="Cancel"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="x" size={22} color={colors.text} />
        </Tappable>
        <View style={styles.copy}>
          <Text style={styles.title} numberOfLines={1}>
            {`Add to “${albumTitle}”`}
          </Text>
          <Text style={styles.count}>
            {picked.size === 0
              ? "Nothing chosen yet"
              : `${picked.size} chosen · nothing has been added yet`}
          </Text>
        </View>
        {/* The one filled element (§18) — unfilled the moment it cannot fire. */}
        <Pressable
          accessibilityLabel={`Add ${picked.size} to ${albumTitle}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canAdd }}
          accessibilityHint={blockedReason ?? undefined}
          disabled={!canAdd}
          onPress={add}
          style={[
            styles.add,
            canAdd
              ? { backgroundColor: colors.accentFill }
              : {
                  borderColor: colors.line,
                  borderWidth: borders.hairline,
                },
          ]}
        >
          <Text
            style={[
              styles.addText,
              { color: canAdd ? colors.textInv : colors.textDisabled },
            ]}
          >
            {picked.size === 0 ? "Add" : `Add ${picked.size}`}
          </Text>
        </Pressable>
      </View>
      <ReplicaStatusBar />
      {/* Refusal stated in `net` mono, once. Never a hint alone (§1). */}
      {blockedReason ? (
        <Text style={[styles.reason, { color: colors.net }]}>
          {blockedReason}
        </Text>
      ) : null}
      <Text style={styles.lede}>{REFERS_NOT_COPIES}</Text>
      {sections.length ? (
        <PhotoTimeline
          sections={sections}
          selection={picked}
          onSelectionChange={setPicked}
          // Tap toggles; `PhotoTimeline` opens on tap only while nothing is selected.
          onOpen={(asset) =>
            setPicked((current) => new Set([...current, asset.id]))
          }
        />
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyCopy}>{NOTHING_LEFT}</Text>
        </View>
      )}
    </PhotosScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    add: {
      alignItems: "center",
      borderRadius: radii.md,
      justifyContent: "center",
      minHeight: 34,
      paddingHorizontal: spacing[3],
    },
    addText: { ...t("control") },
    copy: { flex: 1, marginLeft: spacing[2] },
    count: { ...t("mono"), color: colors.textFaint, marginTop: 2 },
    empty: { alignItems: "center", flex: 1, justifyContent: "center" },
    emptyCopy: {
      ...t("small"),
      color: colors.textSoft,
      paddingHorizontal: spacing[5],
      textAlign: "center",
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 56,
      paddingHorizontal: spacing[4] - 2,
    },
    lede: {
      ...t("small"),
      color: colors.textSoft,
      paddingBottom: spacing[2],
      paddingHorizontal: spacing[4],
    },
    reason: {
      ...t("mono"),
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[1],
    },
    title: { ...t("bodyStrong"), color: colors.text },
  });
