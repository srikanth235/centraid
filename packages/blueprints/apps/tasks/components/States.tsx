// The honest states, as blocks (spec §4, §6).
//
// EACH IS A FACT WITH A WAY FORWARD. A view that says "nothing here" without
// saying on whose terms, or a notice that reports a lag with no way to close
// it, is the class of half-truth this file exists to close: every block below
// carries the sentence AND the act that answers it.
//
// The empty blocks use the shared `kit-empty` vocabulary with a `kit-btn` act,
// because Tasks' three variants differ in their sentence rather than in their
// shape — unlike Docs, which needed five distinguishable blocks and drew its
// own. A centred notice card with one line and one or two acts is exactly what
// Today's quiet, the day-one screen and an empty lens each need.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import {
  DAY_ONE,
  DAY_ONE_ACTS,
  GROUPS,
  PENDING_CHIP,
  REFRESH,
  RETRY,
  TODAY_DONE,
  TODAY_EMPTY,
  TODAY_EMPTY_SUB,
  nothingElseUntil,
  partialNotice,
  pendingStatus,
  reentryNotice,
  staleNotice,
} from "../view-copy.ts";

import styles from "./Board.module.css";

export type EmptyVariant =
  | "day-one"
  | "all-done"
  | "nothing-scheduled"
  | "lens";

export interface EmptyStateProps {
  variant: EmptyVariant;
  /** The day the next thing is due, for the all-done sentence. Absent when
   *  nothing else is due at all, and then the sub-line is simply withheld
   *  rather than invented. */
  nextDay?: string | null;
  /** This lens' own sentence, for the `lens` variant — a shelf is empty on its
   *  own terms, never on Today's. */
  lensLine?: string;
  onQuickAdd?: () => void;
  onNewProject?: () => void;
  onCatchUp?: () => void;
}

export function EmptyState(props: EmptyStateProps): ReactNode {
  const { variant } = props;
  const title =
    variant === "day-one"
      ? DAY_ONE
      : variant === "all-done"
        ? TODAY_DONE
        : variant === "nothing-scheduled"
          ? TODAY_EMPTY
          : displayText(props.lensLine ?? "");
  const sub =
    variant === "all-done" && props.nextDay
      ? nothingElseUntil(props.nextDay)
      : variant === "nothing-scheduled"
        ? TODAY_EMPTY_SUB
        : null;
  return (
    <div className="kit-empty" data-variant={variant}>
      <div className="kit-empty-card">
        <div className="kit-empty-title">{title}</div>
        {sub ? <div className="kit-empty-sub">{sub}</div> : null}
        <div className={styles.emptyActs}>
          {props.onQuickAdd ? (
            <button
              type="button"
              className="kit-btn"
              onClick={props.onQuickAdd}
            >
              {DAY_ONE_ACTS[0]}
            </button>
          ) : null}
          {variant === "day-one" && props.onNewProject ? (
            <button
              type="button"
              className="kit-btn"
              onClick={props.onNewProject}
            >
              {DAY_ONE_ACTS[1]}
            </button>
          ) : null}
          {variant !== "day-one" && props.onCatchUp ? (
            <button type="button" className="kit-btn" onClick={props.onCatchUp}>
              {GROUPS.catchUp}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface NoticesProps {
  /** The absence the board can see, or null when there was none. */
  absence: { days: number; due: number } | null;
  onCatchUp: () => void;
  /** The replica last matched the vault at this wall time — the WEB seat's
   *  lag, stated rather than hidden. */
  staleAt?: string | null;
  onRefresh?: () => void;
  /** A vault that did not answer: the notice names the slice that is missing,
   *  and the board below it is honestly partial rather than pretending whole. */
  partial?: { vault: string; own: number } | null;
  onRetry?: () => void;
  /** How many writes are still on this device. */
  pendingWrites?: number;
}

export function Notices(props: NoticesProps): ReactNode {
  const pending = props.pendingWrites ?? 0;
  return (
    <>
      {props.absence ? (
        <div className={`kit-banner ${styles.notice}`}>
          <span className={styles.num}>
            {reentryNotice(props.absence.days, props.absence.due)}
          </span>
          <button
            type="button"
            className="kit-plain-btn"
            onClick={props.onCatchUp}
          >
            {GROUPS.catchUp}
          </button>
        </div>
      ) : null}

      {props.staleAt ? (
        <div className={`kit-banner ${styles.notice}`}>
          <span className={styles.num}>{staleNotice(props.staleAt)}</span>
          {props.onRefresh ? (
            <button
              type="button"
              className="kit-plain-btn"
              onClick={props.onRefresh}
            >
              {REFRESH}
            </button>
          ) : null}
        </div>
      ) : null}

      {props.partial ? (
        <div className={`kit-banner ${styles.notice}`}>
          <span className={styles.num}>
            {partialNotice(displayText(props.partial.vault), props.partial.own)}
          </span>
          {props.onRetry ? (
            <button
              type="button"
              className="kit-plain-btn"
              onClick={props.onRetry}
            >
              {RETRY}
            </button>
          ) : null}
        </div>
      ) : null}

      {pending > 0 ? (
        <div className={`kit-banner ${styles.notice}`} data-pending="true">
          <span className={styles.num}>{pendingStatus(pending)}</span>
          <span className="kit-pending-chip">{PENDING_CHIP}</span>
        </div>
      ) : null}
    </>
  );
}
