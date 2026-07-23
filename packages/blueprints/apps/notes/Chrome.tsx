// The Notes chrome as JSX (issue #505 inline path). One-for-one with the static
// body markup index.html serves — the sidebar (brand, New note, nav/foot slots),
// the topbar (hamburger, search with clear, view toggle, theme button,
// [data-ask-mount]), the consent/notice banners, the toolbar slot (active scope)
// and the scroll host — but expressed as a React tree so app-inline.tsx renders
// one tree instead of five imperative roots. Classes come from Chrome.module.css
// (scoped chrome) + the global kit-* vocabulary (kit.css, loaded once by the
// route host).
import type { KeyboardEvent, ReactNode } from './react-core.min.js';
import type { AppState } from './types.ts';
import styles from './Chrome.module.css';

export interface ChromeProps {
  narrow: boolean;
  sideOpen: boolean;
  view: AppState['view'];
  consent: { message: string } | null;
  onOpenSide: () => void;
  onCloseSide: () => void;
  onNewNote: () => void;
  onSearchInput: (value: string) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSearchClear: () => void;
  onSelectView: (view: AppState['view']) => void;
  searchRef: (el: HTMLInputElement | null) => void;
  themeButtonRef: (el: HTMLButtonElement | null) => void;
  sidebarNav: ReactNode;
  sidebarFoot: ReactNode;
  toolbar: ReactNode;
  wall: ReactNode;
  editor: ReactNode;
}

const brandGlyph = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v5h5M8 13h8M8 17h5" />
  </svg>
);

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : '',
    props.sideOpen ? styles.sideOpen : '',
    // Global classes the reused Editor/Toolbar/Wall .module.css
    // `:global(.nt-shell.is-narrow)` rules key on — the module-scoped .isNarrow
    // above can't be seen from another module, so mirror the served app's static
    // #shell classes here. `id="shell"` lets logic.ts's selectNav close the
    // drawer via getElementById('shell') exactly as it does served.
    'nt-shell',
    props.narrow ? 'is-narrow' : '',
    props.sideOpen ? 'side-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClass} id="shell">
      <aside className={styles.side} aria-label="Notes navigation">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            {brandGlyph}
          </span>
          <div className={styles.brandText}>
            <div className={styles.brandName}>Notes</div>
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

        <button type="button" className={styles.new} onClick={props.onNewNote}>
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
          <span>New note</span>
        </button>

        <div aria-label="Sections and notebooks">{props.sidebarNav}</div>
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
          <label className={`kit-search ${styles.search}`}>
            <svg
              width="17"
              height="17"
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
              placeholder="Search notes — title and contents"
              aria-label="Search notes"
              autoComplete="off"
              onInput={(event) => props.onSearchInput(event.currentTarget.value)}
              onKeyDown={props.onSearchKeyDown}
            />
            <button
              type="button"
              className={styles.searchClear}
              aria-label="Clear search"
              onClick={props.onSearchClear}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </label>
          <div className={styles.topbarTools}>
            <div className={styles.viewToggle}>
              <button
                type="button"
                aria-label="Card view"
                aria-pressed={props.view === 'masonry'}
                onClick={() => props.onSelectView('masonry')}
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="7" height="9" rx="1" />
                  <rect x="14" y="3" width="7" height="5" rx="1" />
                  <rect x="3" y="16" width="7" height="5" rx="1" />
                  <rect x="14" y="12" width="7" height="9" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="List view"
                aria-pressed={props.view === 'list'}
                onClick={() => props.onSelectView('list')}
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>
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

        <div aria-label="Active scope">{props.toolbar}</div>

        <div className={styles.scroll}>
          <div aria-label="Notes">{props.wall}</div>
        </div>
      </main>

      {props.editor}

      <input id="attachInput" type="file" multiple hidden aria-label="Attach a file to a note" />
    </div>
  );
}
