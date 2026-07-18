// The main pane's toolbar row: active-view title + subtitle, a back
// affordance inside an album, "Add photos"/"New album" on the views that
// want them, and the Select toggle. Pure view — app.tsx computes every
// derived string/flag and passes it straight through.
import { ChevronLeftIcon, PlusIcon } from '../icons.tsx';
import styles from './Toolbar.module.css';

export function ToolbarView({
  title,
  subtitle,
  showBack,
  onBack,
  showNewAlbum,
  onNewAlbum,
  showAddPhotos,
  onAddPhotos,
  showSelect,
  selectMode,
  onToggleSelect,
}: {
  title: string;
  subtitle: string;
  showBack: boolean;
  onBack: () => void;
  showNewAlbum: boolean;
  onNewAlbum: () => void;
  showAddPhotos: boolean;
  onAddPhotos: () => void;
  showSelect: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
}) {
  return (
    <div className={styles.toolbar}>
      {showBack ? (
        <button
          type="button"
          className={`kit-icon-btn ${styles.backBtn}`}
          aria-label="Back to albums"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </button>
      ) : null}
      <div className={styles.toolbarTitle}>
        <div className={styles.toolbarH1}>{title}</div>
        <div className={styles.toolbarSub}>{subtitle}</div>
      </div>
      <div className={styles.toolbarActions}>
        {showAddPhotos ? (
          <button type="button" className={`kit-btn ${styles.pillBtn}`} onClick={onAddPhotos}>
            Add photos
          </button>
        ) : null}
        {showNewAlbum ? (
          <button type="button" className={`kit-btn ${styles.pillBtn}`} onClick={onNewAlbum}>
            <PlusIcon size={15} />
            New album
          </button>
        ) : null}
        {showSelect ? (
          <button
            type="button"
            className={`kit-btn ${styles.pillBtn}`}
            data-active={selectMode ? 'true' : 'false'}
            onClick={onToggleSelect}
          >
            {selectMode ? 'Cancel' : 'Select'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
