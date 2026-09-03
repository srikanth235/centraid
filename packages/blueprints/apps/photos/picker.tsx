import type { ReactNode } from "react";

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

  $("picker").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePicker();
  });

  return { openPicker, closePicker };
}
