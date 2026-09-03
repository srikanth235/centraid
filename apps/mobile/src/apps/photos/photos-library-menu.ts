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
                  staysOpen: true,
                })),
              },
            ]
          : []),
      ],
    },
  ];
}
