import type { JSX } from "react";

import styles from "./OnboardingScreen.module.css";

/**
 * What went wrong, in that order: a sentence the owner can act on, with the
 * raw exception kept but folded away. Shouting `ECONNREFUSED` at someone on
 * their first minute in the product tells them nothing they can do.
 *
 * Every onboarding step renders failures through this one shape, so a step
 * cannot accidentally lead with the exception (issue #660 UX-1).
 */
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
