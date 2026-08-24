// A4 — the placement registry (issue #712).
//
// This module is the ONE place that answers "what can be placed into an
// audience vault, and which app owns it". Every placement control reads its
// `itemType` union from here instead of restating it: the shared web
// `ShareSheet` and `grant-plane.ts` here, and the mobile share sheet's own
// twin of them.
//
// A7 — LOCKER IS STRUCTURALLY EXCLUDED. `packages/vault/src/share/closure.ts`
// keeps `locker.item` in its `ShareableItemType` because the vault-level
// primitive from issue #599 decision 11 (a household "watchtower" vault could
// in principle project a locker item into it) never went away. But no
// SHIPPED app offers that door: a secret is the one thing v0 refuses to let a
// member place, full stop, so `locker.item` is left OUT of
// `PlaceableItemType` on purpose — not filtered at render time, but
// unrepresentable in the type every placement control is typed against. A
// future UI that wanted to reopen this would have to touch this file and
// argue the case, not just import a wider string.
//
// THIS TYPE IS A HAND-MAINTAINED MIRROR, not an import. Blueprint apps run in
// the browser, so this file never imports `@centraid/vault` — that package is
// Node-only (`node:sqlite`, `better-sqlite3`) and has no business resolving in
// a browser's module graph, even for types. `packages/blueprints/src/placement-registry.test.ts`
// source-scans `closure.ts`'s `ShareableItemType` literal and asserts this
// union stays exactly that list minus `"locker.item"`, so the two can never
// drift silently.
export type PlaceableItemType =
  | "core.collection"
  | "core.content_item"
  | "core.document"
  | "docs.folder"
  | "media.asset"
  | "tally.group";

/** One entity the registry knows how to place, and which app it belongs to. */
export interface PlacementEntity {
  itemType: PlaceableItemType;
  /** The blueprint app id this entity's rows live in — `apps/<appId>`. */
  appId: string;
  /** Singular, sentence-case noun for placement copy ("Share this <label>"). */
  label: string;
}

/**
 * The whole registry. Order is not meaningful — every consumer looks entities
 * up by `itemType`, never by position.
 */
export const PLACEMENT_REGISTRY: readonly PlacementEntity[] = [
  { itemType: "core.collection", appId: "photos", label: "album" },
  { itemType: "core.content_item", appId: "notes", label: "note" },
  { itemType: "core.document", appId: "docs", label: "document" },
  { itemType: "docs.folder", appId: "docs", label: "folder" },
  { itemType: "media.asset", appId: "photos", label: "photo" },
  { itemType: "tally.group", appId: "tally", label: "group" },
];

/** Every placeable item type, for a control that needs the bare list. */
export const PLACEABLE_ITEM_TYPES: readonly PlaceableItemType[] =
  PLACEMENT_REGISTRY.map((entity) => entity.itemType);

/** The registry entry for one item type, or undefined for a value that is not
 *  in it (including, structurally, `"locker.item"`). */
export function placementEntity(
  itemType: PlaceableItemType
): PlacementEntity | undefined {
  return PLACEMENT_REGISTRY.find((entity) => entity.itemType === itemType);
}
