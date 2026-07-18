// The selection toolbar: count, "Add to album ▾" menu, Delete, exit. The
// "Add to album ▾" menu's open/closed flag (`menuOpen`) is app.tsx state (it
// drives an away-click listener added/removed in lockstep with it) — this
// view only reads it as a prop. `countRef` is the batch-progress node that
// selection-actions.ts mutates via direct `textContent` writes.
import { armConfirm } from '../kit.js';
import { useRef } from '../react-core.min.js';
import { runBatchAddToAlbum, runBatchDelete } from '../selection-actions.ts';
import type { Album } from '../types.ts';
import styles from './SelectionBar.module.css';

export function SelectionBarView({
  selectedIds,
  albums: albumList,
  menuOpen,
  busy,
  refresh,
  setBarBusy,
  onToggleMenu,
  onCloseMenu,
  onExit,
}: {
  selectedIds: Set<string>;
  albums: Album[];
  menuOpen: boolean;
  busy: boolean;
  refresh: () => Promise<void>;
  setBarBusy: (on: boolean) => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onExit: () => void;
}) {
  const count = selectedIds.size;
  const countRef = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span className={styles.count} ref={countRef}>
        {count === 0 ? 'Select photos' : `${count} selected`}
      </span>
      <div className="bar-menu-wrap">
        <button
          type="button"
          className={`kit-btn ${styles.btn}`}
          aria-haspopup="true"
          disabled={count === 0}
          onClick={onToggleMenu}
        >
          Add to album ▾
        </button>
        {menuOpen ? (
          // kit-popover/kit-popover-item are the shared CSS classes; the
          // JS-positioned openPopover() helper is a bigger behavioral swap
          // than this app wants (this menu's open/close is React state, not
          // an imperative singleton), so `.albumMenu` stays as a thin local
          // positioning rule (compound selector — kit.css loads after
          // app.css and would otherwise win the `position` tie).
          <div className={`kit-popover ${styles.albumMenu}`} role="menu">
            {albumList.length === 0 ? (
              <p className={`${styles.albumMenuEmpty} kit-muted`}>
                No albums yet — make one from the chips above.
              </p>
            ) : (
              albumList.map((album) => (
                <button
                  key={album.album_id}
                  type="button"
                  className={`kit-popover-item ${styles.albumMenuItem}`}
                  role="menuitem"
                  onClick={() => {
                    onCloseMenu();
                    runBatchAddToAlbum([...selectedIds], album, countRef.current, {
                      refresh,
                      setBarBusy,
                      exitSelectMode: onExit,
                    });
                  }}
                >
                  {album.title ?? 'Album'}
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className={`kit-btn ${styles.btn} danger`}
        disabled={count === 0}
        onClick={(e) => {
          if (busy || selectedIds.size === 0) return;
          if (!armConfirm(e.currentTarget, { armedLabel: `Delete ${selectedIds.size}?` })) return;
          runBatchDelete([...selectedIds], countRef.current, {
            refresh,
            setBarBusy,
            exitSelectMode: onExit,
          });
        }}
      >
        Delete
      </button>
      <button type="button" className={styles.close} aria-label="Exit selection" onClick={onExit}>
        ×
      </button>
    </>
  );
}
