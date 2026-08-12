// The Albums shelf (v4 handoff §5): a card grid — 4 columns desktop / 2 phone,
// a 4:3 cover, 4px radius, the title clamped to two lines, the count in mono.
//
// WHAT CHANGED FROM v3, and why each one had to:
//
//  * the cover was a SQUARE with a 12px radius and a drop shadow. A card is a
//    sheet laid on the page, not a plane floating above it ("surfaces are
//    paper, not elevation"), so the shadow went and the ratio is the handoff's
//    4:3 — an album cover is a photograph, and photographs are not square.
//  * the ground was `--bg-sunken`, which reads as a recessed track. A cover
//    with no bytes yet is an ABSENCE, and the ground for an absence is `--skel`
//    (§2.2) at the exact geometry the cover will occupy, so nothing reflows.
//  * the title was `--t-body-strong` and truncated with an ellipsis on one
//    line. Text in a fixed-height container is LINE-CLAMPED, never clipped, and
//    the role §5 names is UI at 13px.
//  * the count said `4 photos`. Numerics are mono and tabular everywhere, so
//    the number stands on its own in the numeric register.
//  * the New album tile hovered to `--accent`, which IS the ink — an outline
//    turning accent-coloured reads as a fill arriving. It takes the strong line
//    instead, and it is the only dashed thing here because it is the only one
//    that is not an album.
//
// The vault initial §5 puts in a cover's top-leading corner is deliberately
// absent: album membership is computed against OWN-SCOPE assets only
// (app-root.tsx's header — a collection id minted in one scope means nothing in
// another), so every album on this shelf is the member's own and the marker
// would fire on none of them. A marker that can never fire is not a marker.
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
