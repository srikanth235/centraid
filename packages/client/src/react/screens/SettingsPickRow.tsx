import type { JSX, ReactNode } from "react";

import Button from "../ui/Button.js";

import styles from "./SettingsPickRow.module.css";

// One subject, N picks, maybe a verb — a ROW WITH A HAIRLINE, not a card. `first` drops the leading hairline (a rule under a head is a second head). `detail` expands inside the row so disclosure and disclosed share one hairline; a peer block below would read as the next subject.

export interface PickRowAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}

export interface PickRowProps {
  label: string;
  lead?: ReactNode;
  /** Facts the row states, not sets — a control belongs in `picks`. */
  chips?: ReactNode;
  caption?: string;
  /** `--net` tints the caption (unreachable), never the name. */
  captionNet?: boolean;
  first?: boolean;
  children?: ReactNode;
  action?: PickRowAction;
  detail?: ReactNode;
}

export default function PickRow({
  label,
  lead,
  chips,
  caption,
  captionNet,
  first,
  children,
  action,
  detail,
}: PickRowProps): JSX.Element {
  return (
    <div className={styles.shell} data-first={first ? "true" : undefined}>
      <div className={styles.row}>
        {lead}
        <div className={styles.text}>
          <span className={styles.label}>{label}</span>
          {caption ? (
            <span
              className={styles.caption}
              data-net={captionNet ? "true" : undefined}
            >
              {caption}
            </span>
          ) : null}
          {chips}
        </div>
        {children ? <div className={styles.picks}>{children}</div> : null}
        {action ? (
          <Button
            className={styles.action}
            commit={false}
            disabled={action.disabled}
            label={action.label}
            onClick={() => action.onClick()}
            size="sm"
            title={action.hint}
            variant="secondary"
          />
        ) : null}
      </div>
      {detail ? <div className={styles.detail}>{detail}</div> : null}
    </div>
  );
}
