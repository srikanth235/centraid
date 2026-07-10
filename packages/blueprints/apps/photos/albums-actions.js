// The three album commands that hit the vault (create/rename/delete). Kept
// beside outcomes.js rather than inline in app.jsx purely for line budget —
// each still needs a couple of app.jsx-owned setters/orchestrators, passed in
// per call exactly like every other action module here.
import { toast } from './kit.js';
import { act, narrate } from './outcomes.js';

export async function submitNewAlbum(
  title,
  { refresh, renderToolbar, setNewAlbumOpen, setSelectedAlbum },
) {
  const outcome = await act('create-album', { title });
  setNewAlbumOpen(false);
  if (narrate(outcome)) {
    if (outcome.output?.album_id) setSelectedAlbum(outcome.output.album_id);
    await refresh();
  } else {
    renderToolbar();
  }
}

export async function submitRenameAlbum(
  album,
  title,
  { refresh, renderToolbar, setRenamingAlbumForId },
) {
  const outcome = await act('rename-album', { album_id: album.album_id, title });
  setRenamingAlbumForId(null);
  if (narrate(outcome)) await refresh();
  else renderToolbar();
}

export async function deleteAlbumConfirmed(album, { refresh, setSelectedAlbum }) {
  const outcome = await act('delete-album', { album_id: album.album_id });
  if (narrate(outcome)) {
    setSelectedAlbum(null);
    toast('Album deleted — its photos stay in your library.');
    await refresh();
  }
}
