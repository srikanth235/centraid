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
  REVOKED_UNKNOWN,
  VERBS,
  pendingNotice,
  revokedAt,
  staleNotice,
} from "../view-copy.ts";

import styles from "./Ledger.module.css";

export interface NoticesProps {
  pendingWriteCount?: number;
  offline?: boolean;
  staleAt?: string | null;
  parked?: boolean;
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

export function AllSettled(): ReactNode {
  return <p className={styles.note}>{ALL_SETTLED}</p>;
}

export interface DeniedGateProps {
  receipt: string;
  revokedAt?: string | null;
}

export function DeniedGate({
  receipt,
  revokedAt: at,
}: DeniedGateProps): ReactNode {
  const facts: readonly (readonly [string, string])[] = [
    [DENIED_FACT_LABELS.receipt, receipt],
    [DENIED_FACT_LABELS.scope, DENIED_SCOPE],
    [DENIED_FACT_LABELS.members, DENIED_MEMBERS],
  ];
  return (
    <div className={styles.gate}>
      <h2 className={styles.gateTitle}>{DENIED_TITLE}</h2>
      <p className={styles.gateBody}>{at ? revokedAt(at) : REVOKED_UNKNOWN}</p>
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
