import type { JSX } from "react";

import { powerPostureLine } from "./resource-summary.js";
import type { PowerContextState } from "./resource-summary.js";

import styles from "./GatewayScreen.module.css";

export interface PowerPostureNoteProps {
  power: PowerContextState;
}

export default function PowerPostureNote({
  power,
}: PowerPostureNoteProps): JSX.Element | null {
  const line = powerPostureLine(power);
  if (line === null) return null;
  return (
    <div className={styles.resourcePosture} data-testid="power-posture">
      <div className={styles.resourcePostureLine}>{line}</div>
      <div className={styles.resourcePostureAttr}>On this gateway’s host</div>
    </div>
  );
}
