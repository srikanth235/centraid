// FACE REVIEW (#711, v4 §8) — self-contained: it reads `face-queue` and fires
// its own writes, so app-root only MOUNTS it.
//
// TWO RULES THIS FILE KEEPS: confidence is a MATCH COUNT, never a percentage;
// and ONE face at a time, so `current` is one entry and nothing loops.
//
// Every control is a real write (#712) except Skip, which writes nothing —
// that is what makes "it stays in the queue" true. "Someone else" picks an
// EXISTING person: no create-party action exists. The cursor/counts machine
// is `../triage-session.ts`.
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
import { photosFaceMatchedOn } from "../shared-copy.ts";

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
  /** A rejection is a state, not a deletion (#712). */
  rejectedTotal?: number;
  dismissedTotal?: number;
  people?: Array<{ party_id: string; name: string | null }>;
  denied?: boolean;
  reason?: string;
}

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
      {/* No server-cropped variant exists, so CSS scales the source photo so
          the bbox fills this box. Not a Tile: it is this proposal's
          evidence. */}
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
      {/* The source photograph, aspect 1.5. */}
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
  /** Applied ONCE, on the first loaded queue, so the member's own cursor
   *  movement is never fought (#711). */
  focusRegionId?: string;
}) {
  const [data, setData] = useState<FaceQueueData | null>(null);
  // Cursor, frozen denominator and counts in ONE immutable value.
  const [session, setSession] = useState<TriageSession<QueueEntry> | null>(
    null
  );
  // A ref, not state: flipping it must not trigger a render.
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
      // First load only: a reload must never re-jump under the member.
      let at = 0;
      if (!focusApplied.current && focusRegionId) {
        focusApplied.current = true;
        at = Math.max(
          queue.findIndex((entry) => entry.region_id === focusRegionId),
          0
        );
      }
      // The first load freezes the denominator at the whole backlog.
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

  /** The ONE write behind every answer (#712): the answer is the
   *  discriminant, so a new answer is a union member, not a new endpoint. */
  async function answer(
    kind: FaceAnswer,
    copy: {
      /** `confirm` only: the vault refuses a party on the other two. */
      partyId?: string;
      /** Blank where the queue moving on says it better. */
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
      // The row stays in the queue; a toast never substitutes for it.
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

  /** Reviewed, kept, deliberately unnamed — unlike Skip, it stays gone. */
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
        {/* Reachable (#712): the queue genuinely empties. */}
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
          {proposedName ? photosFaceMatchedOn(current.matchCount) : ""}
          A rejection is remembered, so the same face is not proposed twice.
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

/** The middle clause reads `reviewed` and counts rejections AND dismissals
 *  together; it is dropped entirely at 0 — omit rather than pad (§14). */
function statusNote(data: FaceQueueData, toGo: number): string {
  const parts = [`confirmed ${data.confirmedTotal ?? 0}`];
  const answeredAway = (data.rejectedTotal ?? 0) + (data.dismissedTotal ?? 0);
  if (answeredAway > 0) parts.push(`reviewed ${answeredAway}`);
  parts.push(`${toGo} to go`);
  return parts.join(" · ");
}
