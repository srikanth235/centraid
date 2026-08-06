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
// EVERY CONTROL IS A REAL WRITE NOW (issue #712), which was not true before —
// this header used to end by explaining which button was an apology:
//   * Confirm / Not this person / Someone else → `answer-face` with
//     `confirm` or `reject`. "Someone else" is a picker over people ALREADY
//     confirmed elsewhere in this vault; minting a BRAND NEW person has no
//     action-plane command in app.json, so picking an existing one is the
//     honest subset of "name this face yourself" this client can do.
//   * Unknown person / Keep unnamed → `answer-face` with `dismiss`. It used
//     to set a note reading "isn't wired up yet"; there was genuinely no
//     vault command that meant "reviewed, deliberately left unnamed", so
//     every stranger the member declined to name came back on the next
//     replica pull. `media.answer_face_proposal` has one, and a dismissed
//     face stays dismissed.
//   * Skip: local only — nothing is written, so "it stays in the queue"
//     (4315) is literally true, and it is now the ONLY control of which that
//     is true.
//
// The cursor/progress arithmetic is `@centraid/blueprints`'
// `apps/photos/triage-session` — the same pure model the web twin and the
// duplicate review consume, so "1 of 54" cannot mean two different things
// on two screens; `session` below explains the per-render build.
import { Image } from "expo-image";
import React, { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  triageCurrent,
  triageProgress,
  triageSkip,
} from "@centraid/blueprints/apps/photos/triage-session";

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
import {
  ANSWER_FAILURE,
  ANSWERED_STATE,
  CROP_PX,
  formatFirstSeen,
  safeParseBBox,
} from "./face-review-model";
import { buildQueue } from "./face-review-queue";
import type { AssetRow, FaceRegionRow } from "./face-review-queue";
import { styles } from "./FaceReview.styles";
import { usePhotoTimeline } from "./timeline-source";
import { useImageFallback } from "./use-image-fallback";

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
    () =>
      facesQuery.rows.filter((row) => row.review_state === "confirmed").length,
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

  // The shared triage model, BUILT PER RENDER rather than held in state — and
  // that is the one thing this screen does differently from the web twin. The
  // web surface loads a queue page and owns it; here the queue is DERIVED from
  // live replica rows that re-resolve on every pull, so a session kept in
  // state would need an effect to refill it on each new array identity, and
  // that effect would set state that produces the next render. Deriving it
  // instead keeps the data flow one-way, and the arithmetic the member reads
  // (current, position, total, skip) still comes from one place for all three
  // surfaces.
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
  // The evidence on this card is the whole point of the card — a face the
  // member is asked to name, over a photograph they are asked to recognise.
  // Both come from the same asset, which is asked for as a derivative and may
  // not have one yet, so both ride the one retry ladder rather than rendering
  // as two empty boxes. Called unconditionally: it is a hook, and `current`
  // changes as the queue advances.
  const media = useImageFallback(
    sourceAsset?.uri ?? "",
    sourceAsset?.originalUri,
    sourceAsset?.assetId ?? "none"
  );

  /**
   * The ONE write behind every answer on this screen (issue #712) — the same
   * `answer-face` action, and the same three answers, the web twin fires.
   *
   * The OPTIMISTIC row is an upsert for all three: a rejection no longer
   * deletes anything, so the local row must land in the same answered state
   * the vault is about to write, or the queue would rebuild with the face
   * still in it for the moment before the pull catches up. Rejected and
   * dismissed regions carry no party — the vault's own CHECK says so.
   */
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
        optimistic: [
          {
            op: "upsert",
            entity: "media.face_region",
            rowId: current.regionId,
            values: {
              review_state: ANSWERED_STATE[kind],
              party_id: confirmed ? (partyId ?? null) : null,
              confirmed_by_party_id: confirmed ? (partyId ?? null) : null,
            },
          },
        ],
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

  /** "Unknown person → Keep unnamed": reviewed, kept, deliberately unnamed —
   *  and, unlike Skip, it does not come back on the next pull. */
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
                      source={imageSource(media.source)}
                      {...gridImageProps(media.source)}
                      recyclingKey={media.recyclingKey}
                      onLoad={media.onLoad}
                      onError={media.onError}
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
                      onLoad={media.onLoad}
                      onError={media.onError}
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
                      source={imageSource(media.source)}
                      {...gridImageProps(media.source)}
                      recyclingKey={media.recyclingKey}
                      onLoad={media.onLoad}
                      onError={media.onError}
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
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    onPress={() => void dismiss()}
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
