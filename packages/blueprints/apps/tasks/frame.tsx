// What Tasks contributes to the FRAME (spec §1, §2).
//
// The contribution SHAPE is `_shared/app-frame.tsx`, the same module Docs and
// Photos fill in; this file is what Tasks puts in it — the route's title, its
// count and its ONE filled verb.
//
// THE ONE FILLED CONTROL IS QUICK ADD, and only where a task can actually be
// captured. A route that draws no board (the Logbook, the reminder surface, the
// consent gate) contributes no primary at all rather than a button that would
// refuse — and a denied WRITE scope keeps the button while stating the reason,
// because a control that vanishes teaches nothing.
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
  allowsQuickAdd,
  bandActiveId,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { QUICK_ADD, shelfCopy } from "./view-copy.ts";

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  /** The open project's name — a project carries its OWN title in the bar. */
  projectName?: string;
  /** Capture a task. Omitted where the route holds no board to capture into. */
  onQuickAdd?: () => void;
  /** Why capture cannot fire, when it cannot — a denied write scope names
   *  itself here rather than leaving a dead control on screen. */
  quickAddDisabledReason?: string;
}

/** The bar's count, in the words the route uses. `null` contributes nothing
 *  rather than a zero the view had to invent. */
export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(state.count, shelfCopy(state.shelf, state.projectName).unit);
}

export function barTitle(state: AppBarState): string {
  return shelfCopy(state.shelf, state.projectName).title;
}

/** Does this route offer capture at all? The bar asks the shelf table, so the
 *  answer cannot drift from the one the routes themselves use. */
export function offersQuickAdd(shelf: ShelfId): boolean {
  return allowsQuickAdd(shelf);
}

export function appBar(state: AppBarState): InlineAppBarContribution {
  const disabled = state.quickAddDisabledReason !== undefined;
  const handleQuickAdd = state.onQuickAdd;
  const handleSearch = state.onSearch;
  const actions: ReactNode = (
    <>
      {!state.compact && handleSearch ? (
        <SearchBarButton label="Search tasks" onSearch={handleSearch} />
      ) : null}
      {offersQuickAdd(state.shelf) && handleQuickAdd ? (
        // A disabled commit takes the plain outline, never the fill (§"the
        // rules that make these three rooms one house", rule 4).
        <button
          type="button"
          className={disabled ? "kit-btn" : "kit-btn primary"}
          disabled={disabled}
          title={state.quickAddDisabledReason}
          onClick={handleQuickAdd}
        >
          {QUICK_ADD.add}
        </button>
      ) : null}
    </>
  );
  return { title: barTitle(state), count: barCount(state), actions };
}

/** The compact band claim (§2) — Tasks' own four destinations plus More, which
 *  the frame ignores on any surface that is not compact. */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
