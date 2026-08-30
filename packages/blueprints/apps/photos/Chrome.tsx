// The Photos chrome as JSX — a ROUTE INSIDE THE FRAME (v4 §3). NONE of these
// may come back: hamburger or drawer, in-pane search, zoom pair, slideshow
// button, the app's own title/count/Select/Import, `#noticeBanner`, a consent
// strip — the frame owns each, and permission is a SCREEN (§13), so no
// `ConsentBanner`/`NoticeBanner` stands here. Overlays re-scope absolute
// against `.shell` (#505 trap 7); selection has NO overlay of its own (§6).
// The imperative nodes keep their ids and a literal `hidden`.
import type { ReactNode } from "react";

import { DropOverlay, ScrollHost } from "../_shared/AppChrome.tsx";
import { chromeClass } from "../_shared/chrome-kit.ts";
import { KitModal } from "../_shared/KitModal.tsx";
import { MEDIA_ROOT_ATTR } from "./media-observer.ts";
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
          {/* NOT `ChromeToolbar`: this is a MOUNT two owners take turns at
              (`selection.tsx` measures and disables it by id), and each writes
              its own `role="toolbar"` row into it — a second role here would
              announce two toolbars where one stands. */}
          <div id="toolbarMount">{slots.toolbar}</div>

          {/* The rail is a flex SIBLING of the pane, which is what makes the
              two columns scroll independently. */}
          <div className={styles.contentRow}>
            {slots.navRail}
            {/* The lookahead observer roots itself HERE (media-observer.ts):
                a `rootMargin` only expands an observer's own root, so a
                viewport-rooted one is clipped by this pane and never looks a
                screen ahead. Declared, never re-derived per tile. */}
            <ScrollHost
              id="scrollPane"
              className={styles.scroll}
              data={{ [MEDIA_ROOT_ATTR]: "" }}
            >
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
            </ScrollHost>
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

      {/* The kit modal's INLINE layer for all three: `open` is mandatory and
          visibility is driven through `hidden` from the app's own code, so the
          top layer — which would cover the frame's app bar — is never taken. */}
      <KitModal
        layer="inline"
        id="lightbox"
        className={styles.lightbox}
        ariaModal
        label="Photo viewer"
        focusable
        hidden
      >
        {slots.lightbox}
      </KitModal>
      <KitModal
        layer="inline"
        id="slideshow"
        className={styles.slideshow}
        ariaModal
        label="Slideshow"
        hidden
      >
        {slots.slideshow}
      </KitModal>
      <KitModal
        layer="inline"
        id="picker"
        className={chromeClass("kit-modal-back", styles.picker)}
        label="Add photos to album"
        hidden
      >
        {slots.picker}
      </KitModal>
      {/* `upload.ts` writes `hidden` on this node itself while a drag is over
          the pane, so `visible` is the resting state and never changes: React
          re-renders around the attribute rather than reclaiming it. */}
      <DropOverlay
        id="dropOverlay"
        className={styles.dropOverlay}
        visible={false}
      >
        Drop to add to your library
      </DropOverlay>
    </div>
  );
}
