// The Agenda chrome as JSX (issue #505 inline path). One-for-one with the static
// body markup index.html serves — the sidebar (brand, Create event, mini-month
// + calendar-list slots, the receipt footer line), the topbar (hamburger, the
// HeaderBar slot, search, theme button, [data-ask-mount]), the consent/notice
// banners and the canvas host — but expressed as a React tree so app-inline.tsx
// renders one tree instead of six imperative roots. Classes come from
// Chrome.module.css (scoped chrome) + the global kit-* vocabulary (kit.css,
// loaded once by the route host).
//
// The two banners keep index.html's ids (#consentBanner/#consentDetail,
// #noticeBanner): app-inline.tsx's ported `applyLoadedData` / logic.notice drive
// them imperatively. Rendered once with constant props, React never reconciles
// those attributes, so the imperative DOM writes are never clobbered — the same
// contract the served app relies on.
import type { KeyboardEvent, ReactNode } from 'react';
import styles from './Chrome.module.css';

export interface ChromeProps {
  narrow: boolean;
  sideOpen: boolean;
  onOpenSide: () => void;
  onCloseSide: () => void;
  onCreate: () => void;
  onSearchInput: (value: string) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  searchRef: (el: HTMLInputElement | null) => void;
  themeButtonRef: (el: HTMLButtonElement | null) => void;
  sidebarMini: ReactNode;
  sidebarCals: ReactNode;
  headerBar: ReactNode;
  canvas: ReactNode;
  drawer: ReactNode;
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
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 9h18M8 3v4M16 3v4" />
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
      <aside className={styles.side} aria-label="Agenda navigation">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            {brandGlyph}
          </span>
          <div className={styles.brandText}>
            <div className={styles.brandName}>Agenda</div>
            <div className={styles.brandTag}>a projection of your vault.</div>
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

        <button type="button" className={styles.new} onClick={props.onCreate}>
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
          <span>Create event</span>
        </button>

        <div aria-live="polite">{props.sidebarMini}</div>

        <div className={`ag-eyebrow-label ${styles.calsLabel}`}>My calendars</div>
        <div>{props.sidebarCals}</div>

        <div className={styles.sideFoot}>
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
            <span>Cancelling parks for the owner &amp; is receipted.</span>
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
          <div className={styles.headerBar}>{props.headerBar}</div>
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
                placeholder="Search events"
                aria-label="Search events"
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

        {/* Driven imperatively by app-inline.tsx's applyLoadedData — rendered
            once with constant props, so React never clobbers the DOM writes. */}
        <div id="consentBanner" className={`kit-banner ${styles.banner}`} hidden>
          <strong>No vault access yet.</strong>{' '}
          <span id="consentDetail">
            Ask the owner to approve this app&apos;s requested scopes in vault settings.
          </span>
        </div>
        <div
          id="noticeBanner"
          className={`kit-banner notice ${styles.banner}`}
          role="status"
          aria-live="polite"
          hidden
        />

        <div className={styles.canvas}>{props.canvas}</div>
      </main>

      {props.drawer}
    </div>
  );
}
