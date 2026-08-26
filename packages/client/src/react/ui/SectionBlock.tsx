// Section head (v9 §8, #765); single implementation.
import type { JSX } from "react";

import type { SectionActionData, SectionCopy } from "@centraid/design/blocks";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./SectionBlock.module.css";

export interface SectionAction extends SectionActionData {
  onClick: () => void;
}

export interface SectionBlockProps extends SectionCopy {
  /** Verb (#775); quiet (`commit={false}`) — app bar owns route verbs. */
  action?: SectionAction;
  /** Controlled; true ⇒ parent skips body (hidden rows stay tabbable). */
  collapsed?: boolean;
  onToggle?: () => void;
  className?: string;
}

export default function SectionBlock({
  label,
  meta,
  action,
  collapsed,
  onToggle,
  className,
}: SectionBlockProps): JSX.Element {
  return (
    <div
      className={cx(styles.section, className)}
      data-collapsed={onToggle && collapsed ? "true" : undefined}
    >
      <h2 className={styles.label}>{label}</h2>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
      {action ? (
        <Button
          className={styles.action}
          commit={false}
          disabled={action.off}
          label={action.label}
          onClick={() => action.onClick()}
          size="sm"
          title={action.hint}
          variant="quiet"
        />
      ) : null}
      {onToggle ? (
        <Button
          className={styles.toggle}
          commit={false}
          ariaExpanded={!collapsed}
          label={collapsed ? "Show" : "Hide"}
          onClick={() => onToggle()}
          size="sm"
          variant="quiet"
        />
      ) : null}
    </div>
  );
}
