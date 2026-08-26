// Albums shelf (v4 handoff §5): paper, not elevation; coverless ground is
// `--skel` at exact cover geometry; the New tile keeps the strong outline and
// stays the only dashed element.
import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText, safeBackgroundImage } from "../../_shared/untrusted.ts";
import { PlusIcon } from "../icons.tsx";
import type { Album } from "../types.ts";

import styles from "./AlbumGrid.module.css";

export function AlbumGridView({
  albums,
  onOpen,
  onNewAlbum,
}: {
  albums: Album[];
  onOpen: (id: string) => void;
  onNewAlbum: () => void;
}) {
  return (
    <div className={styles.albumGrid}>
      {albums.map((album) => {
        const cover = safeBackgroundImage(album.coverUri);
        const title = displayText(album.title ?? "Album");
        return (
          <div key={album.album_id} className={styles.albumCard}>
            <button
              type="button"
              className="kit-stretch-btn"
              aria-label={`Open ${title}`}
              onClick={() => onOpen(album.album_id)}
            />
            <span
              className={styles.albumCardCover}
              style={cover ? { backgroundImage: cover } : undefined}
            />
            <span className={styles.albumCardName}>{title}</span>
            <span className={styles.albumCardCount}>{album.count ?? 0}</span>
            <PendingWriteActions
              row={album as unknown as Record<string, unknown>}
              onEdit={() => onOpen(album.album_id)}
            />
          </div>
        );
      })}
      <button type="button" className={styles.albumCard} onClick={onNewAlbum}>
        <span className={styles.albumCardNewCover}>
          <PlusIcon size={22} />
        </span>
        <span className={styles.albumCardName}>New album</span>
      </button>
    </div>
  );
}
