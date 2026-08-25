// Info panel (§7.2). OWNER RULING (#711) — do not "fix" these back:
// paper not stage; Albums + Activity stay; NO destructive control here
// (Trash lives on the viewer bar). Every row is a write that can fail —
// refusal region, not a generic error; typed text stays on device (§13).
// Place is a phrase, never a coordinate (`LightboxLocation.tsx`). Vault
// meaning is `scope.personal`, never the storage noun or `scope.label`.
import { useEffect, useRef, useState } from "react";

import { fmtBytes } from "@centraid/design/elements";

import { mountedScopes } from "../../_shared/scope-kit.ts";
import { buildActivity } from "../activity.ts";
import { renderFaces } from "../faces.ts";
import { assetBytes, custodyMeta, toLocalInputValue } from "../format.ts";
// Commands address the OPEN asset's scope (#599), not the chip selection.
import { act, narrate } from "../outcomes.ts";
import type { Album, Asset, Place } from "../types.ts";
import {
  DEFAULT_GATEWAY_NAME,
  originParagraph,
  scopeMeaning,
} from "../viewer.ts";
import { LightboxLocation } from "./LightboxLocation.tsx";

import styles from "./LightboxInfo.module.css";

interface Refusal {
  tried: string;
  reason: string;
}

/** Capture time is read in this zone — else a photo taken abroad is silently reinterpreted. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "this device";
  } catch {
    return "this device";
  }
}

function captureSource(asset: Asset): string {
  const exif = asset.exif_json;
  const stamped =
    typeof exif === "string"
      ? exif.length > 2
      : exif != null && Object.keys(exif).length > 0;
  return stamped ? "from the camera" : "from the file";
}

/** Absent facts are omitted, never an em dash. */
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
    // Remounts per asset/refresh (keyed by renderSeq) (#360).
  }, [asset.asset_id]);

  /**
   * Success is silent (frame status line). Refusal via detached `narrate`
   * element — no second banner.
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
      {/* Editable in place: dashed underline, no pencil (§7.2). */}
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

      {/* Capture time plus zone and source — claims the member can check. */}
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

      {/* Place writes use the same refusal region as every other row. */}
      <LightboxLocation
        asset={asset}
        places={places}
        refresh={refresh}
        write={write}
      />

      {/* Tags. */}
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

      {/* No static People label — faces.ts draws a heading only when regions exist. */}
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
                  {/* Cover is an album property; the control lives on the membership chip. */}
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

      {/* Name is the scope's label; meaning is own-vs-not — never a third kind (§H). */}
      <div className={styles.rowLabel}>Where it is</div>
      <p className={styles.rowValue}>
        <span className={styles.scopeName}>{scopeLabel}</span> —{" "}
        {scopeMeaning(scopePersonal)}
      </p>

      {/* Refusal: what was tried, why, and that typed text is still on the device. */}
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

      {/* Where the original currently lives. */}
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
