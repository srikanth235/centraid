// THE HONEST STATES, AS BLOCKS (README-Locker §4, STATES.md's Locker matrix).
//
// EACH IS A FACT WITH A WAY FORWARD, and in this app each also says what still
// works. "Offline" in Locker is not a smaller Locker: stars, tags, trash and
// restore all work, and only a SECRET write needs the gateway — so the notice
// names the boundary rather than apologising for it.
//
// DENIED IS NOT DAY ONE, AND NEITHER IS REFUSED. A revoked grant is a receipt,
// a scope and the fact that nothing was deleted; day one is an offer. They are
// two blocks here because conflating them was how an app that had been
// switched off came to look like an app with nothing in it.
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
  /** How many METADATA writes are still on this device. A secret write is
   *  never among them — that is the sentence, not a caveat. */
  onDeviceWrites: number;
  /** The gateway is out of reach. Read from the host's own verdict
   *  (`_shared/view-state-kit.ts`), never from `navigator.onLine`. */
  offline: boolean;
  onWhyOffline: () => void;
  /** The replica last matched the vault at this wall time. */
  staleAt: string | null;
  onRefresh: () => void;
  /** This item was edited in two places. The values are compared unshown. */
  conflict: boolean;
  onCompare: () => void;
  /** A purge asked for on a device that is not the owner's. */
  parked: boolean;
  onReviewParked: () => void;
  /** The permit ran out with nothing revealed — stated, so a member who looks
   *  back at a concealed field knows why it concealed. */
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
  /** The vault's own message. Rendered as it arrived, never re-worded. */
  message: string;
  /** When the grant was revoked, if the vault said. */
  revokedAt?: string;
  /** The receipt this refusal wrote, if the vault named it. */
  receipt?: string;
}

/**
 * THE DENIED GATE. A receipt, a scope, and the one fact a member actually
 * wants: nothing was deleted. The recovery act is the shared
 * `VaultAccessButton` — a denied read always offers a direct way to the grant,
 * never a dead end.
 */
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
