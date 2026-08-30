// The Tally chrome — a ROUTE INSIDE THE FRAME (spec §1). Geometry only.
//
// The stem, the app bar, the one status line, the sheets and the phone's band
// are the SYSTEM'S; this file draws the regions that are the app's own — the
// 232px rail on a wide pointer surface, the back row, the tool row and the
// scroll host everything else stands in — and nothing more. It adds no token,
// no rung, no colour and no control recipe.
//
// THE BACK ROW LIVES HERE, NOT IN THE BAR. The frame's contribution contract
// (`inline-types.ts`) carries a title, a count and the app's actions — there
// is no back slot in it, and an app that tried to make one out of a trailing
// action would be putting a leading control at the end of the row. So Tally
// draws its own, labelled with the DESTINATION per the spec's route table.
//
// EVERYTHING VARIABLE ARRIVES AS A SLOT, the same shape `tasks/Chrome.tsx`
// and `docs/Chrome.tsx` use. The chrome owns geometry; what stands in each
// region is the orchestrator's decision, so the two can be reasoned about —
// and re-carved for the routes still to land — independently.
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

/** Everything the chrome DRAWS but does not decide. One region per slot, and a
 *  `null` slot renders nothing at all rather than an empty container. */
export interface ChromeSlots {
  /** The rail (§1): *The ledger*, then the groups, then the people, then the
   *  lenses. Null on every surface that is not a wide pointer one — 232px
   *  beside 390 is not a column. */
  rail: ReactNode;
  /** The back row, labelled with where it goes. Null on a route the member
   *  arrived at rather than descended into. */
  backRow: ReactNode;
  /** The honest-state notices — pending writes, offline, a stale replica, a
   *  parked steward act, a conflict. Above the ledger, never over it. */
  notices: ReactNode;
  /** The tool row above the list. Null wherever the row would carry nothing;
   *  an empty band is chrome. */
  toolbar: ReactNode;
  /** The current route's body. */
  scroll: ReactNode;
  /**
   * Whatever stands OVER the room — a confirm, or the band's More sheet.
   *
   * One slot, not two, because the app allows one overlay at a time by
   * construction (`components/Overlays.tsx`): a sheet over a confirm would put
   * the way out behind the thing it was opened from.
   */
  overlays: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  /** No read has landed yet, so the ledger stands as skeleton rows at row
   *  geometry — never a spinner (§4's Loading state). */
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
    <div className={shellClass} data-tally-root data-density="comfortable">
      {/* The rail is `_shared/NavRail.tsx`, which draws its own labelled
          `nav`, its own 232px column and its own divider. Wrapping it in a
          second `nav` here would announce "navigation" twice on one screen
          and fork the column's width into app CSS. */}
      {props.slots.rail}

      <main className={styles.main}>
        {props.consent ? (
          <ConsentBanner
            message={props.consent.message}
            className={styles.banner}
          />
        ) : null}

        {props.slots.backRow ? (
          <div className={styles.backRow}>{props.slots.backRow}</div>
        ) : null}

        {props.slots.notices}

        <ChromeToolbar className={styles.toolbar} label="Tally view">
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

        {/* THE ASSISTANT'S VERBS stream a turn under this app's id, and the
            verbs ARE this app's manifest — `add-expense`, `settle-up`,
            `add-friend` and the six queries. The panel mounts only where the
            app gives it a mount point, which is why the seam is here. */}
        <AskMount className={styles.askMount} />
      </main>

      {props.slots.overlays}
    </div>
  );
}
