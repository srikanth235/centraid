// The Docs chrome as JSX — a ROUTE INSIDE THE FRAME (issue #505 inline path,
// Docs spec §1). The sidebar (brand, New menu, folders, storage), the topbar
// (hamburger, search, grid/list toggle, [data-ask-mount]), the consent/notice
// banners, the shelf strip, the toolbar, the bulk bar and the scroll host,
// expressed as one React tree so app-inline.tsx renders one tree instead of
// fourteen imperative roots. Classes come from Chrome.module.css (scoped
// chrome) + the global kit-* vocabulary (kit.css, loaded once by the host).
//
// TRAP #5 IS CLOSED HERE. This root used to stamp a GLOBAL `docs` /
// `is-narrow` / `side-open` class trio alongside the module-scoped
// `.shell`/`.isNarrow`/`.sideOpen`, purely so that three sibling
// `components/*.module.css` files could reach across a module boundary with
// `:global(.docs.is-narrow) …` overrides. That is a seam: any app that
// happened to stamp `docs` anywhere in the document would have restyled these
// components, and the coupling was invisible from either end. The three
// stylesheets now carry their own `data-narrow` attribute on their own
// elements (List/Editor/QuickLook take a `narrow` prop), the trio is deleted,
// and this file's classes are all module-scoped again.
//
// EVERYTHING VARIABLE ARRIVES AS A SLOT (`ChromeSlots`), the same shape
// `photos/Chrome.tsx` uses. The chrome owns geometry; what stands in each
// region is the orchestrator's decision, so the two can be reasoned about —
// and re-carved for the routes still to land — independently.
import type { KeyboardEvent, ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";
import type { AppState } from "./types.ts";

import styles from "./Chrome.module.css";

/** Everything the chrome DRAWS but does not decide. One region per slot, and
 *  a `null` slot renders nothing at all rather than an empty container. */
export interface ChromeSlots {
  /** The shelf strip (§1.7). Null on the compact form factor whose band claim
   *  was honoured — the band carries the shelves there — and on the routes
   *  §1.7 excludes. */
  shelfStrip: ReactNode;
  /** The folder list, with its inline create/rename editors. */
  folderList: ReactNode;
  storage: ReactNode;
  /** The "+ New" dropdown's contents, or null while it is closed. */
  newMenu: ReactNode;
  tagChips: ReactNode;
  /** The selection action bar, or null while nothing is selected. */
  bulkBar: ReactNode;
  /** The current route's body (components/DriveRoute, FoldersRoute, …). */
  scroll: ReactNode;
  /** Details / Quick Look / Editor / the share sheet. */
  overlays: ReactNode;
  /** The compact band's overflow sheet (§1.5), or null while it is closed. */
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  ready: boolean;
  sideOpen: boolean;
  view: AppState["view"];
  newMenuOpen: boolean;
  consent: { message: string } | null;
  activeTitle: string;
  activeSub: string;
  sortLabel: string;
  /** The grid/list toggle and the filter chips mean nothing off the drive
   *  (§1.7), so the toolbar's tools stand down rather than sitting there
   *  inert over a shelf they cannot filter. */
  showDriveTools: boolean;
  dropVisible: boolean;
  dropTarget: string;
  onOpenSide: () => void;
  onCloseSide: () => void;
  onToggleNewMenu: (event: { stopPropagation: () => void }) => void;
  onSelectView: (view: AppState["view"]) => void;
  onSort: () => void;
  onSearchInput: () => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onUploadChange: () => void;
  searchRef: (el: HTMLInputElement | null) => void;
  uploadRef: (el: HTMLInputElement | null) => void;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  // Callback refs come off `props` first: a ref read from the props object taints
  // every later `props.*` read for the React compiler ("cannot access refs during
  // render"), so they are destructured into plain locals here (#573).
  const { searchRef, uploadRef } = props;

  // Module-scoped only. The global `docs`/`is-narrow`/`side-open` trio that
  // used to be mirrored here is gone (see the trap #5 note at the top).
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : "",
    props.ready ? styles.ready : "",
    props.sideOpen ? styles.sideOpen : "",
    props.consent ? styles.denied : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={shellClass}
      data-docs-root
      data-tone="paper"
      data-density="comfortable"
    >
      <aside className={styles.side} aria-label="Docs navigation">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <svg
              aria-hidden="true"
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
              aria-hidden="true"
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
            className={`kit-btn primary ${styles.new}`}
            aria-haspopup="menu"
            aria-expanded={props.newMenuOpen}
            onClick={props.onToggleNewMenu}
          >
            <svg
              aria-hidden="true"
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
              aria-hidden="true"
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
          <div
            className={styles.newMenu}
            role="menu"
            hidden={!props.newMenuOpen}
          >
            {props.slots.newMenu}
          </div>
        </div>

        <div className={styles.sectionLabel}>Folders</div>
        <div className={styles.folders}>{props.slots.folderList}</div>

        <div className={styles.sideFoot}>
          <div className={styles.storage}>{props.slots.storage}</div>
          <div className={styles.consentLine}>
            <svg
              aria-hidden="true"
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

      {/* Dismiss-on-outside-click for the narrow drawer. A real button, so the
          same gesture is reachable by keyboard; it only exists (display:block)
          while the drawer is open. */}
      <button
        type="button"
        className={`kit-plain-btn ${styles.scrim}`}
        aria-label="Dismiss menu"
        onClick={props.onCloseSide}
      />

      <main className={styles.main}>
        <div className={styles.topbar}>
          <button
            type="button"
            className={styles.hamburger}
            aria-label="Open menu"
            onClick={props.onOpenSide}
          >
            <svg
              aria-hidden="true"
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
              ref={searchRef}
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
            {/* Grid or list is a view of the DRIVE. Off it there are no rows
                to lay out either way, so the toggle stands down with the
                filters rather than pretending to change something. */}
            <fieldset
              className="kit-seg"
              aria-label="View"
              hidden={!props.showDriveTools}
            >
              <button
                type="button"
                aria-label="Grid view"
                aria-pressed={props.view === "grid"}
                onClick={() => props.onSelectView("grid")}
              >
                <svg
                  aria-hidden="true"
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
                aria-pressed={props.view === "list"}
                onClick={() => props.onSelectView("list")}
              >
                <svg
                  aria-hidden="true"
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
            </fieldset>
            <div className={styles.askMount} data-ask-mount />
          </div>
        </div>

        {props.consent ? (
          // `id="consentBanner"` is the shared hook kit's onFocusRefresh reads to
          // detect a denied→recover state and bypass its 30s focus throttle (the
          // served islands exposed the same id). Without it, a refocus after a
          // revoke would be throttled and never retry the read (#505).
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>No vault access yet.</strong>{" "}
            <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}
        {/* Driven imperatively by logic.ts (notice / readFailed) — rendered once,
            never reconciled, so those DOM writes are never clobbered. */}
        <output
          id="noticeBanner"
          className={`kit-banner notice ${styles.banner}`}
          aria-live="polite"
          hidden
        />

        {/* The shelf strip (§1.7), between the banners and the toolbar. It is
            a slot because WHETHER it renders is a routing question — the
            compact band claims the same six destinations, and §1.7 lists the
            routes that carry no strip at all. */}
        {props.slots.shelfStrip}

        <div className={styles.toolbar}>
          <div className={styles.toolbarTitle}>
            <div className={styles.title}>{props.activeTitle}</div>
            <div className={styles.sub}>{props.activeSub}</div>
          </div>
          {/* The filters, the view toggle and the sort belong to the DRIVE.
              Off it (Folders, Coming due) there is nothing to filter or sort,
              and a row of inert controls is worse than none. */}
          <div className={styles.toolbarTools} hidden={!props.showDriveTools}>
            <fieldset className={styles.chips} aria-label="Filter by tag">
              {props.slots.tagChips}
            </fieldset>
            <span className={styles.toolbarDiv} aria-hidden="true" />
            <button type="button" className="kit-btn" onClick={props.onSort}>
              <svg
                aria-hidden="true"
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

        {props.slots.bulkBar ? (
          <div
            className={styles.bulk}
            role="toolbar"
            aria-label="Selection actions"
          >
            {props.slots.bulkBar}
          </div>
        ) : null}

        <div className={styles.scroll}>{props.slots.scroll}</div>
      </main>

      {props.slots.overlays}

      {/* The band's own overflow sheet (§1.5) — the app's, because the band's
          sixth slot is the app's. It renders only while open, so there is no
          empty region to collapse and nothing to hide. */}
      {props.slots.moreSheet}

      {/* Opened programmatically (uploadRef.click()); `hidden` already keeps it
          out of the a11y tree, so it carries no aria-hidden on top of that. */}
      <input
        ref={uploadRef}
        id="uploadInput"
        type="file"
        multiple
        hidden
        aria-label="Upload files"
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
