import { useState } from "react";
import type { JSX } from "react";

import Button from "../ui/Button.js";

import styles from "./StartupErrorScreen.module.css";

/**
 * Rendered when the settings READ fails at startup — never the chooser.
 */
export interface StartupErrorScreenProps {
  /** Host's message, verbatim; omitted if there wasn't one. */
  detail?: string;
  onRetry: () => Promise<void> | void;
}

export default function StartupErrorScreen({
  detail,
  onRetry,
}: StartupErrorScreenProps): JSX.Element {
  const [retrying, setRetrying] = useState(false);

  const handleRetry = (): void => {
    setRetrying(true);
    // Reset only lands when the read failed again — button must work twice.
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
