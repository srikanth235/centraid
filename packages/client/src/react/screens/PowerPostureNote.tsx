import { type JSX } from 'react';
import styles from './GatewayScreen.module.css';
import { powerPostureLine, type PowerContextState } from './resource-summary.js';

// Power-context posture note on the Resource card (issue #528 Phase D). Battery
// and thermal chrome render ONLY when the gateway host actually has a battery;
// a mains/server host shows a server-relevant fact (CPU steal) or nothing. The
// copy is always attributed to the gateway's HOST, never the browser/phone
// viewing the screen (the remote-gateway rule). Extracted so ResourceModeCard
// stays comfortably under the 500-line cap.

export interface PowerPostureNoteProps {
  power: PowerContextState;
}

export default function PowerPostureNote({ power }: PowerPostureNoteProps): JSX.Element | null {
  const line = powerPostureLine(power);
  if (line === null) return null;
  return (
    <div className={styles.resourcePosture} data-testid="power-posture">
      <div className={styles.resourcePostureLine}>{line}</div>
      <div className={styles.resourcePostureAttr}>On this gateway’s host</div>
    </div>
  );
}
