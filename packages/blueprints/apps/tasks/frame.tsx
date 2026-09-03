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
import { BAND_DESTINATIONS, allowsQuickAdd, bandActiveId } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { QUICK_ADD, shelfCopy } from "./view-copy.ts";

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  projectName?: string;
  onQuickAdd?: () => void;
  quickAddDisabledReason?: string;
}

export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(
    state.count,
    shelfCopy(state.shelf, state.projectName).unit
  );
}

export function barTitle(state: AppBarState): string {
  return shelfCopy(state.shelf, state.projectName).title;
}

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

export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
