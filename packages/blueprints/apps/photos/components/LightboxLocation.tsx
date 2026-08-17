// WHERE THIS PHOTOGRAPH WAS TAKEN — the info panel's location block: the Place
// row, the thumbnail map under it, and the one action in the app that spells a
// coordinate out.
//
// Extracted from `LightboxInfo.tsx` (issue #816) when that file crossed the
// 625-line hygiene ceiling. It is a cohesive block and not an arbitrary cut:
// every line here answers one question the panel asks once — "whereabouts is
// this" — and each of the three parts depends on the same two derived values
// (`assetCoords`, and the phrase the ladder resolves from them). Nothing else on
// the panel reads either, which is why the helpers came with it.
//
// A PHRASE, NOT A NUMBER. The row prints whatever `place-phrase.ts` resolves:
// the member's own name for the place, else a gazetteer name, else a phrase
// relative to a place they DID name, else "A place with no name yet". Never the
// coordinate — a coordinate in a name slot looks like an answer and is not one.
// The digits live behind `Copy exact location`, which a member presses on
// purpose, and the map's pin carries no label because the phrase above it
// already said where this is in words.
//
// WHO OWNS WHAT. This component owns only display state: whether the place
// picker is open, and whether the clipboard was just written to. The WRITE and
// its refusal region stay with the panel — `write` is passed in — because a
// refusal is reported once, in one place, for every row on the panel (§7.2).
//
// WHY IT IMPORTS THE PANEL'S STYLESHEET. `LightboxInfo.module.css` is the info
// panel's stylesheet and this is part of the info panel; `.rowLabel`,
// `.rowValue`, `.rowNote` and `.inlineAction` are shared with the rows above and
// below, so moving them would fracture one surface's type scale across two
// files. Same call `ViewerActions.tsx` and `ViewerStage.tsx` already make with
// `Lightbox.module.css`.
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

/**
 * Where this ONE photograph was taken, as coordinates — or null.
 *
 * The camera's own stamp first, because that is this frame's point; the linked
 * place second, which is a point shared by every photograph that adopted it.
 * These numbers never reach the screen as a name: they feed the phrase ladder,
 * the mini map, and the member's own "exact location" action.
 */
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

/**
 * The member's named places, as anchors for a relative phrase — the ones with
 * a name a person would recognise AND somewhere to measure from. A place still
 * labelled with its own coordinate is not an anchor: "3.4 km NE of 37.4419,
 * -122.1430" is the coordinate back again with extra steps.
 */
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

/**
 * How wide the panel's own map is drawn.
 *
 * The rail is 320px and the sheet is wider, but this map answers one question —
 * "roughly whereabouts is this" — and a figure that grew with the panel would
 * start competing with the photograph the panel describes. A fixed small box,
 * capped by the stylesheet's `max-inline-size`, keeps it a thumbnail.
 */
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
  /** The panel's one write trampoline: narrates, refreshes, and owns the
   *  refusal region. See `LightboxInfo`'s `write`. */
  write: (
    tried: string,
    action: string,
    input: Record<string, unknown>
  ) => Promise<void>;
}) {
  const [placeEditorOpen, setPlaceEditorOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // "Copied" is a receipt for a gesture, not a state — it says the clipboard
  // holds the coordinate now, and two seconds later that is old news.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // WHERE THIS WAS TAKEN, in the falling order of what the vault knows: the
  // member's own name for the place, a gazetteer name when that opt-in
  // automation is on, a phrase relative to a place the member named, then the
  // honest fallback. Private context — this is the member's own panel — so the
  // relative rung is allowed; an export must never carry it (place-phrase.ts).
  const coords = assetCoords(asset);
  const phrase = placePhrase({
    placeName: asset.place?.name,
    gazetteerName: asset.place?.gazetteer,
    lat: coords?.lat,
    lng: coords?.lng,
    namedPlaces: namedAnchors(places),
    context: "private",
  });
  // A photograph with no place row AND nothing to phrase is an invitation, not
  // a fallback: the row is the control that adds one.
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
          // The pin carries no name: the phrase above the map already said
          // where this is, in words, and a second label would either repeat it
          // or contradict it.
          name: null,
          thumb: asset.thumb_uri ?? asset.preview_uri ?? asset.content_uri,
        },
      ]
    : [];

  async function copyExact(): Promise<void> {
    if (exact === null) return;
    // No clipboard (an older engine, a hardened context) means no copy and no
    // claim that there was one — the button simply does nothing rather than
    // reporting a success that did not happen.
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
      {/* Place — the value, plus who put it there and how to take it off. */}
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
            {/* A place still labelled with its own coordinate reads as the
                fallback phrase, never as the digits. Several such places share
                the label, and that is correct: they are all a place with no
                name yet, and the member picks by what they know rather than by
                a number they cannot tell apart anyway. */}
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
          {/* The place this photograph is linked to has no name a person would
              recognise — so the phrase above is derived or the honest fallback,
              and the member is the only one who can fix that (issue #816). The
              ask sits next to the phrase it would replace. */}
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

      {/* The map, in the panel: the SAME projection the Places shelf draws
          (place-map.ts through PlaceMap), one point, and the pin is this
          photograph. No basemap, no tile request, nothing that asks a third
          party where the member has been in order to show them. */}
      {coords ? (
        <div className={styles.mapSlot}>
          <PlaceMap
            points={mapPoints}
            width={MINI_MAP_WIDTH}
            height={Math.round(MINI_MAP_WIDTH * 0.66)}
            // There is nowhere to open: the pin IS the photograph on the stage
            // beside this panel. The pin stays a real control because PlaceMap
            // owns that decision for both surfaces, and pressing it here simply
            // lands back where you already are.
            onOpen={() => {}}
          />
          {/* The one action in this app that spells a coordinate out, and only
              after the member asks for it. The label carries no digits — a
              button that prints the thing it is about has already leaked it. */}
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
