// The version-history panel inside the details drawer (issue #352): lists a
// document's `revises` chain (queries/history.ts already did the walk and
// the honest-ordering math — this only renders it), newest-first, each
// entry previewable inline and — unless read-only (a trashed document) or
// already current — restorable through core.restore_document_version.
//
// Mounted keyed by the doc's own content_id at the call site (Details.tsx),
// mirroring QuickLook.tsx's identical trick: a restore mints a new current
// content id, which remounts this component and re-triggers its fetch, so
// the panel always reflects the freshly-recorded chain without any extra
// wiring back to app.tsx's refresh().
import { useEffect, useState } from 'react';
import { fmtBytes, fmtFull, loadable, typeMeta } from '../format.ts';
import type { VersionEntry } from '../types.ts';
import styles from './History.module.css';
import shared from './shared.module.css';

interface HistoryResult {
  versions?: VersionEntry[];
  vaultDenied?: unknown;
}

function VersionPreview({ v }: { v: VersionEntry }) {
  const t = String(v.media_type ?? '');
  if (!loadable(v.content_uri)) return null;
  if (t.startsWith('image/'))
    return <img className={styles.versionPreview} src={v.content_uri} alt="" />;
  if (t.startsWith('video/'))
    return (
      <video
        className={styles.versionPreview}
        src={v.content_uri}
        poster={v.poster_uri ?? undefined}
        controls
        preload="metadata"
      />
    );
  if (t.startsWith('audio/'))
    return (
      <audio className={styles.versionAudio} src={v.content_uri} controls preload="metadata" />
    );
  if (t === 'application/pdf')
    return (
      <iframe className={styles.versionPreviewFrame} src={v.content_uri} title="Version preview" />
    );
  return (
    <a
      className={`kit-btn ${shared.detailBtn}`}
      href={v.content_uri}
      target="_blank"
      rel="noopener"
    >
      Open in a new tab
    </a>
  );
}

function VersionRow({
  v,
  readOnly,
  onRestore,
}: {
  v: VersionEntry;
  readOnly: boolean;
  onRestore: (contentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const m = typeMeta(v.media_type);
  return (
    <div className={v.current ? `${styles.version} ${styles.versionCurrent}` : styles.version}>
      <button
        type="button"
        className={styles.versionRow}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={styles.versionBadge}>{m.label}</span>
        <span className={styles.versionInfo}>
          <span className={styles.versionDate}>{fmtFull(v.asserted_at)}</span>
          <span className={styles.versionSize}>{fmtBytes(v.byte_size)}</span>
        </span>
        {v.current ? <span className={styles.versionTag}>Current</span> : null}
      </button>
      {open ? (
        <div className={styles.versionDetail}>
          <VersionPreview v={v} />
          {!v.current && !readOnly ? (
            <button
              type="button"
              className={`kit-btn ${shared.detailBtn}`}
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

export function History({
  documentId,
  readOnly,
  loadVersions,
  onRestoreVersion,
}: {
  documentId: string;
  readOnly: boolean;
  loadVersions: (documentId: string) => Promise<HistoryResult>;
  onRestoreVersion: (documentId: string, contentId: string) => void;
}) {
  const [versions, setVersions] = useState<VersionEntry[] | null>(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#360) loadVersions/documentId read once at mount; Details.tsx keys this component by content_id, so a real version change already remounts it fresh instead of re-running this effect
  }, []);

  if (versions === null) return <div className={styles.versionStatus}>Loading history…</div>;
  if (denied)
    return <div className={styles.versionStatus}>Ask the owner to approve history access.</div>;
  if (versions.length <= 1)
    return <div className={styles.versionStatus}>No earlier versions yet.</div>;

  return (
    <div className={styles.versionList}>
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
