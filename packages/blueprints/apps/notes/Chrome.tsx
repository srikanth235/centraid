// The Notes chrome — a ROUTE INSIDE THE FRAME, and geometry only.
//
// This file draws the regions and decides nothing about what stands in them:
// the rail, the toolbar row, the banners, the scroll host and the band's
// overflow sheet arrive as SLOTS, exactly as `docs/Chrome.tsx` and
// `photos/Chrome.tsx` take theirs. What is in each region is the
// orchestrator's decision, so the two can be reasoned about independently.
//
// There is NO app bar, NO status line and NO navigation stem here. All three
// are the frame's, contributed through `frame.tsx`; an app that drew its own
// would be a second chrome inside the first. The global
// nt-prefixed side/topbar/hamburger selectors are banned — they are not
// spelled out here, because the ban is enforced by substring over this whole
// tree (shared-css.test.ts). The shell's
// stem is the navigation, and a hamburger opening a sidebar this seat renders
// `display: none` is chrome pretending to be a way somewhere.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";

import styles from "./Chrome.module.css";

/** Everything the chrome DRAWS but does not decide. A `null` slot renders
 *  nothing at all rather than an empty container — an empty band is chrome. */
export interface ChromeSlots {
  /** The toolbar row above the set: the cards/list pair, and the scope or
   *  lens controls a route carries. Null where the row would be empty. */
  toolbar: ReactNode;
  /**
   * The 232px rail: **Notebooks · where a note lives** over
   * **Tags · how a note is seen**. Null on the compact form factor, where
   * the band carries Notebooks as a destination of its own — the rail is a
   * column, and 232 beside 390 is not a column.
   */
  rail: ReactNode;
  /** The current route's body. */
  scroll: ReactNode;
  /** The powerbox, the confirms, the link sheet. */
  overlays: ReactNode;
  /** The band's own overflow sheet, or null while it is closed. */
  moreSheet: ReactNode;
}

export interface ChromeProps {
  /** This app's own pane is too narrow for the rail beside the set. */
  narrow: boolean;
  /** The consent denial, as a value — never an error. */
  consent: { message: string } | null;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : "",
    props.consent ? styles.denied : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={shellClass}
      data-notes-root
      data-tone="paper"
      data-density="comfortable"
    >
      <main className={styles.main}>
        {props.slots.toolbar ? (
          <div className={styles.toolbar} role="toolbar" aria-label="View">
            {props.slots.toolbar}
          </div>
        ) : null}

        {props.consent ? (
          // `id="consentBanner"` is the hook the shared kit's onFocusRefresh
          // reads to detect a denied→recovered state and bypass its focus
          // throttle; without it a refocus after a grant would never retry.
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>No vault access yet.</strong>{" "}
            <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}
        {/* Driven imperatively by logic.ts, so these DOM writes are never
            clobbered by reconciliation. */}
        <output
          id="noticeBanner"
          className={`kit-banner notice ${styles.banner}`}
          aria-live="polite"
          hidden
        />

        <div className={styles.content}>
          {props.slots.rail}
          <div className={styles.scroll}>{props.slots.scroll}</div>
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
