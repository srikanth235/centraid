// The Albums overview: a responsive card grid (square cover pulled from each
// album's newest photo, name, count) plus a dashed "New album" tile. Pure
// view — `albums` already carries `count`/`coverUri` (computed once by
// sidebar.jsx's renderSidebar, reused here so the two views never disagree
// on a cover/count).
import { PlusIcon } from '../icons.jsx';

export function AlbumGridView({ albums, onOpen, onNewAlbum }) {
  return (
    <div className="ph-album-grid">
      {albums.map((album) => (
        <button
          type="button"
          key={album.album_id}
          className="ph-album-card"
          onClick={() => onOpen(album.album_id)}
        >
          <span
            className="ph-album-card-cover"
            style={album.coverUri ? { backgroundImage: `url(${album.coverUri})` } : undefined}
          />
          <span className="ph-album-card-name">{album.title ?? 'Album'}</span>
          <span className="ph-album-card-count">
            {album.count} photo{album.count === 1 ? '' : 's'}
          </span>
        </button>
      ))}
      <button type="button" className="ph-album-card ph-album-card-new" onClick={onNewAlbum}>
        <PlusIcon size={26} />
        <span>New album</span>
      </button>
    </div>
  );
}
