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
