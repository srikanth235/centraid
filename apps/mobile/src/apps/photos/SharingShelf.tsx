// THE SHARING SHELF, phone-shaped (issue #712, A5; v4 handoff §H, proto:3955).
//
// `photos-band.ts` used to say Sharing was "deliberately ABSENT" from the More
// sheet because "there is no Sharing surface (a second vault a photograph sits
// in)" on mobile, and to add the row back "the moment their surfaces ship — not
// before". This is that surface, and it is the FIRST row of the sheet, exactly
// where the handoff puts it.
//
// SAME TIMELINE UNDER A FILTER — the pattern `DuplicatesShelf.tsx` states and
// this shelf follows to the letter: `PhotosScreen current="more"` for the band,
// the shared selection bar, `ReplicaStatusBar`, the shared `PhotoTile` at the
// member's own rung. A shelf that pinned its own tile size would be a fifth
// size nobody asked for, and a shelf that fetched its own rows would be a
// second library to keep in step.
//
// WHAT IS DIFFERENT HERE, AND WHY:
//
//   * THE THIRD SELECTION TARGET READS *Remove from Sharing*, not *Copy to
//     Sharing* (§6 — `buildSelectionActions`'s `shelf: "sharing"` swap, which
//     `photos-selection.ts` modelled long before this screen existed). It is
//     DISABLED, with a stated reason: there is no removal write on either
//     client (see `NO_REMOVE_FROM_SHARING_REASON`). Disabled-and-explained is
//     the §6 contract; hidden would let a member believe the way back out is
//     somewhere else on this screen.
//   * THE STATUS LINE NAMES THE AUDIENCE ONLY WHEN IT HAS ONE. An unanswered
//     roster read is not "nobody" — see `sharingStatusLine`.

import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { vaultAudience } from "../../kit/share/audience";
import { useShareTarget } from "../../kit/share/use-share-target";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { justify } from "./justify";
import { usePhotosRung } from "./photos-rung-store";
import { rungHeight } from "./photos-rungs";
import { NO_DOWNLOAD_REASON, vaultAssets } from "./photos-selection-writes";
import {
  NO_REMOVE_FROM_SHARING_REASON,
  SHARING_SHELF_EMPTY,
  sharedAssets,
  sharingStatusLine,
} from "./photos-sharing";
import { useVaultFacts } from "./photos-vaults";
import PhotosScreen from "./PhotosScreen";
import PhotoTile from "./PhotoTile";
import { usePhotoTimeline } from "./timeline-source";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

export default function SharingShelf({
  navigation,
}: PhotosScreenProps<"SharingShelf">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session } = useReplica();
  const timeline = usePhotoTimeline();
  const shareTarget = useShareTarget();
  const [selection, setSelection] = useState(new Set<string>());
  // Keyed by the vault it was read for, so a pointer change never shows the
  // previous place's roster against the new one's photographs.
  const [audience, setAudience] = useState<{ vaultId: string; size: number }>();

  const targetId = shareTarget.target?.vaultId;
  const shown = useMemo(
    () => sharedAssets(timeline.assets, targetId),
    [timeline.assets, targetId]
  );
  const selecting = selection.size > 0;

  useEffect(() => {
    if (!targetId) return;
    // `vaultAudience` never throws and answers `[]` on any failure, so this is
    // a plain external read — and an empty answer is treated as UNKNOWN by
    // `sharingStatusLine`, never printed as a roster of nobody. The state is
    // set only from the callback: the "no target" case is DERIVED below rather
    // than written synchronously here, which would be a cascading render.
    void vaultAudience(targetId).then((members) =>
      setAudience({ vaultId: targetId, size: members.length })
    );
  }, [targetId]);

  const selected = vaultAssets(shown, selection);
  const writeBlockedReason = session
    ? selected.some((asset) => asset.canWrite === false)
      ? READ_ONLY_VAULT_REASON
      : null
    : "Not connected to a gateway, so nothing can be written here.";

  const selectionBar = {
    count: selection.size,
    // The swap that makes the third target read "Remove from Sharing" (§6).
    shelf: "sharing" as const,
    readOnlyReason: writeBlockedReason,
    favorite: {
      unavailableReason:
        "Favourite from the library — a favourite is yours, not the audience's.",
    },
    addToAlbum: {
      unavailableReason: "Add to album from the library, where the albums are.",
    },
    // Disabled WITH the sentence, never hidden. There is no removal write on
    // any client yet; see `photos-sharing.ts` for the full account.
    share: { unavailableReason: NO_REMOVE_FROM_SHARING_REASON },
    download: { unavailableReason: NO_DOWNLOAD_REASON },
    trash: writeBlockedReason
      ? { unavailableReason: writeBlockedReason }
      : {
          unavailableReason:
            "Trash from the library. Trashing here would delete the photograph for everyone who can see this place, which is not what leaving Sharing means.",
        },
  };

  return (
    <PhotosScreen current="more" selection={selectionBar}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={selecting ? "Clear selection" : "Back to Photos"}
          accessibilityRole="button"
          onPress={() =>
            selecting ? setSelection(new Set()) : navigation.goBack()
          }
        >
          <Icon
            name={selecting ? "x" : "chevron-left"}
            size={selecting ? 22 : 26}
            color={colors.text}
          />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {selecting ? `${selection.size} selected` : "Sharing"}
        </Text>
      </View>
      <ReplicaStatusBar />
      <ScrollView contentContainerStyle={styles.body}>
        {/* The status line, in mono because it is counts (§18). It names the
            place by its own label — never "the sharing vault", which is not a
            thing: the destination is a pointer, not a property. */}
        <Text style={styles.status}>
          {sharingStatusLine(
            shown.length,
            audience && audience.vaultId === targetId ? audience.size : 0
          )}
        </Text>
        {shareTarget.reason ? (
          <Text style={[styles.note, { color: colors.net }]}>
            {shareTarget.reason}
          </Text>
        ) : shareTarget.target ? (
          <Text style={styles.note}>
            These photographs sit in {shareTarget.target.label}. That is what
            makes them shared — nothing here carries a permission of its own.
          </Text>
        ) : shareTarget.hydrated ? (
          <Text style={styles.note}>
            You have not chosen where your shares go yet. Select photographs
            anywhere in Photos and choose Copy to Sharing — you will be asked
            once, there and then.
          </Text>
        ) : null}
        {shareTarget.target && shown.length === 0 ? (
          <Text style={styles.note}>{SHARING_SHELF_EMPTY}</Text>
        ) : null}
        <SharedRows
          assets={shown}
          selection={selection}
          onToggle={(id) =>
            setSelection((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onOpen={(id) => navigation.navigate("PhotoLightbox", { assetId: id })}
        />
      </ScrollView>
    </PhotosScreen>
  );
}

/**
 * The rows, packed by `justify()` at the member's own rung — the same packing
 * the timeline's day-rows use, so a photograph is the same box on both.
 */
function SharedRows({
  assets,
  selection,
  onToggle,
  onOpen,
}: {
  assets: readonly ReturnType<typeof usePhotoTimeline>["assets"][number][];
  selection: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [rung] = usePhotosRung();
  const vaults = useVaultFacts();
  const { width } = useWindowDimensions();
  const content = width - spacing[4] * 2;
  const rows = useMemo(
    () => justify(assets, content, rungHeight(rung, "phone")),
    [assets, content, rung]
  );
  const selecting = selection.size > 0;
  return (
    <>
      {rows.map((tiles, rowIndex) => (
        // Rows are re-packed from the same ordered list on every render, so a
        // row's position IS its identity — same key the timeline's own packed
        // rows carry.
        <View key={`sharing-row-${rowIndex}`} style={styles.row}>
          {tiles.map((tile) => (
            <PhotoTile
              key={tile.asset.id}
              asset={tile.asset}
              width={tile.width}
              height={tile.height}
              rung={rung}
              selected={selection.has(tile.asset.id)}
              selecting={selecting}
              vaults={vaults}
              onOpen={(asset) =>
                selecting ? onToggle(asset.id) : onOpen(asset.id)
              }
              onSelect={(asset) => onToggle(asset.id)}
            />
          ))}
        </View>
      ))}
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { paddingBottom: spacing[5], paddingHorizontal: spacing[4] },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 56,
      paddingHorizontal: spacing[4] - 2,
    },
    note: {
      ...t("small"),
      color: colors.textSoft,
      marginTop: spacing[2],
      marginBottom: spacing[2],
    },
    row: { flexDirection: "row", gap: 2, marginBottom: 2 },
    status: {
      ...t("mono"),
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      color: colors.textSoft,
      paddingTop: spacing[3],
    },
    title: { ...t("bodyStrong"), color: colors.text, flex: 1 },
  });
