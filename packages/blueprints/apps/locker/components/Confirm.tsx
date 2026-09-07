// THE ONE CONFIRM (README-Locker §6). Not a gate over a secret — those are
// gone with the permit (#996, W6-D2) — but the plain "are you sure" a
// consequence deserves: an export that writes plaintext to a file, a purge
// that cannot be undone. It names the consequence and offers the way out.
import type { ReactNode } from "react";

import { KitModal } from "../../_shared/KitModal.tsx";
import { CONFIRM_CANCEL } from "../view-copy.ts";

import styles from "./Rows.module.css";

export interface ConfirmProps {
  title: string;
  body: string;
  /** The commit's word — `Trash`, `Ask the owner`. */
  label: string;
  /** Destructive is OUTLINED in `--net`, never filled. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The one confirm this wave draws: the trash, and the purge that parks. Same
 *  overlay geometry as the gate, because they interrupt for the same reason. */
export function Confirm(props: ConfirmProps): ReactNode {
  return (
    <div className={styles.overlay}>
      <KitModal layer="inline" className={styles.panel} label={props.title}>
        <p className={styles.panelTitle}>{props.title}</p>
        <p className={styles.panelBody}>{props.body}</p>
        <div className={styles.panelActs}>
          <button
            type="button"
            className="kit-btn quiet"
            onClick={props.onCancel}
          >
            {CONFIRM_CANCEL}
          </button>
          <button
            type="button"
            className="kit-btn"
            {...(props.destructive ? { "data-net": "true" } : {})}
            onClick={props.onConfirm}
          >
            {props.label}
          </button>
        </div>
      </KitModal>
    </div>
  );
}
