// The Agenda chrome — a ROUTE INSIDE THE FRAME. Geometry and nothing else:
// the rail, the state row, the banners, the canvas host and the overlay
// regions, expressed as one React tree so `app-root.tsx` renders one tree
// instead of a dozen imperative roots.
//
// THERE IS NO TOPBAR AND NO SIDEBAR NAVIGATION HERE. The global
// ag-prefixed shell/side/topbar trio is permanently banned, and the ban is
// enforced by substring over this whole tree (shared-css.test.ts), so the dead
// selectors are not spelled out even in a comment: navigation is the shell's
// stem, the title and the view switcher are the
// frame's app bar (frame.tsx), and outcomes are the frame's one status line.
// What is left in this file is what the spec actually draws — a 232px rail
// beside a canvas.
//
// EVERYTHING VARIABLE ARRIVES AS A SLOT, the same shape docs/Chrome.tsx uses.
// The chrome owns geometry; what stands in each region is the orchestrator's
// decision, so the two can be reasoned about independently — and the rail's
// `dayContext` slot is exactly the seam the day-context layers mount into.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";
import { DENIED_TITLE, RAIL_CALENDARS, RAIL_DAY_CONTEXT } from "./view-copy.ts";

import styles from "./Chrome.module.css";

/** Everything the chrome DRAWS but does not decide. A `null` slot renders
 *  nothing at all rather than an empty container. */
export interface ChromeSlots {
  /** The rail's mini month. */
  miniMonth: ReactNode;
  /** The rail's calendar list — each row a hue dot and a name. */
  calendars: ReactNode;
  /**
   * THE DAY-CONTEXT SEAM. The rail's third section: the labelled home for the
   * layers that decorate a day without occupying it — birthdays from People,
   * due tasks from Tasks, subscribed holidays. The section is labelled here
   * and carries whatever the orchestrator passes into it; the layer toggles
   * mount in this slot.
   *
   * Layers are NOT calendars, which is why they are a section of their own
   * rather than four more rows under Calendars: nothing in them can be
   * written to, and the section has to be able to say so.
   */
  dayContext: ReactNode;
  /** The second control row: offline, stale, partly denied, parked cancel.
   *  Null where the app has nothing to declare, because an empty row is
   *  chrome. */
  stateRow: ReactNode;
  /** The current view's body. */
  canvas: ReactNode;
  /** The detail panel — a column BESIDE the canvas on a wide surface, so the
   *  next row can be reached without dismissing the description first. */
  detail: ReactNode;
  /** Editor, quick add, scope panel, the create composer. */
  overlays: ReactNode;
  /** The compact band's overflow sheet, or null while it is closed. */
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
      {/* The rail (232px) is the app's own column, not a second navigation
          band: it carries the month at a glance, which calendars are shown,
          and the day-context layers. It is absent on the compact form factor,
          where the band carries the views and the More sheet carries these. */}
      {props.narrow ? null : (
        <aside className={styles.rail} aria-label="Agenda rail">
          <section className={styles.railSection}>
            {props.slots.miniMonth}
          </section>
          <section className={styles.railSection} aria-label={RAIL_CALENDARS}>
            <h2 className={styles.railLabel}>{RAIL_CALENDARS}</h2>
            {props.slots.calendars}
          </section>
          {/* THE SEAM. Labelled here so the section keeps its place in the
              rail's rhythm whatever fills it. */}
          <section className={styles.railSection} aria-label={RAIL_DAY_CONTEXT}>
            <h2 className={styles.railLabel}>{RAIL_DAY_CONTEXT}</h2>
            <div className={styles.dayContext}>{props.slots.dayContext}</div>
          </section>
        </aside>
      )}

      <main className={styles.main}>
        {props.consent ? (
          // `id="consentBanner"` is the hook the shared refresh kit reads to
          // detect a denied→recovered state and bypass its focus throttle.
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>{DENIED_TITLE}</strong> <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}
        {/* Driven imperatively by logic.ts (notice / readFailed) — rendered
            once, never reconciled, so those DOM writes are never clobbered. */}
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
        {/* THE ASSISTANT'S MOUNT. The panel is the shell's
            (`kit-ask-inline.ts`) and it streams a turn under this app's id;
            it mounts ONLY where the app gives it a node, which is why this
            seam is here — without it the descriptor's `kitAsk` config
            (app-inline.tsx) is real and unreachable. */}
        <div className={styles.askMount} data-ask-mount />
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
