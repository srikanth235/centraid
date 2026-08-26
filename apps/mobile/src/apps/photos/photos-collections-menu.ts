// The Collections header menu's model (#712): Show All / Collapse All only.
// NO REORDER ROW — no order is persisted; a control that forgets across
// relaunch is worse than none. NO GRID-DENSITY ROW — Collections draws rails,
// not the rung grid `photos-rungs.ts` governs. Neither row is `checked`: a
// bulk-apply command is not a persistent answer.

import type { MenuGroup } from "../../kit/components/AnchoredMenu";

export interface CollectionsMenuInput {
  onShowAll: () => void;
  onCollapseAll: () => void;
}

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
