// Grid view row (#grid root's mapped children).
import type { MouseEvent } from '../react-core.min.js';
import { fmtBytes, fmtDate, isImage, isVideo, tintBg, typeMeta } from '../format.ts';
import type { DriveDoc } from '../types.ts';
import { Checkbox, CustodyDot } from './Shared.tsx';
import styles from './Grid.module.css';
import shared from './shared.module.css';

export function GridCard({
  doc,
  index,
  selectedIds,
  onOpenDetails,
  onOpenQuick,
  onToggleSelect,
}: {
  doc: DriveDoc;
  index: number;
  selectedIds: Set<string>;
  onOpenDetails: (id: string) => void;
  onOpenQuick: (id: string) => void;
  onToggleSelect: (id: string, index: number, shift: boolean) => void;
}) {
  const m = typeMeta(doc.media_type);
  const selected = selectedIds.has(doc.document_id);
  return (
    <div
      className={styles.card}
      data-selected={String(selected)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a')) return;
        onOpenDetails(doc.document_id);
      }}
    >
      <div
        className={styles.thumb}
        style={{ background: tintBg(m.cv, 15) }}
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
            <span className={shared.mediaPlay} aria-hidden="true">
              ▶
            </span>
          </>
        ) : (
          <>
            <span className={styles.thumbLabel} style={{ color: `var(${m.cv})` }}>
              {m.label}
            </span>
            <div className={styles.thumbLines}>
              <i style={{ width: '70%', background: `var(${m.cv})`, opacity: 0.18 }}></i>
              <i style={{ width: '90%', background: `var(${m.cv})`, opacity: 0.14 }}></i>
              <i style={{ width: '55%', background: `var(${m.cv})`, opacity: 0.14 }}></i>
            </div>
          </>
        )}
      </div>
      <Checkbox
        cls={styles.cardSelect!}
        selected={selected}
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          onToggleSelect(doc.document_id, index, e.shiftKey);
        }}
        label={`Select ${doc.title ?? 'document'}`}
      />
      <div className={styles.cardBody}>
        <div className={styles.cardTitle}>
          {doc.title ?? 'Untitled'}
          {doc.starred ? (
            <span className={shared.starInd} aria-label="Starred">
              ★
            </span>
          ) : null}
        </div>
        <div className={styles.cardMeta}>
          {fmtBytes(doc.byte_size)} · {fmtDate(doc.created_at)}
          <CustodyDot state={doc.custody_state} />
        </div>
      </div>
    </div>
  );
}
