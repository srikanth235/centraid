import type { JSX } from "react";

import type { AmbientSignal } from "../shell/ambientStatus.js";

import styles from "./HomeHealthRibbon.module.css";

export default function HomeHealthRibbon({
  signal,
  onOpen,
}: {
  signal: AmbientSignal;
  onOpen: (route: NonNullable<AmbientSignal["action"]>["route"]) => void;
}): JSX.Element {
  const action = signal.action;
  if (!action)
    return (
      <output
        className={styles.ribbon}
        data-testid="home-health-ribbon"
        data-tone={signal.tone}
      >
        <span className={styles.copy}>{signal.copy}</span>
      </output>
    );
  return (
    <button
      className={styles.ribbon}
      data-testid="home-health-ribbon"
      data-tone={signal.tone}
      type="button"
      onClick={() => onOpen(action.route)}
    >
      <span className={styles.copy}>{signal.copy}</span>
      <span className={styles.action}>{action.label}</span>
    </button>
  );
}
