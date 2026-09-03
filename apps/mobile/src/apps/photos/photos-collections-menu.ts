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
