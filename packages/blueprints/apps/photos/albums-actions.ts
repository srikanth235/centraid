import { statusLine } from "@centraid/design/elements";

import { act, narrate, writeTarget } from "./outcomes.ts";
import type { Album } from "./types.ts";

const ownScope = (): string | null => {
  const target = writeTarget("own");
  return target.disabled ? null : target.scopeId;
};

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
  }
): Promise<void> {
  const outcome = await act("create-album", { title }, ownScope());
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
  }
): Promise<void> {
  const outcome = await act(
    "rename-album",
    { album_id: album.album_id, title },
    ownScope()
  );
  setRenamingAlbumForId(null);
  if (narrate(outcome)) await refresh();
  else renderToolbar();
}

export async function deleteAlbumConfirmed(
  album: Album,
  {
    refresh,
    setSelectedAlbum,
  }: {
    refresh: () => Promise<void>;
    setSelectedAlbum: (id: string | null) => void;
  }
): Promise<void> {
  const outcome = await act(
    "delete-album",
    { album_id: album.album_id },
    ownScope()
  );
  if (narrate(outcome)) {
    const revisionId = String(outcome?.output?.revision_id ?? "");
    setSelectedAlbum(null);
    statusLine("Album deleted — its photos stay in your library.", {
      duration: revisionId ? 10_000 : undefined,
      undoLabel: revisionId ? "Undo" : undefined,
      onUndo: revisionId
        ? () => {
            void (async () => {
              const restored = await act(
                "restore-album",
                { album_id: album.album_id, revision_id: revisionId },
                ownScope()
              );
              if (narrate(restored)) {
                setSelectedAlbum(album.album_id);
                await refresh();
                statusLine("Album restored.");
              }
            })();
          }
        : undefined,
    });
    await refresh();
  }
}
