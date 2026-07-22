// The Photos chrome as JSX (issue #505 inline path). One-for-one with the static
// index.html body the served app ships — the flex row (sidebar host, main column
// with header/consent-notice banners/live region/scroll pane/empty state), plus
// the fixed-overlay regions (selection bar, lightbox, slideshow, picker, drop
// overlay) and the hidden file input — but expressed as a React tree so
// app-inline.tsx renders ONE tree instead of eight imperative `createRoot`
// islands. Each dynamic region is a `slots.*` ReactNode the app's render
// orchestrators (reused verbatim from sidebar.tsx/lightbox.tsx/… through injected
// slot-roots) fill; the imperatively-toggled nodes (`#empty`, `#consentBanner`,
// `#noticeBanner`, `#live`, `#sidebarMount`, `#selectionBar`, `#lightbox`,
// `#slideshow`, `#picker`, `#dropOverlay`) keep their ids and a literal `hidden`
// so app.tsx's `$(…).hidden = …` writes survive (React never re-writes an
// unchanged prop — the pilot's `#noticeBanner` pattern).
//
// Classes: structural chrome comes from Chrome.module.css (scoped, positioned
// for the inline app pane — never the viewport); the `ph-header-icon-btn`
// vocabulary and the media/faces/selection guts stay the global `:global(...)`
// strings app.css owns (Enrichment.tsx / media.ts / faces.ts write them as plain
// strings), and `kit-*` is the global kit vocabulary (kit.css, loaded once by the
// route host). The served path (index.html + app.css) is untouched.
import type { ReactNode } from './react-core.min.js';
import styles from './Chrome.module.css';

export interface ChromeSlots {
  sidebar: ReactNode;
  toolbar: ReactNode;
  main: ReactNode;
  selectionBar: ReactNode;
  lightbox: ReactNode;
  slideshow: ReactNode;
  picker: ReactNode;
  enrichment: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  /** Set one frame after first paint — gates the drawer slide transition so the
      mount-time narrow snap is instant (#505). */
  ready: boolean;
  slots: ChromeSlots;
}

const hamburgerGlyph = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
  >
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
const searchGlyph = (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
const zoomOutGlyph = (
  <svg
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
);
const zoomInGlyph = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="8" height="8" rx="1" />
    <rect x="13" y="13" width="8" height="8" rx="1" />
  </svg>
);
const playGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M8 5v14l11-7z" />
  </svg>
);

export function Chrome({ narrow, ready, slots }: ChromeProps): ReactNode {
  const shellClass = [styles.shell, narrow ? styles.isNarrow : '', ready ? styles.ready : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={shellClass}>
      {/* Sidebar host — the SidebarView Fragment (scrim + <aside>) renders here.
          `display:contents` lets the <aside> be a real flex child while the
          host id survives for app.tsx's `$('sidebarMount').hidden` toggle. */}
      <div id="sidebarMount" className={styles.sideHost}>
        {slots.sidebar}
      </div>

      <main className={styles.main}>
        <div className={styles.header}>
          <button
            id="hamburgerBtn"
            type="button"
            className="ph-header-icon-btn ph-hamburger"
            aria-label="Menu"
          >
            {hamburgerGlyph}
          </button>
          <label className={`kit-search ${styles.search}`} role="search">
            {searchGlyph}
            <input
              id="searchInput"
              type="search"
              placeholder="Search people, places, things — try “beach” or “Dana”"
              aria-label="Search photos"
              autoComplete="off"
            />
            <button
              id="searchClear"
              type="button"
              className="kit-icon-btn"
              aria-label="Clear search"
              hidden
            >
              ×
            </button>
          </label>
          <div className={styles.headerActions}>
            <div className={styles.zoom} role="group" aria-label="Zoom">
              <button
                id="zoomOutBtn"
                type="button"
                className="ph-header-icon-btn"
                aria-label="Smaller tiles"
              >
                {zoomOutGlyph}
              </button>
              <button
                id="zoomInBtn"
                type="button"
                className="ph-header-icon-btn"
                aria-label="Larger tiles"
              >
                {zoomInGlyph}
              </button>
            </div>
            {/* Face-proposer (issue #352) — its own self-contained React region,
                rendered once into this slot at boot. */}
            <div id="enrichmentMount">{slots.enrichment}</div>
            <button
              id="slideshowBtn"
              type="button"
              className="ph-header-icon-btn slideshow-toolbar-btn"
              aria-label="Slideshow"
            >
              {playGlyph}
            </button>
            <div className={`${styles.askMount} ph-ask-mount`} data-ask-mount />
          </div>
        </div>

        <div id="consentBanner" className="kit-banner" hidden>
          <strong>No vault access yet.</strong>{' '}
          <span id="consentDetail">
            Ask the owner to approve this app&apos;s requested scopes in vault settings.
          </span>
        </div>
        <div
          id="noticeBanner"
          className="kit-banner notice"
          role="status"
          aria-live="polite"
          hidden
        />

        <div id="live" className={styles.live}>
          <div id="toolbarMount">{slots.toolbar}</div>

          <div id="scrollPane" className={styles.scroll}>
            <section id="grid" className={styles.content} aria-label="Photo library">
              {slots.main}
            </section>
            <div id="empty" className="kit-empty" hidden>
              <div id="emptyText" className="kit-empty-title" />
              <div className="kit-empty-sub">
                <button id="emptyUpload" type="button" className="kit-btn primary" hidden>
                  ＋ Add media
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Selection bar / lightbox / slideshow / picker — served siblings of
          `.ph-app` at body level (position:fixed to the viewport). Inline they
          live INSIDE the app pane and are re-scoped to `position:absolute`
          against `.shell` so they never overlay the shell chrome (#505 trap 7). */}
      <div
        id="selectionBar"
        className={styles.selectionBar}
        role="toolbar"
        aria-label="Selection actions"
        hidden
      >
        {slots.selectionBar}
      </div>

      <input
        id="fileInput"
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        hidden
        aria-hidden="true"
      />

      <div id="lightbox" className={styles.lightbox} hidden>
        {slots.lightbox}
      </div>
      <div
        id="slideshow"
        className={styles.slideshow}
        role="dialog"
        aria-modal="true"
        aria-label="Slideshow"
        hidden
      >
        {slots.slideshow}
      </div>
      <div
        id="picker"
        className={`kit-modal-back ${styles.picker}`}
        role="dialog"
        aria-label="Add photos to album"
        hidden
      >
        {slots.picker}
      </div>
      <div id="dropOverlay" className={`kit-drop ${styles.dropOverlay}`} aria-hidden="true" hidden>
        <div className="kit-drop-card">Drop to add to your library</div>
      </div>
    </div>
  );
}
