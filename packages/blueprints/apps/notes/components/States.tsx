import type { ReactNode } from "react";

import { VaultAccessButton } from "../../_shared/VaultAccessButton.tsx";
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

export function Skeletons({ rows = 6 }: { rows?: number }): ReactNode {
  return (
    <div className={styles.skeletons} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.skeleton} />
      ))}
    </div>
  );
}

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

export function ImportNotice({ landed }: { landed: number }): ReactNode {
  return (
    <p className={styles.notice}>
      <span className={styles.num}>{landed}</span> notes have landed so far
    </p>
  );
}

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
