// The Collections header menu's MODEL (issue #712).
//
// iOS' own Collections page carries a chip that opens Show All / Collapse
// All plus a Reorder row and a grid-density control. This file states which
// of those this page can honestly offer, over the same anchored card
// `photos-library-menu.ts` built for Library — see that file's header for why
// the model lives as plain data with one pure builder rather than inline in
// the view.
//
// SHOW ALL / COLLAPSE ALL ARE REAL HERE, unlike some of iOS' own chrome this
// product has had to decline elsewhere: Collections is a stack of named
// sections (`photos-collections.ts`), so "collapse" has an honest per-page
// meaning — hide each section's rail and leave its heading and count standing
// — and these two rows just set every section's collapse state at once. The
// view owns the actual state (`PhotosCollectionsView.tsx`); this module only
// carries the two commands, which is why neither row is `checked` — a
// bulk-apply command is not itself a persistent answer the way a filter or a
// rung is, and marking one checked would claim a state that resets the moment
// a member expands one section by hand.
//
// NO REORDER ROW. `buildCollectionSections` returns a fixed, argued order —
// Memories first because it is the one section that changes on its own; then
// the member's own filing; then the standing shelves; then housekeeping last
// (see that file's header). Shipping a Reorder control honestly requires two
// things this pass does not have time to do right: a drag interaction over a
// vertical stack of unequal-height sections (a rail, not a uniform list row),
// and a persisted order that survives a relaunch — without persistence, a
// member who reorders once and reopens the app finds their library "moved
// back", which is a worse experience than no control at all. Rather than draw
// a row that forgets, the row does not exist; the argued order stays the one
// order there is.
//
// NO VIEW-OPTIONS / GRID-DENSITY ROW EITHER. Collections has no grid of its
// own — every section is a fixed-size rail of cover tiles (`TILE` in
// `PhotosCollectionsView.tsx`), not the pinch-and-rung timeline grid Library
// draws. The rung this vault does carry (`photos-rungs.ts`) governs that
// grid; drawing it here, over tiles it does not affect, would be a control
// wired to nothing.
//
// Pure — no react, no kit imports beyond the menu's own row types — so the
// two rows and their honesty can be asserted without a renderer
// (`photos-collections-menu.test.ts`).

import type { MenuGroup } from "../../kit/components/AnchoredMenu";

export interface CollectionsMenuInput {
  onShowAll: () => void;
  onCollapseAll: () => void;
}

/**
 * The Collections chip's whole menu: one group, two commands.
 */
export function collectionsMenuGroups({
  onShowAll,
  onCollapseAll,
}: CollectionsMenuInput): MenuGroup[] {
  return [
    {
      key: "sections",
      rows: [
        {
          key: "show-all",
          label: "Show All",
          icon: "list",
          onSelect: onShowAll,
        },
        {
          key: "collapse-all",
          label: "Collapse All",
          icon: "chevrons-down",
          onSelect: onCollapseAll,
        },
      ],
    },
  ];
}
