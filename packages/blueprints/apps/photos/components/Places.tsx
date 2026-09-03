import { useCallback, useState } from "react";

import type { InlineScope } from "../../inline-types.ts";
import { assetKey } from "../asset-key.ts";
import { justify } from "../layout.ts";
import { readableName } from "../place-map.ts";
import { PLACE_NO_LOCATION } from "../shared-copy.ts";
import { vaultMarker } from "../tile-state.ts";
import type { Asset } from "../types.ts";
import { PLACE_UNNAMED } from "../view-copy.ts";
import { PlaceMap, placePoints } from "./PlaceMap.tsx";
import { PlaceNaming } from "./PlaceNaming.tsx";
import { Tile } from "./Tile.tsx";

import styles from "./Places.module.css";

export interface PlaceSection {
  key: string;
  name: string | null;
  assets: Asset[];
  lat: number | null;
  lng: number | null;
  kind?: string | null;
  gazetteer?: string | null;
}

export const NO_LOCATION_KEY = "no-location";

export function placeSections(assets: readonly Asset[]): PlaceSection[] {
  const byPlace = new Map<string, PlaceSection>();
  for (const asset of assets) {
    const place = asset.place;
    if (!place) continue;
    const key = place.place_id ?? "";
    let section = byPlace.get(key);
    if (!section) {
      section = {
        key,
        name: place.name || null,
        assets: [],
        lat: place.lat ?? null,
        lng: place.lng ?? null,
        kind: place.kind ?? null,
        gazetteer: place.gazetteer ?? null,
      };
      byPlace.set(key, section);
    }
    section.assets.push(asset);
  }
  return [...byPlace.values()];
}

export function noLocationSection(
  assets: readonly Asset[]
): PlaceSection | null {
  const placeless = assets.filter((asset) => !asset.place);
  if (placeless.length === 0) return null;
  return {
    key: NO_LOCATION_KEY,
    name: PLACE_NO_LOCATION,
    assets: placeless,
    lat: null,
    lng: null,
  };
}

export function placeSectionsWithNoLocation(
  assets: readonly Asset[]
): PlaceSection[] {
  const bucket = noLocationSection(assets);
  return bucket ? [...placeSections(assets), bucket] : placeSections(assets);
}

function sectionDomId(key: string): string {
  return `place-${key || "unnamed"}`;
}

export function PlacesShelf({
  sections,
  containerWidth,
  targetHeight,
  rung,
  selectMode,
  selectedIds,
  vaultOf,
  refresh,
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
  refresh: () => Promise<void>;
  onOpen: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onEnterSelectMode: () => void;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const openPlace = useCallback((key: string) => {
    setReading(key);
    document
      .querySelector(`#${sectionDomId(key)}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className={styles.shelf}>
      {/* The map is the shelf's HEADER, never a separate destination, and it
          sizes to the same `containerWidth` the tile packer uses. */}
      <PlaceMap
        points={placePoints(sections)}
        width={containerWidth}
        activeKey={reading}
        onOpen={openPlace}
      />
      {sections.map((section) => (
        <section
          key={section.key || "unnamed"}
          id={sectionDomId(section.key)}
          className={styles.place}
        >
          <h2 className={styles.head}>
            {/* A coordinate-shaped label is NOT a name: it looks like an
                answer. `readableName` is the predicate both surfaces ask. */}
            <span className={styles.name}>
              {readableName(section.name) ?? PLACE_UNNAMED}
            </span>
            <span className={styles.count}>{section.assets.length}</span>
            {/* The ask sits exactly where the fallback shows (#816); a place
                with no id has no row to write to. */}
            {section.key && readableName(section.name) === null ? (
              <PlaceNaming
                placeId={section.key}
                scope={section.assets[0]?.scope_id}
                refresh={refresh}
              />
            ) : null}
          </h2>
          {justify(section.assets, containerWidth, targetHeight).map(
            (tiles, index) => (
              <div key={`${section.key}-${index}`} className={styles.row}>
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
