// The Tasks chrome as JSX (issue #505 inline path). One-for-one with the static
// body markup index.html serves — sidebar (brand, New task, nav/foot slots),
// the topbar (hamburger, heading, search, theme button, [data-ask-mount]), the
// consent/notice banners and the scroll host — but expressed as a React tree so
// app-inline.tsx renders one tree instead of four imperative roots. Classes come
// from Chrome.module.css (scoped chrome) + the global kit-* vocabulary
// (kit.css, loaded once by the route host).
import type { KeyboardEvent, ReactNode } from './react-core.min.js';
import styles from './Chrome.module.css';

export interface ChromeProps {
  narrow: boolean;
  sideOpen: boolean;
  title: string;
  sub: string;
  consent: { message: string } | null;
  onOpenSide: () => void;
  onCloseSide: () => void;
  onNewTask: () => void;
  onSearchInput: (value: string) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  searchRef: (el: HTMLInputElement | null) => void;
  themeButtonRef: (el: HTMLButtonElement | null) => void;
  sidebarNav: ReactNode;
  sidebarFoot: ReactNode;
  board: ReactNode;
  detail: ReactNode;
}

const brandGlyph = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="6" cy="7" r="3" />
    <path d="m4.5 7 1 1 2-2.4M11 7h9M11 17h9" />
    <circle cx="6" cy="17" r="3" />
  </svg>
);

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : '',
    props.sideOpen ? styles.sideOpen : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={shellClass}>
      <aside className={styles.side} aria-label="Tasks navigation">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            {brandGlyph}
          </span>
          <div className={styles.brandText}>
            <div className={styles.brandName}>Tasks</div>
            <div className={styles.brandTag}>a projection of your vault</div>
          </div>
          <button
            type="button"
            className={`kit-icon-btn ${styles.sideClose}`}
            aria-label="Close menu"
            onClick={props.onCloseSide}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <button type="button" className={styles.new} onClick={props.onNewTask}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>New task</span>
        </button>

        <nav className={styles.nav} aria-label="Focus views">
          {props.sidebarNav}
        </nav>
        <div className={styles.sideFoot}>{props.sidebarFoot}</div>
      </aside>

      <div className={styles.scrim} onClick={props.onCloseSide} />

      <main className={styles.main}>
        <div className={styles.topbar}>
          <button
            type="button"
            className={styles.hamburger}
            aria-label="Open menu"
            onClick={props.onOpenSide}
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <div className={styles.heading}>
            <div className={styles.title}>{props.title}</div>
            <div className={styles.sub}>{props.sub}</div>
          </div>
          <div className={styles.topbarTools}>
            <label className={`kit-search ${styles.search}`}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={props.searchRef}
                type="search"
                placeholder="Find tasks ( / )"
                aria-label="Search tasks"
                autoComplete="off"
                onInput={(event) => props.onSearchInput(event.currentTarget.value)}
                onKeyDown={props.onSearchKeyDown}
              />
            </label>
            <button
              ref={props.themeButtonRef}
              type="button"
              className="kit-icon-btn"
              aria-label="Toggle light/dark"
            />
            <div className={styles.askMount} data-ask-mount />
          </div>
        </div>

        {props.consent ? (
          // `id="consentBanner"` is the shared hook kit's onFocusRefresh reads to
          // detect a denied→recover state and bypass its 30s focus throttle (the
          // served islands exposed the same id). Without it, a refocus after a
          // revoke would be throttled and never retry the read (#505).
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>No vault access yet.</strong> <span>{props.consent.message}</span>
          </div>
        ) : null}
        {/* Driven imperatively by logic.ts (notice / readFailed) — rendered once,
            never reconciled, so those DOM writes are never clobbered. */}
        <div
          id="noticeBanner"
          className={`kit-banner notice ${styles.banner}`}
          role="status"
          aria-live="polite"
          hidden
        />

        <div className={styles.scroll}>
          <div aria-label="Tasks">{props.board}</div>
        </div>
      </main>

      {props.detail}

      <input id="attachInput" type="file" multiple hidden aria-label="Attach a file to a task" />
    </div>
  );
}
