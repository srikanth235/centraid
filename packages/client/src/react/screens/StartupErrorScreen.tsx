import { useState } from "react";
import type { JSX } from "react";

import Button from "../ui/Button.js";

import styles from "./StartupErrorScreen.module.css";

/**
 * The shell could not READ its settings at startup.
 *
 * This screen exists because the alternative is worse than a blank window.
 * Swallowing a failed settings read into `{}` yields an object with no
 * `onboardingCompletedAt`, which is indistinguishable from a fresh install —
 * so a member whose gateway simply cannot be assessed (device-key custody
 * mismatch, a lock the daemon never answered) is shown the first-run
 * "Start fresh on this Mac" chooser over a full, populated vault. Being
 * invited to start over is the single most alarming thing this app can say to
 * someone whose data is fine.
 *
 * So the contract is: a read that FAILED renders this, never the chooser. Only
 * a read that SUCCEEDED and came back without an onboarding stamp is a genuine
 * first run.
 *
 * Two deliberate omissions:
 *   - nothing here is destructive, or looks it. No "start fresh", no "reset",
 *     no "erase" — the one action is to try the read again. Whatever is wrong
 *     is on the way IN to the data, not with the data.
 *   - no blame and no jargon in the lead. The host's own message is quoted
 *     below the fold for whoever ends up helping.
 */
export interface StartupErrorScreenProps {
  /** The host's message, quoted verbatim. Omitted when there wasn't one. */
  detail?: string;
  /** Re-attempt the settings read. Resolves once the retry has been decided. */
  onRetry: () => Promise<void> | void;
}

export default function StartupErrorScreen({
  detail,
  onRetry,
}: StartupErrorScreenProps): JSX.Element {
  const [retrying, setRetrying] = useState(false);

  const handleRetry = (): void => {
    setRetrying(true);
    // A successful retry swaps this whole tree out, so the reset only ever
    // lands when the read failed again — which is exactly when the button has
    // to become pressable a second time.
    void Promise.resolve(onRetry()).finally(() => setRetrying(false));
  };

  return (
    <div className={styles.view} data-testid="startup-error" role="alert">
      <div className={styles.card}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          CENTRAID
        </div>
        <h1 className={styles.title}>
          Can&rsquo;t reach your <em>gateway</em>.
        </h1>
        <p className={styles.sub}>
          Your data is safe and exactly where you left it — Centraid just
          can&rsquo;t open it yet. Nothing has been created, changed, or
          removed, and nothing will be.
        </p>
        {detail ? (
          <div className={styles.detail}>
            <span className={styles.detailLabel}>What Centraid reported</span>
            <p className={styles.detailText}>{detail}</p>
          </div>
        ) : null}
        <div className={styles.actions}>
          <Button
            className={styles.cta}
            disabled={retrying}
            label={retrying ? "Trying again…" : "Try again"}
            onClick={handleRetry}
            variant="primary"
          />
        </div>
        <p className={styles.footnote}>
          If trying again doesn&rsquo;t help, quit Centraid and open it once
          more. Your vaults stay exactly as they are either way.
        </p>
      </div>
    </div>
  );
}
