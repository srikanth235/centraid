// The version-history panel inside the details drawer (issue #352): lists a
// document's `revises` chain (queries/history.js already did the walk and
// the honest-ordering math — this only renders it), newest-first, each
// entry previewable inline and — unless read-only (a trashed document) or
// already current — restorable through core.restore_document_version.
//
// Mounted keyed by the doc's own content_id at the call site (Details.jsx),
// mirroring QuickLook.jsx's identical trick: a restore mints a new current
// content id, which remounts this component and re-triggers its fetch, so
// the panel always reflects the freshly-recorded chain without any extra
// wiring back to app.jsx's refresh().
import { useEffect, useState } from '../react-core.min.js';
import { fmtBytes, fmtFull, loadable, typeMeta } from '../format.js';

function VersionPreview({ v }) {
  const t = String(v.media_type ?? '');
  if (!loadable(v.content_uri)) return null;
  if (t.startsWith('image/'))
    return <img className="d-version-preview" src={v.content_uri} alt="" />;
  if (t.startsWith('video/'))
    return (
      <video
        className="d-version-preview"
        src={v.content_uri}
        poster={v.poster_uri ?? undefined}
        controls
        preload="metadata"
      />
    );
  if (t.startsWith('audio/'))
    return <audio className="d-version-audio" src={v.content_uri} controls preload="metadata" />;
  if (t === 'application/pdf')
    return (
      <iframe className="d-version-preview-frame" src={v.content_uri} title="Version preview" />
    );
  return (
    <a className="kit-btn d-detail-btn" href={v.content_uri} target="_blank" rel="noopener">
      Open in a new tab
    </a>
  );
}

function VersionRow({ v, readOnly, onRestore }) {
  const [open, setOpen] = useState(false);
  const m = typeMeta(v.media_type);
  return (
    <div className={v.current ? 'd-version d-version-current' : 'd-version'}>
      <button
        type="button"
        className="d-version-row"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={String(open)}
      >
        <span className="d-version-badge">{m.label}</span>
        <span className="d-version-info">
          <span className="d-version-date">{fmtFull(v.asserted_at)}</span>
          <span className="d-version-size">{fmtBytes(v.byte_size)}</span>
        </span>
        {v.current ? <span className="d-version-tag">Current</span> : null}
      </button>
      {open ? (
        <div className="d-version-detail">
          <VersionPreview v={v} />
          {!v.current && !readOnly ? (
            <button
              type="button"
              className="kit-btn d-detail-btn"
              onClick={() => onRestore(v.content_id)}
            >
              Restore this version
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function History({ documentId, readOnly, loadVersions, onRestoreVersion }) {
  const [versions, setVersions] = useState(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadVersions(documentId).then((res) => {
      if (cancelled) return;
      setVersions(res?.versions ?? []);
      setDenied(Boolean(res?.vaultDenied));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#360) loadVersions/documentId read once at mount; Details.jsx keys this component by content_id, so a real version change already remounts it fresh instead of re-running this effect
  }, []);

  if (versions === null) return <div className="d-version-status">Loading history…</div>;
  if (denied)
    return <div className="d-version-status">Ask the owner to approve history access.</div>;
  if (versions.length <= 1) return <div className="d-version-status">No earlier versions yet.</div>;

  return (
    <div className="d-version-list">
      {versions.map((v) => (
        <VersionRow
          key={v.content_id}
          v={v}
          readOnly={readOnly}
          onRestore={(contentId) => onRestoreVersion(documentId, contentId)}
        />
      ))}
    </div>
  );
}
