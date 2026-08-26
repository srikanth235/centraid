// THE RAIL TOGGLE — the only desk-side way to open details; `aria-pressed`
// makes it a toggle, never a verb. Hidden when compact or selecting
// (`!mob && !sel`): no width beside the set, slot belongs to selection bar.
import type { ReactNode } from "react";

import { I } from "../icons.ts";
import { Icon } from "./Shared.tsx";

import styles from "./InfoToggle.module.css";

export function InfoToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={styles.info}
      // One name for one surface.
      aria-label="Details"
      aria-pressed={on}
      onClick={onToggle}
    >
      <Icon svg={I.info!} />
    </button>
  );
}
