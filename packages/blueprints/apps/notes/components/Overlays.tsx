// The three things that stand OVER a Notes route: the `[[` powerbox, the
// confirms, and the compact band's overflow sheet (Notes spec §1, §5, §7).
//
// Both modals are real `<dialog>` elements opened with `showModal()`, so the
// platform owns the focus trap, the Escape key and the return of focus to
// whatever opened them — a hand-rolled overlay gets one of those three right
// and the member finds out about the other two with a keyboard.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { displayText } from "../_shared/untrusted.ts";
import { groupTargets } from "../powerbox.ts";
import { MORE_SHELVES } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { LinkTarget } from "../types.ts";
import { POWERBOX_FOOT, shelfCopy } from "../view-copy.ts";

import styles from "./Overlays.module.css";

/** Open and close a `<dialog>` in step with a prop, and never leave one open
 *  behind a route change. */
function useModal(open: boolean): React.RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

export interface PowerboxProps {
  open: boolean;
  term: string;
  targets: readonly LinkTarget[];
  /** The passage the link will carry, when the member had one selected. */
  anchored: boolean;
  onTerm: (term: string) => void;
  onPick: (target: LinkTarget) => void;
  onClose: () => void;
}

/**
 * The powerbox: one ranked list across seven kinds, with the kind as its own
 * column. A 620px panel under a pointer; the same list as a bottom sheet on
 * touch, which is the stylesheet's decision and not a second component.
 */
export function Powerbox(props: PowerboxProps): ReactNode {
  const ref = useModal(props.open);
  const groups = groupTargets(props.targets);
  return (
    <dialog
      ref={ref}
      className={styles.powerbox}
      aria-label="Link to something in your vault"
      onClose={props.onClose}
      onCancel={props.onClose}
    >
      <div className={styles.sigil}>
        <span aria-hidden="true">[[</span>
        <input
          className={styles.probe}
          aria-label="Search for a link target"
          value={props.term}
          autoFocus
          onChange={(event) => props.onTerm(event.target.value)}
        />
        <span className={styles.legend}>Esc</span>
      </div>
      {props.anchored ? (
        <p className={styles.annot}>the selected passage travels with it</p>
      ) : null}
      <div className={styles.results}>
        {groups.map((group) => (
          <div key={group.app} className={styles.group}>
            {group.targets.map((target) => (
              <button
                key={`${target.type}/${target.id}`}
                type="button"
                className={`kit-plain-btn ${styles.result}`}
                onClick={() => props.onPick(target)}
              >
                <span className={styles.kind}>{group.app}</span>
                <span className={styles.resultTitle}>
                  {displayText(target.title)}
                </span>
                <span className={styles.annot}>
                  {displayText(target.subtitle ?? "")}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {/* The locker's absence is a SENTENCE, not a hole to be noticed. */}
      <p className={styles.foot}>{POWERBOX_FOOT}</p>
    </dialog>
  );
}

export interface ConfirmProps {
  open: boolean;
  title: string;
  /** One line per sentence: the confirms are the only place this app is
   *  allowed to reassure, and each half is its own literal. */
  lines: readonly string[];
  verb: string;
  /** Destructive verbs are OUTLINED in `--net`, never filled. */
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function Confirm(props: ConfirmProps): ReactNode {
  const ref = useModal(props.open);
  return (
    <dialog
      ref={ref}
      className={styles.confirm}
      aria-label={props.title}
      onClose={props.onClose}
      onCancel={props.onClose}
    >
      <h2 className={styles.confirmTitle}>{props.title}</h2>
      {props.lines.map((line) => (
        <p key={line} className={styles.confirmBody}>
          {line}
        </p>
      ))}
      <div className={styles.confirmActs}>
        <button type="button" className="kit-btn" onClick={props.onClose}>
          Keep it
        </button>
        <button
          type="button"
          className={`kit-btn ${props.destructive ? styles.destructive : ""}`}
          onClick={props.onConfirm}
        >
          {props.verb}
        </button>
      </div>
    </dialog>
  );
}

export interface MoreSheetProps {
  shelf: ShelfId;
  onSelect: (shelf: ShelfId) => void;
  onClose: () => void;
}

/** The band's sixth slot. Only a PLACE is in the band; Capture, Voice, Tags,
 *  Trash and Version history are acts, so they live here. */
export function MoreSheet(props: MoreSheetProps): ReactNode {
  return (
    <div className={styles.sheet} role="dialog" aria-label="More in Notes">
      {MORE_SHELVES.map((shelf) => (
        <button
          key={String(shelf)}
          type="button"
          className={`kit-plain-btn ${styles.sheetRow}`}
          aria-current={props.shelf === shelf ? "page" : undefined}
          onClick={() => {
            props.onSelect(shelf);
            props.onClose();
          }}
        >
          {shelfCopy(shelf).title}
        </button>
      ))}
      <button type="button" className="kit-btn" onClick={props.onClose}>
        Close
      </button>
    </div>
  );
}
