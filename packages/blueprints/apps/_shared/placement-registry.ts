export type PlaceableItemType =
  | "core.collection"
  | "core.content_item"
  | "core.document"
  | "docs.folder"
  | "media.asset"
  | "tally.group";

export interface PlacementEntity {
  itemType: PlaceableItemType;
  appId: string;
  label: string;
}

export const PLACEMENT_REGISTRY: readonly PlacementEntity[] = [
  { itemType: "core.collection", appId: "photos", label: "album" },
  { itemType: "core.content_item", appId: "notes", label: "note" },
  { itemType: "core.document", appId: "docs", label: "document" },
  { itemType: "docs.folder", appId: "docs", label: "folder" },
  { itemType: "media.asset", appId: "photos", label: "photo" },
  { itemType: "tally.group", appId: "tally", label: "group" },
];

export function placementEntity(
  itemType: PlaceableItemType
): PlacementEntity | undefined {
  return PLACEMENT_REGISTRY.find((entity) => entity.itemType === itemType);
}
