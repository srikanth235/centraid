// Details drawer (#detailsRoot root).
import { useRef, useState } from '../react-core.min.js';
import { armConfirm } from '../kit.js';
import {
  extOf,
  fmtBytes,
  fmtFull,
  isImage,
  isTextEditable,
  purgeCountdown,
  tintBg,
  typeMeta,
} from '../format.js';
import { I, RENAME_ICON } from '../icons.js';
import { History } from './History.jsx';
import { Icon } from './Shared.jsx';

// A hidden file input, self-contained: click-through-to-picker plus the
// change handler live entirely inside this button, so Details.jsx and
// app.jsx never need a global replace-target/hidden-input pair the way
// upload does (upload has no "which document" to remember; replace does,
// and this keeps that fact local to the one place that needs it).
function ReplaceButton({ doc, onReplace }) {
  const inputRef = useRef(null);
  return (
    <>
      <button
        type="button"
        className="kit-btn d-detail-btn"
        onClick={() => inputRef.current?.click()}
      >
        Replace file…
      </button>
      <input
        ref={inputRef}
        type="file"
        hidden
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onReplace(doc, file);
        }}
      />
    </>
  );
}

export function Details({
  doc,
  folderName,
  onClose,
  onOpenQuick,
  onToggleStar,
  onMove,
  onTrash,
  onRestore,
  onEdit,
  onReplace,
  loadHistory,
  onRestoreVersion,
}) {
  const m = typeMeta(doc.media_type);
  const trashed = doc.trashed;
  const [historyOpen, setHistoryOpen] = useState(false);

  // Activity — only what the projection can honestly derive: this document was
  // uploaded (created_at) and filed into its folder. Each is a real receipted
  // vault write, so it wears a receipt chip.
  const events = [];
  if (doc.folder_id != null)
    events.push({ text: `Filed in ${folderName(doc.folder_id)}`, date: fmtFull(doc.created_at) });
  events.push({ text: 'Uploaded to your vault', date: fmtFull(doc.created_at) });

  return (
    <>
      <div className="d-details-backdrop" onClick={onClose}></div>
      <aside className="d-details" role="dialog" aria-modal="true" aria-label="Document details">
        <div className="d-details-head">
          <span className="lbl">Details</span>
          <button type="button" className="kit-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon svg={I.close} />
          </button>
        </div>
        <div className="d-details-body">
          <div className="d-hero" style={{ background: tintBg(m.cv, 16) }}>
            {isImage(doc) ? (
              <img src={doc.content_uri} alt="" />
            ) : (
              <span style={{ color: `var(${m.cv})` }}>{m.label}</span>
            )}
          </div>
          <div className="d-detail-name">{doc.title ?? 'Untitled'}</div>
          <div className="d-detail-ext">
            {extOf(doc)} · {fmtBytes(doc.byte_size)}
          </div>
          <div className="d-detail-actions">
            <button
              type="button"
              className="kit-btn d-detail-btn"
              onClick={() => onOpenQuick(doc.document_id)}
            >
              Open
            </button>
            <a
              className="kit-btn d-detail-btn"
              href={doc.content_uri}
              download={doc.title ?? 'file'}
            >
              Download
            </a>
            {trashed ? null : (
              <button
                type="button"
                className="kit-btn d-detail-btn"
                onClick={() => onToggleStar(doc)}
              >
                {doc.starred ? '★ Starred' : '☆ Star'}
              </button>
            )}
            {trashed ? null : isTextEditable(doc) ? (
              <button
                type="button"
                className="kit-btn d-detail-btn"
                onClick={() => onEdit(doc)}
              >
                <Icon svg={RENAME_ICON} />
                Edit
              </button>
            ) : (
              <ReplaceButton doc={doc} onReplace={onReplace} />
            )}
          </div>
          <div className="d-detail-label">Details</div>
          <dl className="d-detail-grid">
            <dt>Type</dt>
            <dd>{m.name}</dd>
            <dt>Size</dt>
            <dd>{fmtBytes(doc.byte_size)}</dd>
            <dt>{trashed ? 'Was in' : 'Folder'}</dt>
            <dd>{folderName(doc.folder_id)}</dd>
            <dt>{trashed ? 'Purges' : 'Added'}</dt>
            <dd>{trashed ? purgeCountdown(doc.purge_at) : fmtFull(doc.created_at)}</dd>
          </dl>
          <div className="d-detail-label">Activity</div>
          <div>
            {events.map((ev, i) => (
              <div className="d-activity-item" key={i}>
                <div className="d-activity-rail">
                  <span className="d-activity-dot"></span>
                  {i < events.length - 1 ? <span className="d-activity-line"></span> : null}
                </div>
                <div>
                  <div className="d-activity-text">{ev.text}</div>
                  <div className="d-activity-meta">
                    <span className="d-activity-date">{ev.date}</span>
                    <span className="d-receipt-chip">receipt</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="d-detail-label d-version-toggle"
            aria-expanded={String(historyOpen)}
            onClick={() => setHistoryOpen((o) => !o)}
          >
            Version history
            <Icon svg={historyOpen ? I.chevL : I.chevR} />
          </button>
          {historyOpen ? (
            <History
              key={doc.content_id}
              documentId={doc.document_id}
              readOnly={trashed}
              loadVersions={loadHistory}
              onRestoreVersion={(documentId, contentId) => onRestoreVersion(doc, contentId)}
            />
          ) : null}
        </div>
        <div className="d-details-foot">
          {trashed ? (
            <button type="button" className="kit-btn d-detail-btn" onClick={() => onRestore(doc)}>
              Restore
            </button>
          ) : (
            <>
              <button
                type="button"
                className="kit-btn d-detail-btn"
                onClick={(e) => onMove(e.currentTarget, [doc])}
              >
                Move
              </button>
              <button
                type="button"
                className="kit-btn d-detail-btn danger"
                onClick={(e) => {
                  if (!armConfirm(e.currentTarget, { armedLabel: 'Trash — sure?' })) return;
                  onTrash(doc);
                }}
              >
                Trash
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
