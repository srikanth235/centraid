import { useEffect, useState } from "react";

import { CloseIcon } from "../icons.tsx";
import { readableName } from "../place-map.ts";
import type { PlacePoint } from "../place-map.ts";
import type { NamedPlace } from "../place-phrase.ts";
import { PLACE_NO_NAME, exactLocation, placePhrase } from "../place-phrase.ts";
import type { Asset, Place } from "../types.ts";
import { PlaceMap } from "./PlaceMap.tsx";
import { PlaceNaming } from "./PlaceNaming.tsx";

import styles from "./LightboxInfo.module.css";

function assetCoords(asset: Asset): { lat: number; lng: number } | null {
  let exif: Record<string, unknown> | null = null;
  if (typeof asset.exif_json === "string") {
    try {
      exif = JSON.parse(asset.exif_json) as Record<string, unknown> | null;
    } catch {
      exif = null;
    }
  } else if (asset.exif_json && typeof asset.exif_json === "object") {
    exif = asset.exif_json;
  }
  if (exif?.latitude != null && exif.longitude != null) {
    const lat = Number(exif.latitude);
    const lng = Number(exif.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const place = asset.place;
  if (place?.lat != null && place.lng != null) {
    return { lat: place.lat, lng: place.lng };
  }
  return null;
}

function namedAnchors(places: readonly Place[]): NamedPlace[] {
  return places.flatMap((place) => {
    const name = readableName(place.name);
    if (name === null || place.lat == null || place.lng == null) return [];
    return [
      {
        key: place.place_id,
        name,
        lat: place.lat,
        lng: place.lng,
        isHome: place.kind === "home",
      },
    ];
  });
}

const MINI_MAP_WIDTH = 280;

export function LightboxLocation({
  asset,
  places,
  refresh,
  write,
}: {
  asset: Asset;
  places: Place[];
  refresh: () => Promise<void>;
  write: (
    tried: string,
    action: string,
    input: Record<string, unknown>
  ) => Promise<void>;
}) {
  const [placeEditorOpen, setPlaceEditorOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const coords = assetCoords(asset);
  const phrase = placePhrase({
    placeName: asset.place?.name,
    gazetteerName: asset.place?.gazetteer,
    lat: coords?.lat,
    lng: coords?.lng,
    namedPlaces: namedAnchors(places),
    context: "private",
  });
  const placeLabel =
    phrase.source === "none" && !asset.place ? "Add a place" : phrase.text;
  const exact = exactLocation(coords?.lat, coords?.lng);
  const mapPoints: PlacePoint[] = coords
    ? [
        {
          key: asset.place?.place_id ?? asset.asset_id,
          lat: coords.lat,
          lng: coords.lng,
          count: 1,
          name: null,
          thumb: asset.thumb_uri ?? asset.preview_uri ?? asset.content_uri,
        },
      ]
    : [];

  async function copyExact(): Promise<void> {
    if (exact === null) return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    try {
      await clipboard.writeText(exact);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      {/* Place. */}
      <div className={styles.rowLabel}>Place</div>
      {placeEditorOpen ? (
        <div className={styles.placeEditor}>
          <select
            className="kit-input"
            aria-label="Set place"
            defaultValue={asset.place?.place_id ?? ""}
            onChange={async (e) => {
              const placeId = e.currentTarget.value;
              setPlaceEditorOpen(false);
              await write(
                "set that place",
                "set-place",
                placeId
                  ? { asset_id: asset.asset_id, place_id: placeId }
                  : { asset_id: asset.asset_id }
              );
            }}
          >
            <option value="">No place</option>
            {/* Unnamed places share the fallback label — never the digits. */}
            {places.map((p) => (
              <option key={p.place_id} value={p.place_id}>
                {readableName(p.name) ?? PLACE_NO_NAME}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Cancel"
            onClick={() => setPlaceEditorOpen(false)}
          >
            <CloseIcon size={14} />
          </button>
          {places.length === 0 ? (
            <p className={styles.rowNote}>
              No known places yet — a place is linked automatically from where a
              photograph says it was taken.
            </p>
          ) : null}
        </div>
      ) : (
        <p className={styles.rowValue}>
          <button
            type="button"
            className={styles.editable}
            onClick={() => setPlaceEditorOpen(true)}
          >
            {placeLabel}
          </button>
          {/* Only the member can name a place the vault cannot (#816). */}
          {asset.place && readableName(asset.place.name) === null ? (
            <PlaceNaming
              placeId={asset.place.place_id}
              scope={asset.scope_id}
              refresh={refresh}
            />
          ) : null}
          {asset.place ? (
            <span className={styles.rowNote}>
              {" set by you · "}
              <button
                type="button"
                className={styles.inlineAction}
                onClick={() =>
                  void write("remove that place", "set-place", {
                    asset_id: asset.asset_id,
                  })
                }
              >
                remove
              </button>
            </span>
          ) : null}
        </p>
      )}

      {/* Same projection as the Places shelf; no basemap, no third-party tile. */}
      {coords ? (
        <div className={styles.mapSlot}>
          <PlaceMap
            points={mapPoints}
            width={MINI_MAP_WIDTH}
            height={Math.round(MINI_MAP_WIDTH * 0.66)}
            onOpen={() => {}}
          />
          {/* No digits in the label — a button that prints its subject leaks it. */}
          <button
            type="button"
            className={styles.inlineAction}
            onClick={() => void copyExact()}
          >
            Copy exact location
          </button>
          {copied ? <output className={styles.rowNote}>Copied</output> : null}
        </div>
      ) : null}
    </>
  );
}
