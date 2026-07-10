// The album chips + per-album tools panel: select/new-album/rename-album/
// delete-album. Not a pure view component — it owns the render orchestrator
// for its two roots and a sliver of state. `newAlbumOpen`/`renamingAlbumForId`
// are private to this controller (nothing outside the toolbar region ever
// reads them); `selectedAlbum` stays app.jsx's own state (refresh/renderGrid/
// the picker all read it directly), so it's threaded through as a
// getter/setter pair instead of living here.
import { AlbumToolsView } from './components/AlbumTools.jsx';
import { ChipsView } from './components/Chips.jsx';
import { deleteAlbumConfirmed, submitNewAlbum, submitRenameAlbum } from './albums-actions.js';
import { TRASH } from './constants.js';
import { $ } from './dom.js';

export function createToolbar({
  chipsRoot,
  albumToolsRoot,
  getAlbums,
  getTrash,
  getAlbumAssets,
  getSelectedAlbum,
  setSelectedAlbum,
  refresh,
  renderGrid,
  exitSelectModeIfActive,
  openPicker,
}) {
  // The "＋ New album" chip while typing, else null — a singleton flag.
  let newAlbumOpen = false;
  // Which album is mid-rename, else null — discarded the moment the selected
  // album no longer matches (switching albums must never show album X's
  // half-typed rename inside album Y's tools). The rename `<input>` is also
  // keyed by album id (AlbumToolsView), so React mints a fresh DOM node on
  // top of this guard rather than relying on either alone.
  let renamingAlbumForId = null;

  function renderToolbar() {
    renderChips();
    renderAlbumTools();
    // Trash tiles offer exactly one action — selection has nothing to select.
    $('selectBtn').hidden = getSelectedAlbum() === TRASH;
  }

  function selectAlbum(albumId) {
    setSelectedAlbum(albumId);
    exitSelectModeIfActive();
    renderToolbar();
    renderGrid();
  }

  function renderChips() {
    $('albumChips').hidden = false;
    chipsRoot.render(
      <ChipsView
        albums={getAlbums()}
        selectedAlbum={getSelectedAlbum()}
        trashCount={getTrash().length}
        newAlbumOpen={newAlbumOpen}
        onSelect={selectAlbum}
        onStartNewAlbum={() => {
          newAlbumOpen = true;
          renderToolbar();
        }}
        onSubmitNewAlbum={(title) =>
          submitNewAlbum(title, {
            refresh,
            renderToolbar,
            setNewAlbumOpen: (v) => {
              newAlbumOpen = v;
            },
            setSelectedAlbum,
          })
        }
        onCancelNewAlbum={() => {
          newAlbumOpen = false;
          renderToolbar();
        }}
      />,
    );
  }

  function renderAlbumTools() {
    const tools = $('albumTools');
    const album = getAlbums().find((a) => a.album_id === getSelectedAlbum());
    tools.hidden = !album;
    if (!album) {
      renamingAlbumForId = null;
      albumToolsRoot.render(null);
      return;
    }
    if (renamingAlbumForId !== album.album_id) renamingAlbumForId = null;
    albumToolsRoot.render(
      <AlbumToolsView
        album={album}
        count={getAlbumAssets().length}
        renaming={renamingAlbumForId === album.album_id}
        onAdd={openPicker}
        onStartRename={(a) => {
          renamingAlbumForId = a.album_id;
          renderToolbar();
        }}
        onRenameSubmit={(renamed, title) =>
          submitRenameAlbum(renamed, title, {
            refresh,
            renderToolbar,
            setRenamingAlbumForId: (id) => {
              renamingAlbumForId = id;
            },
          })
        }
        onRenameCancel={() => {
          renamingAlbumForId = null;
          renderToolbar();
        }}
        onDelete={(deleted) => deleteAlbumConfirmed(deleted, { refresh, setSelectedAlbum })}
      />,
    );
  }

  return { renderToolbar };
}
