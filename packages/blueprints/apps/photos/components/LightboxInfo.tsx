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
//  - There is NO destructive control on this panel — no "Move to trash"
//    button below the Activity log. The viewer bar already carries Trash, and
//    a second destructive path inside a facts panel is a misfire waiting to
//    happen — the prototype's own panel deliberately carries no destructive
//    control either.
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
// WHERE IT WAS TAKEN IS A PHRASE, NOT A NUMBER — and it is a file of its own,
// `LightboxLocation.tsx`: the Place row, the thumbnail map beneath it and the
// single "exact location" action are one question the panel asks once, and they
// left together when this file crossed the 625-line hygiene ceiling (#816). The
// rule they carry with them is the one worth repeating here: never the
// coordinate, because a coordinate in a name slot looks like an answer and is
// not one.
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
// Every command on this panel edits the OPEN asset, so each is addressed at
// the scope that asset is shown from (#599) rather than the chip
// selection — including the album/tag/place ones, whose collection ids are
// only meaningful inside that same scope.
import { act, narrate } from "../outcomes.ts";
import type { Album, Asset, Place } from "../types.ts";
import {
  DEFAULT_GATEWAY_NAME,
  originParagraph,
  scopeMeaning,
} from "../viewer.ts";
import { LightboxLocation } from "./LightboxLocation.tsx";

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
  const [addingTag, setAddingTag] = useState(false);
  const [tagText, setTagText] = useState("");

  useEffect(() => {
    void renderFaces(
      facesHostRef.current!,
      asset.asset_id,
      facesNoteRef.current!
    );
    // (#360) this component remounts fresh per asset/refresh (keyed by renderSeq in the shell)
  }, [asset.asset_id]);

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

      {/* Where it was taken: the Place row, the thumbnail map, and the one
          action that spells a coordinate out — LightboxLocation.tsx, which owns
          the phrase ladder and the picker's own open/closed state. The write
          trampoline is handed over, so a refused place edit surfaces in the
          SAME refusal region as every other row on this panel. */}
      <LightboxLocation
        asset={asset}
        places={places}
        refresh={refresh}
        write={write}
      />

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
