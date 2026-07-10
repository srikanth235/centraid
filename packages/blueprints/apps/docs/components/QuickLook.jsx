// Quick-look overlay (#quickRoot root).
import { fmtBytes, fmtFull, isImage, loadable, tintBg, typeMeta } from '../format.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

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
export function QuickLook({ doc, rows, folderName, onClose, onStep }) {
  const m = typeMeta(doc.media_type);
  const idx = rows.findIndex((d) => d.content_id === doc.content_id);

  let stage;
  if (isImage(doc)) {
    stage = (
      <img
        key={doc.content_id}
        className="d-quick-image"
        src={doc.content_uri}
        alt={doc.title ?? 'Image'}
      />
    );
  } else if (String(doc.media_type ?? '') === 'application/pdf' && loadable(doc.content_uri)) {
    stage = (
      <iframe
        key={doc.content_id}
        className="d-quick-frame"
        src={doc.content_uri}
        title={doc.title ?? 'PDF'}
      />
    );
  } else {
    // A document-page mock for docs / sheets / slides / other.
    const widths = [96, 88, 93, 70, 90, 82, 60];
    stage = (
      <div className="d-quick-page" key={doc.content_id}>
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
    <div className="d-quick" role="dialog" aria-modal="true" aria-label="Quick look">
      <div className="d-quick-top">
        <span
          className="d-quick-badge"
          style={{ background: tintBg(m.cv, 20), color: `var(${m.cv})` }}
        >
          {m.label}
        </span>
        <span className="d-quick-title">{doc.title ?? 'Untitled'}</span>
        <a className="d-quick-btn" href={doc.content_uri} download={doc.title ?? 'file'}>
          <Icon svg={I.download} />
          Download
        </a>
        <button
          type="button"
          className="kit-icon-btn d-quick-icon"
          aria-label="Close"
          onClick={onClose}
        >
          <Icon svg={I.close} />
        </button>
      </div>
      <div className="d-quick-stage">
        <button
          type="button"
          className="kit-viewer-nav prev"
          aria-label="Previous"
          disabled={idx <= 0}
          onClick={() => onStep(-1)}
        >
          <Icon svg={I.chevL} />
        </button>
        {stage}
        <button
          type="button"
          className="kit-viewer-nav next"
          aria-label="Next"
          disabled={idx < 0 || idx >= rows.length - 1}
          onClick={() => onStep(1)}
        >
          <Icon svg={I.chevR} />
        </button>
      </div>
      <div className="d-quick-foot">
        {folderName(doc.folder_id)} · {fmtBytes(doc.byte_size)} · added {fmtFull(doc.created_at)}
      </div>
    </div>
  );
}
