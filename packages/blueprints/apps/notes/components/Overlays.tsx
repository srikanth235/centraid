// The two things that stand OVER a Notes route: the `[[` powerbox and the
// confirms (Notes spec §5, §7). The band's overflow sheet is the ONE shared
// `_shared/MoreSheet.tsx` (#883 B9).
//
// Both are the kit modal's TOP layer, which is `showModal()`: the platform
// owns the focus trap, Escape and the inert background, and the kit hands
// focus back. A hand-rolled overlay gets one of those right and the member
// finds out about the others with a keyboard.
import type { ReactNode } from "react";

import { KitModal } from "../../_shared/KitModal.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { groupTargets } from "../powerbox.ts";
import type { LinkTarget } from "../types.ts";
import { POWERBOX_FOOT } from "../view-copy.ts";

import styles from "./Overlays.module.css";

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
 * One ranked list across seven kinds, the kind its own column. Panel under a
 * pointer, bottom sheet on touch — the stylesheet's decision, not a second
 * component.
 */
export function Powerbox(props: PowerboxProps): ReactNode {
  const groups = groupTargets(props.targets);
  return (
    <KitModal
      layer="top"
      open={props.open}
      className={styles.powerbox}
      label="Link to something in your vault"
      onDismiss={props.onClose}
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
    </KitModal>
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
  return (
    <KitModal
      layer="top"
      open={props.open}
      className={styles.confirm}
      label={props.title}
      onDismiss={props.onClose}
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
    </KitModal>
  );
}
