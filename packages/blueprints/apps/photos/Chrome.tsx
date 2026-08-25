// The Photos chrome as JSX — a ROUTE INSIDE THE FRAME (v4 §3). NONE of these
// may come back: hamburger or drawer, in-pane search, zoom pair, slideshow
// button, the app's own title/count/Select/Import, `#noticeBanner`, a consent
// strip — the frame owns each, and permission is a SCREEN (§13). Overlays
// re-scope absolute against `.shell` (#505 trap 7); selection has NO overlay
// of its own (§6). The imperative nodes keep their ids and a literal `hidden`.
import type { ReactNode } from "react";

import { EMPTY_ACTIONS, EMPTY_TITLE } from "./view-copy.ts";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  shelfStrip: ReactNode;
  navRail: ReactNode;
  toolbar: ReactNode;
  main: ReactNode;
  selectionBottomBar: ReactNode;
  lightbox: ReactNode;
  slideshow: ReactNode;
  picker: ReactNode;
  permission: ReactNode;
  moreSheet: ReactNode;
  /** Pushes nothing aside: everything below it still renders (§14). */
  banner: ReactNode;
}

export interface ChromeProps {
  slots: ChromeSlots;
}

export function Chrome({ slots }: ChromeProps): ReactNode {
  const denied = Boolean(slots.permission);
  return (
    <div className={styles.shell} data-tone="mat" data-density="compact">
      <main className={styles.main}>
        {slots.permission}

        {/* `hidden`, never unmounted: re-mounting throws away every tile's
            already loaded bytes. */}
        <div id="live" className={styles.live} hidden={denied}>
          <div id="shelfStripMount">{slots.shelfStrip}</div>
          <div id="toolbarMount">{slots.toolbar}</div>

          {/* The rail is a flex SIBLING of the pane, which is what makes the
              two columns scroll independently. */}
          <div className={styles.contentRow}>
            {slots.navRail}
            <div id="scrollPane" className={styles.scroll}>
              {slots.banner}
              <section
                id="grid"
                className={styles.content}
                aria-label="Photo library"
              >
                {slots.main}
              </section>
              {/* PHOTOS' OWN EMPTY BLOCK (§14), not `.kit-empty`: the kit
                centres its column, sets its title at a row label's weight and
                has no body-paragraph node at all — so §14's one required
                sentence had nowhere to live. The nodes stay imperative and
                keep their ids for `applyEmptyState` and upload.ts. */}
              <div id="empty" className={styles.empty} hidden>
                {/* Seeded so the heading is never empty to a screen reader;
                  `applyEmptyState` overwrites it. */}
                <h2 id="emptyText" className={styles.emptyTitle}>
                  {EMPTY_TITLE}
                </h2>
                <p id="emptyBody" className={styles.emptyBody} />
                <div className={styles.emptyActions}>
                  {/* The ONE filled control here (§18); the app bar drops its
                    own Import while this is offered. */}
                  <button
                    id="emptyUpload"
                    type="button"
                    className="kit-btn primary"
                    hidden
                  >
                    {EMPTY_ACTIONS.import}
                  </button>
                  {/* Phone only (§15). Outlined, always. */}
                  <button
                    id="emptyCamera"
                    type="button"
                    className="kit-btn"
                    hidden
                  >
                    {EMPTY_ACTIONS.camera}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* `.selectionBottomBar:empty` collapses it; no `hidden` toggle. */}
      <div id="selectionBottomBar" className={styles.selectionBottomBar}>
        {slots.selectionBottomBar}
      </div>

      {/* Renders only while open; no empty region to collapse. */}
      {slots.moreSheet}

      {/* `hidden` keeps it out of the a11y tree; no `aria-hidden`. */}
      <input
        id="fileInput"
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        hidden
      />
      {/* SEPARATE from the file input: `capture` on the shared one would take
          the picker away from the desktop, where the camera is not a way in. */}
      <input
        id="cameraInput"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
      />

      <dialog
        id="lightbox"
        open
        className={styles.lightbox}
        aria-modal="true"
        aria-label="Photo viewer"
        tabIndex={-1}
        hidden
      >
        {slots.lightbox}
      </dialog>
      {/* Never `showModal()`: `open` is mandatory, and visibility is driven
          through `hidden`. */}
      <dialog
        id="slideshow"
        open
        className={styles.slideshow}
        aria-modal="true"
        aria-label="Slideshow"
        hidden
      >
        {slots.slideshow}
      </dialog>
      <dialog
        id="picker"
        open
        className={`kit-modal-back ${styles.picker}`}
        aria-label="Add photos to album"
        hidden
      >
        {slots.picker}
      </dialog>
      <div
        id="dropOverlay"
        className={`kit-drop ${styles.dropOverlay}`}
        aria-hidden="true"
        hidden
      >
        <div className="kit-drop-card">Drop to add to your library</div>
      </div>
    </div>
  );
}
