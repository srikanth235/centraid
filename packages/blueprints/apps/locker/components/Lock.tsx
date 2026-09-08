// THE LOCK SCREEN (README-Locker §1, §6; FLOWS.md "Unlock").
//
// A SENTENCE, NOT A FIELD (#996, ruling W6-D2). This screen used to carry a
// passphrase box and two modes — first run and lock — because the app owned
// the boundary: it collected the secret and a gateway checked it. Both halves
// moved. The shell holds `K` behind the member's own unlock, and an app that
// still drew a passphrase box would be an app collecting a credential it must
// never hold — with nothing on this side to check it against, so the box could
// only ever forward what it took.
//
// FIRST RUN IS GONE with it: "no passphrase yet" was a question for the app
// that stored one. Enrolment is what happens when a device receives `K`, on
// the shell's surface, and a gate here would be a gate this app cannot open.
//
// What is left is the part that was always this app's: SAY WHAT IS TRUE, in
// words rather than a lock icon (§7: never an icon standing in for a
// sentence), and carry the facts table underneath — "why did it close on me"
// is a question a member asks once and should never have to ask twice.
//
// NOTHING IS BROWSABLE BEHIND IT. `shelves.suppressesNavigation` withdraws the
// rail, the band and every list; this screen is what stands in their place.
import type { ReactNode } from "react";

import { LOCK_BODY, LOCK_FACTS, LOCK_UNAVAILABLE_BODY } from "../view-copy.ts";

import styles from "./Rows.module.css";

export interface LockProps {
  /**
   * `locked` — the shell has a Locker door and the member has not unlocked.
   * `unavailable` — this host offers no door at all: an older shell, or a
   * surface that cannot unseal locally. Two different facts, and only one of
   * them is fixed by unlocking, so they are never drawn the same way.
   */
  reason: "locked" | "unavailable";
}

export function Lock(props: LockProps): ReactNode {
  const unavailable = props.reason === "unavailable";
  return (
    <section className={styles.gate}>
      <p className={styles.gateTitle}>
        {unavailable ? "Locker is not available here" : "Locked"}
      </p>
      <p className={styles.gateBody}>
        {unavailable ? LOCK_UNAVAILABLE_BODY : LOCK_BODY}
      </p>

      {unavailable ? null : (
        <dl className={styles.facts}>
          {LOCK_FACTS.map(([key, value]) => (
            <div key={key} className={styles.fact}>
              <dt className={styles.factKey}>{key}</dt>
              <dd className={styles.factValue}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
