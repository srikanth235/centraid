// governance: allow-repo-hygiene file-size-limit The #712 face-review handoff remains one cohesive stateful screen; #716 only adds its testability contract.
//
// WHAT THIS SCREEN MAY NOT DO (#711). Web twin: blueprints' FaceReview.tsx.
//   1. Titled "Face review", never "People review"; say "photographs".
//   2. Crop and photograph are the evidence; bytes come from the local
//      timeline (`usePhotoTimeline`), never the faces query.
//   3. Every proposal carries reject/rename/dismiss/skip even when no name
//      was proposed — unmatched is the primary case a detector produces.
//   4. Confidence is in matches, never a percentage.
//   5. No confirmed-people carousel; the roster is `PhotosPeopleView.tsx`.
//   6. One face at a time (`buildQueue`), never a list over every region.
//
// Every control but Skip is a real `answer-face` write (#712). Dismiss means
// "reviewed, deliberately unnamed" — without it declined strangers return on
// the next pull. "Someone else" picks people already confirmed here; no
// command mints a new one. Progress arithmetic is `triage-session`.
import { Image } from "expo-image";
import React, { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";

import { faceCropStyle } from "@centraid/blueprints/apps/_shared/face-crop";
import {
  triageCurrent,
  triageProgress,
  triageSkip,
} from "@centraid/blueprints/apps/_shared/triage-session";
import { photosFaceMatchedOn } from "@centraid/blueprints/apps/photos/shared-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import Tappable from "../../kit/components/Tappable";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { useImageFallback } from "../../kit/media/use-image-fallback";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { borders, useTheme } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import {
  ANSWER_FAILURE,
  CROP_PX,
  formatFirstSeen,
  safeParseBBox,
} from "./face-review-model";
import { buildQueue } from "./face-review-queue";
import type { AssetRow, FaceRegionRow } from "./face-review-queue";
import { styles } from "./FaceReview.styles";
import { usePhotoTimeline } from "./timeline-source";

export default function FaceReview({
  navigation,
}: PhotosScreenProps<"FaceReview">): React.JSX.Element {
  const { colors } = useTheme();
  const { session: replicaSession } = useReplica();
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
  // Metadata only — no bytes over the replica.
  const assetsQuery = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.asset" }), [])
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
    () =>
      facesQuery.rows.filter((row) => row.review_state === "confirmed").length,
    [facesQuery.rows]
  );

  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Frozen at first non-empty load: the numerator counts up as the member
  // works, rather than the denominator sliding as new proposals land.
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

  // Built per render, never held in state: the queue derives from live replica
  // rows that re-resolve on every pull, so a stateful session would need a
  // refill effect whose setState produces the next render.
  const session = useMemo(
    () => ({
      queue,
      cursor: queue.length === 0 ? 0 : cursor % queue.length,
      total: sessionStartTotal ?? queue.length,
      counts: { answered: actedCount },
    }),
    [queue, cursor, sessionStartTotal, actedCount]
  );
  const current = triageCurrent(session);
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
  // Crop and photograph are the same asset, whose derivative may not exist
  // yet, so both ride one retry ladder. Called unconditionally: it is a hook.
  const media = useImageFallback(
    sourceAsset?.uri ?? "",
    sourceAsset?.originalUri,
    sourceAsset?.assetId ?? "none"
  );

  /** An upsert for all three answers: a rejection deletes nothing, so the row
   *  must land answered or the queue rebuilds with the face in it (#712). */
  async function answer(
    kind: "confirm" | "reject" | "dismiss",
    partyId?: string
  ): Promise<boolean> {
    if (!current || !replicaSession) return false;
    const confirmed = kind === "confirm";
    setBusy(true);
    try {
      const result = await replicaSession.write("photos", {
        action: "answer-face",
        input: {
          region_id: current.regionId,
          answer: kind,
          ...(confirmed && partyId ? { party_id: partyId } : {}),
        },
      });
      surfaceWriteOutcome(result);
      return true;
    } catch (error) {
      surfaceWriteFailure(error, ANSWER_FAILURE[kind]);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirm(partyId: string, name: string): Promise<void> {
    setNote(null);
    if (await answer("confirm", partyId)) {
      setNote(`Confirmed as ${name}.`);
      setActedCount((n) => n + 1);
      setPickerOpen(false);
      setCursor(0);
    }
  }

  async function reject(): Promise<void> {
    setNote(null);
    if (await answer("reject")) {
      setActedCount((n) => n + 1);
      setCursor(0);
    }
  }

  /** Reviewed, kept, deliberately unnamed — unlike Skip it does not come back
   *  on the next pull. */
  async function dismiss(): Promise<void> {
    setNote(null);
    if (await answer("dismiss")) {
      setNote("Kept, and left unnamed.");
      setActedCount((n) => n + 1);
      setCursor(0);
    }
  }

  function skip(): void {
    if (queue.length === 0) return;
    setNote(null);
    setCursor(triageSkip(session).cursor);
  }

  const { position, total } = triageProgress(session);
  const proposedName = current?.partyId
    ? (names.get(current.partyId) ?? null)
    : null;

  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
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
                {/* No server-cropped variant exists: the source photograph is
                  scaled so the bbox fills the box (`faceCropStyle`). */}
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
                      source={imageSource(media.source)}
                      {...gridImageProps(media.source)}
                      recyclingKey={media.recyclingKey}
                      onLoad={media.handleLoad}
                      onError={media.handleError}
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
                      source={imageSource(media.source)}
                      {...gridImageProps(media.source)}
                      recyclingKey={media.recyclingKey}
                      onLoad={media.handleLoad}
                      onError={media.handleError}
                      style={styles.tileImg}
                    />
                  ) : null}
                </View>
                {/* Source photograph, aspect 1.5. */}
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
                      source={imageSource(media.source)}
                      {...gridImageProps(media.source)}
                      recyclingKey={media.recyclingKey}
                      onLoad={media.handleLoad}
                      onError={media.handleError}
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
                  {proposedName ? photosFaceMatchedOn(current.matchCount) : ""}
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
                  <Tappable
                    accessibilityLabel="Name this face"
                    accessibilityHint={
                      busy
                        ? "Face review is updating."
                        : people.length === 0
                          ? "No named people are available."
                          : undefined
                    }
                    accessibilityRole="button"
                    disabled={busy || people.length === 0}
                    onPress={() => setPickerOpen((v) => !v)}
                  >
                    <Text
                      style={[styles.rowLabel, { color: colors.accentText }]}
                    >
                      Name →
                    </Text>
                  </Tappable>
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
                  <Tappable
                    accessibilityLabel="Keep unnamed"
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void dismiss()}
                  >
                    <Text
                      style={[styles.rowLabel, { color: colors.accentText }]}
                    >
                      Keep unnamed
                    </Text>
                  </Tappable>
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
                  <Tappable
                    accessibilityLabel="Skip this face"
                    accessibilityRole="button"
                    onPress={skip}
                  >
                    <Text
                      style={[styles.rowLabel, { color: colors.accentText }]}
                    >
                      Skip
                    </Text>
                  </Tappable>
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
    </TopSafeArea>
  );
}
