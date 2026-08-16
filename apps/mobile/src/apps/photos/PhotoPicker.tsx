// The picker, phone-shaped (Photos v4 handoff §10, proto:4278-4290).
//
// "A centred dialog on desktop and the PWA, a full screen on the phone"
// (proto:3963) — so on this surface it is a pushed screen, not a modal card,
// and it keeps the band like every other non-lightbox surface (§F).
//
// TWO RULES THE PROTOTYPE IS EMPHATIC ABOUT, both structural rather than
// cosmetic:
//
//   1. ITS SELECTION IS ITS OWN SET, not the timeline's. That is why this
//      screen passes NO `selection` to `PhotosScreen`: the five-target
//      selection bar belongs to the library's selection, and letting the
//      picker drive it would put Trash and Copy-to-⟨vault⟩ under a choice that
//      means "add these to an album". The picked set lives here and dies here.
//   2. ADDING MOVES AND COPIES NOTHING. An album REFERS to a photograph where
//      it already lives. The sentence is the web picker's own
//      (`components/Picker.tsx`), verbatim, so the two clients cannot promise
//      a member two different things about their photographs.
//
// WHY THERE IS NO SEARCH FIELD. proto:4282 draws one ("Search the library to
// narrow this"). The only search this app has on the phone is the gateway's
// index (`session.search`, see `PhotosSearch.tsx`), which is online-only and
// has a genuine unreachable state — §9's rule is that search "will not pretend
// to have looked". A field in a picker that silently matches nothing while the
// gateway is unreachable is exactly that pretence, and the unreachable state is
// a surface of its own. The field is omitted rather than faked; add it when the
// picker can carry that state honestly.

import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
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

/** The web picker's own sentence (`components/Picker.tsx`), verbatim. */
const REFERS_NOT_COPIES = "An album refers to a photograph where it lives.";

/** The web picker's empty copy, verbatim. */
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
  // Candidates are the photographs the album does not already refer to. A
  // trashed photograph is not offered: adding one would put a reference to a
  // photograph the member deleted into an album they are curating.
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

  // WHY THE ADD MAY BE REFUSED, in the member's words. Each of the three is a
  // different truth and each is actionable differently, so none of them is
  // collapsed into a generic "cannot add".
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
    // The new references land after the album's existing ones, so the member's
    // own ordering is preserved rather than reshuffled by an add.
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
    // The picker passes NO selection to the shell: its picked set is its own
    // (proto:3963), and the band's five-target selection bar belongs to the
    // library's selection, not to this one.
    <PhotosScreen current="collections">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Cancel"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="x" size={22} color={colors.text} />
        </Pressable>
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
        {/* The ONE filled element on this screen (§18) — and it stops being
            filled the moment it cannot fire, rather than offering a commit
            that would be refused. */}
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
      {/* The refusal, STATED — in `net` mono, on the surface, once. Never a
          hint alone (§1). */}
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
          // Picking is the only thing this screen does, so a tap on a tile
          // toggles it rather than opening it. `PhotoTimeline` opens on tap
          // only while nothing is selected; routing `onOpen` to the same
          // toggle makes the first tap pick, exactly as every later one does.
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
