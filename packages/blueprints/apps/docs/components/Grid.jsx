// Grid view row (#grid root's mapped children).
import { fmtBytes, fmtDate, isImage, tintBg, typeMeta } from '../format.js';
import { Checkbox, CustodyDot } from './Shared.jsx';

export function GridCard({ doc, index, selectedIds, onOpenDetails, onOpenQuick, onToggleSelect }) {
  const m = typeMeta(doc.media_type);
  const selected = selectedIds.has(doc.document_id);
  return (
    <div
      className="d-card"
      data-selected={String(selected)}
      onClick={(e) => {
        if (e.target.closest('button, a')) return;
        onOpenDetails(doc.document_id);
      }}
    >
      <div
        className="d-thumb"
        style={{ background: tintBg(m.cv, 15) }}
        onClick={(e) => {
          e.stopPropagation();
          onOpenQuick(doc.document_id);
        }}
      >
        {isImage(doc) ? (
          <img src={doc.content_uri} alt="" loading="lazy" />
        ) : (
          <>
            <span className="d-thumb-label" style={{ color: `var(${m.cv})` }}>
              {m.label}
            </span>
            <div className="d-thumb-lines">
              <i style={{ width: '70%', background: `var(${m.cv})`, opacity: 0.18 }}></i>
              <i style={{ width: '90%', background: `var(${m.cv})`, opacity: 0.14 }}></i>
              <i style={{ width: '55%', background: `var(${m.cv})`, opacity: 0.14 }}></i>
            </div>
          </>
        )}
      </div>
      <Checkbox
        cls="d-card-select"
        selected={selected}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(doc.document_id, index, e.shiftKey);
        }}
        label={`Select ${doc.title ?? 'document'}`}
      />
      <div className="d-card-body">
        <div className="d-card-title">
          {doc.title ?? 'Untitled'}
          {doc.starred ? (
            <span className="d-star-ind" aria-label="Starred">
              ★
            </span>
          ) : null}
        </div>
        <div className="d-card-meta">
          {fmtBytes(doc.byte_size)} · {fmtDate(doc.created_at)}
          <CustodyDot state={doc.custody_state} />
        </div>
      </div>
    </div>
  );
}
