import type { ReactNode } from "react";

import { KitModal } from "../../_shared/KitModal.tsx";
import { displayText } from "../../_shared/untrusted.ts";

import styles from "./Ledger.module.css";

export interface ConfirmProps {
  title: string;
  body: string;
  note?: string;
  commitLabel: string;
  destructive?: boolean;
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
