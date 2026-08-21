// Trash's ask panel (Docs spec §4.3 `trash`, §14).
//
// AN ASK, NOT A VERB. §4.3 draws this panel with two actions — a dangerous
// "Empty trash" and "Read the fallback wording" — and the first of those is
// the very thing being asked FOR: nothing behind it exists. So the panel is a
// label and one sentence, and the ask's own rationale lives beside the copy
// in `drive-copy.ts`.
//
// The eyebrow says which kind of thing this is so it is never mistaken for a
// control that failed, and nothing here is in the `net` role: nothing has gone
// wrong, and a net border would say otherwise.
import type { ReactNode } from "react";

import { TRASH_ASK, TRASH_FALLBACK } from "../drive-copy.ts";

import styles from "./TrashAsk.module.css";

export function TrashAsk(): ReactNode {
  return (
    <section className={styles.panel} aria-label={TRASH_ASK.title}>
      <p className={styles.eyebrow}>{TRASH_ASK.eyebrow}</p>
      <h2 className={styles.title}>{TRASH_ASK.title}</h2>
      {/* The one sentence the shelf owes a member here. What is asked for, and
          why, is a design note in `drive-copy.ts` rather than a panel of facts
          printed at someone who came to empty a trash. */}
      <p className={styles.fallback}>{TRASH_FALLBACK}</p>
    </section>
  );
}
