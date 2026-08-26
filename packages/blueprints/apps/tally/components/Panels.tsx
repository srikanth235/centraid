// The confirms, the band's More sheet, and the honest stub a route Wave 2 has
// still to draw.
//
// A CONFIRM STATES THE CONSEQUENCE, NOT THE QUESTION TWICE. Each of the ones
// below carries the spec's own sentence about what the act does to the ledger
// — rows kept as departed, an archive that is not a deletion, a member the
// arithmetic will not let go.
//
// TWO OF THEM CANNOT FIRE YET, AND SAY SO ON THE COMMIT. Leaving and archiving
// a group are engineering asks (gap register §7): the confirm is drawn against
// the ask so a reviewer can read the consequence the backend will have to
// honour, and its commit is a plain OUTLINE carrying the reason rather than a
// filled button that would do nothing. A disabled commit never takes the fill.
//
// DESTRUCTIVE IS OUTLINED IN `--net`, never filled — the `kit-btn destructive`
// recipe is exactly that.
//
// A REAL `<dialog>` OPENED WITH `showModal()`, the same door Tasks' confirm
// uses. That is what makes Escape, the focus trap and the inert background the
// platform's job rather than this app's — and it is why there is no
// press-the-backdrop target here: a scrim that dismisses is a control with no
// name and no keyboard equivalent.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { MORE_FOOT, MORE_TITLE } from "../view-copy.ts";

import styles from "./Ledger.module.css";

/** Open a dialog modally for the life of the component, and hand focus back to
 *  whatever opened it — a member who dismissed a question should be standing
 *  where they asked it. */
function useModal(onClose: () => void): (el: HTMLDialogElement | null) => void {
  const ref = useRef<HTMLDialogElement | null>(null);
  const priorFocus = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    priorFocus.current = document.activeElement;
    // `showModal` rather than the `open` attribute: only the modal form makes
    // the rest of the page inert and gives Escape its meaning for free.
    if (!dialog.open) dialog.showModal();
    const close = (): void => onClose();
    dialog.addEventListener("close", close);
    return () => {
      dialog.removeEventListener("close", close);
      const opener = priorFocus.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);

  return (el: HTMLDialogElement | null) => {
    ref.current = el;
  };
}

export interface ConfirmProps {
  title: string;
  body: string;
  /** The commit's own word — `Leave`, `Archive`, `Remove`. */
  commitLabel: string;
  /** Does the commit take the destructive outline? */
  destructive?: boolean;
  /** Why the commit cannot fire, when it cannot. Present means disabled, and
   *  the reason travels with the control rather than being discovered by
   *  pressing it. */
  disabledReason?: string;
  cancelLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function Confirm(props: ConfirmProps): ReactNode {
  const setDialog = useModal(props.onCancel);
  const blocked = props.disabledReason !== undefined;
  return (
    <dialog ref={setDialog} className={`kit-modal ${styles.confirm}`}>
      <h2 className={styles.confirmTitle}>{displayText(props.title)}</h2>
      <p className={styles.confirmBody}>{displayText(props.body)}</p>
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
    </dialog>
  );
}

/**
 * A confirm that has FIELDS in it — minting a friend, a group, a member.
 *
 * The same `<dialog>` + `showModal()` door as the confirm above, for the same
 * reasons, and deliberately the same shape: a member who has learnt that a
 * question in this product is a card with the consequence stated and two
 * controls at its foot should not have to learn a second thing when the
 * question happens to need a name typed into it.
 *
 * The commit carries its own refusal, exactly as `Confirm` does: `disabled`
 * with the reason on the page rather than discovered by pressing.
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
  const setDialog = useModal(props.onCancel);
  const blocked = props.disabledReason !== undefined;
  return (
    <dialog ref={setDialog} className={`kit-modal ${styles.confirm}`}>
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
    </dialog>
  );
}

export interface MoreRow {
  id: string;
  name: string;
  meta: string;
  open: () => void;
}

/** The band's sixth slot: the lenses and acts that are not places. */
export function MoreSheet({
  rows,
  closeLabel,
  onClose,
}: {
  rows: readonly MoreRow[];
  closeLabel: string;
  onClose: () => void;
}): ReactNode {
  const setDialog = useModal(onClose);
  return (
    <dialog ref={setDialog} className={`kit-modal ${styles.sheet}`}>
      <div className={styles.sheetHead}>{MORE_TITLE}</div>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={styles.sheetRow}
          onClick={() => row.open()}
        >
          <span className={styles.sheetName}>{row.name}</span>
          <span className={styles.sheetMeta}>{row.meta}</span>
        </button>
      ))}
      <p className={styles.sheetFoot}>{MORE_FOOT}</p>
      <div className="kit-modal-foot">
        <button type="button" className="kit-btn" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
    </dialog>
  );
}
