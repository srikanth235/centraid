// What Photos contributes to the FRAME (v4 handoff §3, §3.1).
//
// Photos is a route inside the frame, not a standalone app. The app bar, the
// one status line and the compact band are the frame's; this module says what
// they should CARRY and nothing about how they look. There is no class, no
// colour and no metric here on purpose — an app that could restyle the bar
// would be drawing a second chrome inside the first, which is the duplication
// the contribution channel exists to retire.
//
// Two of these actions are Photos': `Select` (outlined) and `Import` (the ONE
// filled ink element in the view, §18). The frame draws the app mark chip, the
// 20/26 title and the numeric register around them.
import type { CSSProperties, ReactNode } from "react";

import type {
  InlineAppBarContribution,
  InlineBandClaim,
  InlineFrame,
} from "../inline-types.ts";
import { SearchIcon } from "./icons.tsx";
import { BAND_DESTINATIONS, bandActiveId } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

export interface AppBarState {
  /** The shelf's own title, or an album's (§5: album detail carries the
   *  album's own title and count in the bar). */
  title: string;
  /** How many photographs this view is showing, or null where a count would
   *  have to be invented (the Duplicates clusters, an empty Places map). */
  count: number | null;
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
  /**
   * Is this surface compact? On compact, the band already carries a Search
   * destination (§3.1) — a second Search control in the bar would be a
   * second way to the same place. Desktop/PWA has no band, so the bar is the
   * only way in, and §9's search page was unreachable there until this
   * control existed.
   */
  compact: boolean;
  /** Reach the Search shelf. Omitted on a surface with no way to search
   *  (there is none today, but the bar should not assume one forever). */
  onSearch?: () => void;
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
  const unit = state.unit ?? "photographs";
  const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${state.count} ${state.count === 1 ? singular : unit}`;
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
        // The bar's own way to Search (§9), desktop/PWA only — the compact
        // band already claims a Search destination (§3.1), so this control
        // would double it there. Outlined, never filled: Import stays the
        // one filled element in the view (§18).
        <button
          type="button"
          className="kit-icon-btn"
          aria-label="Search"
          style={
            {
              "--icon-button-size": "34px",
              border: "1px solid var(--line-strong)",
              borderRadius: "7px",
            } as CSSProperties
          }
          onClick={handleSearch}
        >
          <SearchIcon size={16} />
        </button>
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
        // re-reads on every render; it moved here from the retired drawer.
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

/**
 * The compact band claim (§3.1). Photos claims it with exactly Library ·
 * Albums · People · Search · More; the frame keeps the home capsule outside
 * this group, enforces the cap, and ignores the claim entirely on a surface
 * that is not compact — so the app never has to ask whether it may.
 */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return {
    destinations: BAND_DESTINATIONS,
    activeId: bandActiveId(shelf),
    onSelect,
    onMore,
  };
}

/** One write's outcome, as the status line carries it (§16 `outcome`). */
export interface Outcome {
  text: string;
  /** The inline text action — Photos is the first route to use that slot, and
   *  it uses it for Undo (§3). */
  undo?: () => void;
  /** …or for a NAMED action where the sentence is not an undo: issue #738's
   *  refused-write announcement answers with "Discard", and calling that
   *  button "Undo" would say the opposite of what it does. Wins over `undo`
   *  when both are set; still exactly ONE action, so the §3 budget holds. */
  action?: { label: string; run: () => void };
  /** Determinate progress with exact counts. Never a spinner (§14). */
  progress?: { done: number; total: number; unit?: string };
}

/** Put an outcome on the frame's ONE status line, or take it back down. */
export function publishOutcome(
  frame: InlineFrame,
  outcome: Outcome | null
): void {
  if (outcome === null || outcome.text === "") {
    frame.clearStatus();
    return;
  }
  frame.setStatus(outcome.text, {
    ...(outcome.action
      ? { action: outcome.action }
      : outcome.undo
        ? { action: { label: "Undo", run: outcome.undo } }
        : {}),
    ...(outcome.progress ? { progress: outcome.progress } : {}),
  });
}
