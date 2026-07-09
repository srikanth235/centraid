import { type JSX, useEffect, useState } from 'react';
import { activateVersion, listVersions } from '../../../../gateway-client.js';
import { relativeWhen, shortVersionTitle } from '../../../../format.js';
import styles from './BuilderHistory.module.css';
import controlsCss from '../../../styles/controls.module.css';
import { cx } from '../../../ui/cx.js';

// Version-history list inside the builder chat pane's History view (React port
// of builder.ts renderHistoryInto). Newest first; each row can Restore a prior
// version (activateVersion), which the shell treats as a publish flip. Mounted
// by the shell into the host BuilderChatPane hands via `onMountHistory`.

type Versions = Awaited<ReturnType<typeof listVersions>>;

export interface BuilderHistoryProps {
  appId: string | undefined;
  /** Called after a successful restore so the shell can refresh preview/status. */
  onRestored: (versionId: string) => void;
  showToast: (message: string) => void;
}

export default function BuilderHistory({
  appId,
  onRestored,
  showToast,
}: BuilderHistoryProps): JSX.Element {
  const [data, setData] = useState<Versions | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!appId) return;
    let alive = true;
    setData(null);
    setError(false);
    listVersions({ id: appId })
      .then((r) => {
        if (alive) setData(r);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [appId, nonce]);

  if (!appId) return <div className="empty">No app yet.</div>;
  if (error) return <div className="empty">No versions yet. Publish to create the first one.</div>;
  if (!data) return <div className="empty">Loading…</div>;
  if (data.versions.length === 0) {
    return <div className="empty">No versions yet. Publish to create the first one.</div>;
  }

  const sorted = [...data.versions].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  const restore = (versionId: string, title: string): void => {
    void (async () => {
      try {
        await activateVersion({ id: appId, versionId });
        showToast(`Restored to ${title}`);
        onRestored(versionId);
        setNonce((n) => n + 1);
      } catch (err) {
        showToast(`Restore failed: ${String(err)}`);
      }
    })();
  };

  return (
    <>
      {sorted.map((v) => {
        const isCurrent = v.versionId === data.activeVersion;
        return (
          <div key={v.versionId} className={styles.item} data-active={String(isCurrent)}>
            <div className={styles.thumb}>
              <div className={styles.shimmer} />
            </div>
            <div className={styles.meta}>
              <div className={styles.title}>
                <b>{shortVersionTitle(v)}</b>
                {isCurrent ? <span className={styles.tag}>● current</span> : null}
              </div>
              <div className={styles.when}>{relativeWhen(v.uploadedAt)}</div>
              <p className={styles.prompt}>
                {`${v.files} files · ${(v.bytes / 1024).toFixed(1)} KB · sha ${v.sha256.slice(0, 8)}`}
              </p>
            </div>
            <div className={styles.actions}>
              {!isCurrent ? (
                <button
                  type="button"
                  className={cx("btn", controlsCss.soft, "tiny-btn")}
                  onClick={() => restore(v.versionId, shortVersionTitle(v))}
                >
                  Restore
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
}
