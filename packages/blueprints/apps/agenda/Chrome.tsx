// Agenda chrome — a route inside the frame. Geometry only. No topbar/sidebar:
// the ag-prefixed shell/side/topbar trio is banned (shared-css.test.ts).
// Everything variable arrives as a slot; `dayContext` is the day-context seam.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";
import { DENIED_TITLE, RAIL_CALENDARS, RAIL_DAY_CONTEXT } from "./view-copy.ts";

import styles from "./Chrome.module.css";

/** What the chrome DRAWS but does not decide. `null` renders nothing, not an empty container. */
export interface ChromeSlots {
  miniMonth: ReactNode;
  calendars: ReactNode;
  /** Layers are NOT calendars — nothing in them can be written to. */
  dayContext: ReactNode;
  /** Null where the app has nothing to declare — an empty row is chrome. */
  stateRow: ReactNode;
  canvas: ReactNode;
  detail: ReactNode;
  overlays: ReactNode;
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  ready: boolean;
  consent: { message: string } | null;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : "",
    props.ready ? styles.ready : "",
    props.consent ? styles.denied : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={shellClass}
      data-agenda-root
      data-tone="paper"
      data-density="comfortable"
    >
      {/* Rail is the app's column (232px), not a second nav; absent on compact. */}
      {props.narrow ? null : (
        <aside className={styles.rail} aria-label="Agenda rail">
          <section className={styles.railSection}>
            {props.slots.miniMonth}
          </section>
          <section className={styles.railSection} aria-label={RAIL_CALENDARS}>
            <h2 className={styles.railLabel}>{RAIL_CALENDARS}</h2>
            {props.slots.calendars}
          </section>
          {/* Day-context seam: labelled so the section keeps its place. */}
          <section className={styles.railSection} aria-label={RAIL_DAY_CONTEXT}>
            <h2 className={styles.railLabel}>{RAIL_DAY_CONTEXT}</h2>
            <div className={styles.dayContext}>{props.slots.dayContext}</div>
          </section>
        </aside>
      )}

      <main className={styles.main}>
        {props.consent ? (
          // `id="consentBanner"` — refresh kit hook for denied→recovered (bypass focus throttle).
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>{DENIED_TITLE}</strong> <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}
        {/* Imperative writes from logic.ts — never reconcile this node. */}
        <output
          id="noticeBanner"
          className={`kit-banner notice ${styles.banner}`}
          aria-live="polite"
          hidden
        />

        {props.slots.stateRow ? (
          <div className={styles.stateRow}>{props.slots.stateRow}</div>
        ) : null}

        <div className={styles.content}>
          <div className={styles.canvas}>{props.slots.canvas}</div>
          {props.slots.detail}
        </div>
        {/* kitAsk mount: without this node the descriptor config is unreachable. */}
        <div className={styles.askMount} data-ask-mount />
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
