// What Docs contributes to the FRAME (Docs spec §1.4, §11).
//
// The contribution SHAPE is `_shared/app-frame.tsx`, the same module
// `photos/frame.tsx` fills in; this file is what Docs puts in it — the shelf's
// own primary verb, its title and its count.
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

/**
 * The shelves whose app bar carries NO primary action (spec §2, the
 * `primaryLabel:''` list at prototype line 4636), and what the rest carry.
 *
 * This is a table rather than a chain of conditions because it is the one
 * place the product decides "does this screen have a commit at all" — and
 * because §2's list is long enough that expressing it inline is how a screen
 * ends up with a verb it cannot perform.
 */
const NO_PRIMARY: ReadonlySet<string> = new Set([
  // Trash's §2 label is "Empty trash". THE PLATFORM HAS NO DESTROY VERB
  // (spec §14: "Destruction happens only on the schedule a purge date
  // announces, so a trash cannot be emptied"), so the bar offers nothing
  // rather than a control that would refuse — the shelf's caption says why.
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
  /** The open folder's name — a folder carries its OWN title in the bar
   *  (§2 row 4), not the app's. */
  folderName?: string;
  /**
   * Fire the shelf's primary verb. OMITTED IS THE HONEST DEFAULT: a bar that
   * drew "New" with nothing behind it would be a dead control. The label comes
   * from `primaryLabel`, so a caller cannot name the verb something the shelf
   * does not have.
   */
  onPrimary?: () => void;
  /** Why the primary cannot fire, when it cannot. */
  primaryDisabledReason?: string;
  /**
   * Enter or leave SELECTION MODE (§4.1's `showBox`). Omitted where selection
   * means nothing — a shelf that paints no rows has nothing to select — so the
   * bar simply does not carry the verb there rather than carrying a dead one.
   */
  onToggleSelecting?: () => void;
  /** Whether the mode is on, which is the whole difference between the two
   *  words the verb can say. */
  selecting?: boolean;
}

/**
 * The bar's count, in the words the product uses. `null` contributes nothing
 * rather than a zero the view had to invent.
 */
export function barCount(state: AppBarState): ReactNode {
  if (state.count === null) return undefined;
  return countLabel(state.count, shelfCopy(state.shelf, state.folderName).unit);
}

/** The bar's title for a shelf — the app's own name on most shelves, the
 *  shelf's name where the shelf IS the subject, the folder's name in a
 *  folder (§2). */
export function barTitle(state: AppBarState): string {
  return shelfCopy(state.shelf, state.folderName).title;
}

/**
 * The app bar contribution. Search first (quiet), then Select (quiet), then the
 * shelf's primary last (filled) — the frame's own affordances stand beside
 * these, never displaced by them.
 *
 * ONE FILLED CONTROL. Select is an outline whatever mode it is in: entering
 * selection is not the commit, it is the thing you do before deciding what the
 * commit is, and the selection bar that appears underneath carries the verbs
 * that actually change something.
 */
export function appBar(state: AppBarState): InlineAppBarContribution {
  const label = primaryLabel(state.shelf);
  const disabled = state.primaryDisabledReason !== undefined;
  const handlePrimary = state.onPrimary;
  const handleSearch = state.onSearch;
  const handleSelecting = state.onToggleSelecting;
  const actions: ReactNode = (
    <>
      {!state.compact && handleSearch ? (
        // The bar's own way to Search, desktop/PWA only. Outlined, never
        // filled: the shelf's own verb stays the one filled element in the view.
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
        // A disabled commit takes the plain outline, never the fill.
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

/** The compact band claim (§1.4) — Docs' own four destinations plus More
 *  (`BAND_DESTINATIONS`), which the frame ignores on any surface that is not
 *  compact, so the app never has to ask whether it may claim. */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return claimBand(BAND_DESTINATIONS, bandActiveId(shelf), onSelect, onMore);
}
