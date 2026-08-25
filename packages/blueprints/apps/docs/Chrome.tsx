// The Docs chrome as JSX — a ROUTE INSIDE THE FRAME (#505 inline path,
// Docs spec §1). The sidebar (brand, New menu, folders, storage), the
// consent/notice banners, the shelf strip and the scroll host,
// expressed as one React tree so app-inline.tsx renders one tree instead of
// fourteen imperative roots.
//
// THERE IS NO TOPBAR, NO TAG RAIL, NO HAMBURGER AND NO INLINE ASK BUTTON, and
// none of them may come back: each would restate something the screen already
// says better — the search field is the Search shelf's own first block
// (`components/SearchField.tsx`), reached from the app bar's Search control
// beside Select and from the compact band's Search tab; the filter pills and
// the column heads carry what a tag rail and a compact sort button would; the
// hamburger opened a sidebar this seat renders `display: none` at every width;
// and Ask is the shell's own affordance in the corner of the same window. What
// the handoff draws above the strip is a 34px row of controls carrying the
// List/Grid pair at its trailing edge (`components/ViewToggle.tsx`). Classes
// come from Chrome.module.css (scoped chrome) + the global kit-* vocabulary
// (kit.css, loaded once by the host).
//
// TRAP #5 IS CLOSED HERE. This root stamps NO global `docs` / `is-narrow` /
// `side-open` class trio alongside the module-scoped
// `.shell`/`.isNarrow`/`.sideOpen`, and must not grow one so that sibling
// `components/*.module.css` files can reach across a module boundary with
// `:global(.docs.is-narrow) …` overrides. That is a seam: any app that
// happened to stamp `docs` anywhere in the document would restyle these
// components, and the coupling is invisible from either end. The three
// stylesheets carry their own `data-narrow` attribute on their own elements
// (List/Editor/QuickLook take a `narrow` prop), and this file's classes are
// all module-scoped.
//
// EVERYTHING VARIABLE ARRIVES AS A SLOT (`ChromeSlots`), the same shape
// `photos/Chrome.tsx` uses. The chrome owns geometry; what stands in each
// region is the orchestrator's decision, so the two can be reasoned about —
// and re-carved for the routes still to land — independently.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";

import styles from "./Chrome.module.css";

/** Everything the chrome DRAWS but does not decide. One region per slot, and
 *  a `null` slot renders nothing at all rather than an empty container. */
export interface ChromeSlots {
  /**
   * The toolbar row above the strip (the handoff's `barRow`) — ONE ROW WITH
   * TWO STATES, exactly as `barNormal: !sel, selOn: !!sel` says: the List/Grid
   * pair while nothing is picked, the selection bar's count and verbs while
   * something is. The caller decides which; this row only draws it.
   *
   * Null wherever the row would carry nothing. AN EMPTY BAND IS CHROME:
   * Photos' own toolbar returns null rather than draw a rule with nothing in
   * it (`toolbarCarriesSomething`).
   */
  toolbar: ReactNode;
  /** The shelf strip (§1.7). Null on the compact form factor whose band claim
   *  was honoured — the band carries the shelves there — and on the routes
   *  §1.7 excludes. Null on a pointer seat too since v16: `navRail` carries
   *  the same destinations there, on the other axis. */
  shelfStrip: ReactNode;
  /**
   * The app navigation rail (v16) — Docs' own destinations, and the FOLDER
   * TREE this app's §14 once cut, as a 232px column on the leading edge of the
   * content on a pointer seat. Null where the strip or the band carries them.
   *
   * It is the LEADING column of the content row and `rail` (the details) is
   * the trailing one, which is the arrangement §1 of the rail spec draws:
   * stem · app rail · content · info rail — three questions, not three spines.
   * Which app, where in it, what is this.
   */
  navRail: ReactNode;
  /** The folder list, with its inline create/rename editors. */
  folderList: ReactNode;
  storage: ReactNode;
  /** The "+ New" dropdown's contents, or null while it is closed. */
  newMenu: ReactNode;
  /** The current route's body (components/DriveRoute, FoldersRoute, …). */
  scroll: ReactNode;
  /** The DOCKED details rail (§8), or null while it is closed — a column
   *  BESIDE the set, never over it. The handoff's `docsRail` is a flex
   *  sibling of the scroller inside `contentStyle`, which is what makes
   *  "select another row and the rail follows it" a usable sentence: a modal
   *  drawer over a scrim covers the set it is describing, so the next row
   *  cannot be reached without dismissing the description first. On the
   *  compact form factor this stays null and the rail keeps its drawer form
   *  (Details.tsx) — 308px beside 390 is not a column. */
  rail: ReactNode;
  /** Details / Quick Look / Editor / the share sheet. */
  overlays: ReactNode;
  /** The compact band's overflow sheet (§1.5), or null while it is closed. */
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  ready: boolean;
  sideOpen: boolean;
  newMenuOpen: boolean;
  consent: { message: string } | null;
  /** Something is picked, so the toolbar row is carrying the SELECTION bar
   *  rather than the arrangement pair. Carried as a prop and stamped on this
   *  row, never read off a global state class another module owns (trap #5). */
  selecting: boolean;
  dropVisible: boolean;
  dropTarget: string;
  onCloseSide: () => void;
  onToggleNewMenu: (event: { stopPropagation: () => void }) => void;
  onUploadChange: () => void;
  uploadRef: (el: HTMLInputElement | null) => void;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  // Callback refs come off `props` first: a ref read from the props object taints
  // every later `props.*` read for the React compiler ("cannot access refs during
  // render"), so they are destructured into plain locals here (#573).
  const { uploadRef } = props;

  // Module-scoped only: no global `docs`/`is-narrow`/`side-open` trio is
  // mirrored here (see the trap #5 note at the top).
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
        {/* THE TOOLBAR ROW (the handoff's `barRow`, above the strip). Controls
            and nothing else — no rule, no title, no count of its own: those are
            the frame's app bar. It carries the List/Grid pair at its trailing
            edge, and while a set is picked it carries the SELECTION BAR in the
            same slot instead (`barNormal: !sel, selOn: !!sel`).

            `aria-label` follows what the row is currently for, because a row
            of five destructive-adjacent verbs announced as "View" is the label
            describing the furniture rather than the contents.

            THIS IS NOT THE OLD TOPBAR. That row was `kit-app-topbar` — 66px,
            a search field and a border-bottom, chrome pretending to be a
            header. The field became the Search shelf's own block
            (components/SearchField.tsx); what is left is the row the handoff
            actually draws, at the height it actually draws it, and it renders
            only where it carries something. */}
        {props.slots.toolbar ? (
          <div
            className={styles.toolbar}
            data-selecting={String(props.selecting)}
            role="toolbar"
            aria-label={props.selecting ? "Selection actions" : "View"}
          >
            {props.slots.toolbar}
          </div>
        ) : null}

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

        {/* THE CONTENT ROW: the scroller and the details rail, side by side
            (the handoff's `contentStyle`, `display: flex`). The rail is
            furniture, not a fixed overlay, so the two share the row and the
            set reflows to the width that is left rather than being covered. */}
        <div className={styles.content}>
          {props.slots.navRail}
          <div className={styles.scroll}>{props.slots.scroll}</div>
          {props.slots.rail}
        </div>
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
