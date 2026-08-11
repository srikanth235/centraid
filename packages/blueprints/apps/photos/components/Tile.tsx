// THE TILE (v4 handoff §2.3, §2.4, §4.4) — a new SHARED control, not a Photos
// component that happens to be square.
//
// What makes it its own control rather than a card: it is content-led, it has
// NO CHROME, it carries its own aspect ratio, and it has exactly FOUR overlay
// slots — selection, vault, kind, state — and nothing else. Everything else in
// the product is a row or a card.
//
// The four slots, and why each one is where it is:
//
//   Selection  top, trailing, 6px in. The only control on the tile.
//   Vault      a 2px rule on the LEADING edge in the vault's hue, plus the
//              vault initial at rungs M and L. Fires on the record, never on
//              a name (tile-state.ts) — any vault but the personal one. The
//              member's own photographs are the unmarked default.
//   Kind       bottom, trailing, from rung S up. A duration or `live`.
//   State      bottom, inline. ONE line of mono on the page colour. Never a
//              fill, never a red dot, never a vanishing tile.
//
// STATE IS WHAT THE TILE *IS*, NOT A POLISH PASS (§14). The tile paints
// `--skel` at the exact geometry the photograph will occupy from the first
// frame, so nothing reflows when bytes land; a row with no bytes on this
// device says `on the gateway` immediately rather than after a failed fetch;
// and a real terminal failure KEEPS ITS GEOMETRY, takes a `--net` border and
// one line of mono. The geometry comes from `justify()` either way, so the
// three states are the same box.
import { useState } from "react";
import type { ReactNode } from "react";

import { readPendingOverlay } from "../../_shared/pending-overlay.ts";
import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { scopeAttr } from "../../_shared/scope-kit.ts";
import { assetKey } from "../asset-key.ts";
import { cls } from "../format.ts";
import { CheckIcon } from "../icons.tsx";
import { mountMedia } from "../media.ts";
import {
  initialMediaState,
  kindLabel,
  showsKindSlot,
  showsVaultInitial,
  stateLine,
} from "../tile-state.ts";
import type { TileMediaState, TileVault } from "../tile-state.ts";
import type { Asset } from "../types.ts";

import styles from "./Tile.module.css";

export interface TileProps {
  asset: Asset;
  /** The packed box from `justify()` — the tile's geometry, in CSS pixels. */
  width: number;
  height: number;
  /** The member's tile-size rung, 0-3 = XS/S/M/L. Gates the kind slot (S up)
   *  and the vault initial (M and L) — nothing else about the tile changes. */
  rung: number;
  selected: boolean;
  selectMode: boolean;
  /** The vault slot, or null for the member's own — see `vaultMarker`. */
  vaultMark: TileVault | null;
  /**
   * What is true about the bytes, when the CALLER already knows (the picker
   * paints a read-only tile's reason on the tile; a test states the case it is
   * asserting). Left off, the tile derives its own starting state from the
   * record and escalates it as the media reports back.
   */
  state?: TileMediaState;
  /**
   * A second thing the STATE SLOT can say when the bytes have nothing to
   * report — today, Trash's purge countdown (§5). Same slot, same one line of
   * mono on the page colour; the media always wins, because "could not decode"
   * matters more than "purges in 12 days".
   */
  note?: string;
  /** Clicking the media: open, or toggle in selection. */
  onOpen: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onEnterSelectMode: () => void;
  /**
   * NOT a fifth slot (§4.4 says four, and means it) — a narrow carve-out for
   * the one per-tile action the selection bar's fixed five (§6) has nowhere
   * to put: album detail's own Remove. Trash's Restore used to live here too;
   * it retired once `allowsSelection(TRASH)` went true and the bar grew the
   * Trash → Restore swap (`buildSelectionActions`), which is where a batch
   * restore belongs. Removing a single photograph from the album you are
   * looking at has no equivalent swap — "Add to album" opens a destination
   * picker on every other shelf, and album detail is not a destination to
   * pick — so it stays a per-tile control until the bar grows one.
   */
  extras?: ReactNode;
}

export function Tile({
  asset,
  width,
  height,
  rung,
  selected,
  selectMode,
  vaultMark,
  state,
  note,
  onOpen,
  onToggleSelect,
  onEnterSelectMode,
  extras,
}: TileProps) {
  // Seeded from the RECORD, so the first frame is already truthful; the media
  // only ever escalates it (`pending` → `bytes` / `failed`).
  const [seen, setSeen] = useState<TileMediaState>(() =>
    initialMediaState(asset)
  );
  const media = state ?? seen;
  const line = stateLine(media) ?? note ?? null;
  const kind = showsKindSlot(rung) ? kindLabel(asset) : null;
  const key = assetKey(asset);
  const name = asset.title ?? asset.kind ?? "Photograph";
  const pending = readPendingOverlay(asset);
  return (
    <div
      className={cls(
        styles.tile,
        selected && styles.selected,
        media === "failed" && styles.failed
      )}
      // The geometry, from the record, before the bytes: `justify()` packed
      // this box out of the asset's own width/height columns, so the skeleton,
      // the photograph and the failure all occupy exactly the same pixels.
      style={{ width: `${width}px`, height: `${height}px` }}
      data-asset-id={asset.asset_id}
      data-tile-state={media}
      /* Which scope owns these bytes — the shell's blob authorizer reads it off
         the nearest ancestor, and content ids collide across scopes by design
         (issue #599). */
      data-scope={scopeAttr(asset.scope_id)}
    >
      <button
        type="button"
        className={styles.media}
        aria-label={vaultMark ? `${name} · in ${vaultMark.label}` : name}
        ref={(el) => mountMedia(el, asset, setSeen)}
        onClick={() => {
          if (selectMode) onToggleSelect(key);
          else onOpen(key);
        }}
      />

      {/* ---- slot 2: the vault marker. Logical inset, so it mirrors under
              RTL — `inset-inline-start` leads, `left` does not. ---- */}
      {vaultMark ? (
        <span
          className={styles.vaultRule}
          style={{ background: vaultMark.hue }}
          aria-hidden="true"
        />
      ) : null}
      {vaultMark && showsVaultInitial(rung) ? (
        <span className={styles.vaultInitial} aria-hidden="true">
          {vaultMark.initial}
        </span>
      ) : null}

      {/* ---- slot 1: selection ---- */}
      <button
        type="button"
        className={styles.check}
        aria-pressed={selected}
        aria-label={selected ? `Deselect ${name}` : `Select ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!selectMode) onEnterSelectMode();
          onToggleSelect(key);
        }}
      >
        {selected ? <CheckIcon size={12} /> : null}
      </button>

      {/* ---- slot 3: kind ---- */}
      {kind ? <span className={styles.kind}>{kind}</span> : null}

      {/* ---- slot 4: state. One line, never a fill and never a red dot. ---- */}
      {line ? <span className={styles.state}>{line}</span> : null}

      {extras || pending ? (
        <div className={styles.extras}>
          <PendingWriteActions row={asset} onEdit={() => onOpen(key)} />
          {extras}
        </div>
      ) : null}
    </div>
  );
}
