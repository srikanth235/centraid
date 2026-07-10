// The album picker ("Add photos" from inside an album). Owns its own small
// state (which album, which ids are picked) — nothing outside the picker
// region ever reads `pickerAlbum`/`pickerPicked`.
import { PickerView } from './components/Picker.jsx';
import { submitPicker as runSubmitPicker } from './picker-actions.js';
import { $ } from './dom.js';

export function createPicker({ pickerRoot, getAlbums, getAssets, getSelectedAlbum, refresh }) {
  let pickerAlbum = null;
  const pickerPicked = new Set();

  function closePicker() {
    const p = $('picker');
    p.hidden = true;
    pickerRoot.render(null);
    pickerAlbum = null;
    pickerPicked.clear();
  }

  function submitPicker(e) {
    return runSubmitPicker(e, pickerAlbum, [...pickerPicked], { refresh, closePicker });
  }

  function renderPicker() {
    if (!pickerAlbum) return;
    const candidates = getAssets().filter(
      (a) => !(a.album_ids ?? []).includes(pickerAlbum.album_id),
    );
    pickerRoot.render(
      <PickerView
        album={pickerAlbum}
        candidates={candidates}
        picked={pickerPicked}
        onToggle={(id) => {
          if (pickerPicked.has(id)) pickerPicked.delete(id);
          else pickerPicked.add(id);
          renderPicker();
        }}
        onCancel={closePicker}
        onSubmit={submitPicker}
      />,
    );
  }

  function openPicker() {
    const album = getAlbums().find((a) => a.album_id === getSelectedAlbum());
    if (!album) return;
    pickerAlbum = album;
    pickerPicked.clear();
    renderPicker();
    $('picker').hidden = false;
  }

  // A plain native listener directly on `#picker` (which doubles as this
  // region's React root container, `pickerRoot` above) — a nested tile's
  // `onClick` can't reliably shield itself from this via `stopPropagation()`:
  // React's own delegated listener lives on this SAME node and is registered
  // *before* this one (`createRoot()` runs ahead of `createPicker()` in
  // app.jsx's Boot section), so this raw listener always fires, in full,
  // before — or regardless of — anything a descendant's synthetic handler
  // does. That closed the picker on every tile pick instead of just backdrop
  // clicks. Gating on `e.target === e.currentTarget` sidesteps the whole
  // ordering question: only a click landing on the backdrop itself (never a
  // descendant) closes it, same fix as the lightbox's identical setup.
  $('picker').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePicker();
  });

  return { openPicker, closePicker };
}
