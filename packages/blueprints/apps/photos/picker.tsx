import type { ReactNode } from "react";

// The album picker ("Add photos" from inside an album). Owns its own small
// state (which album, which ids are picked) — nothing outside the picker
// region ever reads `pickerAlbum`/`pickerPicked`.
import { PickerView } from "./components/Picker.tsx";
import { $ } from "./dom.ts";
import { submitPicker as runSubmitPicker } from "./picker-actions.ts";
import type { Album, Asset } from "./types.ts";

type Root = { render: (node: ReactNode) => void };

export function createPicker({
  pickerRoot,
  getAlbums,
  getAssets,
  getSelectedAlbum,
  refresh,
}: {
  pickerRoot: Root;
  getAlbums: () => Album[];
  getAssets: () => Asset[];
  getSelectedAlbum: () => string | null;
  refresh: () => Promise<void>;
}) {
  let pickerAlbum: Album | null = null;
  const pickerPicked = new Set<string>();
  // The panel goes BUSY rather than the commit turning into a progress bar
  // (§14): the geometry stands still, the counts ride the frame's one status
  // line, and a second click cannot start a second pass.
  let pickerBusy = false;

  function closePicker() {
    const p = $("picker");
    p.hidden = true;
    pickerRoot.render(null);
    pickerAlbum = null;
    pickerBusy = false;
    pickerPicked.clear();
  }

  async function submitPicker(): Promise<void> {
    const album = pickerAlbum;
    if (!album || pickerBusy) return;
    pickerBusy = true;
    renderPicker();
    try {
      await runSubmitPicker(album, [...pickerPicked], {
        refresh,
        closePicker,
      });
    } finally {
      pickerBusy = false;
    }
  }

  function renderPicker() {
    if (!pickerAlbum) return;
    const album = pickerAlbum;
    // Albums are own-scope (issue #599), so the picker offers own-scope photos:
    // an audience's asset id cannot be added to a collection in another scope.
    const candidates = getAssets().filter(
      (a) => !(a.album_ids ?? []).includes(album.album_id)
    );
    pickerRoot.render(
      <PickerView
        album={album}
        candidates={candidates}
        picked={pickerPicked}
        busy={pickerBusy}
        onToggle={(id) => {
          if (pickerBusy) return;
          if (pickerPicked.has(id)) pickerPicked.delete(id);
          else pickerPicked.add(id);
          renderPicker();
        }}
        onCancel={closePicker}
        onSubmit={() => void submitPicker()}
      />
    );
  }

  function openPicker() {
    const album = getAlbums().find((a) => a.album_id === getSelectedAlbum());
    if (!album) return;
    pickerAlbum = album;
    pickerBusy = false;
    pickerPicked.clear();
    renderPicker();
    $("picker").hidden = false;
  }

  // A plain native listener directly on `#picker` (which doubles as this
  // region's React root container, `pickerRoot` above) — a nested tile's
  // `onClick` can't reliably shield itself from this via `stopPropagation()`:
  // React's own delegated listener lives on this SAME node and is registered
  // *before* this one (`createRoot()` runs ahead of `createPicker()` in
  // app.tsx's Boot section), so this raw listener always fires, in full,
  // before — or regardless of — anything a descendant's synthetic handler
  // does. That closed the picker on every tile pick instead of just backdrop
  // clicks. Gating on `e.target === e.currentTarget` sidesteps the whole
  // ordering question: only a click landing on the backdrop itself (never a
  // descendant) closes it, same fix as the lightbox's identical setup.
  $("picker").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePicker();
  });

  return { openPicker, closePicker };
}
