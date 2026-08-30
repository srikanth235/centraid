// The album picker, drawn as a panel. IT OFFERS THE SAME `<Tile>` THE TIMELINE
// DOES over the shared `justify()` packer — never a second square tile whose
// shape comes from CSS instead of the record. Permanently in `selectMode`:
// picking is all it does, and there is nothing here to open.
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { justify, RUNGS } from "../layout.ts";
import type { Album, Asset } from "../types.ts";
import { Tile } from "./Tile.tsx";

import styles from "./Picker.module.css";

/** Rung S — never the member's timeline rung. */
const PICKER_RUNG = 1;
const PICKER_ROW_HEIGHT = RUNGS[PICKER_RUNG]!.desktop;

const FALLBACK_WIDTH = 720;

/** It filters what is OFFERED — a loaded window, with no path to the gateway's
 *  index — so the copy may never claim to search the library. */
const NARROW_PLACEHOLDER = "Narrow the photographs offered here";

function matchesQuery(asset: Asset, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  const title = asset.title ?? "";
  const kind = asset.kind ?? "";
  return (
    title.toLowerCase().includes(needle) || kind.toLowerCase().includes(needle)
  );
}

function useGridWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(el.clientWidth || FALLBACK_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function PickerView({
  album,
  candidates,
  picked,
  busy = false,
  onToggle,
  onCancel,
  onSubmit,
}: {
  album: Album;
  candidates: Asset[];
  picked: Set<string>;
  busy?: boolean;
  onToggle: (id: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [gridRef, width] = useGridWidth();
  const [query, setQuery] = useState("");
  const n = picked.size;
  const title = album.title ?? "Album";
  const offered = candidates.filter((asset) => matchesQuery(asset, query));
  const rows = justify(offered, width, PICKER_ROW_HEIGHT);
  return (
    <div className={`kit-modal ${styles.panel}`}>
      <div className={styles.head}>
        <h2 className={styles.title}>Add to “{title}”</h2>
        <p className={styles.sub}>
          An album refers to a photograph where it lives.
        </p>
      </div>

      <input
        type="search"
        className="kit-input"
        aria-label={NARROW_PLACEHOLDER}
        placeholder={NARROW_PLACEHOLDER}
        value={query}
        disabled={busy}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />

      <div className={styles.grid} ref={gridRef} data-media-root="">
        {candidates.length === 0 ? (
          <p className={styles.empty}>
            Everything in your library is already in this album.
          </p>
        ) : offered.length === 0 ? (
          <p className={styles.empty}>
            {`Nothing offered here matches “${query}”.`}
          </p>
        ) : (
          rows.map((tiles, i) => (
            <div key={`row-${i}`} className={styles.row}>
              {tiles.map((t) => (
                <Tile
                  key={t.asset.asset_id}
                  asset={t.asset}
                  width={t.width}
                  height={t.height}
                  rung={PICKER_RUNG}
                  selected={picked.has(t.asset.asset_id)}
                  selectMode
                  // Album membership is own-scope only (#599): nothing is marked.
                  vaultMark={null}
                  onOpen={() => onToggle(t.asset.asset_id)}
                  onToggleSelect={() => onToggle(t.asset.asset_id)}
                  onEnterSelectMode={() => undefined}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div className={styles.foot}>
        <span className={styles.count}>
          <span className={styles.countNum}>{n}</span>
          {n === 1 ? " photograph picked" : " photographs picked"}
        </span>
        <button
          type="button"
          className="kit-btn"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        {/* The ONE filled ink element here (§18); unfilled once it cannot fire. */}
        <button
          type="button"
          className={n === 0 || busy ? "kit-btn" : "kit-btn primary"}
          disabled={n === 0 || busy}
          onClick={onSubmit}
        >
          {/* The commit carries its count: what the press does, on the control. */}
          {n === 0 ? "Add" : `Add ${n}`}
        </button>
      </div>
    </div>
  );
}
