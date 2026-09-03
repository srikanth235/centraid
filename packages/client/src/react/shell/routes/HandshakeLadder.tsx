import type { CSSProperties, JSX } from "react";

import Icon from "../../ui/Icon.js";
import type {
  ConnectivityReport,
  ConnectivityStage,
} from "./connectFlow-core.js";

import styles from "./HandshakeLadder.module.css";

export interface HandshakeLadderProps {
  stages: readonly ConnectivityStage[];
  pending?: boolean;
}

function stageIcon(status: ConnectivityStage["status"]): JSX.Element {
  if (status === "pass")
    return <Icon name="Check" size={13} strokeWidth={2.4} />;
  if (status === "fail")
    return <Icon name="AlertCircle" size={13} strokeWidth={2} />;
  return <Icon name="Loader" size={12} strokeWidth={2.2} />;
}

export default function HandshakeLadder({
  stages,
  pending,
}: HandshakeLadderProps): JSX.Element {
  return (
    <ol className={styles.ladder} aria-live="polite">
      {stages.map((stage, i) => (
        <li
          key={stage.id}
          className={styles.stage}
          data-status={stage.status}
          style={{ "--stage-i": i } as CSSProperties}
        >
          <span className={styles.dot} data-status={stage.status}>
            {stage.status === "skip" ? null : stageIcon(stage.status)}
          </span>
          <span className={styles.text}>
            <span className={styles.label}>{stage.label}</span>
            {stage.detail ? (
              <span className={styles.detail}>{stage.detail}</span>
            ) : null}
          </span>
        </li>
      ))}
      {pending ? (
        <li
          className={styles.stage}
          data-status="pending"
          style={{ "--stage-i": stages.length } as CSSProperties}
        >
          <span className={styles.dot} data-status="pending">
            <Icon name="Loader" size={12} strokeWidth={2.2} />
          </span>
          <span className={styles.text}>
            <span className={styles.label}>Checking…</span>
          </span>
        </li>
      ) : null}
    </ol>
  );
}

export function reportSummaryText(report: ConnectivityReport | null): string {
  if (!report) return "";
  if (report.ticket) {
    return `${report.ticket.vaultName} · expires ${new Date(report.ticket.expiresAt).toLocaleString()}`;
  }
  if (report.gateway) {
    return `v${report.gateway.version}${report.gateway.compatible ? "" : " · version mismatch"}`;
  }
  return report.ok ? "Connected" : (report.error ?? "Could not connect");
}
