import { VaultAccessButton } from "../../_shared/VaultAccessButton.tsx";
import { PERMISSION_COPY } from "../view-copy.ts";

import styles from "./Permission.module.css";

export function PermissionScreen({ reason }: { reason?: string | null }) {
  return (
    <section id="consentBanner" className={styles.screen} aria-live="polite">
      <h1 className={styles.headline}>{PERMISSION_COPY.headline}</h1>
      <p className={styles.lede}>{PERMISSION_COPY.lede}</p>

      <h2 className={styles.head}>{PERMISSION_COPY.missingLabel}</h2>
      {/* The host's own words naming the refused scopes. */}
      <p id="consentDetail" className={styles.missing}>
        {reason || PERMISSION_COPY.missingFallback}
      </p>

      <dl className={styles.facts}>
        {PERMISSION_COPY.facts.map((fact) => (
          <div key={fact.label} className={styles.fact}>
            <dt className={styles.factLabel}>{fact.label}</dt>
            <dd className={styles.factValue}>{fact.value}</dd>
          </div>
        ))}
      </dl>

      <div className={styles.actions}>
        <VaultAccessButton />
      </div>
    </section>
  );
}
