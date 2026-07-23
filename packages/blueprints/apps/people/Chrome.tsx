// The People chrome as JSX (issue #505 inline path). One-for-one with the static
// body markup index.html serves — the sidebar (brand, New menu, smart nav, list
// list, journal nav, storage + consent line), the topbar (hamburger, search,
// grid/list view toggle, theme button, [data-ask-mount]), the consent/notice
// banners, the toolbar (title/sub, status chips, sort) and the scroll host — but
// expressed as ONE React tree so app-inline.tsx renders a single tree instead of
// fifteen imperative roots. Classes come from Chrome.module.css (scoped chrome +
// the folded People token layer) + the global kit-* vocabulary (kit.css, loaded
// once by the route host). The profile drawer + add-person modal render as slots
// after the shell, inside the token-scoped app root.
import type { KeyboardEvent, ReactNode } from 'react';
import styles from './Chrome.module.css';

export interface ChromeProps {
  narrow: boolean;
  sideOpen: boolean;
  newMenuOpen: boolean;
  view: 'grid' | 'list';
  title: string;
  sub: string;
  showPeopleTools: boolean;
  sortLabel: string;
  consent: { message: string } | null;
  bulkCount: number;
  onOpenSide: () => void;
  onCloseSide: () => void;
  onToggleNewMenu: () => void;
  onSelectView: (view: 'grid' | 'list') => void;
  onSort: () => void;
  onSearchInput: () => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  themeButtonRef: (el: HTMLButtonElement | null) => void;
  newWrapRef: (el: HTMLDivElement | null) => void;
  sidebarNav: ReactNode;
  sidebarLists: ReactNode;
  sidebarJournalNav: ReactNode;
  sidebarStorage: ReactNode;
  newMenu: ReactNode;
  statusChips: ReactNode;
  bulk: ReactNode;
  board: ReactNode;
  details: ReactNode;
  modal: ReactNode;
}

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : '',
    props.sideOpen ? styles.sideOpen : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <div className={shellClass}>
        <aside className={styles.side} aria-label="People navigation">
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
                <path d="M20.8 8.6a4.6 4.6 0 00-8-3.1 4.6 4.6 0 00-8 3.1c0 5 8 10 8 10s8-5 8-10z" />
              </svg>
            </span>
            <div className={styles.brandText}>
              <div className={styles.brandName}>People</div>
              <div className={styles.brandTag}>your circle, remembered</div>
            </div>
            <button
              type="button"
              className={styles.sideClose}
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

          <div className={styles.newWrap} ref={props.newWrapRef}>
            <button
              type="button"
              className={styles.new}
              aria-haspopup="menu"
              aria-expanded={props.newMenuOpen}
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleNewMenu();
              }}
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

          <div className={styles.sectionLabel}>Lists</div>
          <div className={styles.folders}>{props.sidebarLists}</div>

          <nav
            className={styles.nav}
            style={{ marginTop: '8px' }}
            aria-label="Journal and activity"
          >
            {props.sidebarJournalNav}
          </nav>

          <div className={styles.sideFoot}>
            <div className={styles.storage}>{props.sidebarStorage}</div>
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
              <span>Private to you — nothing leaves this device</span>
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
            <div className={styles.search}>
              <svg
                className={styles.searchIcon}
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
                id="searchInput"
                type="search"
                placeholder="Search people, roles, notes…"
                aria-label="Search people"
                autoComplete="off"
                onInput={props.onSearchInput}
                onKeyDown={props.onSearchKeyDown}
              />
            </div>
            <div className={styles.topbarTools}>
              <div className={`kit-seg ${styles.viewtoggle}`} role="group" aria-label="View">
                <button
                  type="button"
                  className={styles.viewbtn}
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
                  className={styles.viewbtn}
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
                className={styles.themebtn}
                aria-label="Toggle light/dark"
              />
              <div className={styles.askMount} data-ask-mount />
            </div>
          </div>

          {props.consent ? (
            // `id="consentBanner"` is the shared hook kit's onFocusRefresh reads
            // to detect a denied→recover state and bypass its 30s focus throttle
            // (the served islands exposed the same id). Without it, a refocus
            // after a revoke would be throttled and never retry the read (#505).
            <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
              <strong>No vault access yet.</strong>{' '}
              <span>
                {props.consent.message ||
                  "Ask the owner to approve this app's requested scopes in vault settings."}
              </span>
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
              <div className={styles.title}>{props.title}</div>
              <div className={styles.sub}>{props.sub}</div>
            </div>
            {props.showPeopleTools ? (
              <div className={styles.toolbarTools}>
                <div className={styles.chips} role="group" aria-label="Filter by status">
                  {props.statusChips}
                </div>
                <span className={styles.toolbarDiv} aria-hidden="true" />
                <button type="button" className={styles.sort} onClick={props.onSort}>
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
            ) : null}
          </div>

          {props.bulkCount > 0 ? (
            <div className={styles.bulk} role="toolbar" aria-label="Selection actions">
              {props.bulk}
            </div>
          ) : null}

          <div className={styles.scroll}>{props.board}</div>
        </main>
      </div>

      {props.details}
      {props.modal}
    </>
  );
}
