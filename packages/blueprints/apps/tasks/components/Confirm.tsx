import type { ReactNode } from "react";

import { KitModal } from "../../_shared/KitModal.tsx";
import { CANCEL, DELETE_CONFIRM, RELEASE_CONFIRM } from "../view-copy.ts";

import styles from "./Board.module.css";

export interface ConfirmProps {
  kind: "release" | "delete";
  onCancel: () => void;
  onConfirm: () => void;
}

export function Confirm(props: ConfirmProps): ReactNode {
  const copy = props.kind === "release" ? RELEASE_CONFIRM : DELETE_CONFIRM;
  return (
    <KitModal
      layer="top"
      className={`kit-modal ${styles.confirm}`}
      onDismiss={props.onCancel}
    >
      <h2 className={styles.confirmTitle}>{copy.title}</h2>
      <p className={styles.confirmBody}>{copy.bodyA}</p>
      <p className={styles.confirmBody}>{copy.bodyB}</p>
      <div className="kit-modal-foot">
        <button type="button" className="kit-btn" onClick={props.onCancel}>
          {CANCEL}
        </button>
        <button
          type="button"
          className="kit-btn"
          data-net={props.kind === "delete" ? "true" : undefined}
          onClick={props.onConfirm}
        >
          {copy.verb}
        </button>
      </div>
    </KitModal>
  );
}
