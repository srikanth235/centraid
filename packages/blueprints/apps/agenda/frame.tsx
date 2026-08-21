// What Agenda contributes to the FRAME (the app bar, the compact band).
//
// The contribution SHAPE is `_shared/app-frame.tsx`, the same module Docs and
// Photos fill in; this file is what Agenda puts in it — the range it is
// showing, how many rows that is, the view switcher on pointer, and the one
// filled verb.
//
// ONE FILLED CONTROL PER VIEW. `New event` is it. Search is an outline and
// only on pointer, because on compact the band already carries a way in;
// Today and the two arrows are outlines because moving the window is not the
// commit.
import type { ReactNode } from "react";

import {
  SearchBarButton,
  bandClaim as claimBand,
  countLabel,
} from "../_shared/app-frame.tsx";
import type { AppBarBase } from "../_shared/app-frame.tsx";
import type { BandDestination } from "../_shared/shelves.ts";
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
import { POINTER_VIEWS, TOUCH_VIEWS } from "./views.ts";

/** Supporting glyphs, from the shared registry. An unknown key draws no glyph
 *  rather than a broken one, and the label names the tab either way. */
const BAND_ICONS: Readonly<Record<ViewKind, string>> = {
  month: "Calendar",
  week: "Calendar",
  day: "Clock",
  schedule: "List",
  waiting: "Inbox",
};

/**
 * The compact band's four destinations plus More — each one a VIEW, because
 * Agenda has one route and its views are its places. The frame keeps its home
 * capsule outside this group and enforces the cap, so the app never has to ask.
 */
export const BAND_DESTINATIONS: readonly BandDestination[] = TOUCH_VIEWS.map(
  (view) => ({ id: view, label: VIEW_LABELS[view], icon: BAND_ICONS[view] })
);

export interface AppBarState extends AppBarBase {
  view: ViewKind;
  /** The range the current view is showing, in the member's own locale. */
  range: string;
  onSetView: (view: ViewKind) => void;
  onToday: () => void;
  onStep: (direction: -1 | 1) => void;
  onNew: () => void;
  /** Why the commit cannot fire, when a denied write scope means it cannot.
   *  A filled control that cannot be pressed stops being filled. */
  newDisabledReason?: string;
}

/** The bar's count, in the words this view uses. */
export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(state.count, VIEW_UNITS[state.view]);
}

/**
 * The app bar contribution: the range as the title, the count beside it, then
 * the quiet controls and the one filled verb last.
 *
 * The VIEW SWITCHER is a pointer-only segmented control (the frame's own §2
 * rule); on compact the band carries the same four destinations, so drawing
 * both would be two answers to one question.
 */
export function appBar(state: AppBarState): InlineAppBarContribution {
  const disabled = state.newDisabledReason !== undefined;
  const actions: ReactNode = (
    <>
      {state.compact ? null : (
        <div className="kit-seg" role="group" aria-label="View">
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
        </div>
      )}
      <button type="button" className="kit-btn" onClick={state.onToday}>
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
      {!state.compact && state.onSearch ? (
        <SearchBarButton label={SEARCH_LABEL} onSearch={state.onSearch} />
      ) : null}
      <button
        type="button"
        className={disabled ? "kit-btn" : "kit-btn primary"}
        disabled={disabled}
        title={state.newDisabledReason}
        onClick={state.onNew}
      >
        {NEW_EVENT}
      </button>
    </>
  );
  return { title: state.range, count: barCount(state), actions };
}

/** The compact band claim — the frame ignores it on any surface that is not
 *  compact, so the app never has to ask whether it may claim. */
export function bandClaim(
  view: ViewKind,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, view, onSelect, onMore);
}
