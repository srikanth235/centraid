// The states every Notes route can be in (Notes spec §4), each drawn once.
//
// LOADING IS SKELETONS, NEVER A SPINNER, and the skeletons take the geometry
// of the rows they replace. Nothing here counts, badges or reddens: offline,
// stale, denied and window-end are all facts the app READ, and each says what
// it read.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";
import {
  CAPTURE_CUSTODY,
  CAPTURE_SCANNER,
  CAPTURE_WHAT,
  CONFLICT_INTACT,
  CONFLICT_KEPT,
  CONFLICT_TITLE,
  DENIED_ASK,
  DENIED_INTACT,
  DENIED_TITLE,
  EMPTY_DAY_ONE,
  ORIGIN_SEAT_ONLY,
  STALE_VERB,
  VOICE_AUDIO_READABLE,
  VOICE_NO_TRANSCRIPT_YET,
  WINDOW_END_VERB,
  staleReplica,
  windowEnd,
} from "../view-copy.ts";

import styles from "./States.module.css";

/** The boot state: blocks at the geometry of the cards they stand in for. */
export function Skeletons({ rows = 6 }: { rows?: number }): ReactNode {
  return (
    <div className={styles.skeletons} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.skeleton} />
      ))}
    </div>
  );
}

/** Day one: ONE SENTENCE and two acts, with every count blanked — a first
 *  run that quotes a zero is teaching the member to watch a number. */
export function DayOne({
  onNew,
  onCapture,
}: {
  onNew: () => void;
  onCapture?: () => void;
}): ReactNode {
  return (
    <div className={styles.panel}>
      <p className={styles.lead}>{EMPTY_DAY_ONE}</p>
      <div className={styles.acts}>
        <button type="button" className="kit-btn primary" onClick={onNew}>
          New note
        </button>
        {onCapture ? (
          <button type="button" className="kit-btn" onClick={onCapture}>
            Capture
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Day one, still landing: an import in flight, reported on a notice line
 *  rather than left to look like an empty library. */
export function ImportNotice({ landed }: { landed: number }): ReactNode {
  return (
    <p className={styles.notice}>
      <span className={styles.num}>{landed}</span> notes have landed so far
    </p>
  );
}

/** The window's own edge. A CUT LIST MUST NEVER READ AS EVERYTHING. */
export function WindowEnd({
  shown,
  total,
  onMore,
}: {
  shown: number;
  total: number;
  onMore: () => void;
}): ReactNode {
  return (
    <p className={styles.notice}>
      <span className={styles.num}>{windowEnd(shown, total)}</span>{" "}
      <button type="button" className="kit-plain-btn" onClick={onMore}>
        {WINDOW_END_VERB}
      </button>
    </p>
  );
}

/** The web seat's replica can lag behind the vault, and says when it last
 *  did not. */
export function Stale({
  at,
  onRefresh,
}: {
  at: string;
  onRefresh: () => void;
}): ReactNode {
  return (
    <p className={styles.notice}>
      <span className={styles.num}>{staleReplica(at)}</span>{" "}
      <button type="button" className="kit-plain-btn" onClick={onRefresh}>
        {STALE_VERB}
      </button>
    </p>
  );
}

/** Two devices, one passage, both bodies kept. NO FILLED BUTTON: nothing
 *  here is the thing the member is supposed to press, because nothing was
 *  lost and nothing needs choosing. */
export function Conflict({
  onOpenHistory,
}: {
  onOpenHistory: () => void;
}): ReactNode {
  return (
    <section className={styles.panel} aria-label={CONFLICT_TITLE}>
      <h2 className={styles.title}>{CONFLICT_TITLE}</h2>
      <p className={styles.body}>{CONFLICT_KEPT}</p>
      <p className={styles.body}>{CONFLICT_INTACT}</p>
      <div className={styles.acts}>
        <button type="button" className="kit-btn" onClick={onOpenHistory}>
          Version history
        </button>
      </div>
    </section>
  );
}

/** The app-level gate. A DENIAL IS A STATE WITH A RECEIPT, never an error,
 *  and it names what is untouched. */
export function Denied({ message }: { message: string }): ReactNode {
  return (
    <section className={styles.panel} aria-label={DENIED_TITLE}>
      <h2 className={styles.title}>{DENIED_TITLE}</h2>
      <p className={styles.body}>{DENIED_ASK}</p>
      <p className={styles.body}>{DENIED_INTACT}</p>
      {message ? <p className={styles.receipt}>{message}</p> : null}
      <div className={styles.acts}>
        <VaultAccessButton />
      </div>
    </section>
  );
}

/**
 * The two origin acts. Content that is BORN ON A DEVICE cannot be born on a
 * seat with no camera or microphone in the member's hand, so each route
 * exists everywhere and states what this seat can do — the alternative is a
 * hidden route that a phone member is told about by nobody.
 */
export function CaptureRoute({
  onOrigin,
}: {
  onOrigin?: () => void;
}): ReactNode {
  return (
    <section className={styles.panel} aria-label="Capture">
      <p className={styles.body}>{CAPTURE_SCANNER}</p>
      <p className={styles.body}>{CAPTURE_WHAT}</p>
      <p className={styles.receipt}>{CAPTURE_CUSTODY}</p>
      {onOrigin ? (
        <div className={styles.acts}>
          <button type="button" className="kit-btn primary" onClick={onOrigin}>
            Open the camera
          </button>
        </div>
      ) : (
        <p className={styles.receipt}>{ORIGIN_SEAT_ONLY}</p>
      )}
    </section>
  );
}

export function VoiceRoute({ onOrigin }: { onOrigin?: () => void }): ReactNode {
  return (
    <section className={styles.panel} aria-label="Voice">
      <p className={styles.body}>{VOICE_NO_TRANSCRIPT_YET}</p>
      <p className={styles.body}>{VOICE_AUDIO_READABLE}</p>
      <p className={styles.receipt}>{CAPTURE_CUSTODY}</p>
      {onOrigin ? (
        <div className={styles.acts}>
          <button type="button" className="kit-btn primary" onClick={onOrigin}>
            Record a memo
          </button>
        </div>
      ) : (
        <p className={styles.receipt}>{ORIGIN_SEAT_ONLY}</p>
      )}
    </section>
  );
}
