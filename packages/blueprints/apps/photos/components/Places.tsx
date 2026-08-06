import type { InlineScope } from "../../inline-types.ts";
// The Places shelf (v4 handoff §5) — SECTIONS, NOT CARTOGRAPHY.
//
// The handoff draws a map above the place cards and says so plainly in its own
// "still open": *Places ships with a placeholder map. Real geography is a data
// question, not a layout one.* A placeholder map is a picture of a promise —
// it would put pins where nothing was measured — so this surface ships the
// half that IS grounded: one section per place, in the member's own order of
// recency, each a place name, a count in tabular mono, and justified rows of
// the SAME tile at the SAME rung as the timeline (§5: a shelf is the same
// timeline under a filter).
//
// A place row with no name is not "Unknown": the record knows exactly where
// these were taken and simply has no label to print, and `PLACE_UNNAMED` says
// which of the two is true.
import { assetKey } from "../asset-key.ts";
import { justify } from "../layout.ts";
import { vaultMarker } from "../tile-state.ts";
import type { Asset } from "../types.ts";
import { PLACE_UNNAMED } from "../view-copy.ts";
import { Tile } from "./Tile.tsx";

import styles from "./Places.module.css";

/** One place and everything in the loaded window taken there. */
export interface PlaceSection {
  /** The place id, or `""` for the group of rows whose place carries no name. */
  key: string;
  name: string | null;
  assets: Asset[];
}

/**
 * Group assets into place sections, newest place first. Only assets that
 * actually carry a place appear: a photograph with no place is not "somewhere
 * unknown", it is a photograph nobody told where it was taken, and inventing
 * a section for it would be a claim about geography.
 */
export function placeSections(assets: readonly Asset[]): PlaceSection[] {
  const byPlace = new Map<string, PlaceSection>();
  for (const asset of assets) {
    const place = asset.place;
    if (!place) continue;
    const key = place.place_id ?? "";
    let section = byPlace.get(key);
    if (!section) {
      section = { key, name: place.name || null, assets: [] };
      byPlace.set(key, section);
    }
    section.assets.push(asset);
  }
  return [...byPlace.values()];
}

export function PlacesShelf({
  sections,
  containerWidth,
  targetHeight,
  rung,
  selectMode,
  selectedIds,
  vaultOf,
  onOpen,
  onToggleSelect,
  onEnterSelectMode,
}: {
  sections: readonly PlaceSection[];
  containerWidth: number;
  targetHeight: number;
  rung: number;
  selectMode: boolean;
  selectedIds: Set<string>;
  vaultOf: (scopeId: string | null | undefined) => InlineScope | undefined;
  onOpen: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onEnterSelectMode: () => void;
}) {
  return (
    <div className={styles.shelf}>
      {sections.map((section) => (
        <section key={section.key || "unnamed"} className={styles.place}>
          <h2 className={styles.head}>
            <span className={styles.name}>{section.name ?? PLACE_UNNAMED}</span>
            <span className={styles.count}>{section.assets.length}</span>
          </h2>
          {justify(section.assets, containerWidth, targetHeight).map(
            (tiles, index) => (
              <div
                // The row index is stable for a given section and width: the
                // packer is pure, so re-packing the same assets emits the same
                // rows in the same order.
                key={`${section.key}-${index}`}
                className={styles.row}
              >
                {tiles.map((tile) => (
                  <Tile
                    key={`${tile.asset.scope_id ?? ""}:${tile.asset.asset_id}`}
                    asset={tile.asset}
                    width={tile.width}
                    height={tile.height}
                    rung={rung}
                    selected={selectedIds.has(assetKey(tile.asset))}
                    selectMode={selectMode}
                    vaultMark={vaultMarker(vaultOf(tile.asset.scope_id))}
                    onOpen={onOpen}
                    onToggleSelect={onToggleSelect}
                    onEnterSelectMode={onEnterSelectMode}
                  />
                ))}
              </div>
            )
          )}
        </section>
      ))}
    </div>
  );
}
