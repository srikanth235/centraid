// Agenda's FRAME contribution (shape in _shared/app-frame.tsx): ONE FILLED
// CONTROL PER VIEW — `New event` is it; search, Today and the arrows stay
// outlines because moving the window is not the commit.
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
import type { ViewKind } from "./types.ts";
import {
  NEW_EVENT,
  NEXT,
  PREVIOUS,
  SEARCH_LABEL,
  TODAY,
  VIEW_LABELS,
  VIEW_UNITS,
} from "./view-copy.ts";
import { BAND_DESTINATIONS, POINTER_VIEWS, bandActiveId } from "./views.ts";

export interface AppBarState extends AppBarBase {
  view: ViewKind;
  range: string;
  onSetView: (view: ViewKind) => void;
  onToday: () => void;
  onStep: (direction: -1 | 1) => void;
  onNew: () => void;
  /** Why the commit cannot fire when a write scope is denied. */
  newDisabledReason?: string;
}

export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(state.count, VIEW_UNITS[state.view]);
}

/** Pointer-only switcher; on compact the band carries Search too. */
export function appBar(state: AppBarState): InlineAppBarContribution {
  const disabled = state.newDisabledReason !== undefined;
  const handleToday = state.onToday;
  const handleNew = state.onNew;
  const handleSearch = state.onSearch;
  const actions: ReactNode = (
    <>
      {state.compact ? null : (
        <fieldset className="kit-seg" aria-label="View">
          {POINTER_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={state.view === view}
              onClick={() => state.onSetView(view)}
            >
              {VIEW_LABELS[view]}
            </button>
          ))}
        </fieldset>
      )}
      <button type="button" className="kit-btn" onClick={handleToday}>
        {TODAY}
      </button>
      <button
        type="button"
        className="kit-icon-btn"
        aria-label={PREVIOUS}
        onClick={() => state.onStep(-1)}
      >
        ‹
      </button>
      <button
        type="button"
        className="kit-icon-btn"
        aria-label={NEXT}
        onClick={() => state.onStep(1)}
      >
        ›
      </button>
      {!state.compact && handleSearch ? (
        <SearchBarButton label={SEARCH_LABEL} onSearch={handleSearch} />
      ) : null}
      <button
        type="button"
        className={disabled ? "kit-btn" : "kit-btn primary"}
        disabled={disabled}
        title={state.newDisabledReason}
        onClick={handleNew}
      >
        {NEW_EVENT}
      </button>
    </>
  );
  return { title: state.range, count: barCount(state), actions };
}

/** Ignored off compact. Takes the RESOLVED view. */
export function bandClaim(
  view: ViewKind,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(view), onSelect, onMore);
}
