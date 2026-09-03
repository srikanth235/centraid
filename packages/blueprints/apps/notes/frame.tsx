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

const NO_PRIMARY: ReadonlySet<string> = new Set([
  TRASH,
  SEARCH,
  HISTORY,
  CAPTURE,
  VOICE,
]);

export function primaryLabel(shelf: ShelfId): string | null {
  if (shelf === NOTE) return "Link";
  return typeof shelf === "string" && NO_PRIMARY.has(shelf) ? null : "New note";
}

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  notebookName?: string;
  onPrimary?: () => void;
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

export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
