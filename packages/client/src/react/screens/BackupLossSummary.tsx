import type { JSX } from "react";

import { formatBytes } from "../../format.js";
import { formatDuration } from "../shell/routes/gatewayData.js";
import type { LossSummary } from "./backupMetrics.js";

import styles from "./BackupCard.module.css";

const HEADLINE: Record<LossSummary["tone"], (s: LossSummary) => string> = {
  unconfigured: () =>
    "If this device died right now, you would lose everything.",
  unknown: () =>
    "If this device died right now, we can’t tell you what you’d lose.",
  safe: () => "If this device died right now, you would lose almost nothing.",
  exposed: (s) =>
    s.exposedMs === null
      ? "If this device died right now, you would lose whatever hasn’t left this machine yet."
      : `If this device died right now, you would lose up to ${formatDuration(s.exposedMs)} of changes.`,
};

const DETAIL: Record<LossSummary["tone"], (s: LossSummary) => string | null> = {
  unconfigured: () =>
    "Backup isn’t configured on this gateway — databases, code, and attachments live only on this machine.",
  unknown: () =>
    "At least one protection step has never completed, so the gap since it last ran can’t be measured.",
  safe: (s) =>
    s.pendingCount > 0
      ? `${s.pendingCount} attachment${s.pendingCount === 1 ? "" : "s"} (${formatBytes(s.pendingBytes)}) are still leaving this machine.`
      : null,
  exposed: (s) =>
    s.pendingCount > 0
      ? `${s.pendingCount} attachment${s.pendingCount === 1 ? "" : "s"} — ${formatBytes(s.pendingBytes)} — ${s.pendingCount === 1 ? "hasn’t" : "haven’t"} left this machine yet.`
      : null,
};

export default function BackupLossSummary({
  summary,
}: {
  summary: LossSummary;
}): JSX.Element {
  const detail = DETAIL[summary.tone](summary);
  return (
    <div className={styles.lossSummary} data-tone={summary.tone}>
      <p className={styles.lossHeadline}>{HEADLINE[summary.tone](summary)}</p>
      {detail ? <p className={styles.lossDetail}>{detail}</p> : null}
    </div>
  );
}
