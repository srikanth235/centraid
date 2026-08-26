import type { ReactNode } from "react";

import type { AppState } from "../types.ts";

import styles from "./ViewToggle.module.css";

const VIEWS: readonly { id: AppState["view"]; label: string }[] = [
  { id: "list", label: "List" },
  { id: "grid", label: "Grid" },
];

export function ViewToggle({
  view,
  onSelectView,
}: {
  view: AppState["view"];
  onSelectView: (view: AppState["view"]) => void;
}): ReactNode {
  return (
    // fieldset IS role="group" per the a11y profile; aria-pressed buttons, never radios.
    <fieldset aria-label="View" className={styles.track}>
      {VIEWS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={styles.item}
          aria-label={`${entry.label} view`}
          aria-pressed={view === entry.id}
          onClick={() => onSelectView(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </fieldset>
  );
}
