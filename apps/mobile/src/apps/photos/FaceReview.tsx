// FACE REVIEW, NATIVE (issue #711, v4 handoff 4305-4318 / §8) — brought in
// line with the same handoff EnrichmentConsent.tsx already answers to, and
// with the web twin (@centraid/blueprints FaceReview.tsx).
//
// WHAT THIS REPLACES, AND WHY EACH PIECE WAS A REAL DEFECT, NOT A STYLING GAP
// (issue #711 review):
//
//   1. Title read "People review" — the handoff's own name for this screen
//      is "Face review" (proto:4306, §16 `faces.title`).
//   2. No face crop, no source photograph — just a `--skel` circle with a
//      generic user glyph, because the old query never asked for bytes. The
//      photograph and the crop are the evidence the member is being asked to
//      judge (4307); a member confirming a face they cannot see is not
//      meaningfully consenting. Fixed by widening the read to the LOCAL
//      TIMELINE (`usePhotoTimeline`, the same source every other Photos
//      screen already paints from) rather than the faces query — see
//      `sourceAssetFor` below.
//   3. The three escape rows (Someone else / Unknown person / Skip) did not
//      exist — only a bare confirm/reject icon pair.
//   4. CONFIRM RENDERED ONLY WHEN `party_id` WAS ALREADY SET, so an unmatched
//      face — the PRIMARY case a face detector produces — was reject-only:
//      no way forward at all beyond deleting it. Fixed: every proposal has
//      "Not this person", "Someone else", "Unknown person" and "Skip"
//      regardless of whether the enricher proposed a name.
//   5. Confidence read `{pct}% confidence`, the enricher's raw similarity
//      score. README.md:285 is explicit: confidence is expressed in
//      MATCHES, not a percentage. Fixed by `face-review-queue.ts`'s
//      `matchCountFor`.
//   6. No progress line (v4 3966/4316's three-part note).
//   7. AN INVENTED "CONFIRMED PEOPLE" horizontal carousel duplicating the
//      real People destination (`PhotosPeopleView.tsx`, its own band
//      destination per v4 §3.1) and using "{count} photos" — the handoff's
//      vocabulary is "photographs" throughout. Removed outright, not
//      relabelled: Face review is proposal triage, not a browsable roster
//      (see PhotosPeopleView.tsx's own header for that same distinction).
//   8. A FlatList over every unconfirmed region at once — batched, contrary
//      to v4 3967 "One face at a time". Restructured into a single-entry
//      queue (`face-review-queue.ts`'s `buildQueue`), one proposal on screen
//      at a time.
//
// WHAT IS AND ISN'T A REAL WRITE (mirrors the web twin's own header — same
// vault schema, same gap):
//   * Confirm / Not this person: real writes (confirm-face / reject-face).
//   * Someone else → a picker over people ALREADY confirmed elsewhere in
//     this vault, reusing confirm-face with that party_id. Minting a BRAND
//     NEW person has no action-plane command in app.json; picking an
//     existing one is the honest subset of "name this face yourself" this
//     client can actually do today.
//   * Unknown person / Keep unnamed: no vault command confirms a region as
//     "reviewed, deliberately left unnamed" (confirm-face needs a party_id;
//     reject-face deletes the row outright). Says so instead of faking it.
//   * Skip: local only — nothing is written, so "it stays in the queue"
//     (4315) is literally true.
import { Image } from "expo-image";
import React, { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { borders, useTheme } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { faceCropStyle } from "./face-crop";
import { buildQueue } from "./face-review-queue";
import type { AssetRow, FaceRegionRow } from "./face-review-queue";
import { styles } from "./FaceReview.styles";
import { usePhotoTimeline } from "./timeline-source";

const CROP_PX = 120;

function safeParseBBox(
  json: unknown
): { x: number; y: number; w: number; h: number } | null {
  if (json == null) return null;
  try {
    const v = JSON.parse(String(json));
    if (
      v &&
      typeof v.x === "number" &&
      typeof v.y === "number" &&
      typeof v.w === "number" &&
      typeof v.h === "number"
    )
      return v;
    return null;
  } catch {
    return null;
  }
}

function formatFirstSeen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function FaceReview({
  navigation,
}: PhotosScreenProps<"FaceReview">): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const timeline = usePhotoTimeline();

  const facesQuery = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  const partiesQuery = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.party" }), [])
  );
  // Metadata only (captured_at/width/height) — the same "no bytes over the
  // replica" contract the old query kept. The PHOTOGRAPH itself is looked up
  // from the local timeline below, exactly like every other Photos screen.
  const assetsQuery = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.media_asset" }), [])
  );

  const names = useMemo(
    () =>
      new Map(
        partiesQuery.rows.map((row) => [
          String(row.party_id),
          String(row.display_name ?? "Unnamed"),
        ])
      ),
    [partiesQuery.rows]
  );
  const people = useMemo(
    () =>
      partiesQuery.rows.map((row) => ({
        partyId: String(row.party_id),
        name: String(row.display_name ?? "Unnamed"),
      })),
    [partiesQuery.rows]
  );
  const queue = useMemo(
    () =>
      buildQueue(
        facesQuery.rows as unknown as FaceRegionRow[],
        assetsQuery.rows as unknown as AssetRow[]
      ),
    [facesQuery.rows, assetsQuery.rows]
  );
  const confirmedTotal = useMemo(
    () => facesQuery.rows.filter((row) => row.confirmed_by_party_id).length,
    [facesQuery.rows]
  );

  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Frozen at first non-empty load — the numerator counts UP as the member
  // works (4306 "1 of 54 unmatched"), instead of the denominator sliding
  // around as other proposals land mid-session (same choice as the web twin).
  const [sessionStartTotal, setSessionStartTotal] = useState<number | null>(
    null
  );
  const [actedCount, setActedCount] = useState(0);
  useEffect(() => {
    if (sessionStartTotal == null && queue.length > 0)
      queueMicrotask(() =>
        setSessionStartTotal((previous) => previous ?? queue.length)
      );
  }, [sessionStartTotal, queue.length]);

  const current = queue.length > 0 ? queue[cursor % queue.length] : undefined;
  const region = current
    ? facesQuery.rows.find((r) => String(r.region_id) === current.regionId)
    : undefined;
  const sourceAsset = current
    ? timeline.assets.find((a) => a.assetId === current.assetId)
    : undefined;
  const bbox = safeParseBBox(region?.bbox_json);
  const crop =
    sourceAsset && bbox
      ? faceCropStyle(bbox, sourceAsset.width, sourceAsset.height, CROP_PX)
      : null;

  async function act(
    action: "confirm-face" | "reject-face",
    partyId?: string
  ): Promise<boolean> {
    if (!current || !session) return false;
    setBusy(true);
    try {
      const result = await session.write("photos", {
        action,
        input: {
          region_id: current.regionId,
          ...(partyId ? { party_id: partyId } : {}),
        },
        optimistic:
          action === "reject-face"
            ? [
                {
                  op: "delete",
                  entity: "media.face_region",
                  rowId: current.regionId,
                },
              ]
            : [
                {
                  op: "upsert",
                  entity: "media.face_region",
                  rowId: current.regionId,
                  values: {
                    party_id: partyId ?? null,
                    confirmed_by_party_id: partyId ?? null,
                  },
                },
              ],
      });
      surfaceWriteOutcome(result);
      return true;
    } catch (error) {
      surfaceWriteFailure(
        error,
        action === "reject-face" ? "Face not rejected" : "Face not confirmed"
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirm(partyId: string, name: string): Promise<void> {
    setNote(null);
    if (await act("confirm-face", partyId)) {
      setNote(`Confirmed as ${name}.`);
      setActedCount((n) => n + 1);
      setPickerOpen(false);
      setCursor(0);
    }
  }

  async function reject(): Promise<void> {
    setNote(null);
    if (await act("reject-face")) {
      setActedCount((n) => n + 1);
      setCursor(0);
    }
  }

  function skip(): void {
    if (queue.length === 0) return;
    setNote(null);
    setCursor((c) => (c + 1) % queue.length);
  }

  const total = sessionStartTotal ?? queue.length;
  const position = Math.min(actedCount + 1, Math.max(total, 1));
  const proposedName = current?.partyId
    ? (names.get(current.partyId) ?? null)
    : null;

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
          style={styles.headerBtn}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          Face review
        </Text>
        <Text style={[styles.count, { color: colors.textSoft }]}>
          {current ? `${position} of ${total}` : ""}
        </Text>
      </View>
      <ReplicaStatusBar />
      <FlatList
        data={current ? [current.regionId] : []}
        keyExtractor={(regionId) => regionId}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refreshNow} />
        }
        renderItem={() =>
          current ? (
            <>
              <View style={styles.tiles}>
                {/* The face crop — no server-cropped variant exists, so the
                  same source photograph is scaled/positioned so the bbox
                  fills the box (face-crop.ts). */}
                <View
                  style={[
                    styles.tile,
                    {
                      width: CROP_PX,
                      height: CROP_PX,
                      backgroundColor: colors.skel,
                    },
                  ]}
                >
                  {sourceAsset && crop ? (
                    <Image
                      source={imageSource(sourceAsset.uri)}
                      {...gridImageProps(sourceAsset.uri)}
                      contentFit="fill"
                      style={[
                        styles.cropImg,
                        {
                          width: crop.width,
                          height: crop.height,
                          left: crop.left,
                          top: crop.top,
                        },
                      ]}
                    />
                  ) : sourceAsset ? (
                    <Image
                      source={imageSource(sourceAsset.uri)}
                      {...gridImageProps(sourceAsset.uri)}
                      style={styles.tileImg}
                    />
                  ) : null}
                </View>
                {/* The source photograph, aspect 1.5 per 4307. */}
                <View
                  style={[
                    styles.tile,
                    {
                      width: CROP_PX * 1.5,
                      height: CROP_PX,
                      backgroundColor: colors.skel,
                    },
                  ]}
                >
                  {sourceAsset ? (
                    <Image
                      source={imageSource(sourceAsset.uri)}
                      {...gridImageProps(sourceAsset.uri)}
                      style={styles.tileImg}
                    />
                  ) : null}
                  <Text
                    numberOfLines={1}
                    style={[styles.tileNote, { color: colors.onStage }]}
                  >
                    the photograph it came from
                  </Text>
                </View>
              </View>

              <View
                style={[
                  styles.panel,
                  { backgroundColor: colors.bgElev, borderColor: colors.line },
                ]}
              >
                <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
                  Is this someone you know?
                </Text>
                <Text style={[styles.panelTitle, { color: colors.text }]}>
                  {proposedName
                    ? `Proposed: ${proposedName}`
                    : "No proposed match"}
                </Text>
                <Text style={[styles.body, { color: colors.textSoft }]}>
                  {proposedName
                    ? `Matched on ${current.matchCount} other photograph${current.matchCount === 1 ? "" : "s"}. `
                    : ""}
                  Nothing is written until you confirm, and a rejection is
                  remembered so the same face is not proposed twice.
                </Text>
                <View>
                  <View
                    style={[styles.fact, { borderBottomColor: colors.line }]}
                  >
                    <Text
                      style={[styles.factLabel, { color: colors.textSoft }]}
                    >
                      confidence
                    </Text>
                    <Text style={[styles.factValue, { color: colors.text }]}>
                      {current.matchCount} matching face
                      {current.matchCount === 1 ? "" : "s"}
                    </Text>
                  </View>
                  <View
                    style={[styles.fact, { borderBottomColor: colors.line }]}
                  >
                    <Text
                      style={[styles.factLabel, { color: colors.textSoft }]}
                    >
                      first seen
                    </Text>
                    <Text style={[styles.factValue, { color: colors.text }]}>
                      {formatFirstSeen(current.firstSeenAt) ?? "unknown"}
                    </Text>
                  </View>
                  <View
                    style={[styles.fact, { borderBottomColor: colors.line }]}
                  >
                    <Text
                      style={[styles.factLabel, { color: colors.textSoft }]}
                    >
                      where it ran
                    </Text>
                    <Text style={[styles.factValue, { color: colors.text }]}>
                      on this device
                    </Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  {proposedName && current.partyId ? (
                    <Pressable
                      accessibilityLabel={`Confirm as ${proposedName}`}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: busy }}
                      disabled={busy}
                      onPress={() =>
                        void confirm(current.partyId!, proposedName)
                      }
                      style={[
                        styles.action,
                        styles.filled,
                        {
                          backgroundColor: busy
                            ? colors.bgSunken
                            : colors.accentFill,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.actionText,
                          {
                            color: busy ? colors.textDisabled : colors.textInv,
                          },
                        ]}
                      >
                        Confirm as {proposedName}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityLabel="Not this person"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    onPress={() => void reject()}
                    style={[styles.action, { borderColor: colors.line }]}
                  >
                    <Text style={[styles.actionText, { color: colors.text }]}>
                      Not this person
                    </Text>
                  </Pressable>
                </View>
                {note ? (
                  <Text style={[styles.wroteNote, { color: colors.textSoft }]}>
                    {note}
                  </Text>
                ) : null}
              </View>

              <View style={[styles.rows, { borderColor: colors.line }]}>
                <View
                  style={[
                    styles.row,
                    {
                      borderBottomColor: colors.line,
                      borderBottomWidth: borders.hairline,
                    },
                  ]}
                >
                  <View style={styles.rowText}>
                    <Text style={[styles.rowLabel, { color: colors.text }]}>
                      Someone else
                    </Text>
                    <Text style={[styles.rowSub, { color: colors.textFaint }]}>
                      name this face yourself
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Name this face"
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: busy || people.length === 0,
                    }}
                    disabled={busy || people.length === 0}
                    onPress={() => setPickerOpen((v) => !v)}
                  >
                    <Text
                      style={[styles.rowLabel, { color: colors.accentText }]}
                    >
                      Name →
                    </Text>
                  </Pressable>
                </View>
                {pickerOpen ? (
                  <View style={styles.picker}>
                    {people
                      .filter((p) => p.partyId !== current.partyId)
                      .map((p) => (
                        <Pressable
                          key={p.partyId}
                          accessibilityRole="button"
                          disabled={busy}
                          onPress={() => void confirm(p.partyId, p.name)}
                          style={[styles.action, { borderColor: colors.line }]}
                        >
                          <Text
                            style={[styles.actionText, { color: colors.text }]}
                          >
                            {p.name}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                ) : null}
                <View
                  style={[
                    styles.row,
                    {
                      borderBottomColor: colors.line,
                      borderBottomWidth: borders.hairline,
                    },
                  ]}
                >
                  <View style={styles.rowText}>
                    <Text style={[styles.rowLabel, { color: colors.text }]}>
                      Unknown person
                    </Text>
                    <Text style={[styles.rowSub, { color: colors.textFaint }]}>
                      keep the face, do not name it
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Keep unnamed"
                    accessibilityRole="button"
                    onPress={() =>
                      setNote(
                        "Keeping a face unnamed isn't wired up yet — there's no vault command for it. Skip for now."
                      )
                    }
                  >
                    <Text
                      style={[styles.rowLabel, { color: colors.accentText }]}
                    >
                      Keep unnamed
                    </Text>
                  </Pressable>
                </View>
                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowLabel, { color: colors.text }]}>
                      Skip
                    </Text>
                    <Text style={[styles.rowSub, { color: colors.textFaint }]}>
                      decide later; it stays in the queue
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Skip this face"
                    accessibilityRole="button"
                    onPress={skip}
                  >
                    <Text
                      style={[styles.rowLabel, { color: colors.accentText }]}
                    >
                      Skip
                    </Text>
                  </Pressable>
                </View>
              </View>
            </>
          ) : null
        }
        ListEmptyComponent={
          <Text style={[styles.body, { color: colors.textSoft }]}>
            No faces need review right now.
          </Text>
        }
        ListFooterComponent={
          <Text style={[styles.note, { color: colors.textFaint }]}>
            confirmed {confirmedTotal} · {queue.length} to go
          </Text>
        }
      />
    </SafeAreaView>
  );
}
