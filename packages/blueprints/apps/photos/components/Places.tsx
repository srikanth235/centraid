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

/** One place and everything in the loaded window taken there. */
export interface PlaceSection {
  /** The place id, `""` for the group of rows whose place carries no name, or
   *  `NO_LOCATION_KEY` for the trailing bucket of rows with no place at all. */
  key: string;
  name: string | null;
  assets: Asset[];
  /** Where it is, when the place knows. The map above the sections plots
   *  these; a section whose place has no geography still lists its
   *  photographs, it simply has no pin. */
  lat: number | null;
  lng: number | null;
  /** `core_place.kind` — `'home'` marks the one place a relative phrase is
   *  anchored to, and the one search can answer "near home" with (issue #816,
   *  `search-groups.ts`). */
  kind?: string | null;
  /** The settlement name the opt-in gazetteer automation derived, if any. A
   *  place can be FOUND by it even when the member has named it something else
   *  ("Tahoe" finding a section called "the shore"). */
  gazetteer?: string | null;
}

/**
 * The reserved key of the trailing "no location" section (issue #816).
 *
 * Not a place id and never confusable with one: place ids are uuids, and this
 * carries a hyphen and no digits. Both surfaces spell it the same way
 * (`places-model.ts` on the phone) because it is the key a search hit and the
 * destination it opens have to agree on.
 */
export const NO_LOCATION_KEY = "no-location";

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

/**
 * The trailing bucket: everything in the loaded window that carries NO place
 * (issue #816). Null when there is nothing in it — an empty section would be a
 * heading standing over nothing.
 *
 * This is not the section above's "a place with no name": there is no place
 * here at all, and the two are different facts about a photograph, which is why
 * they are different sentences (`PLACE_NO_LOCATION`). It exists because "no
 * location" is a question a member asks — the photographs a phone stripped the
 * EXIF from, the scans, the screenshots — and before this it was the one answer
 * Places could not give: the shelf listed every place and nothing else, so the
 * set was reachable by scrolling the whole timeline or not at all.
 *
 * It has no coordinates, so `placePoints` draws no pin for it and the map above
 * the sections is unchanged.
 */
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

/**
 * The Places shelf as it is actually drawn: the places, newest first, then the
 * no-location bucket (issue #816).
 *
 * A sibling of `placeSections` rather than a widening of it, because that
 * function answers "which places are in this window" and its answer is still
 * exactly the places — the bucket is a section on the shelf, not a place. The
 * shelf, the search groups over it and the lightbox's walk order all read this
 * one, so the three cannot disagree about what the shelf contains.
 */
export function placeSectionsWithNoLocation(
  assets: readonly Asset[]
): PlaceSection[] {
  const bucket = noLocationSection(assets);
  return bucket ? [...placeSections(assets), bucket] : placeSections(assets);
}

/** The dom id a place's section carries, so a pin can find it. Derived on
 *  both sides from the place key rather than stored, and prefixed because a
 *  place key is a uuid and an id starting with a digit is not a valid CSS
 *  selector. */
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
  /** Re-read the library after a place is named, so every heading re-phrases. */
  refresh: () => Promise<void>;
  onOpen: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onEnterSelectMode: () => void;
}) {
  // WHICH PIN IS FILLED. The map has no route of its own to navigate to — a
  // place is a section on this page, not a screen — so tapping a pin brings
  // its section under the eye and marks the pin as the one being read. That
  // also gives invariant 3's single filled element something true to mean
  // here: "this is the place you asked about", not "this pin is special".
  const [reading, setReading] = useState<string | null>(null);
  const openPlace = useCallback((key: string) => {
    setReading(key);
    // `getElementById` rather than a ref map: the sections are rendered from
    // the same array the pins came from, so the id is derivable on both sides
    // and no second data structure has to be kept in step with the first.
    document
      .querySelector(`#${sectionDomId(key)}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className={styles.shelf}>
      {/* The map is the shelf's HEADER, not a separate destination. Both
          halves answer "where have I been" and splitting them cost the member
          a navigation to compare a pin against its photographs. The map sizes
          to the same `containerWidth` the tile packer uses, so the two agree
          about how wide the shelf is. */}
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
            {/* A coordinate-shaped label is not a name. Until a gazetteer
                lands, `findOrCreatePlaceTx` names a brand-new place after its
                own coordinate, and printing "37.4419, -122.1430" as a heading
                is the same mistake the map used to make in its margins — it
                looks like an answer. `readableName` is the one predicate both
                surfaces ask. */}
            <span className={styles.name}>
              {readableName(section.name) ?? PLACE_UNNAMED}
            </span>
            <span className={styles.count}>{section.assets.length}</span>
            {/* THE ASK, exactly where the fallback shows (issue #816). A place
                the member has already named has nothing to answer, and a
                section with no place id — the group of rows whose place is
                unknown — has no row to write to. */}
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
