import { useEffect, useState } from "react";

import { relTime } from "@centraid/design/elements";

import styles from "./History.module.css";

interface NoteVersion {
  content_id: string;
  body: string;
  media_type?: string | null;
  current: boolean;
  asserted_at: string;
}

export function History({
  noteId,
  readOnly,
  onRestore,
}: {
  noteId: string;
  readOnly: boolean;
  onRestore: (contentId: string) => void;
}) {
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.centraid
      .read<{
        versions?: NoteVersion[];
        vaultDenied?: unknown;
      }>({ query: "history", input: { note_id: noteId } })
      .then((result) => {
        if (cancelled) return;
        setVersions(result.versions ?? []);
        setDenied(Boolean(result.vaultDenied));
      })
      .catch(() => {
        if (!cancelled) setDenied(true);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  if (versions === null)
    return <p className={styles.status}>Loading history…</p>;
  if (denied)
    return <p className={styles.status}>History access needs approval.</p>;
  if (versions.length <= 1)
    return <p className={styles.status}>No earlier versions yet.</p>;

  return (
    <div className={styles.list}>
      {versions.map((version) => (
        <details className={styles.version} key={version.content_id}>
          <summary>
            <span>{relTime(version.asserted_at)}</span>
            {version.current ? <strong>Current</strong> : null}
          </summary>
          <pre>{version.body.slice(0, 2_000)}</pre>
          {!version.current && !readOnly ? (
            <button
              type="button"
              className="kit-btn"
              onClick={() => onRestore(version.content_id)}
            >
              Restore this version
            </button>
          ) : null}
        </details>
      ))}
    </div>
  );
}
