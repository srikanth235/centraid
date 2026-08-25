// What Photos contributes to the FRAME (v4 handoff §3, §3.1).
//
// The contribution SHAPE is `_shared/app-frame.tsx`; this file is what Photos
// puts in it. Two of these actions are Photos' own: `Select` (outlined) and
// `Import` (the ONE filled ink element in the view, §18). The frame draws the
// app mark chip, the 20/26 title and the numeric register around them.
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
import { BAND_DESTINATIONS, bandActiveId } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

export interface AppBarState extends AppBarBase {
  /** The shelf's own title, or an album's (§5: album detail carries the
   *  album's own title and count in the bar). */
  title: string;
  /** The noun the count counts. Final copy. */
  unit?: string;
  showSelect: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  showImport: boolean;
  onImport: () => void;
  /** Why Import cannot fire, when it cannot. A disabled commit is NOT filled
   *  (§18), so the reason rides the control rather than a tooltip alone. */
  importDisabledReason?: string;
  /**
   * On the phone, while selecting, `Select all`/`Select none` stays in the
   * head with the count and `Done` — the five actions are the only thing
   * that moves to the bottom bar (§6, §15). Desktop/PWA carry Select all
   * inside the bar itself, so this is left off there. Setting it also swaps
   * `count` to the number SELECTED rather than the shelf's total, because a
   * head that still read "128 photographs" while five were picked would be
   * answering a different question than the one being asked.
   */
  onToggleAll?: () => void;
  selectedCount?: number;
}

/** The bar's count, in words the product uses. `null` contributes nothing
 *  rather than a zero the view had to invent. While the phone's `Select all`
 *  rides the head (`onToggleAll` set), the count it answers is how many are
 *  SELECTED, not the shelf's total — a different question once picking has
 *  started. */
export function barCount(state: AppBarState): ReactNode {
  if (state.onToggleAll && state.selectMode) {
    return `${state.selectedCount ?? 0} selected`;
  }
  if (state.count === null) return undefined;
  return countLabel(state.count, state.unit ?? "photographs");
}

/**
 * The app bar contribution. `Select` first (quiet), `Import` last (filled) —
 * the frame's own affordances stand beside these, never displaced by them.
 */
export function appBar(state: AppBarState): InlineAppBarContribution {
  const disabled = state.showImport && state.importDisabledReason !== undefined;
  const handleToggleSelect = state.onToggleSelect;
  const handleImport = state.onImport;
  const handleToggleAll = state.onToggleAll;
  const handleSearch = state.onSearch;
  const actions: ReactNode = (
    <>
      {!state.compact && handleSearch ? (
        // The bar's own way to Search (§9), desktop/PWA only. Import stays the
        // one filled element in the view (§18), so this one is outlined.
        <SearchBarButton label="Search" onSearch={handleSearch} />
      ) : null}
      {state.selectMode && handleToggleAll ? (
        // The phone only (§6, §15): desktop/PWA carry Select all/none inside
        // the bar itself.
        <button type="button" className="kit-btn" onClick={handleToggleAll}>
          {(state.selectedCount ?? 0) > 0 ? "Select none" : "Select all"}
        </button>
      ) : null}
      {state.showSelect ? (
        <button
          type="button"
          className="kit-btn"
          data-active={state.selectMode ? "true" : "false"}
          onClick={handleToggleSelect}
        >
          {state.selectMode ? "Done" : "Select"}
        </button>
      ) : null}
      {state.showImport ? (
        // `uploadBtn` is the id upload.ts drives and `applyUploadTarget`
        // re-reads on every render.
        // A disabled commit takes the plain outline, never the fill (§18).
        <button
          type="button"
          id="uploadBtn"
          className={disabled ? "kit-btn" : "kit-btn primary"}
          disabled={disabled}
          title={state.importDisabledReason}
          onClick={handleImport}
        >
          Import
        </button>
      ) : null}
    </>
  );
  return { title: state.title, count: barCount(state), actions };
}

/** The compact band claim (§3.1) — Photos' own four destinations plus More
 *  (`BAND_DESTINATIONS`), which the frame ignores on any surface that is not
 *  compact, so the app never has to ask whether it may claim. */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
