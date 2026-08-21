// The two confirms (spec §3, §6) — one component, two tones.
//
// RELEASE IS NOT DESTRUCTION. "Won't do" moves a task to the Logbook with its
// history intact, so its confirm takes the plain OUTLINED SECONDARY control.
// Only Delete takes the outlined `net` control, and `net` is outlined and never
// filled anywhere in this system.
//
// A REAL `<dialog>` OPENED WITH `showModal()`. That is what makes Escape,
// the focus trap and the inert background the platform's job rather than this
// app's; and focus goes back to the control that opened it on close, because a
// member who dismissed a question should be standing where they asked it.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { CANCEL, DELETE_CONFIRM, RELEASE_CONFIRM } from "../view-copy.ts";

import styles from "./Board.module.css";

export interface ConfirmProps {
  kind: "release" | "delete";
  onCancel: () => void;
  onConfirm: () => void;
}

export function Confirm(props: ConfirmProps): ReactNode {
  const ref = useRef<HTMLDialogElement | null>(null);
  const priorFocus = useRef<Element | null>(null);
  const { onCancel } = props;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    priorFocus.current = document.activeElement;
    // `showModal` rather than the `open` attribute: only the modal form makes
    // the rest of the page inert and gives Escape its meaning for free.
    if (!dialog.open) dialog.showModal();
    const close = (): void => onCancel();
    dialog.addEventListener("close", close);
    return () => {
      dialog.removeEventListener("close", close);
      const opener = priorFocus.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onCancel]);

  const copy = props.kind === "release" ? RELEASE_CONFIRM : DELETE_CONFIRM;
  return (
    <dialog ref={ref} className={`kit-modal ${styles.confirm}`}>
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
    </dialog>
  );
}
