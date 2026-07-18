// Quick-look overlay (#quickRoot root).
import {
  fmtBytes,
  fmtFull,
  isAudio,
  isImage,
  isVideo,
  loadable,
  tintBg,
  typeMeta,
} from '../format.ts';
import { I } from '../icons.ts';
import type { DriveDoc } from '../types.ts';
import { Icon } from './Shared.tsx';
import styles from './QuickLook.module.css';

// The iframe (PDF) / img stage is load-bearing: content_uri is a same-origin
// vault blob URL or data: URI (CSP `default-src 'self'` — issue #296), and
// re-setting `src` reloads/rescrolls it. Under Lit this needed an explicit
// `lastQuickId` short-circuit to skip re-rendering entirely for an unrelated
// re-render of the SAME open doc. React's reconciler gives the same guarantee
// for free here: `renderQuick()` is called on every unrelated `render()` too,
// but as long as the doc is unchanged the new element tree has the same
// type/position/props at every node (including this `src` string, which is
// never regenerated — it's the same field straight off the doc), so React
// bails out of touching the real `<iframe>`/`<img>` DOM node at all. The
// `key={doc.content_id}` on the stage element is the belt-and-braces part:
// it forces a genuine remount (a real reload) exactly when the doc changes
// (prev/next), and never otherwise.
export function QuickLook({
  doc,
  rows,
  folderName,
  onClose,
  onStep,
}: {
  doc: DriveDoc;
  rows: DriveDoc[];
  folderName: (id: string | null | undefined) => string;
  onClose: () => void;
  onStep: (delta: number) => void;
}) {
  const m = typeMeta(doc.media_type);
  const idx = rows.findIndex((d) => d.document_id === doc.document_id);

  let stage;
  if (isImage(doc)) {
    stage = (
      <img
        key={doc.content_id}
        className={styles.quickImage}
        src={doc.content_uri}
        alt={doc.title ?? 'Image'}
      />
    );
  } else if (isVideo(doc)) {
    stage = (
      <video
        key={doc.content_id}
        className={styles.quickMedia}
        src={doc.content_uri}
        poster={doc.poster_uri ?? undefined}
        controls
        playsInline
        preload="metadata"
        aria-label={doc.title ?? 'Video'}
      />
    );
  } else if (isAudio(doc)) {
    stage = (
      <div className={styles.quickAudio} key={doc.content_id}>
        <span aria-hidden="true">♪</span>
        <audio
          src={doc.content_uri}
          controls
          preload="metadata"
          aria-label={doc.title ?? 'Audio'}
        />
      </div>
    );
  } else if (String(doc.media_type ?? '') === 'application/pdf' && loadable(doc.content_uri)) {
    stage = (
      <iframe
        key={doc.content_id}
        className={styles.quickFrame}
        src={doc.content_uri}
        title={doc.title ?? 'PDF'}
      />
    );
  } else {
    // A document-page mock for docs / sheets / slides / other.
    const widths = [96, 88, 93, 70, 90, 82, 60];
    stage = (
      <div className={styles.quickPage} key={doc.content_id}>
        <i
          style={{
            height: '11px',
            width: '44%',
            background: `var(${m.cv})`,
            opacity: 0.85,
            marginBottom: '22px',
          }}
        ></i>
        {widths.map((w, i) => (
          <i
            key={i}
            style={{
              height: '7px',
              width: `${w}%`,
              background: i < 4 ? '#e6e7ea' : '#eceef1',
              marginBottom: `${i === 3 ? 26 : 11}px`,
            }}
          ></i>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.quick} role="dialog" aria-modal="true" aria-label="Quick look">
      <div className={styles.quickTop}>
        <span
          className={styles.quickBadge}
          style={{ background: tintBg(m.cv, 20), color: `var(${m.cv})` }}
        >
          {m.label}
        </span>
        <span className={styles.quickTitle}>{doc.title ?? 'Untitled'}</span>
        <a className={styles.quickBtn} href={doc.content_uri} download={doc.title ?? 'file'}>
          <Icon svg={I.download!} />
          Download
        </a>
        <button
          type="button"
          className={`kit-icon-btn ${styles.quickIcon}`}
          aria-label="Close"
          onClick={onClose}
        >
          <Icon svg={I.close!} />
        </button>
      </div>
      <div className={styles.quickStage}>
        <button
          type="button"
          className="kit-viewer-nav prev"
          aria-label="Previous"
          disabled={idx <= 0}
          onClick={() => onStep(-1)}
        >
          <Icon svg={I.chevL!} />
        </button>
        {stage}
        <button
          type="button"
          className="kit-viewer-nav next"
          aria-label="Next"
          disabled={idx < 0 || idx >= rows.length - 1}
          onClick={() => onStep(1)}
        >
          <Icon svg={I.chevR!} />
        </button>
      </div>
      <div className={styles.quickFoot}>
        {folderName(doc.folder_id)} · {fmtBytes(doc.byte_size)} · added {fmtFull(doc.created_at)}
      </div>
    </div>
  );
}
