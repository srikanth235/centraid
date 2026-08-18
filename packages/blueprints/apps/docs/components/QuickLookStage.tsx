/* oxlint-disable react/iframe-missing-sandbox -- the one <iframe> below holds
   the browser's own PDF viewer, and a sandboxed frame cannot instantiate a
   plugin document at all: the attribute did not harden this preview, it
   replaced it with a white rectangle. What bounds the frame is the CONTENT
   TYPE, checked on the branch that renders it. Full reasoning at the element. */
// WHAT THE STAGE HOLDS, and the two steps beside it (§7's `vMediaWrap`).
//
// Split out of QuickLook.tsx on the same seam Photos splits `ViewerStage` on:
// the shell owns which regions exist, this file owns the one region that
// changes with the KIND of the document. Six branches, and each is the
// truthful rendering of its kind rather than a mock of one.
//
// PREV AND NEXT STEP TO THE PREVIOUS AND NEXT DOCUMENT — not to the previous
// and next page. The handoff is explicit that those are two different axes and
// must not be one control, which is also why this stage draws no filmstrip:
// the strip walks the PAGES of one document, and neither this seat nor the
// frame a PDF renders in exposes a page model to walk — the browser's own
// viewer owns paging inside that frame.
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

// The iframe (PDF) / img stage is load-bearing: content_uri is a same-origin
// vault blob URL or data: URI (CSP `default-src 'self'` — issue #296), and
// re-setting `src` reloads/rescrolls it. React's reconciler gives the
// short-circuit for free: as long as the doc is unchanged the new element tree
// has the same type/position/props at every node (including this `src` string,
// which is never regenerated — it's the same field straight off the doc), so
// React bails out of touching the real DOM node at all. The
// `key={doc.content_id}` is the belt-and-braces part: it forces a genuine
// remount (a real reload) exactly when the doc changes, and never otherwise.
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
        {/* The vault has no caption sidecar for a document yet; this is the
            wiring point for its `src` when it does. */}
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
        // NO `sandbox`, and the reason is worth writing down because the
        // attribute was here for a long time and the frame was BLANK for all
        // of it. A sandboxed frame cannot instantiate a plugin document, and
        // the browser's PDF viewer is one — `sandbox=""` did not harden the
        // preview, it silently replaced it with a white rectangle. (Second
        // half of the same bug: off the gateway origin the shell's authorizer
        // rewrites the vault path to a `blob:` URL, which an opaque-origin
        // frame may not load either.)
        //
        // WHAT BOUNDS THIS IS THE CONTENT TYPE, not the attribute. This branch
        // runs only when the document's `media_type` IS `application/pdf`, and
        // the bytes arrive carrying that same value as their `Content-Type` —
        // from the vault's blob route, or from the blob the authorizer built
        // out of that response. The browser hands a typed PDF to its viewer;
        // it never sniffs it back into HTML. So the frame holds a rendered
        // document, not a script host. Anything this app cannot type that
        // confidently gets no frame at all — it gets the sheet below.
      />
    );

  // The real document, set in the app's declared READING register at the
  // reading measure — this is the surface a reader opens to READ, and a
  // decorative mock of a page here shows strictly less of the document than
  // the row it was opened from. `isTextKind`, not "did an inline data URI
  // decode": a text document whose bytes live in the vault's CAS is still
  // text, and it is fetched rather than mocked.
  if (isTextKind(doc)) return <QuickLookText key={doc.content_id} doc={doc} />;

  // A document-page mock — only for a kind whose bytes this app cannot render
  // (a .docx, a spreadsheet, a deck), never for text it holds. The handoff's
  // own sheet: 1/1.414 paper, ruled, on the near-black ground.
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
      {/* 44px circles inset from the stage's edges, MIRRORED under RTL by the
          two logical insets in the stylesheet (§18). */}
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
