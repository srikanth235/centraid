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
  itemTitle?: string;
  gated: boolean;
  onPrimary?: () => void;
  onQuiet?: () => void;
  quietField?: string;
}

export function barTitle(state: AppBarState): string {
  if (state.shelf === ITEM && state.itemTitle) return state.itemTitle;
  const key = (
    state.shelf === null
      ? "items"
      : String(state.shelf).replace("built-in:", "")
  ) as keyof typeof ROUTE_TITLE;
  return ROUTE_TITLE[key] ?? ROUTE_TITLE.items;
}

export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(state.count, "items");
}

export function primaryLabel(shelf: ShelfId): string {
  return shelf === ITEM ? EDIT_ITEM : NEW_ITEM;
}

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
