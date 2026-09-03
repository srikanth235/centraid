import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { VaultAccessButton } from "../../_shared/VaultAccessButton.tsx";
import {
  COMPARE,
  CONFLICT_NOTICE,
  DENIED_BODY,
  DENIED_SCOPE,
  DENIED_TITLE,
  OFFLINE_NOTICE,
  OFFLINE_WHY,
  PARKED_NOTICE,
  REAUTH_NOTICE,
  REFRESH,
  REVIEW_IN_TRASH,
  pendingNotice,
  staleNotice,
} from "../view-copy.ts";

import styles from "./Rows.module.css";

export interface NoticesProps {
  onDeviceWrites: number;
  offline: boolean;
  onWhyOffline: () => void;
  staleAt: string | null;
  onRefresh: () => void;
  conflict: boolean;
  onCompare: () => void;
  parked: boolean;
  onReviewParked: () => void;
  reauth: boolean;
}

function Notice({
  text,
  action,
  onAct,
}: {
  text: string;
  action?: string;
  onAct?: () => void;
}): ReactNode {
  return (
    <div className={`kit-banner notice ${styles.notice}`}>
      <span className={styles.num}>{text}</span>
      {action && onAct ? (
        <button type="button" className="kit-plain-btn" onClick={onAct}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

export function Notices(props: NoticesProps): ReactNode {
  return (
    <>
      {props.onDeviceWrites > 0 ? (
        <Notice text={pendingNotice(props.onDeviceWrites)} />
      ) : null}
      {props.offline ? (
        <Notice
          text={OFFLINE_NOTICE}
          action={OFFLINE_WHY}
          onAct={props.onWhyOffline}
        />
      ) : null}
      {props.staleAt ? (
        <Notice
          text={staleNotice(props.staleAt)}
          action={REFRESH}
          onAct={props.onRefresh}
        />
      ) : null}
      {props.conflict ? (
        <Notice
          text={CONFLICT_NOTICE}
          action={COMPARE}
          onAct={props.onCompare}
        />
      ) : null}
      {props.parked ? (
        <Notice
          text={PARKED_NOTICE}
          action={REVIEW_IN_TRASH}
          onAct={props.onReviewParked}
        />
      ) : null}
      {props.reauth ? <Notice text={REAUTH_NOTICE} /> : null}
    </>
  );
}

export interface DeniedGateProps {
  message: string;
  revokedAt?: string;
  receipt?: string;
}

export function DeniedGate(props: DeniedGateProps): ReactNode {
  const facts: Array<[string, string]> = [
    ["Scope", DENIED_SCOPE],
    ...(props.receipt
      ? ([["Receipt", props.receipt]] as Array<[string, string]>)
      : []),
    ...(props.revokedAt
      ? ([["Revoked", props.revokedAt]] as Array<[string, string]>)
      : []),
  ];
  return (
    <div className={styles.screen}>
      <p className={styles.screenTitle}>{DENIED_TITLE}</p>
      <p className={styles.screenBody}>{DENIED_BODY}</p>
      {props.message ? (
        <p className={styles.screenBody}>{displayText(props.message)}</p>
      ) : null}
      <dl className={styles.facts}>
        {facts.map(([key, value]) => (
          <div key={key} className={styles.fact}>
            <dt className={styles.factKey}>{key}</dt>
            <dd className={`${styles.factValue} ${styles.num}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.screenActs}>
        <VaultAccessButton />
      </div>
    </div>
  );
}
