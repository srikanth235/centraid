import type { JSX } from "react";

import styles from "./OnboardingScreen.module.css";

export function ErrorNote({
  summary,
  detail,
}: {
  summary: string;
  detail: string | null;
}): JSX.Element {
  return (
    <div className={styles.error}>
      <p className={styles.errorSummary} role="alert">
        {summary}
      </p>
      {detail ? (
        <details className={styles.errorDetail}>
          <summary>Technical detail</summary>
          <p className={styles.errorDetailText}>{detail}</p>
        </details>
      ) : null}
    </div>
  );
}
