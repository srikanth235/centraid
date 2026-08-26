// What Notes contributes to the FRAME (Notes spec §1, §2): what the frame's
// app bar, status line and phone band CARRY on each route — never how they
// look. The contribution shape is `_shared/app-frame.tsx`.
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
 * Routes whose bar carries NO commit. Trash has no verb — the platform has no
 * destroy command (purge-date schedule; the shelf caption explains). Search,
 * History and the two origin acts are read or performed in place; a filled
 * button would be a second answer.
 */
const NO_PRIMARY: ReadonlySet<string> = new Set([
  TRASH,
  SEARCH,
  HISTORY,
  CAPTURE,
  VOICE,
]);

/** The one filled control, per route: **Link** in the editor (the act it exists for), **New note** on any drawn set of notes. */
export function primaryLabel(shelf: ShelfId): string | null {
  if (shelf === NOTE) return "Link";
  return typeof shelf === "string" && NO_PRIMARY.has(shelf) ? null : "New note";
}

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  /** The open notebook's name — a notebook carries its OWN title in the bar. */
  notebookName?: string;
  /** Fire the route's primary verb. OMITTED IS THE HONEST DEFAULT: label comes from `primaryLabel`, so a caller cannot name a verb the route does not have. */
  onPrimary?: () => void;
  /** Why the primary cannot fire (usually a denied write scope). The reason is the point. */
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

/** Search first and quiet, the route's primary last and filled. A DISABLED COMMIT TAKES THE PLAIN OUTLINE — a filled control that cannot be pressed stops being filled. */
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

/** Compact band claim (§2): Library · Notebooks · Journal · Search, plus More. The frame ignores the claim on non-compact surfaces, so the app never has to ask. */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
