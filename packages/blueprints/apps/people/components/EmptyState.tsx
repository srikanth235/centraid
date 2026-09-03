import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";

import styles from "./EmptyState.module.css";

export function EmptyState({
  title,
  body,
  action,
  onAction,
  variant = "line",
}: {
  title: string;
  body?: string;
  action?: string;
  onAction?: () => void;
  variant?: "line" | "first-run";
}): ReactNode {
  const cta =
    action && onAction ? (
      <button type="button" className="kit-btn primary" onClick={onAction}>
        {action}
      </button>
    ) : null;

  if (variant === "first-run") {
    return (
      <div className={styles.firstRun}>
        <h2 className={styles.title}>{displayText(title)}</h2>
        {body ? <p className={styles.body}>{displayText(body)}</p> : null}
        {cta ? <div className={styles.actions}>{cta}</div> : null}
      </div>
    );
  }

  return (
    <div className="kit-empty">
      <div className="kit-empty-title">{displayText(title)}</div>
      {body ? <div className="kit-empty-sub">{displayText(body)}</div> : null}
      {cta ? <div className="kit-empty-sub">{cta}</div> : null}
    </div>
  );
}
