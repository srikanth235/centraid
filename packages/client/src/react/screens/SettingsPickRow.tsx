import type { JSX, ReactNode } from "react";

import Button from "../ui/Button.js";

import styles from "./SettingsPickRow.module.css";

export interface PickRowAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}

export interface PickRowProps {
  label: string;
  lead?: ReactNode;
  chips?: ReactNode;
  caption?: string;
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
