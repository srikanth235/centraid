// Binding Layer states (#708 A). Offline is NOT a component — the status line
// (#707) and `commitAvailability` already own it. No overlay, spinner, toast,
// or focus trap.
import type { CSSProperties, JSX } from "react";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./states.module.css";

const count = (n: number): string => n.toLocaleString();

export interface WorkingStateProps {
  label: string;
  /** Omit ONLY while total is unknown — then skeletons, never a spinner. */
  progress?: { done: number; total: number; unit?: string };
  /** Never a shimmer. */
  skeletonRows?: number;
  className?: string;
}

export function WorkingState({
  label,
  progress,
  skeletonRows = 0,
  className,
}: WorkingStateProps): JSX.Element {
  const ratio =
    progress && progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <section
      className={cx(styles.working, className)}
      aria-live="polite"
      aria-busy="true"
    >
      <div className={styles.workingHead}>
        <span className={styles.workingLabel}>{label}</span>
        {progress ? (
          <span className={styles.workingCounts}>
            {count(progress.done)} of {count(progress.total)}
            {progress.unit ? ` ${progress.unit}` : ""}
          </span>
        ) : null}
      </div>
      {progress ? (
        // Bar is decoration; COUNTS are the announcement (`aria-live`).
        <div className={styles.workingTrack} aria-hidden="true">
          <div
            className={styles.workingFill}
            style={{ "--working-progress": ratio } as CSSProperties}
          />
        </div>
      ) : null}
      {skeletonRows > 0 ? (
        <div className={styles.skeletons} aria-hidden="true">
          {Array.from({ length: skeletonRows }, (_, row) => (
            <div className={styles.skeleton} key={row} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export interface DisagreeVersion {
  /** Device NAME. "MacBook Pro", never a device id. */
  device: string;
  at: string;
  body: string;
}

export interface DevicesDisagreeProps {
  subject: string;
  versions: readonly [DisagreeVersion, DisagreeVersion];
  /** Three equal-weight options, no default, nothing destructive. */
  choices: readonly { id: string; label: string }[];
  onChoose: (id: string) => void;
  className?: string;
}

export function DevicesDisagree({
  subject,
  versions,
  choices,
  onChoose,
  className,
}: DevicesDisagreeProps): JSX.Element {
  return (
    <section
      className={cx(styles.disagree, className)}
      aria-labelledby="disagree-title"
    >
      <div>
        <h2 className={styles.disagreeTitle} id="disagree-title">
          Two devices changed “{subject}”
        </h2>
        <p className={styles.disagreeSub}>
          Pick which one this vault should carry.
        </p>
      </div>
      <div className={styles.versions}>
        {versions.map((version) => (
          <article className={styles.version} key={version.device}>
            <div className={styles.versionHead}>
              <span className={styles.versionDevice}>{version.device}</span>
              <span className={styles.versionAt}>{version.at}</span>
            </div>
            <p className={styles.versionBody}>{version.body}</p>
          </article>
        ))}
      </div>
      {/* Same variant for all three. A primary would BE the default the brief forbids. */}
      <div className={styles.choices}>
        {choices.map((choice) => (
          <Button
            key={choice.id}
            label={choice.label}
            variant="secondary"
            onClick={() => onChoose(choice.id)}
          />
        ))}
      </div>
    </section>
  );
}

export interface OutOfRoomProps {
  cause: string;
  consequence: string;
  usedLabel: string;
  limitLabel: string;
  /** 0–1. Above 1 the meter takes the danger role rather than overflowing. */
  fractionUsed: number;
  /** One action. A list of remedies is a way of not choosing one. */
  action: { label: string; run: () => void };
  className?: string;
}

export function OutOfRoom({
  cause,
  consequence,
  usedLabel,
  limitLabel,
  fractionUsed,
  action,
  className,
}: OutOfRoomProps): JSX.Element {
  const over = fractionUsed >= 1;
  return (
    <section
      className={cx(styles.outOfRoom, className)}
      aria-labelledby="out-of-room-consequence"
    >
      <p className={styles.outOfRoomCause}>{cause}</p>
      {/* Consequence outranks cause typographically on purpose. */}
      <p className={styles.outOfRoomConsequence} id="out-of-room-consequence">
        {consequence}
      </p>
      <div className={styles.outOfRoomMeter} aria-hidden="true">
        <div
          className={styles.outOfRoomFill}
          data-over={over ? "true" : undefined}
          style={
            {
              "--room-used": Math.min(1, Math.max(0, fractionUsed)),
            } as CSSProperties
          }
        />
      </div>
      <span className={styles.outOfRoomFigures}>
        {usedLabel} of {limitLabel}
      </span>
      <Button
        className={styles.outOfRoomAction}
        label={action.label}
        variant="secondary"
        onClick={() => action.run()}
      />
    </section>
  );
}
