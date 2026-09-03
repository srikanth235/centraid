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
  width: number;
  height: number;
  rung: number;
  selected: boolean;
  selectMode: boolean;
  vaultMark: TileVault | null;
  state?: TileMediaState;
  note?: string;
  onOpen: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onEnterSelectMode: () => void;
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
  const [seen, setSeen] = useState<TileMediaState>(() =>
    initialMediaState(asset)
  );
  const media = state ?? seen;
  const mediaLine = stateLine(media);
  const line = mediaLine ?? note ?? null;
  const expiring = mediaLine == null && note != null;
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
      style={{ width: `${width}px`, height: `${height}px` }}
      data-asset-id={asset.asset_id}
      data-tile-state={media}
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

      {/* slot 2: vault marker. Logical inset, so it mirrors under RTL. */}
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

      {/* slot 1: selection */}
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

      {/* slot 3: kind */}
      {kind ? <span className={styles.kind}>{kind}</span> : null}

      {/* slot 4: state — one line, never a fill or a dot. */}
      {line ? (
        <span className={cls(styles.state, expiring && styles.expiring)}>
          {line}
        </span>
      ) : null}

      {extras || pending ? (
        <div className={styles.extras}>
          <PendingWriteActions row={asset} onEdit={() => onOpen(key)} />
          {extras}
        </div>
      ) : null}
    </div>
  );
}
