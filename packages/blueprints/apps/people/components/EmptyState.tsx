// People's empty states, as one block.
//
// TWO REGISTERS, ONE COMPONENT. The first run is the whole screen — a display
// head, one sentence and one commit — because it is the only moment the app
// has nothing at all to show. Everything else (a filter with no matches, a
// section with no rows, an empty trash, a search nobody has typed into) is one
// state of a screen that normally has rows, so it takes the kit's own notice
// card at the kit's own rung.
//
// AN ACTION IS DRAWN ONLY WHERE THE APP CAN PERFORM IT. `onAction` is optional
// and the button appears only with it, so no variant offers a way forward into
// a screen that does not exist.
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
  /** One sentence. Absent on the in-screen variants, which say it in the
   *  title — a second line explaining the first is the first admitting it did
   *  not work. */
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
