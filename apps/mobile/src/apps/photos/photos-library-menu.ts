// Library header menu model (#712). The omissions are the point.
//
// NO SORT SECTION: `captured_at` is the only orderable key, so a "Recently
// Added" row would sort identically to Date Captured while claiming otherwise.
//
// FILTER stops at All/Favorites — the only honest per-asset predicates
// (`photos-collections.ts`). `kind === "video"` already has its own door
// (Collections' shelf, `PhotoStateView`'s `videos` mode).
//
// DETECT FACES (#724) opens the consent gate, NEVER the `request-enrichment`
// write; omitted entirely when the caller passes no handler.

import type { MenuGroup } from "../../kit/components/AnchoredMenu";
import type { DetectFacesAvailability } from "./people-model";
import { RUNGS, RUNG_LABELS } from "./photos-rungs";
import type { Rung } from "./photos-rungs";
import type { TimelineGrain } from "./timeline-grains";

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
  grain: TimelineGrain;
  detectFaces?: {
    availability: DetectFacesAvailability;
    onDetectFaces: () => void;
  };
}

/**
 * View Options is grain-scoped: Years and Months draw one cover per period at an
 * aspect the grain fixes, so a rung control there cannot act on what is on
 * screen. Filter holds at every grain — it narrows the sections periods are
 * built from.
 */
export function libraryMenuGroups({
  filter,
  onFilter,
  rung,
  onRung,
  grain,
  detectFaces,
}: LibraryMenuInput): MenuGroup[] {
  return [
    ...(detectFaces
      ? [
          {
            key: "enrichment",
            rows: [
              {
                key: "detect-faces",
                // One text slot per row, so a refusal rides after an em dash.
                label: detectFaces.availability.available
                  ? "Detect faces"
                  : `Detect faces — ${detectFaces.availability.reason ?? "not available yet"}`,
                icon: "users",
                disabled: !detectFaces.availability.available,
                onSelect: detectFaces.onDetectFaces,
              },
            ],
          },
        ]
      : []),
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
            // Closes the menu: the card would hide the grid it just changed.
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
                  // Stepping rungs against the live grid needs the card up.
                  staysOpen: true,
                })),
              },
            ]
          : []),
      ],
    },
  ];
}
