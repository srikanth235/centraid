// The Library header menu's MODEL (issue #712).
//
// iOS' Library header carries a chip that opens an anchored menu — Sort, then
// a Filter submenu, then View Options (grid density). This file states which
// of those three this vault can honestly offer, and the two omissions are the
// point of the file: the rows that are NOT here are a claim about what the
// data can answer, and that claim has to survive being read by whoever adds
// the next row.
//
// The presentation is `kit/components/AnchoredMenu.tsx` — the same floating
// card any app's header chip gets. This module is plain data and one pure
// builder, so the anatomy above can be asserted without a renderer.
//
// NO SORT SECTION. iOS' "Recently Added" needs an added-at timestamp that is
// genuinely independent of capture time. This vault's replica row carries only
// `captured_at`, with the content row's `created_at` folded in as
// `capturedAt`'s OWN fallback when `captured_at` is absent
// (`timeline-engine.ts`) — not a second, independently-orderable field. A
// "Recently Added" row here would sort by the exact same key as "Date
// Captured" while claiming to do something else, which is a worse lie than no
// row at all. Date Captured (newest first, `mergePhotoAssets`' own sort) is
// the timeline's only order, so there is nothing for a Sort section to choose
// between.
//
// FILTER: All Photos and Favorites are the two facts a member's own vault can
// answer honestly (`PhotoAsset.favorite`). iOS also offers Videos,
// Screenshots, Selfies and more; this repo has no honest way to tell a
// screenshot or a selfie from any other photograph today — see the header
// comment of `photos-collections.ts` for why a shelf that would sometimes come
// back empty by construction is worse than a shelf that does not exist.
// `PhotoAsset.kind` DOES carry "video" honestly, and Collections grew a
// Videos shelf on that fact (issue #721 B3) — but this Filter row did not
// grow a matching entry alongside it: this menu narrows the SECTIONS the
// Years/Months grains are built from, and Videos already has its own door
// (Collections' shelf, and `PhotoStateView`'s `videos` mode); adding a second
// path to the same filter here is a separate, deliberate call rather than a
// gap in this pass.
//
// TILE SIZE came here from `PhotosMoreSheet.tsx` by way of the bottom sheet
// this menu replaced — see that file's header for why it left the More sheet,
// and `photos-rungs.ts` for why the value is one shared, persisted member
// preference rather than menu-local state. Inside a menu it is FOUR CHECKED
// ROWS, not the stepper the sheet drew: a menu row's whole grammar is "this is
// the current answer, here are the others", and a `‹ M ›` stepper inside one
// would be a second, different control idiom in a card that has room for
// neither. The rows also state where the ends are — at XS there is visibly
// nothing below it — which the stepper could only say by disabling a chevron.

import type { MenuGroup } from "../../kit/components/AnchoredMenu";
import { RUNGS, RUNG_LABELS } from "./photos-rungs";
import type { Rung } from "./photos-rungs";
import type { TimelineGrain } from "./timeline-grains";

/** The two facts this vault can answer honestly — see the header comment for
 *  why the set stops here rather than growing to iOS' full filter list. */
export type LibraryFilter = "all" | "favorites";

const FILTER_ROWS: ReadonlyArray<{ key: LibraryFilter; label: string }> = [
  { key: "all", label: "All Photos" },
  { key: "favorites", label: "Favorites" },
];

export interface LibraryMenuInput {
  filter: LibraryFilter;
  onFilter: (filter: LibraryFilter) => void;
  rung: Rung;
  onRung: (rung: Rung) => void;
  /** The grain on screen (`timeline-grains.ts`). View Options is dropped at
   *  the Years and Months grains — see below. */
  grain: TimelineGrain;
}

/**
 * The Library chip's whole menu: two disclosure rows in one group, and no
 * third.
 *
 * Both are submenus rather than flat groups because the card is 280 wide and
 * the header chip is at the top of the screen — six rows hanging off it would
 * reach the middle of the grid to answer a question a member asks rarely.
 *
 * VIEW OPTIONS IS GRAIN-SCOPED. The rung sizes justified tiles, and the Years
 * and Months grids draw no tiles — one cover per period at an aspect the grain
 * itself fixes. Leaving the submenu up there would let a member step XS→L four
 * times over a page that cannot change, which is the same "a control that
 * cannot act on what is on screen" failure the header chip's own
 * destination-scoping exists to prevent (`PhotosHome.tsx`). Filter stays: it
 * narrows the sections the periods are BUILT from, so it is answerable at
 * every grain.
 */
export function libraryMenuGroups({
  filter,
  onFilter,
  rung,
  onRung,
  grain,
}: LibraryMenuInput): MenuGroup[] {
  return [
    {
      key: "library",
      rows: [
        {
          key: "filter",
          label: "Filter",
          icon: "Filter",
          rows: FILTER_ROWS.map((row) => ({
            checked: row.key === filter,
            key: row.key,
            label: row.label,
            // A filter choice CLOSES the menu — it is a destination-weight
            // decision (what the grid shows), and holding a card over the
            // answer would hide the very thing that just changed.
            onSelect: () => onFilter(row.key),
          })),
        },
        ...(grain === "all"
          ? [
              {
                key: "view-options",
                label: "View Options",
                icon: "Grid",
                rows: RUNGS.map((_target, index) => ({
                  checked: index === rung,
                  key: RUNG_LABELS[index]!,
                  label: RUNG_LABELS[index]!,
                  onSelect: () => onRung(index as Rung),
                  // iOS' tile-size rows keep the menu up: a member steps a rung,
                  // sees the grid behind the card change, and steps again.
                  // Closing after each one would cost three taps per rung.
                  staysOpen: true,
                })),
              },
            ]
          : []),
      ],
    },
  ];
}
