// The album picker — "Add photographs" from inside an album (v4 handoff §E:
// "the picker is drawn as a panel in the content area, labelled as the dialog
// it is").
//
// IT OFFERS THE SAME TILE THE TIMELINE DOES. Before v4 this file hand-rolled a
// second square tile with its own check circle and its own accent outline; a
// photograph therefore looked like one thing in the grid and another thing in
// the picker, and the picker's tiles reflowed the moment their bytes landed
// because their shape came from the CSS, not from the record. Now the rows come
// from the shared `justify()` packer and every box is a `<Tile>`: `--skel`
// ground at the packed geometry from the first frame, four overlay slots, 2px
// gutters, and selection drawn as 2px of INK — never Photos' hue on a control.
//
// The picker is permanently IN SELECTION (`selectMode`), because picking is the
// only thing it does: a tile's media click toggles, exactly as the check does,
// and there is nothing here to open.
//
// `onCancel`/`onSubmit` are picker.tsx's `closePicker`/`submitPicker` — both
// touch app-owned picker state (`pickerAlbum`/`pickerPicked`), so they stay
// there and are passed straight through.
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { justify, RUNGS } from "../layout.ts";
import type { Album, Asset } from "../types.ts";
import { Tile } from "./Tile.tsx";

import styles from "./Picker.module.css";

/**
 * The picker packs at rung S (§4.2): small enough that a panel shows a real
 * choice at a glance, large enough that the kind slot (a duration, `live`) is
 * still readable. It is NOT the member's timeline rung — the stepper sets how
 * the library reads, and a modal panel is a different question.
 */
const PICKER_RUNG = 1;
const PICKER_ROW_HEIGHT = RUNGS[PICKER_RUNG]!.desktop;

/**
 * The packing width before the first measurement lands (and in any environment
 * with no layout at all, e.g. a static render in a test). The real number is
 * the grid element's own content width, read by the observer below.
 */
const FALLBACK_WIDTH = 720;

/**
 * The picker's own narrowing field (v4 handoff proto :4283,
 * `fieldBlock('','Search the library to narrow this',false)`).
 *
 * IT FILTERS WHAT IS OFFERED, AND ITS COPY SAYS SO. The prototype's placeholder
 * says "the library"; this panel is handed the loaded own-scope window
 * (picker.tsx's `getAssets()`), which on a large library is a window and not
 * the whole of it, and this app has no picker-side path to the gateway's FTS5
 * index. Claiming to have searched the library from here would be the same
 * class of untruth `view-copy.ts` already refuses elsewhere, so the field
 * describes exactly what it does. Nothing else about the field changes: it is
 * the shared `kit-input`, and it is the only text control on the panel.
 */
const NARROW_PLACEHOLDER = "Narrow the photographs offered here";

/** Case-insensitive match over the one member-facing string a candidate row
 *  carries. `kind` is matched too so `video` narrows to videos — both are
 *  facts already on the row, never a second read. */
function matchesQuery(asset: Asset, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  const title = asset.title ?? "";
  const kind = asset.kind ?? "";
  return (
    title.toLowerCase().includes(needle) || kind.toLowerCase().includes(needle)
  );
}

/** The grid's live content width in CSS pixels — what `justify()` packs into. */
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
  /** True while the add is running. The panel keeps its geometry and its
   *  controls; the counts go to the frame's ONE status line (§14). */
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
          An album refers to a photograph where it lives; nothing moves and
          nothing is copied.
        </p>
      </div>

      <input
        type="search"
        className="kit-input"
        aria-label={NARROW_PLACEHOLDER}
        placeholder={NARROW_PLACEHOLDER}
        value={query}
        // Inert while the add runs, like every other control on the panel —
        // narrowing the list under a commit that is already reading it would
        // be answering a different question than the one being committed.
        disabled={busy}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />

      <div className={styles.grid} ref={gridRef}>
        {candidates.length === 0 ? (
          <p className={styles.empty}>
            Everything in your library is already in this album.
          </p>
        ) : offered.length === 0 ? (
          // A narrowed-to-nothing list is not an empty album — it keeps the
          // panel's geometry and says which of the two it is (§14).
          <p className={styles.empty}>
            {`Nothing offered here matches “${query}”.`}
          </p>
        ) : (
          rows.map((tiles, i) => (
            <div
              // Rows are re-packed from the same ordered list on every render,
              // so a row's position IS its identity here — same key the
              // timeline's own packed rows carry.
              key={`row-${i}`}
              className={styles.row}
            >
              {tiles.map((t) => (
                <Tile
                  key={t.asset.asset_id}
                  asset={t.asset}
                  width={t.width}
                  height={t.height}
                  rung={PICKER_RUNG}
                  selected={picked.has(t.asset.asset_id)}
                  // Always picking: a media click toggles, same as the check.
                  selectMode
                  // Album membership is own-scope only (issue #599), so every
                  // candidate is the member's own and none is marked (§H).
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
        {/* The ONE filled ink element in this view (§18) — and it stops being
            filled the moment it cannot fire, rather than offering a commit
            that would be refused. */}
        <button
          type="button"
          className={n === 0 || busy ? "kit-btn" : "kit-btn primary"}
          disabled={n === 0 || busy}
          onClick={onSubmit}
        >
          {/* The commit CARRIES ITS COUNT (proto :4285, `Add 12`) — the member
              reads what the press will do off the control itself, not off a
              line beside it. With nothing picked there is no number to carry
              and the control is already refusing. */}
          {n === 0 ? "Add" : `Add ${n}`}
        </button>
      </div>
    </div>
  );
}
