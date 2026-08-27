// What Locker contributes to the FRAME (README-Locker §1).
//
// The contribution SHAPE is `_shared/app-frame.tsx`, the same module Tasks,
// Docs and Photos fill in; this file is what Locker puts in it — the route's
// title, its count, its ONE filled verb and its quiet second one.
//
// THE ONE FILLED CONTROL IS `New item`, or `Edit` on an item. `Generate` and
// `Copy password` are QUIET, and `Copy password` is quiet for a reason worth
// stating: it opens the permit gate exactly like any other reveal. A filled
// button beside a sealed value would read as "take it", and the whole claim of
// this app is that taking it costs a permit and a receipt.
//
// BEHIND A GATE THE BAR CONTRIBUTES NO VERB AT ALL. A first run, a lock, a
// denied grant and the refused seat each leave a bar with a title and nothing
// to press — not a disabled button, which would teach a member that the app is
// broken rather than that it is closed.
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
import { BAND_DESTINATIONS, ITEM, bandActiveId, railShelf } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import {
  COPY,
  COPY_PASSWORD,
  EDIT_ITEM,
  FIELD_LABEL,
  GENERATE,
  NEW_ITEM,
  ROUTE_TITLE,
} from "./view-copy.ts";

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  /** The open item's own title — an item carries its own name in the bar. */
  itemTitle?: string;
  /** True while a gate stands: first run, lock, denied, or the refused seat.
   *  The bar keeps its title and drops every verb. */
  gated: boolean;
  /** Create an item, or edit the open one. */
  onPrimary?: () => void;
  /** Reach the generator, or ask for the open item's own sealed field — which
   *  opens the permit gate, never a copy. */
  onQuiet?: () => void;
  /** The field the quiet verb would copy on an item, so the word matches what
   *  this TYPE actually seals: a card's number, a note's body. Absent
   *  everywhere but an item. */
  quietField?: string;
}

/** The bar's title. Items is *Locker*; one item is its own title; every other
 *  route is named for itself. */
export function barTitle(state: AppBarState): string {
  if (state.shelf === ITEM && state.itemTitle) return state.itemTitle;
  const key = (
    state.shelf === null
      ? "items"
      : String(state.shelf).replace("built-in:", "")
  ) as keyof typeof ROUTE_TITLE;
  return ROUTE_TITLE[key] ?? ROUTE_TITLE.items;
}

/** The bar's count. `null` contributes nothing rather than a zero the view had
 *  to invent — which is exactly what a locked vault has. */
export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(state.count, "items");
}

/** The primary's word for this route. */
export function primaryLabel(shelf: ShelfId): string {
  return shelf === ITEM ? EDIT_ITEM : NEW_ITEM;
}

/**
 * The quiet verb's word. On an item it is the copy that opens the gate, named
 * for the field the item actually seals; everywhere else it reaches the
 * generator. Verb-first and two words, always.
 */
export function quietLabel(shelf: ShelfId, field?: string): string {
  if (shelf !== ITEM) return GENERATE;
  if (!field || field === "password") return COPY_PASSWORD;
  return `${COPY} ${(FIELD_LABEL[field] ?? "value").toLowerCase()}`;
}

export function appBar(state: AppBarState): InlineAppBarContribution {
  const primary = state.onPrimary;
  const quiet = state.onQuiet;
  const search = state.onSearch;
  const actions: ReactNode = state.gated ? null : (
    <>
      {!state.compact && search ? (
        <SearchBarButton label="Search items" onSearch={search} />
      ) : null}
      {quiet ? (
        <button type="button" className="kit-btn" onClick={quiet}>
          {quietLabel(state.shelf, state.quietField)}
        </button>
      ) : null}
      {primary ? (
        <button type="button" className="kit-btn primary" onClick={primary}>
          {primaryLabel(state.shelf)}
        </button>
      ) : null}
    </>
  );
  return {
    title: barTitle(state),
    ...(state.gated ? {} : { count: barCount(state) }),
    actions,
  };
}

/** The compact band claim (§1) — Locker's own four destinations plus More,
 *  which the frame ignores on any surface that is not compact. A gate claims
 *  NOTHING: `null` withdraws the band rather than drawing a dead one. */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(
    BAND_DESTINATIONS,
    bandActiveId(railShelf(shelf)),
    onSelect,
    onMore
  );
}
