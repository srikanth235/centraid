// The Tasks chrome — a ROUTE INSIDE THE FRAME (spec §1). Geometry only.
//
// The stem, the app bar, the back row, the one status line, the sheets and the
// phone's band are the SYSTEM'S; this file draws the two regions that are the
// app's own — the 232px rail on a wide pointer surface, and the scroll host
// everything else stands in — and nothing more. It adds no token, no rung, no
// colour and no control recipe.
//
// THE RETIRED SELECTORS ARE GONE FOR GOOD. The pre-rebuild chrome stamped a
// global `.tk-shell`/`.tk-side`/`.tk-topbar` trio so sibling stylesheets could
// reach across a module boundary; that seam is permanently banned (trap #5,
// packages/blueprints/src/shared-css.test.ts). Every class in this tree is
// module-scoped or part of the global `kit-*` vocabulary the host loads once.
//
// EVERYTHING VARIABLE ARRIVES AS A SLOT, the same shape `docs/Chrome.tsx` and
// `photos/Chrome.tsx` use. The chrome owns geometry; what stands in each region
// is the orchestrator's decision, so the two can be reasoned about — and
// re-carved for the routes still to land — independently.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../_shared/LoadingSkeleton.tsx";
import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";

import styles from "./Chrome.module.css";

/** Everything the chrome DRAWS but does not decide. One region per slot, and a
 *  `null` slot renders nothing at all rather than an empty container. */
export interface ChromeSlots {
  /** The rail (§5): two named heads, the five view rows, the areas and their
   *  projects, then the Logbook and Catch up. Null on every surface that is
   *  not a wide pointer one — 232px beside 390 is not a column. */
  rail: ReactNode;
  /**
   * The tool row above the list — the count, the lenses and the sort verb. It
   * is ONE horizontal scroller at 390px (§7): a count, three lenses and a sort
   * verb cannot wrap into three stacked lines without eating the first task.
   * Null wherever the row would carry nothing; an empty band is chrome.
   */
  toolbar: ReactNode;
  /** The honest-state notices — re-entry, stale replica, a vault that did not
   *  answer, the pending count. Above the list, never over it. */
  notices: ReactNode;
  /** The current route's body. */
  scroll: ReactNode;
  /** Quick add, the editor's confirms, the shortcut sheet. */
  overlays: ReactNode;
  /** The compact band's overflow sheet, or null while it is closed. */
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  /** No read has landed yet, so the list stands as skeleton rows — never a
   *  spinner (§4's Loading state). */
  loading: boolean;
  /** A denied read, as the query reported it. Denial is DATA. */
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
    <div className={shellClass} data-tasks-root data-density="comfortable">
      {props.slots.rail ? (
        <nav className={styles.rail} aria-label="Tasks navigation">
          {props.slots.rail}
        </nav>
      ) : null}

      <main className={styles.main}>
        {props.consent ? (
          // `id="consentBanner"` is the hook the shared kit's onFocusRefresh
          // reads to detect a denied→recovered flip and bypass its 30s focus
          // throttle; without it a refocus after a grant would be throttled and
          // the read never retried (#505).
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>No vault access yet.</strong>{" "}
            <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}

        {props.slots.notices}

        {props.slots.toolbar ? (
          <div className={styles.toolbar} role="toolbar" aria-label="Tasks view">
            {props.slots.toolbar}
          </div>
        ) : null}

        <div className={styles.scroll}>
          {props.loading ? (
            <div className={styles.skeleton} aria-hidden="true">
              <LoadingSkeleton rows={6} />
            </div>
          ) : (
            props.slots.scroll
          )}
        </div>
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
