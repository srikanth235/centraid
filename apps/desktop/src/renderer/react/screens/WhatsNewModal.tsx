import { useEffect, useRef, type JSX } from 'react';
import type { CentraidChangelogRelease } from '../../centraid-api.js';
import { changelogNotesToHtml } from '../shell/changelogMarkdown.js';
import { useChangelog } from '../shell/useChangelog.js';
import styles from './WhatsNewModal.module.css';

const X_SVG = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

/** `v0.2.0` and `0.2.0` should compare equal — strip a leading `v`. */
function sameVersion(tag: string, current: string): boolean {
  const norm = (s: string): string => s.replace(/^v/i, '').trim();
  return norm(tag) === norm(current) && current.length > 0;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function ReleaseSection({
  release,
  isCurrent,
}: {
  release: CentraidChangelogRelease;
  isCurrent: boolean;
}): JSX.Element {
  const notesHtml = changelogNotesToHtml(release.notes);
  const date = formatDate(release.publishedAt);
  return (
    <section className={styles.release}>
      <header className={styles.releaseHead}>
        <div className={styles.releaseHeadMain}>
          {date ? <span className={styles.date}>{date}</span> : null}
          <h3 className={styles.title}>{release.title}</h3>
        </div>
        <div className={styles.tags}>
          {isCurrent ? <span className={styles.installed}>Installed</span> : null}
          {release.prerelease ? <span className={styles.pre}>Pre-release</span> : null}
          <span className={styles.version}>{release.version}</span>
        </div>
      </header>
      {notesHtml ? (
        <div
          className={styles.notes}
          // eslint-disable-next-line react/no-danger -- (#348) notes are HTML-escaped in changelogNotesToHtml; only our own tags are emitted
          dangerouslySetInnerHTML={{ __html: notesHtml }}
        />
      ) : (
        <p className={styles.emptyNotes}>No notes for this release.</p>
      )}
      {release.url ? (
        <a className={styles.ghLink} href={release.url} target="_blank" rel="noreferrer noopener">
          View on GitHub →
        </a>
      ) : null}
    </section>
  );
}

/**
 * "What's new" changelog modal — the project's GitHub release notes, newest
 * first, matching Claude Code's dialog. Opened from the sidebar or auto-opened
 * once after the running build's version changes. Esc / backdrop / the close
 * button dismiss it; the body scrolls when the history is long.
 */
export default function WhatsNewModal({ onClose }: { onClose: () => void }): JSX.Element {
  const { state, reload } = useChangelog();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => closeRef.current?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [onClose]);

  const current = state.status === 'ready' ? state.result.currentVersion : '';

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.card} role="dialog" aria-modal="true" aria-label="What's new">
        <header className={styles.head}>
          <h2 className={styles.heading}>What&rsquo;s new</h2>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            aria-label="Close"
            onClick={onClose}
          >
            {X_SVG}
          </button>
        </header>

        <div className={styles.body}>
          {state.status === 'loading' ? (
            <p className={styles.status}>Loading release notes…</p>
          ) : state.status === 'error' ? (
            <div className={styles.status}>
              <p>Couldn&rsquo;t load the changelog.</p>
              <p className={styles.statusDetail}>{state.message}</p>
              <button type="button" className={styles.retry} onClick={reload}>
                Try again
              </button>
            </div>
          ) : state.result.releases.length === 0 ? (
            <div className={styles.status}>
              <p>No releases published yet.</p>
              <p className={styles.statusDetail}>
                Release notes will appear here once the first version ships.
              </p>
            </div>
          ) : (
            state.result.releases.map((r) => (
              <ReleaseSection
                key={r.version}
                release={r}
                isCurrent={sameVersion(r.version, current)}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}
