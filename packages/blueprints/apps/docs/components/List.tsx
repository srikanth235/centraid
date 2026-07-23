// List view: the head row (#listHead root), each row (#list root's mapped
// children) and the truncation footer (#windowFoot root).
import type { CSSProperties, MouseEvent } from 'react';
import {
  fmtBytes,
  fmtDate,
  isImage,
  isVideo,
  purgeCountdown,
  tintBg,
  typeMeta,
} from '../format.ts';
import { I } from '../icons.ts';
import type { DriveDoc } from '../types.ts';
import { Checkbox, CustodyDot, Icon, Snippet } from './Shared.tsx';
import styles from './List.module.css';
import shared from './shared.module.css';

export function ListRow({
  doc,
  index,
  selectedIds,
  narrow,
  search,
  trashed,
  folderName,
  onOpenDetails,
  onOpenQuick,
  onToggleSelect,
  onOpenMenu,
  onRestore,
}: {
  doc: DriveDoc;
  index: number;
  selectedIds: Set<string>;
  narrow: boolean;
  search: string;
  trashed: boolean;
  folderName: (id: string | null | undefined) => string;
  onOpenDetails: (id: string) => void;
  onOpenQuick: (id: string) => void;
  onToggleSelect: (id: string, index: number, shift: boolean) => void;
  onOpenMenu: (anchor: HTMLElement, doc: DriveDoc) => void;
  onRestore: (doc: DriveDoc) => void;
}) {
  const m = typeMeta(doc.media_type);
  const selected = selectedIds.has(doc.document_id);
  return (
    <div
      className={styles.row}
      data-selected={String(selected)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        onOpenDetails(doc.document_id);
      }}
    >
      <Checkbox
        cls={styles.check!}
        selected={selected}
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          onToggleSelect(doc.document_id, index, e.shiftKey);
        }}
        label={`Select ${doc.title ?? 'document'}`}
      />
      <button
        type="button"
        className={styles.badge}
        style={{ background: tintBg(m.cv, 16) }}
        aria-label={`Preview ${doc.title ?? 'document'}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpenQuick(doc.document_id);
        }}
      >
        {isImage(doc) ? (
          <img src={doc.content_uri} alt="" loading="lazy" />
        ) : isVideo(doc) && doc.poster_uri ? (
          <>
            <img
              src={doc.poster_uri}
              alt=""
              loading="lazy"
              onError={(e) => e.currentTarget.remove()}
            />
            <span className={`${shared.mediaPlay} ${shared.small}`} aria-hidden="true">
              ▶
            </span>
          </>
        ) : (
          <span style={{ color: `var(${m.cv})` }}>{m.label}</span>
        )}
      </button>
      <div className={styles.rowMain}>
        <button
          type="button"
          className={styles.rowTitle}
          onClick={(e) => {
            e.stopPropagation();
            onOpenQuick(doc.document_id);
          }}
        >
          {doc.title ?? 'Untitled'}
          {doc.starred ? (
            <span className={shared.starInd} aria-label="Starred">
              ★
            </span>
          ) : null}
        </button>
        {search.trim() && doc.snippet ? <Snippet snippet={doc.snippet} /> : null}
        {narrow ? (
          <div className={styles.rowMeta}>
            {trashed
              ? `from ${folderName(doc.folder_id)} · ${purgeCountdown(doc.purge_at)}`
              : search.trim()
                ? `in ${folderName(doc.folder_id)}`
                : `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}`}
          </div>
        ) : null}
      </div>
      <span className={`${styles.cell} ${styles.where}`}>
        {trashed ? `from ${folderName(doc.folder_id)}` : folderName(doc.folder_id)}
      </span>
      <span className={`${styles.cell} ${styles.size}`}>{fmtBytes(doc.byte_size)}</span>
      <span className={`${styles.cell} ${styles.added}${trashed ? ` ${styles.purge}` : ''}`}>
        {trashed ? purgeCountdown(doc.purge_at) : fmtDate(doc.created_at)}
        <CustodyDot state={doc.custody_state} />
      </span>
      <div className={styles.rowEnd}>
        {trashed ? (
          <button
            type="button"
            className="kit-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRestore(doc);
            }}
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            className="kit-icon-btn"
            style={{ '--kit-icon-btn-size': '1.875rem' } as CSSProperties}
            aria-label={`Actions for ${doc.title ?? 'document'}`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              onOpenMenu(e.currentTarget, doc);
            }}
          >
            <Icon svg={I.dots!} />
          </button>
        )}
      </div>
    </div>
  );
}

export function ListHead({
  rows,
  selectedIds,
  onToggleAll,
}: {
  rows: DriveDoc[];
  selectedIds: Set<string>;
  onToggleAll: (rows: DriveDoc[], allSelected: boolean) => void;
}) {
  const allSel = rows.length > 0 && rows.every((d) => selectedIds.has(d.document_id));
  return (
    <>
      <Checkbox
        cls={styles.check!}
        selected={allSel}
        onClick={() => onToggleAll(rows, allSel)}
        label={allSel ? 'Deselect all' : 'Select all'}
      />
      <span style={{ width: '34px' }}></span>
      <span className={`${styles.col} ${styles.name}`}>Name</span>
      <span className={`${styles.col} ${styles.where}`}>Where</span>
      <span className={`${styles.col} ${styles.size}`}>Size</span>
      <span className={`${styles.col} ${styles.added}`}>Added</span>
      <span className={`${styles.col} ${styles.end}`}></span>
    </>
  );
}

export function WindowFoot({
  driveWindow,
  onShowMore,
}: {
  driveWindow: number;
  onShowMore: () => Promise<void> | void;
}) {
  return (
    <>
      <span>Showing your latest {driveWindow} documents — older ones are a search away.</span>
      <button
        type="button"
        className="kit-btn"
        onClick={async (e) => {
          e.currentTarget.disabled = true;
          await onShowMore();
        }}
      >
        Show more
      </button>
    </>
  );
}
