// The confirms, and the honest stub for a route still to be drawn.
//
// The band's More sheet is NOT here: `_shared/MoreSheet.tsx` is the one docked
// sheet six apps draw (#883) — an overflow OF the band stands inside the app
// pane, not in the platform's top layer over the band it overflows.
//
// A confirm states the CONSEQUENCE, not the question twice: the spec's own
// sentence about what the act does to the ledger.
//
// Leaving and archiving a group are engineering asks (gap register §7): the
// confirm is drawn against the ask, and its commit is a plain OUTLINE carrying
// the reason. A disabled commit never takes the fill.
//
// Destructive is OUTLINED in `--net`, never filled (`kit-btn destructive`).
//
// `_shared/KitModal.tsx` owns the top layer, Escape, the focus trap and the
// inert background. No press-the-backdrop target: a scrim that dismisses is a
// control with no name and no keyboard equivalent.
import type { ReactNode } from "react";

import { KitModal } from "../../_shared/KitModal.tsx";
import { displayText } from "../../_shared/untrusted.ts";

import styles from "./Ledger.module.css";

export interface ConfirmProps {
  title: string;
  body: string;
  /** The annotation rung: the body carries the consequence, this the
   *  qualification. */
  note?: string;
  commitLabel: string;
  destructive?: boolean;
  /** Present means disabled: the reason travels with the control rather than
   *  being discovered by pressing. */
  disabledReason?: string;
  cancelLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function Confirm(props: ConfirmProps): ReactNode {
  const blocked = props.disabledReason !== undefined;
  return (
    <KitModal
      layer="top"
      className={`kit-modal ${styles.confirm}`}
      onDismiss={props.onCancel}
    >
      <h2 className={styles.confirmTitle}>{displayText(props.title)}</h2>
      <p className={styles.confirmBody}>{displayText(props.body)}</p>
      {props.note ? (
        <p className={styles.confirmNote}>{displayText(props.note)}</p>
      ) : null}
      {blocked ? (
        <p className={styles.refusal}>{props.disabledReason}</p>
      ) : null}
      <div className="kit-modal-foot">
        <button type="button" className="kit-btn" onClick={props.onCancel}>
          {props.cancelLabel}
        </button>
        <button
          type="button"
          className={
            !blocked && props.destructive ? "kit-btn destructive" : "kit-btn"
          }
          disabled={blocked}
          title={props.disabledReason}
          onClick={props.onConfirm}
        >
          {props.commitLabel}
        </button>
      </div>
    </KitModal>
  );
}

/**
 * A confirm that has FIELDS in it — minting a friend, a group, a member.
 * Deliberately the same shape as `Confirm`: same top-layer door, consequence
 * stated, commit carrying its own refusal as `disabled` with the reason on the
 * page.
 */
export function FormSheet(props: {
  title: string;
  body?: string;
  children: ReactNode;
  commitLabel: string;
  disabledReason?: string;
  cancelLabel: string;
  onCancel: () => void;
  onCommit: () => void;
}): ReactNode {
  const blocked = props.disabledReason !== undefined;
  return (
    <KitModal
      layer="top"
      className={`kit-modal ${styles.confirm}`}
      onDismiss={props.onCancel}
    >
      <h2 className={styles.confirmTitle}>{displayText(props.title)}</h2>
      {props.body ? <p className={styles.confirmBody}>{props.body}</p> : null}
      {props.children}
      {blocked ? (
        <p className={styles.refusal}>{props.disabledReason}</p>
      ) : null}
      <div className="kit-modal-foot">
        <button type="button" className="kit-btn" onClick={props.onCancel}>
          {props.cancelLabel}
        </button>
        <button
          type="button"
          className={blocked ? "kit-btn" : "kit-btn primary"}
          disabled={blocked}
          onClick={props.onCommit}
        >
          {props.commitLabel}
        </button>
      </div>
    </KitModal>
  );
}
