// The v2 sidebar's render orchestrator — replaces toolbar.jsx (and folds in
// what Chips.jsx/AlbumTools.jsx used to own): the nav list, the album list's
// inline new-album/rename editors, the narrow-width drawer's open/closed
// state, and the storage footer. Same split as every other region here:
// `selectedAlbum` stays app.jsx's own state (refresh/renderGrid/the picker
// all read it directly), threaded through as a getter/setter pair.
import { deleteAlbumConfirmed, submitNewAlbum, submitRenameAlbum } from './albums-actions.js';
import { fmtBytes } from './kit.js';
import { SidebarView } from './components/Sidebar.jsx';
import { $ } from './dom.js';

export function createSidebar({
  sidebarRoot,
  getAlbums,
  getAssets,
  getTrash,
  getSelectedAlbum,
  setSelectedAlbum,
  refresh,
  renderMain,
  exitSelectModeIfActive,
}) {
  let newAlbumOpen = false;
  let renamingAlbumForId = null;
  let sidebarOpen = false;

  function openSidebar() {
    if (sidebarOpen) return;
    sidebarOpen = true;
    renderSidebar();
  }
  function closeSidebar() {
    if (!sidebarOpen) return;
    sidebarOpen = false;
    renderSidebar();
  }

  // Entry point for the "New album" buttons that live OUTSIDE the sidebar
  // (the toolbar's Albums-view button, the AlbumGrid's dashed tile) — the
  // editor itself only exists inside the sidebar's album list, so this also
  // opens the narrow-width drawer if it's currently closed.
  function openNewAlbum() {
    newAlbumOpen = true;
    sidebarOpen = true;
    renderSidebar();
  }

  function selectShelf(id) {
    setSelectedAlbum(id);
    exitSelectModeIfActive();
    sidebarOpen = false; // picking a destination always closes the narrow drawer
    renderSidebar();
    renderMain();
  }

  function renderSidebar() {
    const rawAlbums = getAlbums();
    const assets = getAssets();
    if (renamingAlbumForId && !rawAlbums.some((a) => a.album_id === renamingAlbumForId)) {
      renamingAlbumForId = null;
    }
    // Mini cover thumb + live count per album, computed off the loaded
    // window (same reach every other album-scoped view already has).
    const albums = rawAlbums.map((album) => {
      const members = assets.filter((a) => (a.album_ids ?? []).includes(album.album_id));
      const cover = members[0];
      return {
        ...album,
        count: members.length,
        coverUri: cover?.thumb_uri ?? cover?.content_uri ?? null,
      };
    });
    const tagOptions = [...new Set(assets.flatMap((a) => a.tags ?? []))].sort();
    const bytes = assets.reduce((sum, a) => sum + (a.byte_size ?? 0), 0);
    const storageLabel =
      assets.length === 0
        ? 'Nothing uploaded yet'
        : `${fmtBytes(bytes)} across ${assets.length} photo${assets.length === 1 ? '' : 's'}`;

    sidebarRoot.render(
      <SidebarView
        open={sidebarOpen}
        onClose={closeSidebar}
        onUpload={() => $('fileInput').click()}
        counts={{
          all: assets.length,
          favorites: assets.filter((a) => a.favorite).length,
          albums: albums.length,
          trash: getTrash().length,
        }}
        selectedAlbum={getSelectedAlbum()}
        onSelect={selectShelf}
        albums={albums}
        renamingAlbumForId={renamingAlbumForId}
        onStartRename={(album) => {
          renamingAlbumForId = album.album_id;
          renderSidebar();
        }}
        onRenameSubmit={(album, title) =>
          submitRenameAlbum(album, title, {
            refresh,
            renderToolbar: renderSidebar,
            setRenamingAlbumForId: (id) => {
              renamingAlbumForId = id;
            },
          })
        }
        onRenameCancel={() => {
          renamingAlbumForId = null;
          renderSidebar();
        }}
        onDeleteAlbum={(album) => deleteAlbumConfirmed(album, { refresh, setSelectedAlbum })}
        newAlbumOpen={newAlbumOpen}
        onStartNewAlbum={() => {
          newAlbumOpen = true;
          renderSidebar();
        }}
        onSubmitNewAlbum={(title) =>
          submitNewAlbum(title, {
            refresh,
            renderToolbar: renderSidebar,
            setNewAlbumOpen: (v) => {
              newAlbumOpen = v;
            },
            setSelectedAlbum,
          })
        }
        onCancelNewAlbum={() => {
          newAlbumOpen = false;
          renderSidebar();
        }}
        tagOptions={tagOptions}
        storageLabel={storageLabel}
      />,
    );
  }

  return {
    renderSidebar,
    openSidebar,
    closeSidebar,
    openNewAlbum,
    isSidebarOpen: () => sidebarOpen,
  };
}
