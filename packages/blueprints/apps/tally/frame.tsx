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

const SEGMENTS: readonly ShelfId[] = [null, ACTIVITY, GROUPS, WAITING];

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  subjectName?: string;
  unit?: string;
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

export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
