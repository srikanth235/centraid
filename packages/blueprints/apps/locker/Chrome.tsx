// The Locker chrome — a ROUTE INSIDE THE FRAME (README-Locker §1). Geometry
// only.
//
// The stem, app bar, back row, status line, sheets and phone band are the
// SYSTEM'S; this file draws only the app's own two regions — the 232px rail on
// a wide pointer surface and the scroll host — and adds no token, rung, colour
// or control recipe.
//
// THE ONE THING IT DECIDES: whether the rail is drawn at all. `railOn` is the
// gate from `shelves.ts` (`suppressesNavigation`), passed down as a fact: a
// locked vault, a first run, a denied grant and the refused seat each withdraw
// the spine, and a chrome that dimmed it instead would be advertising
// destinations that do not exist yet.
//
// EVERYTHING VARIABLE ARRIVES AS A SLOT, the same shape `tasks/Chrome.tsx` and
// `docs/Chrome.tsx` use.
import type { ReactNode } from "react";

import {
  AskMount,
  ChromeToolbar,
  ConsentBanner,
  ScrollHost,
} from "../_shared/AppChrome.tsx";
import { chromeClass } from "../_shared/chrome-kit.ts";
import { LoadingSkeleton } from "../_shared/LoadingSkeleton.tsx";

import styles from "./Chrome.module.css";

/** Everything the chrome DRAWS but does not decide. A `null` slot renders
 *  nothing at all rather than an empty container. */
export interface ChromeSlots {
  /** The rail (§1): *The vault*, the six types, and the acts. Null on every
   *  surface that is not a wide pointer one, and behind every gate. */
  rail: ReactNode;
  /** The tool row above the list — the count and the lenses. ONE horizontal
   *  scroller at the narrow rung; null wherever it would carry nothing. */
  toolbar: ReactNode;
  /** The honest-state notices — pending, offline, stale, conflict, parked,
   *  re-auth. Above the list, never over it. */
  notices: ReactNode;
  /** The current route's body. */
  scroll: ReactNode;
  /** The permit gate and the confirms. A full-stop overlay is the one
   *  sanctioned divergence in this app (handoff README, divergence 1). */
  overlays: ReactNode;
  /** The compact band's overflow sheet, or null while it is closed. */
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  /** No read has landed yet, so the list stands as skeleton rows at row
   *  geometry — never a spinner. */
  loading: boolean;
  /** A denied read, as the query reported it. Denial is DATA. */
  consent: { message: string } | null;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = chromeClass(
    styles.shell,
    props.narrow && styles.isNarrow,
    props.consent && styles.denied
  );

  return (
    <div className={shellClass} data-locker-root data-density="comfortable">
      {props.slots.rail ? (
        <nav className={styles.rail} aria-label="Locker navigation">
          {props.slots.rail}
        </nav>
      ) : null}

      <main className={styles.main}>
        {props.consent ? (
          <ConsentBanner
            message={props.consent.message}
            className={styles.banner}
          />
        ) : null}

        {props.slots.notices}

        <ChromeToolbar className={styles.toolbar} label="Locker view">
          {props.slots.toolbar}
        </ChromeToolbar>

        <ScrollHost
          className={styles.scroll}
          loading={props.loading}
          skeletonClassName={styles.skeleton}
          skeleton={<LoadingSkeleton rows={6} />}
        >
          {props.slots.scroll}
        </ScrollHost>
        <AskMount className={styles.askMount} />
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
