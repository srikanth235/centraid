// What Tally contributes to the FRAME (spec §1).
//
// The contribution SHAPE is `_shared/app-frame.tsx`, the same module Tasks,
// Docs and Photos fill in; this file is what Tally puts in it — the route's
// title, its count, its segmented switcher on a pointer, and its ONE filled
// verb.
//
// THE ONE FILLED CONTROL IS `Add expense` ON EVERY LIST ROUTE, and `Edit` on
// an expense. A route that cannot take either — the denied gate, the first
// read, an editor that already carries its own commit — contributes no primary
// at all rather than a button that would refuse.
//
// THE SWITCHER IS POINTER-ONLY. On compact the band already carries the same
// four destinations, and drawing both would be two answers to one question.
import type { ReactNode } from "react";

import { bandClaim as claimBand, countLabel } from "../_shared/app-frame.tsx";
import type { AppBarBase } from "../_shared/app-frame.tsx";
import { Segmented } from "../_shared/Segmented.tsx";
import type {
  InlineAppBarContribution,
  InlineBandClaim,
} from "../inline-types.ts";
import {
  ACTIVITY,
  BAND_DESTINATIONS,
  EXPENSE,
  GROUPS,
  WAITING,
  bandActiveId,
  shelfLabel,
  showsLedgerList,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { VERBS } from "./view-copy.ts";

/** The four destinations the switcher offers, in the spec's order. */
const SEGMENTS: readonly ShelfId[] = [null, ACTIVITY, GROUPS, WAITING];

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  /** The open group's or friend's own name: a descent carries ITS title. */
  subjectName?: string;
  /** What the count counts on this route ("expenses", "members"). */
  unit?: string;
  /** No grant, or no read yet: the bar contributes a title and nothing to
   *  press. */
  quiet?: boolean;
  onSelect: (shelf: ShelfId) => void;
  onAddExpense: () => void;
  onSettle: () => void;
  onEdit: () => void;
  onItemise: () => void;
}

export function barTitle(state: AppBarState): string {
  return state.subjectName ?? shelfLabel(state.shelf);
}

/** The bar's count, in the words the route uses. `null` contributes nothing
 *  rather than a zero the view had to invent. */
export function barCount(state: AppBarState): ReactNode {
  if (state.count === null || !state.unit) return undefined;
  return countLabel(state.count, state.unit);
}

export function appBar(state: AppBarState): InlineAppBarContribution {
  const onExpense = state.shelf === EXPENSE;
  const actions: ReactNode = state.quiet ? null : (
    <>
      {state.compact ? null : (
        <Segmented
          label="Tally view"
          options={SEGMENTS.map((shelf) => ({
            key: String(shelf),
            label: shelfLabel(shelf),
            pressed: bandActiveId(state.shelf) === bandActiveId(shelf),
            select: () => state.onSelect(shelf),
          }))}
        />
      )}
      {/* The quiet verb: `Itemise` where the member is looking at one
          expense, `Settle up` everywhere else. */}
      <button
        type="button"
        className="kit-btn"
        onClick={onExpense ? state.onItemise : state.onSettle}
      >
        {onExpense ? VERBS.itemise : VERBS.settleUp}
      </button>
      {onExpense || showsLedgerList(state.shelf) ? (
        <button
          type="button"
          className="kit-btn primary"
          onClick={onExpense ? state.onEdit : state.onAddExpense}
        >
          {onExpense ? VERBS.edit : VERBS.addExpense}
        </button>
      ) : null}
    </>
  );
  return { title: barTitle(state), count: barCount(state), actions };
}

/** The compact band claim — Tally's own four destinations plus More, which the
 *  frame ignores on any surface that is not compact. */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
