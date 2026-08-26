// Placement registry (#712): the one `itemType` union every placement
// control reads. A7 — `locker.item` is unrepresentable here (vault
// `ShareableItemType` still has it). A secret cannot be placed.
// Hand-maintained mirror of that union minus locker — never import
// `@centraid/vault` (Node-only). `placement-registry.test.ts` source-scans
// `closure.ts`.
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

export const PLACEABLE_ITEM_TYPES: readonly PlaceableItemType[] =
  PLACEMENT_REGISTRY.map((entity) => entity.itemType);

export function placementEntity(
  itemType: PlaceableItemType
): PlacementEntity | undefined {
  return PLACEMENT_REGISTRY.find((entity) => entity.itemType === itemType);
}
