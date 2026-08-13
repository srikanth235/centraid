// The Photos chrome as JSX — a ROUTE INSIDE THE FRAME, not a standalone app
// (v4 handoff §3).
//
// WHAT RETIRED HERE, and why each one had to go:
//
//  * the hamburger and the sidebar/drawer — the frame owns navigation (the
//    240px stem on desktop, the claimed band on the phone). A drawer inside
//    the content pane was a second navigation for the same destinations.
//  * the in-pane search field — search is a SHELF now (§9), reached from the
//    band and the frame, not a field this app draws in a header of its own.
//  * the zoom in/out pair — tile size is a four-rung member preference in the
//    toolbar row (§4.2), not two unlabelled buttons walking a pixel value.
//  * the slideshow button — the slideshow is a mode on the stage, entered from
//    the viewer.
//  * the app's own title, count, Select and Import — those are the frame's app
//    bar, contributed through `frame.setAppBar` (frame.tsx).
//  * `#noticeBanner` — the ONE status line is the frame's, and every write
//    outcome goes there through `frame.setStatus` with Undo where undo is
//    possible (outcomes.ts). No toast, no spinner, no badge, no red dot.
//
//  * the `kit-banner` consent strip — permission is a designed SCREEN (§13,
//    components/Permission.tsx), which arrives here as a slot and replaces the
//    live region rather than sitting in a strip above it. A strip reads as
//    "something went wrong up there"; a refused grant is a state the product
//    is designed for.
//
// WHAT STAYS: the permission screen's slot (§13), the
// live region, the scroll pane and the fixed-overlay regions — lightbox,
// slideshow, picker, drop overlay — whose contents other modules own. Inline
// they live INSIDE the app pane and are re-scoped to `position:absolute`
// against `.shell` so they never overlay the shell chrome (#505 trap 7).
//
// SELECTION HAS NO OVERLAY OF ITS OWN (v4 §6). It used to get a second React
// root on a floating `#selectionBar` pill — two roots fighting over what "the
// selection bar" means. Now there is one decision, made where the toolbar row
// already lives (`#toolbarMount`, selection.tsx): `selectMode ? <SelectionBar>
// : <ToolbarView>`. `#selectionBottomBar` is new and different — the PHONE's
// five-target action bar (§6, §15), which is never the toolbar row (the row
// carries nothing there while selecting; the count/Select all/Done move to
// the frame's head) and never a second band (it claims no destinations and
// never calls `frame.claimBand`).
//
// The imperatively-toggled nodes (`#empty`, `#consentBanner`, `#live`,
// `#lightbox`, `#slideshow`, `#picker`, `#dropOverlay`) keep their ids and a
// literal `hidden` so the orchestrator's `$(…).hidden = …` writes survive —
// React never re-writes an unchanged prop.
import type { ReactNode } from "react";

import { EMPTY_ACTIONS, EMPTY_TITLE } from "./view-copy.ts";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  /** The shelf strip (§5). Absent in album detail and on the phone whose band
   *  claim was honoured — the band carries the shelves there. */
  shelfStrip: ReactNode;
  /** The Photos toolbar row (§3) — or the selection bar, while a selection is
   *  active (§6). Null when it carries nothing. */
  toolbar: ReactNode;
  main: ReactNode;
  /** The phone's floating selection action bar (§6, §15). Null everywhere
   *  else — desktop/PWA carry the same actions inside `toolbar`. */
  selectionBottomBar: ReactNode;
  lightbox: ReactNode;
  slideshow: ReactNode;
  picker: ReactNode;
  /**
   * The permission screen (§13), or null while access is granted. It is a
   * SCREEN and not a strip, so it replaces the live region rather than sitting
   * above it — there is nothing behind it to look at, and a banner over an
   * empty pane would say otherwise.
   */
  permission: ReactNode;
  /** The compact band's overflow sheet (§3.1), or null while it is closed. */
  moreSheet: ReactNode;
  /**
   * The offline banner (§14), or null while the library is reachable. It sits
   * at the head of the scroll pane and pushes nothing aside: everything below
   * it — months, days, counts, captions, albums, people, the rail, Select —
   * still renders, because "the meaning is still here" is the banner's whole
   * claim (components/OfflineBanner.tsx).
   */
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

        {/* `hidden` rather than unmounted: the orchestrator kept the live
            region's geometry across a denial before, and re-mounting it would
            throw away every tile's already loaded bytes the moment access
            came back. */}
        <div id="live" className={styles.live} hidden={denied}>
          <div id="shelfStripMount">{slots.shelfStrip}</div>
          <div id="toolbarMount">{slots.toolbar}</div>

          <div id="scrollPane" className={styles.scroll}>
            {slots.banner}
            <section
              id="grid"
              className={styles.content}
              aria-label="Photo library"
            >
              {slots.main}
            </section>
            {/* THE EMPTY BLOCK IS PHOTOS' OWN (§14, proto 4406), not the
                shared `.kit-empty`. Three things the kit's version could not
                say, each of them load-bearing:

                  * it CENTRES a 38ch column, and this state is a paragraph a
                    member reads — reading copy is left-aligned and in flow,
                    at 44ch, like every other paragraph in the product;
                  * its title is 0.95rem/600, which is a row label. §14 asks
                    for the display serif, because an empty library is the
                    first real screen this app ever shows somebody;
                  * IT HAS NO NODE FOR A BODY PARAGRAPH AT ALL. So the one
                    sentence §14 requires — where the bytes actually go — had
                    nowhere to live and was simply never said.

                The nodes stay imperative (`#emptyText`, `#emptyBody`,
                `#emptyUpload`, `#emptyCamera`) and keep their ids: app-root's
                `applyEmptyState` writes them from `emptyStateView`
                (view-state.ts), upload.ts binds `#emptyUpload` once at boot,
                and `applyUploadTarget` re-reads it on every render. React
                never re-writes an unchanged prop, so those writes survive. */}
            <div id="empty" className={styles.empty} hidden>
              {/* Seeded with the title it takes in every view but a search
                  miss, so the heading is never an empty one to a screen
                  reader; `applyEmptyState` overwrites its text content, and
                  the block is `hidden` until it has. */}
              <h2 id="emptyText" className={styles.emptyTitle}>
                {EMPTY_TITLE}
              </h2>
              <p id="emptyBody" className={styles.emptyBody} />
              <div className={styles.emptyActions}>
                {/* The ONE filled control in this view (§18). The frame's app
                    bar drops its own Import while this is offered — two filled
                    Imports on one screen is two answers to one question. */}
                <button
                  id="emptyUpload"
                  type="button"
                  className="kit-btn primary"
                  hidden
                >
                  {EMPTY_ACTIONS.import}
                </button>
                {/* Phone only (§15's Import row: the camera is the compact
                    surface's second way in). Outlined, always. */}
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
      </main>

      {/* Empty (no children) whenever selection is not active on the phone —
          `.selectionBottomBar:empty` (Chrome.module.css) collapses it to
          nothing rather than this needing a `hidden` toggle of its own. */}
      <div id="selectionBottomBar" className={styles.selectionBottomBar}>
        {slots.selectionBottomBar}
      </div>

      {/* The band's own overflow sheet (§3.1) — the app's, because the band's
          sixth slot is the app's. It renders only while open, so there is no
          empty region to collapse and nothing to hide. */}
      {slots.moreSheet}

      {/* Never focusable and never shown — `hidden` already keeps it out of the
          accessibility tree, so it carries no `aria-hidden`; upload.ts drives it
          with `.click()`. */}
      <input
        id="fileInput"
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        hidden
      />
      {/* `Take a photograph` (§14, §15) is a real camera, not a second file
          picker: `capture` hands the compact surface its camera directly. It
          is a SEPARATE input because `capture` on the shared one would take
          the file picker away from the desktop, where the camera is not one
          of the three ways in. app-root binds its `change`; it is never shown
          on a surface where the button is not offered. */}
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
      {/* Native <dialog>, never `showModal()` — `open` is mandatory (a <dialog>
          without it is `display:none`) and the orchestrator keeps driving
          visibility through the `hidden` attribute exactly as before. */}
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
