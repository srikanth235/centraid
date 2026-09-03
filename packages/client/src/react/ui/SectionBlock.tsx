import type { JSX } from "react";

import type { SectionActionData, SectionCopy } from "@centraid/design/blocks";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./SectionBlock.module.css";

export interface SectionAction extends SectionActionData {
  onClick: () => void;
}

export interface SectionBlockProps extends SectionCopy {
  action?: SectionAction;
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
