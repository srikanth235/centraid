// The Albums overview: a responsive card grid (square cover pulled from each
// album's newest photo, name, count) plus a dashed "New album" tile. Pure
// view — `albums` already carries `count`/`coverUri` (computed once by
// sidebar.tsx's renderSidebar, reused here so the two views never disagree
// on a cover/count).
import { PlusIcon } from '../icons.tsx';
import type { Album } from '../types.ts';
import styles from './AlbumGrid.module.css';

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
      {albums.map((album) => (
        <button
          type="button"
          key={album.album_id}
          className={styles.albumCard}
          onClick={() => onOpen(album.album_id)}
        >
          <span
            className={styles.albumCardCover}
            style={album.coverUri ? { backgroundImage: `url(${album.coverUri})` } : undefined}
          />
          <span className={styles.albumCardName}>{album.title ?? 'Album'}</span>
          <span className={styles.albumCardCount}>
            {album.count} photo{album.count === 1 ? '' : 's'}
          </span>
        </button>
      ))}
      <button
        type="button"
        className={`${styles.albumCard} ${styles.albumCardNew}`}
        onClick={onNewAlbum}
      >
        <PlusIcon size={26} />
        <span>New album</span>
      </button>
    </div>
  );
}
