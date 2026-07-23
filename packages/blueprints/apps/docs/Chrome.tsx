// The Docs chrome as JSX (issue #505 inline path). One-for-one with the static
// body markup index.html serves — the sidebar (brand, New menu, nav/folders/
// storage slots), the topbar (hamburger, search, grid/list toggle, theme button,
// [data-ask-mount]), the consent/notice banners, the toolbar (active scope,
// type/tag chip slots, sort), the bulk bar, and the scroll host — but expressed
// as a React tree so app-inline.tsx renders one tree instead of fourteen
// imperative roots. Classes come from Chrome.module.css (scoped chrome) + the
// global kit-* vocabulary (kit.css, loaded once by the route host).
//
// The reused components/*.module.css narrow rules key on the GLOBAL
// `.docs.is-narrow` state class (their `:global(.docs.is-narrow) …` overrides),
// so this root also stamps the served app's static `docs`/`is-narrow`/`side-open`
// class trio alongside the module-scoped `.shell`/`.isNarrow`/`.sideOpen` (trap
// #5). The app root deliberately does NOT carry `id="root"` — the host page's own
// mount div owns that id, and the reused nav.ts only touches it as a harmless
// no-op class toggle.
import type { KeyboardEvent, ReactNode } from 'react';
import type { AppState } from './types.ts';
import styles from './Chrome.module.css';

export interface ChromeProps {
  narrow: boolean;
  ready: boolean;
  sideOpen: boolean;
  view: AppState['view'];
  newMenuOpen: boolean;
  consent: { message: string } | null;
  activeTitle: string;
  activeSub: string;
  sortLabel: string;
  dropVisible: boolean;
  dropTarget: string;
  onOpenSide: () => void;
  onCloseSide: () => void;
  onToggleNewMenu: (event: { stopPropagation: () => void }) => void;
  onSelectView: (view: AppState['view']) => void;
  onSort: () => void;
  onSearchInput: () => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onUploadChange: () => void;
  searchRef: (el: HTMLInputElement | null) => void;
  themeButtonRef: (el: HTMLButtonElement | null) => void;
  uploadRef: (el: HTMLInputElement | null) => void;
  sidebarNav: ReactNode;
  folderList: ReactNode;
  storage: ReactNode;
  newMenu: ReactNode;
  typeChips: ReactNode;
  tagChips: ReactNode;
  bulkBar: ReactNode;
  scroll: ReactNode;
  overlays: ReactNode;
}

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : '',
    props.ready ? styles.ready : '',
    props.sideOpen ? styles.sideOpen : '',
    props.consent ? styles.denied : '',
    // Global classes the reused Grid/List/Editor .module.css
    // `:global(.docs.is-narrow)` rules key on — the module-scoped .isNarrow above
    // can't be seen from another module, so mirror the served app's static #root
    // classes here.
    'docs',
    props.narrow ? 'is-narrow' : '',
    props.sideOpen ? 'side-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClass} data-docs-root>
      <aside className={styles.side} aria-label="Docs navigation">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 6h5l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" />
            </svg>
          </span>
          <div className={styles.brandText}>
            <div className={styles.brandName}>Docs</div>
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

        <div className={styles.newWrap} data-new-wrap>
          <button
            type="button"
            className={styles.new}
            aria-haspopup="menu"
            aria-expanded={props.newMenuOpen}
            onClick={props.onToggleNewMenu}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>New</span>
            <svg
              className={styles.newChev}
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div className={styles.newMenu} role="menu" hidden={!props.newMenuOpen}>
            {props.newMenu}
          </div>
        </div>

        <nav className={styles.nav} aria-label="Views">
          {props.sidebarNav}
        </nav>

        <div className={styles.sectionLabel}>Folders</div>
        <div className={styles.folders}>{props.folderList}</div>

        <div className={styles.sideFoot}>
          <div className={styles.storage}>{props.storage}</div>
          <div className={styles.consentLine}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
              <path d="m9.5 12 2 2 3.5-3.5" />
            </svg>
            <span>Every write is consent-checked &amp; receipted</span>
          </div>
        </div>
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
              id="searchInput"
              type="search"
              placeholder="Search documents, contents, people…"
              aria-label="Search documents by title or contents"
              autoComplete="off"
              onInput={props.onSearchInput}
              onKeyDown={props.onSearchKeyDown}
            />
          </label>
          <div className={styles.topbarTools}>
            <div className="kit-seg" role="group" aria-label="View">
              <button
                type="button"
                aria-label="Grid view"
                aria-pressed={props.view === 'grid'}
                onClick={() => props.onSelectView('grid')}
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
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
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
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
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

        <div className={styles.toolbar}>
          <div className={styles.toolbarTitle}>
            <div className={styles.title}>{props.activeTitle}</div>
            <div className={styles.sub}>{props.activeSub}</div>
          </div>
          <div className={styles.toolbarTools}>
            <div className={styles.chips} role="group" aria-label="Filter by type">
              {props.typeChips}
            </div>
            <div className={styles.chips} role="group" aria-label="Filter by tag">
              {props.tagChips}
            </div>
            <span className={styles.toolbarDiv} aria-hidden="true" />
            <button type="button" className="kit-btn" onClick={props.onSort}>
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" />
              </svg>
              <span>{props.sortLabel}</span>
            </button>
          </div>
        </div>

        {props.bulkBar ? (
          <div className={styles.bulk} role="toolbar" aria-label="Selection actions">
            {props.bulkBar}
          </div>
        ) : null}

        <div className={styles.scroll}>{props.scroll}</div>
      </main>

      {props.overlays}

      <input
        ref={props.uploadRef}
        id="uploadInput"
        type="file"
        multiple
        hidden
        aria-hidden="true"
        onChange={props.onUploadChange}
      />
      <div className="kit-drop" hidden={!props.dropVisible} aria-hidden="true">
        <div className="kit-drop-card">
          <span>{props.dropTarget}</span>
        </div>
      </div>
    </div>
  );
}
