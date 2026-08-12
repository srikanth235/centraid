// FACE REVIEW (issue #711, v4 handoff 4305-4318 / §8) — the surface the
// handoff describes and the app did not have: reachable on its own (not
// buried inside one photograph's lightbox), one proposal at a time, with the
// exact copy transcribed from the prototype below.
//
// SELF-CONTAINED, same pattern as Enrichment.tsx: it reads its own data
// (`face-queue`) and fires its own writes (`outcomes.ts`'s act/narrate), so
// app-root.tsx only needs to MOUNT it — see the file header of faces.ts for
// the one-line wiring this still needs (app-root.tsx is out of this file's
// ownership).
//
// TWO RULES THIS FILE EXISTS TO STOP BREAKING (see faces.ts's header for the
// full account of why they were broken):
//   1. Confidence is a MATCH COUNT, never a percentage (README.md:285) — the
//      `face-queue` query already did that derivation; this file only ever
//      prints `matchCount`, never `confidence`.
//   2. One face at a time (v4 3967 "One face at a time") — `current` below
//      is always exactly one entry; nothing here loops the queue into a list.
//
// EVERY CONTROL HERE IS A REAL WRITE, AND THAT IS NEW (issue #712). Four of
// the five used to be, and the fifth was an apology:
//   * Confirm / Not this person / Someone else → `answer-face` with
//     `confirm` or `reject`. "Someone else" opens an inline picker over
//     people ALREADY confirmed elsewhere in this vault; the prototype's
//     "name this face yourself" implies minting a BRAND NEW person and there
//     is no action-plane command to create one (app.json has no create-party
//     action), so picking an existing person is the honest subset.
//   * Unknown person / Keep unnamed → `answer-face` with `dismiss`. This
//     button used to set a note reading "isn't wired up yet — there's no
//     command for it. Skip for now.", because confirm demanded a party_id
//     and reject DELETED the row. That gap is why this queue could not be
//     finished: every stranger the member deliberately declined to name came
//     back on the next load, for ever. `media.answer_face_proposal` now has
//     an answer for it, and a dismissed face stays dismissed.
//   * Skip: still genuinely local — nothing is written, so "it stays in the
//     queue" (4315) is exactly true, not just a promise.
//
// THE CURSOR/PROGRESS/COUNTS STATE MACHINE IS NOT WRITTEN HERE. It is
// `../triage-session.ts`, shared with the duplicate review and the native
// twin — see that file's header for what the three flows do and do not have
// in common.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { faceCropStyle } from "../../_shared/face-crop.ts";
import { readPendingOverlay } from "../../_shared/pending-overlay.ts";
import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import {
  openTriage,
  triageAnswer,
  triageCurrent,
  triageProgress,
  triageRefill,
  triageSkip,
} from "../../_shared/triage-session.ts";
import type { TriageSession } from "../../_shared/triage-session.ts";
import { act, narrate } from "../outcomes.ts";

import styles from "./FaceReview.module.css";

const CROP_PX = { desktop: 180, phone: 120 };

interface QueueAsset {
  asset_id: string;
  content_uri: string | null;
  thumb_uri: string | null;
  width: number | null;
  height: number | null;
}

interface QueueEntry {
  region_id: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  party_id: string | null;
  person_name: string | null;
  matchCount: number;
  firstSeenAt: string | null;
  asset: QueueAsset | null;
}

interface FaceQueueData {
  queue?: QueueEntry[];
  unmatchedTotal?: number;
  confirmedTotal?: number;
  /** Real counts since issue #712 — a rejection is a state, not a deletion. */
  rejectedTotal?: number;
  dismissedTotal?: number;
  people?: Array<{ party_id: string; name: string | null }>;
  denied?: boolean;
  reason?: string;
}

/** The three answers `actions/answer-face.ts` forwards, and the outcome names
 *  the session counts them under. */
type FaceAnswer = "confirm" | "reject" | "dismiss";

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

function FaceTiles({ entry, narrow }: { entry: QueueEntry; narrow: boolean }) {
  const edge = narrow ? CROP_PX.phone : CROP_PX.desktop;
  const asset = entry.asset;
  const src = asset?.content_uri ?? asset?.thumb_uri ?? null;
  const crop = src
    ? faceCropStyle(entry.bbox, asset?.width, asset?.height, edge)
    : null;
  return (
    <div className={styles.tiles}>
      {/* The face crop — no server-cropped variant exists, so the same
          source photograph is scaled/positioned in CSS so the bbox fills
          this box (face-crop.ts). Non-selectable: it is not a Tile, it is
          this one proposal's own evidence (v4 4307). */}
      <div
        className={styles.tile}
        style={{ width: edge, height: edge }}
        aria-hidden="true"
      >
        {src ? (
          crop ? (
            <img
              className={styles.cropImg}
              src={src}
              alt=""
              style={{
                width: crop.width,
                height: crop.height,
                left: crop.left,
                top: crop.top,
              }}
            />
          ) : (
            <img className={styles.plainImg} src={src} alt="" />
          )
        ) : (
          <div className={styles.skel} />
        )}
      </div>
      {/* The source photograph, 3:2-ish (aspect 1.5) per 4307. */}
      <div className={styles.tile} style={{ width: edge * 1.5, height: edge }}>
        {src ? (
          <img className={styles.plainImg} src={src} alt="" />
        ) : (
          <div className={styles.skel} />
        )}
        <span className={styles.tileNote}>the photograph it came from</span>
      </div>
    </div>
  );
}

export function FaceReview({
  narrow = false,
  focusRegionId,
}: {
  narrow?: boolean;
  /** Opens the queue already positioned on one region — the People shelf's
   *  proposal cards route here (issue #711 review) so tapping a specific
   *  proposal does not land the member on an unrelated face first. Applied
   *  once, the first time it appears in a loaded queue; ignored after that
   *  so the member's own Skip/cursor movement is never fought. */
  focusRegionId?: string;
}) {
  const [data, setData] = useState<FaceQueueData | null>(null);
  // The cursor, the frozen denominator and the per-answer counts all live in
  // one immutable value (../triage-session.ts) rather than three useStates
  // that have to be kept in step by hand. `null` = nothing loaded yet.
  const [session, setSession] = useState<TriageSession<QueueEntry> | null>(
    null
  );
  // A ref, not state: applying the focus is a one-shot side effect of a
  // successful load, not something a render needs to react to itself — so
  // flipping it must not itself trigger another render (the pattern the
  // effect-based version of this hit react-compiler's
  // "no synchronous setState in an effect" rule on).
  const focusApplied = useRef(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.centraid.read<FaceQueueData>({
        query: "face-queue",
      });
      setData(result ?? {});
      const queue = result?.queue ?? [];
      // Land on the requested proposal exactly once (issue #711 review's
      // People-shelf routing) — found or not, this only ever fires on the
      // FIRST load: a region answered elsewhere before this loads (and so
      // already missing from the queue) leaves the member on whatever the
      // queue's own order lands on, not stuck retrying a jump that can never
      // succeed, and a later reload (after an answer or a Skip) never
      // re-jumps out from under the member's own navigation.
      let at = 0;
      if (!focusApplied.current && focusRegionId) {
        focusApplied.current = true;
        at = Math.max(
          queue.findIndex((entry) => entry.region_id === focusRegionId),
          0
        );
      }
      // A functional update, so a reload never has to name the session it is
      // replacing — the FIRST load opens it (freezing the denominator at the
      // whole backlog, not this page), every later one refills it and keeps
      // the total and the answer counts the member has been watching.
      setSession((previous) =>
        previous
          ? triageRefill(previous, queue, { at })
          : openTriage(queue, { total: result?.unmatchedTotal ?? 0, at })
      );
    } catch {
      setData({ queue: [], unmatchedTotal: 0, confirmedTotal: 0 });
      setSession((previous) => previous ?? openTriage<QueueEntry>([]));
    }
  }, [focusRegionId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const current = session ? triageCurrent(session) : undefined;

  const people = useMemo(() => data?.people ?? [], [data]);

  /**
   * The ONE write behind every answer on this screen (issue #712). It used to
   * be two actions with two shapes; the answer is now the discriminant, so
   * adding "keep unnamed" was a new member of a union rather than a new
   * endpoint — and Skip stayed the only control that writes nothing.
   */
  async function answer(
    kind: FaceAnswer,
    copy: {
      /** `confirm` only — the vault refuses a party on the other two. */
      partyId?: string;
      /** What the member is told it did. Blank where the queue moving on
       *  says it better than a sentence would (a rejection). */
      done?: string;
      failed: string;
    }
  ): Promise<void> {
    if (!current) return;
    setBusy(true);
    const outcome = await act("answer-face", {
      region_id: current.region_id,
      answer: kind,
      ...(copy.partyId ? { party_id: copy.partyId } : {}),
    });
    setBusy(false);
    if (narrate(outcome)) {
      setNote(copy.done ?? "");
      setSession((previous) =>
        previous ? triageAnswer(previous, kind) : previous
      );
      setPickerOpen(false);
      await load();
    } else if (
      outcome?.status === "queued" ||
      outcome?.status === "in-flight" ||
      outcome?.status === "parked"
    ) {
      // The row stays in the queue and the reload re-reads its durable overlay;
      // a toast is supplemental, never a substitute for the row.
      setNote("");
      await load();
    } else {
      setNote(copy.failed);
    }
  }

  async function confirm(partyId: string, name: string | null): Promise<void> {
    await answer("confirm", {
      partyId,
      done: name ? `Confirmed as ${name}.` : "Confirmed.",
      failed: "Could not confirm that face.",
    });
  }

  async function reject(): Promise<void> {
    await answer("reject", { failed: "Could not reject that face." });
  }

  /** "Unknown person → Keep unnamed": reviewed, kept, deliberately unnamed —
   *  and, unlike Skip, it does not come back. */
  async function dismiss(): Promise<void> {
    await answer("dismiss", {
      done: "Kept, and left unnamed.",
      failed: "Could not keep that face unnamed.",
    });
  }

  function skip(): void {
    setNote("");
    setSession((previous) => (previous ? triageSkip(previous) : previous));
  }

  if (data?.denied) {
    return (
      <div className={styles.screen}>
        <p className={styles.body}>
          {data.reason ?? "No access to review faces in your library."}
        </p>
      </div>
    );
  }

  if (data == null) {
    return <div className={styles.screen} aria-busy="true" />;
  }

  const progress = session ? triageProgress(session) : null;
  if (!current || !progress) {
    return (
      <div className={styles.screen}>
        <div className={styles.head}>
          <h2 className={styles.heading}>Face review</h2>
        </div>
        {/* REACHABLE, as of issue #712: with every face confirmed, rejected
            or deliberately left unnamed, the queue is genuinely empty rather
            than cycling the ones the member kept skipping. */}
        <p className={styles.body}>No faces need review right now.</p>
        <p className={styles.note}>{statusNote(data, 0)}</p>
      </div>
    );
  }

  const { position, total } = progress;
  const firstSeen = formatFirstSeen(current.firstSeenAt);
  const proposedName = current.person_name;
  const pending = Boolean(
    readPendingOverlay(current as unknown as Record<string, unknown>)
  );
  const unavailableReason =
    people.length === 0 ? "No one else is named in your library yet" : null;

  return (
    <div className={styles.screen}>
      <div className={styles.head}>
        <h2 className={styles.heading}>Face review</h2>
        <span className={styles.headMeta}>
          {position} of {total} unmatched
        </span>
      </div>

      <FaceTiles entry={current} narrow={narrow} />

      <section className={styles.panel} aria-label="Is this someone you know?">
        <p className={styles.eyebrow}>Is this someone you know?</p>
        <h3 className={styles.title}>
          {proposedName ? `Proposed: ${proposedName}` : "No proposed match"}
        </h3>
        <p className={styles.body}>
          {proposedName
            ? `Matched on ${current.matchCount} other photograph${current.matchCount === 1 ? "" : "s"}. `
            : ""}
          Nothing is written until you confirm, and a rejection is remembered so
          the same face is not proposed twice.
        </p>
        <PendingWriteActions
          row={current as unknown as Record<string, unknown>}
          onEdit={() => setPickerOpen(true)}
        />
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>confidence</dt>
            <dd className={styles.factValue}>
              {current.matchCount} matching face
              {current.matchCount === 1 ? "" : "s"}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>first seen</dt>
            <dd className={styles.factValue}>{firstSeen ?? "unknown"}</dd>
          </div>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>where it ran</dt>
            <dd className={styles.factValue}>on this device</dd>
          </div>
        </dl>
        <div className={styles.actions}>
          {proposedName && current.party_id ? (
            <button
              type="button"
              className="kit-btn primary"
              disabled={busy || pending}
              onClick={() => void confirm(current.party_id!, proposedName)}
            >
              Confirm as {proposedName}
            </button>
          ) : null}
          <button
            type="button"
            className="kit-btn"
            disabled={busy || pending}
            onClick={() => void reject()}
          >
            Not this person
          </button>
        </div>
        {note ? <p className={styles.wroteNote}>{note}</p> : null}
      </section>

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>Someone else</span>
            <span className={styles.rowSub}>name this face yourself</span>
            {unavailableReason ? (
              <span className={styles.rowSub}>{unavailableReason}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="kit-btn"
            disabled={busy || pending || people.length === 0}
            title={
              people.length === 0 ? (unavailableReason ?? undefined) : undefined
            }
            onClick={() => setPickerOpen((v) => !v)}
          >
            Name →
          </button>
        </div>
        {pickerOpen ? (
          <div className={styles.picker}>
            {people
              .filter((p) => p.party_id !== current.party_id)
              .map((p) => (
                <button
                  key={p.party_id}
                  type="button"
                  className="kit-btn"
                  disabled={busy || pending}
                  onClick={() => void confirm(p.party_id, p.name)}
                >
                  {p.name ?? "Unnamed"}
                </button>
              ))}
          </div>
        ) : null}
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>Unknown person</span>
            <span className={styles.rowSub}>keep the face, do not name it</span>
          </div>
          <button
            type="button"
            className="kit-btn"
            disabled={busy || pending}
            onClick={() => void dismiss()}
          >
            Keep unnamed
          </button>
        </div>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>Skip</span>
            <span className={styles.rowSub}>
              decide later; it stays in the queue
            </span>
          </div>
          <button type="button" className="kit-btn" onClick={skip}>
            Skip
          </button>
        </div>
      </div>

      <p className={styles.note}>
        {statusNote(data, data.unmatchedTotal ?? 0)}
      </p>
    </div>
  );
}

/**
 * The foot note (v4 3966/4316). Three parts at last — the prototype asks for
 * `confirmed N · rejected M · K to go` and this surface could only ever say
 * two of them, because a rejection DELETED the region and left nothing to
 * count (issue #712, and queries/face-queue.ts's old header).
 *
 * The middle clause reads `reviewed`, not `rejected`, and counts rejections
 * AND dismissals together: both are "the member answered this and it is not
 * a person in your library", and splitting them into two more numerals would
 * be four clauses of arithmetic on one quiet line. It is dropped entirely
 * when it would read 0 — omit rather than pad (§14).
 */
function statusNote(data: FaceQueueData, toGo: number): string {
  const parts = [`confirmed ${data.confirmedTotal ?? 0}`];
  const answeredAway = (data.rejectedTotal ?? 0) + (data.dismissedTotal ?? 0);
  if (answeredAway > 0) parts.push(`reviewed ${answeredAway}`);
  parts.push(`${toGo} to go`);
  return parts.join(" · ");
}
