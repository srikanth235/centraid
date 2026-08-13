// The COMING DUE shelf (Docs spec §4.3 `due`, §10.7's `due` capability).
//
// The band claims this destination (§1.4), so it must exist and it must be
// honest. The capability that would populate it — "Find dates that fall due" —
// is off, and there is no consent record to read, so what this shelf draws is
// the ONE true thing about it: it is empty for a reason, and the reason is not
// that nothing is due.
//
// "It is switched off, so this shelf is empty for a reason rather than because
// nothing is due." (spec §4.3, verbatim.)
//
// NO ACTIONS THIS WAVE. §4.3 gives the panel two — "What this would read" and
// "Turn it on" — and both land on the `capabilities` screen, which does not
// exist yet. A control that goes nowhere is worse than no control, so the
// panel states the fact and stops; the agent who lands `capabilities` adds the
// two buttons and nothing else changes here.
import type { ReactNode } from "react";

import { DCAPS } from "../capabilities.ts";

import styles from "./DueRoute.module.css";

const DUE_CAP = DCAPS.find((cap) => cap.id === "due");

export function DueRoute(): ReactNode {
  return (
    <div className={styles.wrap}>
      <section className={styles.panel} aria-label="Coming due">
        {/* The eyebrow is the state, not a severity: nothing has failed. */}
        <p className={styles.eyebrow}>Switched off</p>
        <h2 className={styles.title}>
          Nothing has been read out of your documents yet
        </h2>
        <p className={styles.body}>
          {DUE_CAP?.what} It is switched off, so this shelf is empty for a
          reason rather than because nothing is due.
        </p>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt className={styles.key}>where it would run</dt>
            <dd className={styles.value}>{DUE_CAP?.where}</dd>
          </div>
          <div className={styles.fact}>
            <dt className={styles.key}>what leaves the device</dt>
            <dd className={styles.value}>{DUE_CAP?.leaves}</dd>
          </div>
          <div className={styles.fact}>
            <dt className={styles.key}>what it would write</dt>
            <dd className={styles.value}>{DUE_CAP?.writes}</dd>
          </div>
        </dl>
      </section>
      <p className={styles.note}>
        Agenda owns the event. Docs would show the date, the document and the
        link — never a second copy of the event.
      </p>
    </div>
  );
}
