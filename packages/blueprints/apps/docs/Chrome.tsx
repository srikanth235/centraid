// The Docs chrome as one React tree — a route inside the frame (#505, §1). No
// topbar, tag rail, hamburger or inline Ask button may come back.
//
// TRAP #5: stamp NO global `docs`/`is-narrow`/`side-open` trio beside the
// module-scoped classes — sibling `*.module.css` would reach across the module
// boundary. Narrowness travels as `data-narrow`/`narrow`; every variable
// region arrives as a slot.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  /** List/Grid pair, or the selection bar. Null, never an empty band. */
  toolbar: ReactNode;
  /** Null where the band or `navRail` carries them. */
  shelfStrip: ReactNode;
  navRail: ReactNode;
  folderList: ReactNode;
  storage: ReactNode;
  newMenu: ReactNode;
  scroll: ReactNode;
  /** Docked BESIDE the set (§8), never over it. Null on compact. */
  rail: ReactNode;
  overlays: ReactNode;
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  ready: boolean;
  sideOpen: boolean;
  newMenuOpen: boolean;
  consent: { message: string } | null;
  /** From this prop, never a global state class (trap #5). */
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
  // Destructure refs first, or every later `props.*` read taints (#573).
  const { uploadRef } = props;

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

      {/* A real button, so dismissal is keyboard-reachable. */}
      <button
        type="button"
        className={`kit-plain-btn ${styles.scrim}`}
        aria-label="Dismiss menu"
        onClick={props.onCloseSide}
      />

      <main className={styles.main}>
        {/* Controls only; the frame's app bar owns rule, title and count.
            `aria-label` follows what the row is currently for. */}
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
          // `id="consentBanner"` lets onFocusRefresh bypass its throttle (#505).
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>No vault access yet.</strong>{" "}
            <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}
        {/* Driven imperatively by logic.ts; never reconciled. */}
        <output
          id="noticeBanner"
          className={`kit-banner notice ${styles.banner}`}
          aria-live="polite"
          hidden
        />

        {/* A slot because WHETHER it renders is a routing question. */}
        {props.slots.shelfStrip}

        {/* The rail is furniture, not an overlay: the set reflows beside it. */}
        <div className={styles.content}>
          {props.slots.navRail}
          <div className={styles.scroll}>{props.slots.scroll}</div>
          {props.slots.rail}
        </div>
      </main>

      {props.slots.overlays}

      {/* Renders only while open; no empty region to collapse. */}
      {props.slots.moreSheet}

      {/* `hidden` already keeps it out of the a11y tree; no aria-hidden. */}
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
