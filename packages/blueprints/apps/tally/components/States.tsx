// Tally's honest states, as blocks (spec §4, STATES.md).
//
// EACH IS A FACT WITH A WAY FORWARD. A notice that reports a lag with no way
// to close it, or a screen that says "nothing here" without saying on whose
// terms, is the class of half-truth this file exists to close.
//
// WHY OFFLINE AND STALE ARE TWO NOTICES HERE AND ONE IN TASKS. Tasks has one
// sentence because its two facts collapse: a task board that cannot reach the
// gateway is simply lagging. Tally's do not. "The gateway is not answering" and
// "what you are reading was matched at 08:02" answer different questions, and
// Tally has a third thing to say that Tasks does not — that it RECORDS FULLY
// OFFLINE, with exactly one exception, which a member has to know before they
// decide whether to keep working. Folding that into a staleness line would
// bury the one sentence that changes what they do next.
//
// DAY ONE AND DENIED LOOK NOTHING ALIKE. Day one offers a first move; denied
// shows absence with a receipt, the scope to re-grant, and the fact that the
// other members still hold their own copies of the facts.
import { Fragment } from "react";
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { VaultAccessButton } from "../../_shared/VaultAccessButton.tsx";
import {
  ALL_SETTLED,
  CONFLICT_NOTICE,
  DAY_ONE,
  DAY_ONE_ACT,
  DAY_ONE_SUB,
  DENIED_BODY,
  DENIED_FACT_LABELS,
  DENIED_MEMBERS,
  DENIED_REGRANT,
  DENIED_SCOPE,
  DENIED_TITLE,
  OFFLINE_NOTICE,
  PARKED_NOTICE,
  VERBS,
  pendingNotice,
  staleNotice,
} from "../view-copy.ts";

import styles from "./Ledger.module.css";

export interface NoticesProps {
  /** How many of this member's writes are still on this device. */
  pendingWriteCount?: number;
  /** The gateway did not answer. Tally records anyway, and says which single
   *  act it cannot do. */
  offline?: boolean;
  /** The wall time the replica last matched the vault, or null when it is
   *  current. */
  staleAt?: string | null;
  /** A steward-only act is waiting on this member. */
  parked?: boolean;
  /** Two edits to one expense reached the replica. */
  conflict?: boolean;
  onWaiting: () => void;
  onRefresh: () => void;
}

export function Notices(props: NoticesProps): ReactNode {
  const pending = props.pendingWriteCount ?? 0;
  return (
    <>
      {pending > 0 ? (
        <div className={`kit-banner ${styles.notice}`} data-pending="true">
          <span className={styles.num}>{pendingNotice(pending)}</span>
          <button
            type="button"
            className="kit-plain-btn"
            onClick={props.onWaiting}
          >
            {VERBS.waiting}
          </button>
        </div>
      ) : null}

      {props.offline ? (
        <div className={`kit-banner ${styles.notice}`} data-offline="true">
          <span>{OFFLINE_NOTICE}</span>
          <button
            type="button"
            className="kit-plain-btn"
            onClick={props.onWaiting}
          >
            {VERBS.waiting}
          </button>
        </div>
      ) : null}

      {props.staleAt ? (
        <div className={`kit-banner ${styles.notice}`}>
          <span className={styles.num}>{staleNotice(props.staleAt)}</span>
          <button
            type="button"
            className="kit-plain-btn"
            onClick={props.onRefresh}
          >
            {VERBS.refresh}
          </button>
        </div>
      ) : null}

      {props.parked ? (
        <div className={`kit-banner ${styles.notice}`} data-parked="true">
          <span>{PARKED_NOTICE}</span>
          <button
            type="button"
            className="kit-plain-btn"
            onClick={props.onWaiting}
          >
            {VERBS.review}
          </button>
        </div>
      ) : null}

      {props.conflict ? (
        <div className={`kit-banner ${styles.notice}`} data-conflict="true">
          <span>{CONFLICT_NOTICE}</span>
          <button
            type="button"
            className="kit-plain-btn"
            onClick={props.onWaiting}
          >
            {VERBS.compare}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Day one: nothing is split yet, and the first real move is one expense with
 *  one person. Never shown until a read has landed. */
export function DayOne({ onAdd }: { onAdd: () => void }): ReactNode {
  return (
    <div className="kit-empty" data-variant="day-one">
      <div className="kit-empty-card">
        <div className="kit-empty-title">{DAY_ONE}</div>
        <div className="kit-empty-sub">{DAY_ONE_SUB}</div>
        <div className={styles.emptyActs}>
          <button type="button" className="kit-btn" onClick={onAdd}>
            {DAY_ONE_ACT}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Every balance level. STATED, not celebrated: no tick, no colour, no
 *  congratulation — and the ledger that got the member here is still there. */
export function AllSettled(): ReactNode {
  return <p className={styles.note}>{ALL_SETTLED}</p>;
}

export interface DeniedGateProps {
  /** The receipt the denial came back with, as the query reported it. */
  receipt: string;
}

export function DeniedGate({ receipt }: DeniedGateProps): ReactNode {
  const facts: readonly (readonly [string, string])[] = [
    [DENIED_FACT_LABELS.receipt, receipt],
    [DENIED_FACT_LABELS.scope, DENIED_SCOPE],
    [DENIED_FACT_LABELS.members, DENIED_MEMBERS],
  ];
  return (
    <div className={styles.gate}>
      <h2 className={styles.gateTitle}>{DENIED_TITLE}</h2>
      <p className={styles.gateBody}>{DENIED_BODY}</p>
      <p className={styles.gateBody}>{DENIED_REGRANT}</p>
      <dl className={styles.gateFacts}>
        {/* The pairs sit DIRECTLY in the grid — a wrapper element per row
            would put a box between the two columns and break the alignment
            the grid exists to give. */}
        {facts.map(([label, value]) => (
          <Fragment key={label}>
            <dt className={styles.gateFactLabel}>{label}</dt>
            <dd>{displayText(value)}</dd>
          </Fragment>
        ))}
      </dl>
      <div className={styles.gateActs}>
        <VaultAccessButton />
      </div>
    </div>
  );
}
