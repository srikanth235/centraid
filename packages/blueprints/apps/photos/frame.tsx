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
  title: string;
  unit?: string;
  showSelect: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  showImport: boolean;
  onImport: () => void;
  importDisabledReason?: string;
  onToggleAll?: () => void;
  selectedCount?: number;
}

export function barCount(state: AppBarState): ReactNode {
  if (state.onToggleAll && state.selectMode) {
    return `${state.selectedCount ?? 0} selected`;
  }
  if (state.count === null) return undefined;
  return countLabel(state.count, state.unit ?? "photographs");
}

export function appBar(state: AppBarState): InlineAppBarContribution {
  const disabled = state.showImport && state.importDisabledReason !== undefined;
  const handleToggleSelect = state.onToggleSelect;
  const handleImport = state.onImport;
  const handleToggleAll = state.onToggleAll;
  const handleSearch = state.onSearch;
  const actions: ReactNode = (
    <>
      {!state.compact && handleSearch ? (
        <SearchBarButton label="Search" onSearch={handleSearch} />
      ) : null}
      {state.selectMode && handleToggleAll ? (
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

export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
