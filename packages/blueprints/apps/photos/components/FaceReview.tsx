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
// WHAT IS AND ISN'T WIRED TO A REAL WRITE (see queries/face-queue.ts's own
// header for the schema-level reasons):
//   * Confirm / Not this person: real writes (confirm-face / reject-face).
//   * Someone else → an inline picker over people ALREADY confirmed
//     elsewhere in this vault (reusing confirm-face with that party_id) —
//     the prototype's "name this face yourself" implies minting a BRAND NEW
//     person, and there is no action-plane command to create one
//     (app.json has no create-party action). Picking an existing person is
//     the honest subset of "Someone else" this app can actually do today.
//   * Unknown person / Keep unnamed: there is no command to confirm a region
//     as "reviewed, deliberately left unnamed" — confirm-face requires a
//     party_id and reject-face DELETES the row (queries/face-queue.ts's
//     header). Clicking it says so instead of pretending to write.
//   * Skip: genuinely local — nothing is written, so "it stays in the
//     queue" (4315) is exactly true, not just a promise.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { faceCropStyle } from "../face-crop.ts";
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
  people?: Array<{ party_id: string; name: string | null }>;
  denied?: boolean;
  reason?: string;
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
  const [cursor, setCursor] = useState(0);
  // A ref, not state: applying the focus is a one-shot side effect of a
  // successful load, not something a render needs to react to itself — so
  // flipping it must not itself trigger another render (the pattern the
  // effect-based version of this hit react-compiler's
  // "no synchronous setState in an effect" rule on).
  const focusApplied = useRef(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  // Frozen at first load so the numerator counts UP as the member works
  // (v4 4306 "1 of 54 unmatched") instead of the denominator sliding around
  // as other proposals arrive mid-session.
  const [sessionStartTotal, setSessionStartTotal] = useState<number | null>(
    null
  );
  const [actedCount, setActedCount] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.centraid.read<FaceQueueData>({
        query: "face-queue",
      });
      setData(result ?? {});
      setSessionStartTotal((prev) => prev ?? result?.unmatchedTotal ?? 0);
      // Land on the requested proposal exactly once (issue #711 review's
      // People-shelf routing) — found or not, this only ever fires on the
      // FIRST load: a region confirmed/rejected elsewhere before this loads
      // (and so already missing from the queue) leaves the member on
      // whatever the queue's own order lands on, not stuck retrying a jump
      // that can never succeed, and a later reload (after Confirm/Skip)
      // never re-jumps out from under the member's own navigation.
      if (!focusApplied.current && focusRegionId) {
        focusApplied.current = true;
        const index = (result?.queue ?? []).findIndex(
          (entry) => entry.region_id === focusRegionId
        );
        setCursor(Math.max(index, 0));
      } else {
        setCursor(0);
      }
    } catch {
      setData({ queue: [], unmatchedTotal: 0, confirmedTotal: 0 });
    }
  }, [focusRegionId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const queue = data?.queue ?? [];
  const current = queue[cursor % Math.max(queue.length, 1)];

  const people = useMemo(() => data?.people ?? [], [data]);

  async function confirm(partyId: string, name: string | null): Promise<void> {
    if (!current) return;
    setBusy(true);
    const outcome = await act("confirm-face", {
      region_id: current.region_id,
      party_id: partyId,
    });
    setBusy(false);
    if (narrate(outcome)) {
      setNote(name ? `Confirmed as ${name}.` : "Confirmed.");
      setActedCount((n) => n + 1);
      setPickerOpen(false);
      await load();
    } else {
      setNote("Could not confirm that face.");
    }
  }

  async function reject(): Promise<void> {
    if (!current) return;
    setBusy(true);
    const outcome = await act("reject-face", {
      region_id: current.region_id,
    });
    setBusy(false);
    if (narrate(outcome)) {
      setNote("");
      setActedCount((n) => n + 1);
      await load();
    } else {
      setNote("Could not reject that face.");
    }
  }

  function skip(): void {
    if (queue.length === 0) return;
    setNote("");
    setCursor((c) => (c + 1) % queue.length);
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

  if (!current) {
    return (
      <div className={styles.screen}>
        <div className={styles.head}>
          <h2 className={styles.heading}>Face review</h2>
        </div>
        <p className={styles.body}>No faces need review right now.</p>
        <p className={styles.note}>
          confirmed {data.confirmedTotal ?? 0} · 0 to go
        </p>
      </div>
    );
  }

  const total = sessionStartTotal ?? data.unmatchedTotal ?? 1;
  const position = Math.min(actedCount + 1, Math.max(total, 1));
  const firstSeen = formatFirstSeen(current.firstSeenAt);
  const proposedName = current.person_name;

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
              disabled={busy}
              onClick={() => void confirm(current.party_id!, proposedName)}
            >
              Confirm as {proposedName}
            </button>
          ) : null}
          <button
            type="button"
            className="kit-btn"
            disabled={busy}
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
          </div>
          <button
            type="button"
            className="kit-btn"
            disabled={busy || people.length === 0}
            title={
              people.length === 0
                ? "No one else is named in your library yet"
                : undefined
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
                  disabled={busy}
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
            disabled={busy}
            onClick={() =>
              setNote(
                "Keeping a face unnamed isn't wired up yet — there's no command for it. Skip for now."
              )
            }
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
        confirmed {data.confirmedTotal ?? 0} · {data.unmatchedTotal ?? 0} to go
      </p>
    </div>
  );
}
