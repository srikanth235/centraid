// Quick-look overlay (#quickRoot root).
import {
  fillVar,
  fmtBytes,
  fmtFull,
  inlineText,
  isAudio,
  isImage,
  isVideo,
  loadable,
  tintBg,
  typeMeta,
} from "../format.ts";
import { I } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { Icon } from "./Shared.tsx";

import styles from "./QuickLook.module.css";

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
  narrow,
  folderName,
  onClose,
  onStep,
}: {
  doc: DriveDoc;
  rows: DriveDoc[];
  /** The compact form factor — the stage loses its side padding and the
   *  Download label collapses to its glyph. Carried as a prop and stamped on
   *  this component's own dialog, never read off a global state class another
   *  module owns (trap #5). */
  narrow: boolean;
  folderName: (id: string | null | undefined) => string;
  onClose: () => void;
  onStep: (delta: number) => void;
}) {
  const m = typeMeta(doc.media_type);
  const idx = rows.findIndex((d) => d.document_id === doc.document_id);
  const text = inlineText(doc);

  let stage;
  if (isImage(doc)) {
    stage = (
      <img
        key={doc.content_id}
        className={styles.quickImage}
        src={doc.content_uri}
        alt={doc.title ?? "Image"}
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
        aria-label={doc.title ?? "Video"}
      >
        {/* The vault has no caption sidecar for a document yet; this is the
            wiring point for its `src` when it does. */}
        <track kind="captions" />
      </video>
    );
  } else if (isAudio(doc)) {
    stage = (
      <div className={styles.quickAudio} key={doc.content_id}>
        <span aria-hidden="true">♪</span>
        <audio
          src={doc.content_uri}
          controls
          preload="metadata"
          aria-label={doc.title ?? "Audio"}
        >
          {/* The vault has no caption sidecar for a document yet; this is the
              wiring point for its `src` when it does. */}
          <track kind="captions" />
        </audio>
      </div>
    );
  } else if (
    String(doc.media_type ?? "") === "application/pdf" &&
    loadable(doc.content_uri)
  ) {
    stage = (
      <iframe
        key={doc.content_id}
        className={styles.quickFrame}
        src={doc.content_uri}
        title={doc.title ?? "PDF"}
        sandbox=""
      />
    );
  } else if (text) {
    // The real document, set in the app's declared READING register at the
    // reading measure — this is the surface a reader opens to READ, and a
    // decorative mock of a page here showed strictly less of the document
    // than the row it was opened from.
    stage = (
      <div className={styles.quickRead} key={doc.content_id}>
        <div className={styles.quickReadBody}>{text}</div>
      </div>
    );
  } else {
    // A document-page mock — only for a kind whose bytes this app cannot
    // render (a .docx, a spreadsheet, a deck), never for text it holds.
    const widths = [96, 88, 93, 70, 90, 82, 60];
    stage = (
      <div className={styles.quickPage} key={doc.content_id}>
        <i
          className={styles.quickPageHead}
          style={{ background: `var(${fillVar(m.cv)})` }}
        />
        {widths.map((w, i) => (
          <i
            key={i}
            className={i === 3 ? styles.quickPageBreak : styles.quickPageRule}
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    );
  }

  return (
    <dialog
      open
      className={styles.quick}
      data-narrow={String(narrow)}
      aria-modal="true"
      aria-label="Quick look"
    >
      <div className={styles.quickTop}>
        <span
          className={styles.quickBadge}
          style={{ background: tintBg(m.cv, 12), color: `var(${m.cv})` }}
        >
          {m.label}
        </span>
        <span className={styles.quickTitle}>{doc.title ?? "Untitled"}</span>
        <a
          className={`kit-btn quiet ${styles.quickBtn}`}
          href={doc.content_uri}
          download={doc.title ?? "file"}
        >
          <Icon svg={I.download!} />
          <span className={styles.quickBtnLabel}>Download</span>
        </a>
        <button
          type="button"
          className={`kit-icon-btn ${styles.quickIcon}`}
          aria-label="Close quick look"
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
        {folderName(doc.folder_id)} · {fmtBytes(doc.byte_size)} · added{" "}
        {fmtFull(doc.created_at)}
      </div>
    </dialog>
  );
}
