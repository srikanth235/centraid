/* oxlint-disable react/iframe-missing-sandbox -- sandboxing kills the PDF viewer; the checked content type bounds the frame. */
import {
  fillVar,
  isAudio,
  isImage,
  isTextKind,
  isVideo,
  loadable,
  typeMeta,
} from "../format.ts";
import { I } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { QuickLookText } from "./QuickLookText.tsx";
import { Icon } from "./Shared.tsx";

import styles from "./QuickLook.module.css";

function StageMedia({ doc }: { doc: DriveDoc }) {
  const m = typeMeta(doc.media_type, doc.title);

  if (isImage(doc))
    return (
      <img
        key={doc.content_id}
        className={styles.image}
        src={doc.content_uri}
        alt={doc.title ?? "Image"}
      />
    );

  if (isVideo(doc))
    return (
      <video
        key={doc.content_id}
        className={styles.media}
        src={doc.content_uri}
        poster={doc.poster_uri ?? undefined}
        controls
        playsInline
        preload="metadata"
        aria-label={doc.title ?? "Video"}
      >
        {/* Wiring point for a caption sidecar's `src`. */}
        <track kind="captions" />
      </video>
    );

  if (isAudio(doc))
    return (
      <div className={styles.audio} key={doc.content_id}>
        <span aria-hidden="true">♪</span>
        <audio
          src={doc.content_uri}
          controls
          preload="metadata"
          aria-label={doc.title ?? "Audio"}
        >
          <track kind="captions" />
        </audio>
      </div>
    );

  if (
    String(doc.media_type ?? "") === "application/pdf" &&
    loadable(doc.content_uri)
  )
    return (
      <iframe
        key={doc.content_id}
        className={styles.frame}
        src={doc.content_uri}
        title={doc.title ?? "PDF"}
      />
    );

  if (isTextKind(doc)) return <QuickLookText key={doc.content_id} doc={doc} />;

  const widths = [96, 88, 93, 70, 90, 82, 60];
  return (
    <div className={styles.page} key={doc.content_id}>
      <i
        className={styles.pageHead}
        style={{ background: `var(${fillVar(m.cv)})` }}
      />
      {widths.map((w, i) => (
        <i
          key={i}
          className={i === 3 ? styles.pageBreak : styles.pageRule}
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}

export function QuickLookStage({
  doc,
  hasPrev,
  hasNext,
  onStep,
}: {
  doc: DriveDoc;
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: number) => void;
}) {
  return (
    <div className={styles.mediaWrap}>
      {/* Mirrored under RTL by logical insets (§18). */}
      <button
        type="button"
        className={`${styles.nav} ${styles.navPrev}`}
        aria-label="Previous document"
        disabled={!hasPrev}
        onClick={() => onStep(-1)}
      >
        <Icon svg={I.chevL!} />
      </button>
      <StageMedia doc={doc} />
      <button
        type="button"
        className={`${styles.nav} ${styles.navNext}`}
        aria-label="Next document"
        disabled={!hasNext}
        onClick={() => onStep(1)}
      >
        <Icon svg={I.chevR!} />
      </button>
    </div>
  );
}
