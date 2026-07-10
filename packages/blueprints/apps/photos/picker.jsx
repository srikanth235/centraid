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

  $('picker').addEventListener('click', closePicker);

  return { openPicker, closePicker };
}
