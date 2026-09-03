import { OFFLINE_COPY } from "../view-copy.ts";

import styles from "./OfflineBanner.module.css";

export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <section
      className={styles.banner}
      aria-label={OFFLINE_COPY.label}
      aria-live="polite"
    >
      <p className={styles.body}>{OFFLINE_COPY.banner}</p>
      <button type="button" className="kit-btn" onClick={onRetry}>
        {OFFLINE_COPY.retry}
      </button>
    </section>
  );
}
