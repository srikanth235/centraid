// What Docs contributes to the FRAME (spec §1.4, §11); the contribution shape
// is `_shared/app-frame.tsx`.
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
  CAPABILITIES,
  FOLDERS,
  NEWDOC,
  SCAN,
  SEARCH,
  STORAGE,
  TRASH,
  bandActiveId,
  folderIdFrom,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { shelfCopy } from "./view-copy.ts";

const NO_PRIMARY: ReadonlySet<string> = new Set([
  // Trash offers nothing: the platform has no destroy verb (spec §14).
  TRASH,
  SEARCH,
  STORAGE,
  CAPABILITIES,
  NEWDOC,
  SCAN,
]);

export function primaryLabel(shelf: ShelfId): string | null {
  if (folderIdFrom(shelf)) return "New";
  if (shelf === FOLDERS) return "New folder";
  return typeof shelf === "string" && NO_PRIMARY.has(shelf) ? null : "New";
}

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  folderName?: string;
  /** Omitting it is honest: a bar drawing "New" with nothing behind is dead. */
  onPrimary?: () => void;
  primaryDisabledReason?: string;
  onToggleSelecting?: () => void;
  selecting?: boolean;
}

export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(state.count, shelfCopy(state.shelf, state.folderName).unit);
}

export function barTitle(state: AppBarState): string {
  return shelfCopy(state.shelf, state.folderName).title;
}

/** ONE FILLED CONTROL — the shelf's primary; Select stays outline. */
export function appBar(state: AppBarState): InlineAppBarContribution {
  const label = primaryLabel(state.shelf);
  const disabled = state.primaryDisabledReason !== undefined;
  const handlePrimary = state.onPrimary;
  const handleSearch = state.onSearch;
  const handleSelecting = state.onToggleSelecting;
  const actions: ReactNode = (
    <>
      {!state.compact && handleSearch ? (
        <SearchBarButton label="Search documents" onSearch={handleSearch} />
      ) : null}
      {handleSelecting ? (
        <button
          type="button"
          className="kit-btn"
          aria-pressed={state.selecting === true}
          onClick={handleSelecting}
        >
          {state.selecting === true ? "Done" : "Select"}
        </button>
      ) : null}
      {label && handlePrimary ? (
        // A disabled commit takes the outline, never the fill.
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
