// List view: the head row (#listHead root), each row (#list root's mapped
// children) and the truncation footer (#windowFoot root).
import { fmtBytes, fmtDate, isImage, purgeCountdown, tintBg, typeMeta } from '../format.js';
import { I } from '../icons.js';
import { Checkbox, Icon, Snippet } from './Shared.jsx';

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
}) {
  const m = typeMeta(doc.media_type);
  const selected = selectedIds.has(doc.content_id);
  return (
    <div
      className="d-row"
      data-selected={String(selected)}
      onClick={(e) => {
        if (e.target.closest('button, a, input')) return;
        onOpenDetails(doc.content_id);
      }}
    >
      <Checkbox
        cls="d-check"
        selected={selected}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(doc.content_id, index, e.shiftKey);
        }}
        label={`Select ${doc.title ?? 'document'}`}
      />
      <button
        type="button"
        className="d-badge"
        style={{ background: tintBg(m.cv, 16) }}
        aria-label={`Preview ${doc.title ?? 'document'}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpenQuick(doc.content_id);
        }}
      >
        {isImage(doc) ? (
          <img src={doc.content_uri} alt="" loading="lazy" />
        ) : (
          <span style={{ color: `var(${m.cv})` }}>{m.label}</span>
        )}
      </button>
      <div className="d-row-main">
        <button
          type="button"
          className="d-row-title"
          onClick={(e) => {
            e.stopPropagation();
            onOpenQuick(doc.content_id);
          }}
        >
          {doc.title ?? 'Untitled'}
          {doc.starred ? (
            <span className="d-star-ind" aria-label="Starred">
              ★
            </span>
          ) : null}
        </button>
        {search.trim() && doc.snippet ? <Snippet snippet={doc.snippet} /> : null}
        {narrow ? (
          <div className="d-row-meta">
            {trashed
              ? `from ${folderName(doc.folder_id)} · ${purgeCountdown(doc.purge_at)}`
              : search.trim()
                ? `in ${folderName(doc.folder_id)}`
                : `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}`}
          </div>
        ) : null}
      </div>
      <span className="d-cell where">
        {trashed ? `from ${folderName(doc.folder_id)}` : folderName(doc.folder_id)}
      </span>
      <span className="d-cell size">{fmtBytes(doc.byte_size)}</span>
      <span className={`d-cell added${trashed ? ' purge' : ''}`}>
        {trashed ? purgeCountdown(doc.purge_at) : fmtDate(doc.created_at)}
      </span>
      <div className="d-row-end">
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
            className="d-kebab"
            aria-label={`Actions for ${doc.title ?? 'document'}`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              onOpenMenu(e.currentTarget, doc);
            }}
          >
            <Icon svg={I.dots} />
          </button>
        )}
      </div>
    </div>
  );
}

export function ListHead({ rows, selectedIds, onToggleAll }) {
  const allSel = rows.length > 0 && rows.every((d) => selectedIds.has(d.content_id));
  return (
    <>
      <Checkbox
        cls="d-check"
        selected={allSel}
        onClick={() => onToggleAll(rows, allSel)}
        label={allSel ? 'Deselect all' : 'Select all'}
      />
      <span style={{ width: '34px' }}></span>
      <span className="d-col name">Name</span>
      <span className="d-col where">Where</span>
      <span className="d-col size">Size</span>
      <span className="d-col added">Added</span>
      <span className="d-col end"></span>
    </>
  );
}

export function WindowFoot({ driveWindow, onShowMore }) {
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
