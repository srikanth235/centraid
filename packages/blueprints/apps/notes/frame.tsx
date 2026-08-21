// What Notes contributes to the FRAME (Notes spec §1, §2).
//
// The app bar, the one status line and the phone's band are the frame's. This
// file says what they should CARRY on each route and nothing about how they
// look — the contribution SHAPE is `_shared/app-frame.tsx`, the same module
// Docs and Photos fill in.
import type { ReactNode } from "react";

import {
  SearchBarButton,
  bandClaim as claimBand,
  countLabel,
} from "../_shared/app-frame.tsx";
import type { AppBarBase } from "../_shared/app-frame.tsx";
import type {
  InlineAppBarContribution,
  InlineBandClaim,
} from "../inline-types.ts";
import {
  BAND_DESTINATIONS,
  CAPTURE,
  HISTORY,
  NOTE,
  SEARCH,
  TRASH,
  VOICE,
  bandActiveId,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { shelfCopy } from "./view-copy.ts";

/**
 * The routes whose bar carries NO commit at all.
 *
 * Trash offers no verb: the platform has no destroy command — a trashed note
 * leaves on the schedule its purge date announces — so the bar stands down
 * and the shelf's caption says what will happen instead. Search, History and
 * the two origin acts are surfaces you read or perform in place; a filled
 * button over any of them would be a second answer to a question the screen
 * has already answered.
 */
const NO_PRIMARY: ReadonlySet<string> = new Set([
  TRASH,
  SEARCH,
  HISTORY,
  CAPTURE,
  VOICE,
]);

/**
 * The one filled control, per route. In the editor it is **Link**, which is
 * the act the editor exists to make possible and the powerbox's other door;
 * everywhere a set of notes is drawn it is **New note**.
 */
export function primaryLabel(shelf: ShelfId): string | null {
  if (shelf === NOTE) return "Link";
  return typeof shelf === "string" && NO_PRIMARY.has(shelf) ? null : "New note";
}

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  /** The open notebook's name — a notebook carries its OWN title in the bar. */
  notebookName?: string;
  /**
   * Fire the route's primary verb. OMITTED IS THE HONEST DEFAULT: a bar that
   * drew a verb with nothing behind it would be a dead control, and the label
   * comes from `primaryLabel` so a caller cannot name a verb the route does
   * not have.
   */
  onPrimary?: () => void;
  /** Why the primary cannot fire, when it cannot. A denied write scope is
   *  the usual reason, and the reason is the point. */
  primaryDisabledReason?: string;
}

export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(
    state.count,
    shelfCopy(state.shelf, state.notebookName).unit
  );
}

export function barTitle(state: AppBarState): string {
  return shelfCopy(state.shelf, state.notebookName).title;
}

/**
 * The bar contribution: Search first and quiet, the route's primary last and
 * filled. A DISABLED COMMIT TAKES THE PLAIN OUTLINE — a filled control that
 * cannot be pressed stops being filled.
 */
export function appBar(state: AppBarState): InlineAppBarContribution {
  const label = primaryLabel(state.shelf);
  const disabled = state.primaryDisabledReason !== undefined;
  const handlePrimary = state.onPrimary;
  const handleSearch = state.onSearch;
  const actions: ReactNode = (
    <>
      {!state.compact && handleSearch ? (
        <SearchBarButton label="Search notes" onSearch={handleSearch} />
      ) : null}
      {label && handlePrimary ? (
        <button
          type="button"
          className={disabled ? "kit-btn" : "kit-btn primary"}
          disabled={disabled}
          title={state.primaryDisabledReason}
          onClick={handlePrimary}
        >
          {label}
        </button>
      ) : null}
    </>
  );
  return { title: barTitle(state), count: barCount(state), actions };
}

/** The compact band claim (§2): Library · Notebooks · Journal · Search, plus
 *  More. The frame keeps its home capsule beside them and ignores the claim
 *  on any surface that is not compact, so the app never has to ask. */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
