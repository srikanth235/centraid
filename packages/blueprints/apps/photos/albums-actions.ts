// The three album commands that hit the vault (create/rename/delete). Kept
// beside outcomes.ts rather than inline in app.tsx purely for line budget —
// each still needs a couple of app.tsx-owned setters/orchestrators, passed in
// per call exactly like every other action module here.
import { toast } from './kit.ts';
import { act, narrate } from './outcomes.ts';
import type { Album } from './types.ts';

export async function submitNewAlbum(
  title: string,
  {
    refresh,
    renderToolbar,
    setNewAlbumOpen,
    setSelectedAlbum,
  }: {
    refresh: () => Promise<void>;
    renderToolbar: () => void;
    setNewAlbumOpen: (v: boolean) => void;
    setSelectedAlbum: (id: string | null) => void;
  },
): Promise<void> {
  const outcome = await act('create-album', { title });
  setNewAlbumOpen(false);
  if (narrate(outcome)) {
    const albumId = outcome?.output?.album_id;
    if (albumId) setSelectedAlbum(albumId as string);
    await refresh();
  } else {
    renderToolbar();
  }
}

export async function submitRenameAlbum(
  album: Album,
  title: string,
  {
    refresh,
    renderToolbar,
    setRenamingAlbumForId,
  }: {
    refresh: () => Promise<void>;
    renderToolbar: () => void;
    setRenamingAlbumForId: (id: string | null) => void;
  },
): Promise<void> {
  const outcome = await act('rename-album', { album_id: album.album_id, title });
  setRenamingAlbumForId(null);
  if (narrate(outcome)) await refresh();
  else renderToolbar();
}

export async function deleteAlbumConfirmed(
  album: Album,
  {
    refresh,
    setSelectedAlbum,
  }: { refresh: () => Promise<void>; setSelectedAlbum: (id: string | null) => void },
): Promise<void> {
  const outcome = await act('delete-album', { album_id: album.album_id });
  if (narrate(outcome)) {
    setSelectedAlbum(null);
    toast('Album deleted — its photos stay in your library.');
    await refresh();
  }
}
