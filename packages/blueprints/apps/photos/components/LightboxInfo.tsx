// The info panel (v4 handoff §7.2) — 320px rail on the trailing edge, a 64%
// sheet with a grabber on the phone (the two are one element; see
// Lightbox.module.css).
//
// OWNER RULING (#711, 2a/2b/2c) — do not "fix" these back:
//  - The panel stays on PAPER, not stage ground. Both clients arrived at this
//    independently, and Google Photos (our north star) does the same: dense
//    facts read better on paper, and the stage's job is to frame the
//    photograph, not to host text. This is a deliberate amendment to the
//    prototype's `vInfoStyle`, which had put the panel over the stage.
//  - The "Albums" row and the "Activity" log below are inventions beyond the
//    prototype, and they stay: both are honest provenance with real member
//    value (which albums this is in, what has actually happened to it).
//  - There is NO destructive control on this panel. A "Move to trash" button
//    used to sit below the Activity log; it was removed because the viewer
//    bar already carries Trash, and a second destructive path inside a facts
//    panel is a misfire waiting to happen — the prototype's own panel
//    deliberately carries no destructive control either.
//
// EVERY ROW IS A WRITE THAT CAN FAIL, BE REFUSED, OR BE UNDONE. That is the
// organising idea, not a caveat: the caption, the capture time, the place, the
// tags and the people are all editable in place, and each of them fires a
// typed, consent-checked command. So the panel carries a REFUSAL region — what
// was tried, why it was refused, what to do — rather than a generic error
// string, and it says out loud that the typed text is still on the device
// (§13).
//
// Below a hairline sit the FACTS: dimensions, file size, kind, timezone,
// source and asset id, all in the numeric register. Then one paragraph on
// where the original currently lives, which is the only place in the app that
// question is answered in prose.
//
// WHERE IT WAS TAKEN IS A PHRASE, NOT A NUMBER. The Place row prints whatever
// `place-phrase.ts` resolves — the member's own name for the place, else a
// gazetteer name, else a phrase relative to a place they DID name, else "A
// place with no name yet". Never the coordinate: a coordinate in a name slot
// looks like an answer and is not one. Under it sits the same map the Places
// shelf draws, at thumbnail size, and the digits live behind one explicit
// action the member takes on purpose.
//
// The storage noun never reaches a user-visible string. What a member reads
// for a vault is `scope.label` — the shell owns it and the owner may rename
// it — and what it MEANS comes from whether that scope is the member's own
// (`scope.personal`, viewer.ts's `scopeMeaning`), never from its name.
import { useEffect, useRef, useState } from "react";

import { fmtBytes } from "@centraid/design/elements";

import { mountedScopes } from "../../_shared/scope-kit.ts";
import { buildActivity } from "../activity.ts";
import { renderFaces } from "../faces.ts";
import { assetBytes, custodyMeta, toLocalInputValue } from "../format.ts";
import { CloseIcon } from "../icons.tsx";
// Every command on this panel edits the OPEN asset, so each is addressed at
// the scope that asset is shown from (issue #599) rather than the chip
// selection — including the album/tag/place ones, whose collection ids are
// only meaningful inside that same scope.
import { act, narrate } from "../outcomes.ts";
import { readableName } from "../place-map.ts";
import type { PlacePoint } from "../place-map.ts";
import type { NamedPlace } from "../place-phrase.ts";
import { PLACE_NO_NAME, exactLocation, placePhrase } from "../place-phrase.ts";
import type { Album, Asset, Place } from "../types.ts";
import {
  DEFAULT_GATEWAY_NAME,
  originParagraph,
  scopeMeaning,
} from "../viewer.ts";
import { PlaceMap } from "./PlaceMap.tsx";

import styles from "./LightboxInfo.module.css";

/** One refused write, in the three parts §7.2 and §13 ask for. */
interface Refusal {
  tried: string;
  reason: string;
}

/** The device's own zone — the panel says which one a capture time is read
 *  in, because a photograph taken abroad is otherwise silently reinterpreted. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "this device";
  } catch {
    return "this device";
  }
}

/** Where a capture time came from. A camera's own stamp and a value the member
 *  typed are different claims, and the panel does not blur them. */
function captureSource(asset: Asset): string {
  const exif = asset.exif_json;
  const stamped =
    typeof exif === "string"
      ? exif.length > 2
      : exif != null && Object.keys(exif).length > 0;
  return stamped ? "from the camera" : "from the file";
}

/** The facts, in the numeric register (§7.2). A fact with no value is not
 *  rendered as an em dash: an absent fact says nothing. */
function factRows(asset: Asset): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (asset.width && asset.height) {
    rows.push(["dimensions", `${asset.width} × ${asset.height}`]);
  }
  const size = fmtBytes(assetBytes(asset));
  if (size) rows.push(["file size", size]);
  const kind = asset.media_type ?? asset.kind;
  if (kind) rows.push(["kind", String(kind)]);
  rows.push(
    ["timezone", localZone()],
    ["source", captureSource(asset)],
    ["asset id", asset.asset_id]
  );
  const custody = custodyMeta(asset.custody_state);
  if (custody) rows.push(["backup", custody.label]);
  return rows;
}

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

export function LightboxInfo({
  asset,
  albums: albumList,
  places,
  gatewayName = DEFAULT_GATEWAY_NAME,
  refresh,
  onClose: _onClose,
}: {
  asset: Asset;
  albums: Album[];
  places: Place[];
  gatewayName?: string;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const facesHostRef = useRef<HTMLDivElement | null>(null);
  const facesNoteRef = useRef<HTMLParagraphElement | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [placeEditorOpen, setPlaceEditorOpen] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [tagText, setTagText] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void renderFaces(
      facesHostRef.current!,
      asset.asset_id,
      facesNoteRef.current!
    );
    // (#360) this component remounts fresh per asset/refresh (keyed by renderSeq in the shell)
  }, [asset.asset_id]);

  // "Copied" is a receipt for a gesture, not a state — it says the clipboard
  // holds the coordinate now, and two seconds later that is old news.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  /**
   * Fire one write and report it the way §7.2 asks: nothing on success (the
   * frame's ONE status line already carries the outcome, with Undo), and a
   * three-part refusal on anything else. `narrate` writes the refusal message
   * into an element, so it is handed a detached one and read back — no second
   * banner is mounted anywhere.
   */
  async function write(
    tried: string,
    action: string,
    input: Record<string, unknown>
  ): Promise<void> {
    const holder = document.createElement("p");
    const outcome = await act(action, input, asset.scope_id);
    if (narrate(outcome, holder)) {
      setRefusal(null);
      await refresh();
      return;
    }
    setRefusal({
      tried,
      reason: holder.textContent || "The write was refused.",
    });
  }

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

  const scope = mountedScopes().find((s) => s.id === (asset.scope_id ?? ""));
  const scopeLabel = scope?.label ?? "Library";
  const scopePersonal = scope?.personal;

  return (
    <>
      {/* Caption — 13/1.5 with a dashed underline, which is how the panel says
          "this is editable in place" without a pencil on every row (§7.2). */}
      <div className={styles.rowLabel}>Caption</div>
      <input
        type="text"
        className={styles.caption}
        defaultValue={asset.title ?? ""}
        placeholder="Add a caption"
        aria-label="Caption"
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={async (e) => {
          const title = e.currentTarget.value.trim();
          if (title === (asset.title ?? "")) return;
          await write("write that caption", "update-asset", {
            asset_id: asset.asset_id,
            title,
          });
        }}
      />

      {/* Capture time — the value, plus the timezone it is read in and where
          it came from. Both are claims the member can check. */}
      <div className={styles.rowLabel}>Capture time</div>
      <input
        type="datetime-local"
        className={styles.captureInput}
        defaultValue={toLocalInputValue(asset.captured_at ?? asset.taken_at)}
        aria-label="Capture time"
        onChange={async (e) => {
          if (!e.currentTarget.value) return;
          const d = new Date(e.currentTarget.value);
          if (Number.isNaN(d.getTime())) return;
          await write("change the capture time", "update-asset", {
            asset_id: asset.asset_id,
            captured_at: d.toISOString(),
          });
        }}
      />
      <p className={styles.rowNote}>
        {localZone()} · {captureSource(asset)}
      </p>

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

      {/* Tags — 24px chips at a pill radius, with `+ add`. */}
      <div className={styles.rowLabel}>Tags</div>
      <div className={styles.chipRow}>
        {(asset.tags ?? []).map((tag) => (
          <button
            key={tag.tag_id}
            type="button"
            className={styles.chip}
            aria-label={`Remove tag ${tag.label}`}
            onClick={() =>
              void write("remove that tag", "untag-asset", {
                tag_id: tag.tag_id,
              })
            }
          >
            {tag.label} ×
          </button>
        ))}
        {addingTag ? (
          <input
            type="text"
            className={styles.chipInput}
            placeholder="Tag name"
            aria-label="Add tag"
            value={tagText}
            autoFocus
            onChange={(e) => setTagText(e.currentTarget.value)}
            onKeyDown={async (e) => {
              if (e.key === "Escape") {
                setAddingTag(false);
                setTagText("");
                return;
              }
              if (e.key !== "Enter") return;
              const label = e.currentTarget.value.trim();
              setAddingTag(false);
              setTagText("");
              if (!label) return;
              await write("add that tag", "tag-asset", {
                asset_id: asset.asset_id,
                label,
              });
            }}
          />
        ) : (
          <button
            type="button"
            className={styles.chip}
            onClick={() => setAddingTag(true)}
          >
            + add
          </button>
        )}
      </div>

      {/* People — faces.ts owns its own heading and only draws one when face
          regions actually exist, so there is no static label here. The chips
          it injects take the same treatment from the stylesheet. */}
      <div className="ph-faces" ref={facesHostRef} />

      {albumList.length > 0 ? (
        <>
          <div className={styles.rowLabel}>Albums</div>
          <div className={styles.chipRow}>
            {albumList.map((album) => {
              const member = asset.album_ids?.includes(album.album_id) ?? false;
              const isCover =
                member &&
                !!asset.content_id &&
                album.cover_content_id === asset.content_id;
              return (
                <span className={styles.chipPair} key={album.album_id}>
                  <button
                    type="button"
                    className={styles.chip}
                    data-active={member ? "true" : "false"}
                    aria-pressed={member}
                    onClick={() =>
                      void write(
                        member
                          ? "take it out of that album"
                          : "add it to that album",
                        member ? "remove-from-album" : "add-to-album",
                        { album_id: album.album_id, asset_id: asset.asset_id }
                      )
                    }
                  >
                    {album.title ?? "Album"}
                  </button>
                  {/* The album's cover is a property of the album that only a
                      photograph can set, so the control lives on the chip that
                      says the photograph is in it. */}
                  {member ? (
                    <button
                      type="button"
                      className={styles.chipTail}
                      disabled={isCover}
                      aria-label={
                        isCover
                          ? `Cover of ${album.title ?? "this album"}`
                          : `Use this as the cover of ${album.title ?? "this album"}`
                      }
                      onClick={() =>
                        void write("set that cover", "set-album-cover", {
                          album_id: album.album_id,
                          asset_id: asset.asset_id,
                        })
                      }
                    >
                      {isCover ? "cover" : "set cover"}
                    </button>
                  ) : null}
                </span>
              );
            })}
          </div>
        </>
      ) : null}

      {/* Where it is, and what that means. The NAME is whatever the scope
          calls itself; the CONSEQUENCE is whether that scope is the member's
          own — never the name, and never a third "kind" of place (§H). */}
      <div className={styles.rowLabel}>Where it is</div>
      <p className={styles.rowValue}>
        <span className={styles.scopeName}>{scopeLabel}</span> —{" "}
        {scopeMeaning(scopePersonal)}
      </p>

      {/* A refused write (§7.2, §13): what was tried, why, and what to do —
          and the fact that what the member typed is still on the device. */}
      {refusal ? (
        <output className={styles.refusal}>
          <p className={styles.refusalHead}>
            Could not {refusal.tried}. {refusal.reason}
          </p>
          <p className={styles.refusalNote}>
            What you typed is still on this device — ask whoever owns this
            library for access.
          </p>
        </output>
      ) : null}
      <p className="lightbox-note" ref={facesNoteRef} />

      <hr className={styles.rule} />

      <div className={styles.facts}>
        {factRows(asset).map(([label, value]) => (
          <div className={styles.factRow} key={label}>
            <span className={styles.factKey}>{label}</span>
            <span className={styles.factValue}>{value}</span>
          </div>
        ))}
      </div>

      {/* One paragraph on where the original currently lives (§7.2). */}
      <p className={styles.origin}>{originParagraph(asset, gatewayName)}</p>

      <div className={styles.rowLabel}>Activity</div>
      <div className={styles.activity}>
        {buildActivity(asset).map((ev, i) => (
          <div className={styles.activityRow} key={i}>
            <div className={styles.activityText}>{ev.text}</div>
            <div className={styles.activityMeta}>{ev.date} · receipted</div>
          </div>
        ))}
      </div>
    </>
  );
}
