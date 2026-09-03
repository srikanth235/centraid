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
  anchored: boolean;
  onTerm: (term: string) => void;
  onPick: (target: LinkTarget) => void;
  onClose: () => void;
}

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
  lines: readonly string[];
  verb: string;
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
