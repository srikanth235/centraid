// PERMISSION IS A SCREEN, NOT AN ERROR (v4 handoff §13, CHANGELOG A.6).
//
// What this replaced: a `kit-banner` strip at the head of the pane with a bold
// "No access yet." and a sentence beside it. A strip says "something went
// wrong up there"; an ungranted or revoked grant is not a fault, it is a state
// the product is designed for — so it takes the whole pane, in the app's own
// register: a display-serif headline, one paragraph in the reading register,
// what is missing, and the two facts a member actually wants (what Photos can
// see meanwhile, and what happens if the grant comes back).
//
// It keeps `id="consentBanner"` on its root. That id is a CONTRACT, not
// decoration: the element layer's `onFocusRefresh` looks for it to decide
// whether a window focus is a recovery from a just-granted permission and must
// re-read immediately (packages/design/src/elements/refresh.ts). The element moved and was redrawn;
// the hook's question did not change.
//
// ONE FILLED ELEMENT (§18): the ask. `VaultAccessButton` is the shared control
// that reaches the owner's own settings, and nothing else here is filled.
import { VaultAccessButton } from "../../_shared/VaultAccessButton.tsx";
import { PERMISSION_COPY } from "../view-copy.ts";

import styles from "./Permission.module.css";

export function PermissionScreen({ reason }: { reason?: string | null }) {
  return (
    <section id="consentBanner" className={styles.screen} aria-live="polite">
      <h1 className={styles.headline}>{PERMISSION_COPY.headline}</h1>
      <p className={styles.lede}>{PERMISSION_COPY.lede}</p>

      <h2 className={styles.head}>{PERMISSION_COPY.missingLabel}</h2>
      {/* The host's own words when it gave any — it names the scopes that were
          refused, which is the one thing this app cannot know for itself. */}
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
