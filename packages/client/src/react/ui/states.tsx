// The Binding Layer's designed states (issue #708, section A), in the brief's
// own language and as reusable client components.
//
// Three of the four live here. The fourth — OFFLINE — is not a component: it
// is already reported by the one status line with its reason inline (#707), and
// its consequence for controls is `commitAvailability.tsx`. Giving offline a
// second visual home would be exactly the duplicated feedback channel the
// status line replaced.
//
// What they have in common is what makes them a set: none of them is an
// overlay, none of them is a spinner, none of them is a toast, and none of them
// takes focus. They are blocks the surface around them keeps working behind.
import type { CSSProperties, JSX } from "react";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./states.module.css";

/** Numerics are mono and tabular in every app, and grouped, because "11205"
 *  and "11,205" are not equally readable at 11.5px. */
const count = (n: number): string => n.toLocaleString();

export interface WorkingStateProps {
  /** What is happening, as a sentence. "Indexing your photos", not "Working". */
  label: string;
  /**
   * Determinate progress, always with exact counts. Omit ONLY while the total
   * is genuinely not yet known — and then the block shows skeletons and the
   * label alone, never a spinner. A spinner says "wait" without saying how
   * long, which is the one thing a local-first product always knows.
   */
  progress?: { done: number; total: number; unit?: string };
  /** Static placeholder rows for the content that has not arrived. Never a
   *  shimmer: a shimmer is attention-seeking about work we can describe. */
  skeletonRows?: number;
  className?: string;
}

/**
 * `working` — a long local operation. The surrounding app STAYS USABLE: this
 * renders inline, blocks no input, and traps no focus.
 */
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
        // The bar is decoration; the COUNTS above are the announcement, and
        // they sit inside this `aria-live` section. Same division the status
        // line makes — a reader hears "2,340 of 11,205 photos", which is
        // strictly more than a percentage a progressbar role would report.
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

/** One side of a disagreement. Both sides carry the same three facts, in the
 *  same order, in the same recipe — that is what "equal weight" means here. */
export interface DisagreeVersion {
  /** The device's NAME. "MacBook Pro", never a device id. */
  device: string;
  /** When that device last wrote it, already formatted for the reader. */
  at: string;
  /** What that version says. The reader chooses between contents, not labels. */
  body: string;
}

export interface DevicesDisagreeProps {
  /** What disagrees — "Grocery list", "Passport scan". */
  subject: string;
  /** Exactly two versions: this is a disagreement, not a merge conflict list. */
  versions: readonly [DisagreeVersion, DisagreeVersion];
  /**
   * THREE options, equal weight, NO default. Keeping both is a real answer and
   * is offered as one, and nothing here is styled destructive — the reader has
   * seen both versions above, so no choice is a leap.
   */
  choices: readonly { id: string; label: string }[];
  onChoose: (id: string) => void;
  className?: string;
}

/**
 * `two devices disagree` — show BOTH versions with device name and time, three
 * equal-weight options, no default, nothing destructive-styled.
 */
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
      {/* Same variant for all three. A primary here would BE the default the
          brief forbids — the product does not know which edit you meant. */}
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
  /** The CAUSE, stated plainly. "Your 20 GB backup store is full." */
  cause: string;
  /** The CONSEQUENCE — the line that matters. "New photos will stop syncing." */
  consequence: string;
  /** Used vs. limit, already formatted (`formatBytes`), for the numeric line. */
  usedLabel: string;
  limitLabel: string;
  /** 0–1. Above 1 the meter takes the danger role rather than overflowing. */
  fractionUsed: number;
  /** ONE action. A list of remedies is a way of not choosing one. */
  action: { label: string; run: () => void };
  className?: string;
}

/** `out of room` — cause, consequence, one action. */
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
      {/* The consequence outranks the cause typographically on purpose. */}
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
