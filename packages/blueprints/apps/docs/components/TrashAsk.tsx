// Trash's ask panel (Docs spec §4.3 `trash`, §14).
//
// AN ASK, NOT A VERB. "There is no destroy verb in the platform today;
// destruction happens only on the purge schedule." (§4.3, verbatim.) §4.3
// draws this panel with two actions — a dangerous "Empty trash" and "Read the
// fallback wording" — and the first of those is the very thing being asked
// FOR: nothing behind it exists. So the panel states the ask, names what
// confirmation would look like when it lands, and prints the fallback wording
// inline instead of hiding it behind a button that would only reveal a
// sentence.
//
// The eyebrow says which kind of thing this is ("An ask · (b)") so it is never
// mistaken for a control that failed, and nothing here is in the `net` role:
// nothing has gone wrong, and a net border would say otherwise.
import type { ReactNode } from "react";

import { TRASH_ASK, TRASH_FALLBACK } from "../drive-copy.ts";

import styles from "./TrashAsk.module.css";

export function TrashAsk(): ReactNode {
  return (
    <section className={styles.panel} aria-label={TRASH_ASK.title}>
      <p className={styles.eyebrow}>{TRASH_ASK.eyebrow}</p>
      <h2 className={styles.title}>{TRASH_ASK.title}</h2>
      <p className={styles.body}>{TRASH_ASK.body}</p>
      <dl className={styles.facts}>
        {TRASH_ASK.facts.map((fact) => (
          <div key={fact.key} className={styles.fact}>
            <dt className={styles.key}>{fact.key}</dt>
            <dd className={styles.value}>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {/* The fallback, printed rather than linked: it is one sentence, and a
          member reading this panel is already asking the question it answers. */}
      <p className={styles.fallback}>{TRASH_FALLBACK}</p>
    </section>
  );
}
