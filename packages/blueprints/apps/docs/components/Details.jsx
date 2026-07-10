// Details drawer (#detailsRoot root).
import { armConfirm } from '../kit.js';
import { extOf, fmtBytes, fmtFull, isImage, purgeCountdown, tintBg, typeMeta } from '../format.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

export function Details({
  doc,
  folderName,
  onClose,
  onOpenQuick,
  onToggleStar,
  onMove,
  onTrash,
  onRestore,
}) {
  const m = typeMeta(doc.media_type);
  const trashed = doc.trashed;

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
              onClick={() => onOpenQuick(doc.content_id)}
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
