// Selection, as one owner (v4 handoff §6).
//
// Everything about "which photographs are picked and what the bar says about
// them" lives here: the mode, the composite-key set, the shift-range anchor,
// the busy latch, the *Add to album* menu's away-click, and the bar's own
// render. The orchestrator asks it questions and tells it when the data moved.
//
// ONE ROOT, ONE DECISION (v4 §6 close-out). `#toolbarMount` — the same node
// the Photos toolbar row renders into — is where the selection bar renders
// too: `selectMode ? <selection bar> : <ToolbarView>`. Two React roots cannot
// share one DOM node, so `renderBar` only ever writes to `selectionBarRoot`
// while a selection is active, and `app-root.tsx`'s `renderToolbarRow` only
// ever writes to it while one is not — each function is silent on the other's
// turn, so neither clobbers what the other just painted.
//
// THE PHONE IS DIFFERENT (§6, §15): the row carries nothing while selecting
// there (the count, Select all and Done move to the frame's head instead —
// app-root.tsx's `contributeAppBar`), and the five actions move to
// `SelectionBottomBar`, which takes the compact foot while selecting
// (Chrome.tsx's `#selectionBottomBar`). The shell withdraws the claimed band
// for this focused state; this action bar claims no destinations and never
// touches `frame.claimBand`.
//
// SELECTION SURVIVES SCROLLING AND SHELF CHANGES, and is cleared when the
// route leaves Photos (§6, §16) — the mount's teardown is that clear, because
// this state is ephemeral by construction and never outlives the mount.
//
// Keys are COMPOSITE (asset-key.ts), never bare asset ids: the merged timeline
// can show two scopes' rows that share an `asset_id`, and a bare-id set would
// tick both and send a batch to the wrong one (#599).
import type { ReactNode } from "react";

import { observeWidth } from "@centraid/design/elements";

import { canWriteScope, mountedScopes } from "../_shared/scope-kit.ts";
import {
  pruneSelection,
  toggleAllSelection,
  toggleSelectionKey,
  toggleSelectionRange,
} from "../_shared/selection-engine.ts";
import { assetKey, parseAssetKey } from "./asset-key.ts";
import type { SelectionShelfKind } from "./components/SelectionBar.tsx";
import {
  LABEL_BREAKPOINT,
  PhoneAlbumSheet,
  SelectionBarView,
  SelectionBottomBar,
} from "./components/SelectionBar.tsx";
import { $ } from "./dom.ts";
import { writeTarget } from "./outcomes.ts";
import { runBatchAddToAlbum } from "./selection-actions.ts";
import type { Album, Asset } from "./types.ts";

import styles from "./components/SelectionBar.module.css";

type Root = { render: (node: ReactNode) => void };

export interface Selection {
  isActive: () => boolean;
  isBusy: () => boolean;
  /** The live key set, handed to the grid so a tile can read its own state.
   *  A `Set`, not a `ReadonlySet`, because that is what the grid's props ask
   *  for; every mutation still goes through `toggle`/`exit`/`prune`. */
  keys: Set<string>;
  enter: () => void;
  exit: () => void;
  toggle: (key: string, shiftKey?: boolean) => void;
  /** Select every visible row, or clear the selection if any row is already
   *  on (§6's `Select all` / `Select none`) — the label follows the same
   *  rule the bar reads it with: "none selected" is the only state that
   *  offers "Select all". */
  toggleAll: () => void;
  /** Drop keys for rows that are no longer on screen. */
  prune: (present: readonly Asset[]) => void;
  renderBar: () => void;
  /** Teardown: the away-click listener, the width observer and the body
   *  class outlive React's own unmount, so the caller must release them. */
  dispose: () => void;
}

export function createSelection({
  selectionBarRoot,
  bottomBarRoot,
  getVisible,
  getAlbums,
  refresh,
  repaint,
  getShelfKind,
  isNarrow,
}: {
  /** `#toolbarMount` — the SAME root the toolbar row renders into (§6). */
  selectionBarRoot: Root;
  /** `#selectionBottomBar` — the phone's floating action bar. Optional so
   *  this stays constructible without it (the test file above builds a
   *  `Selection` to exercise `keys`/`prune` alone and never calls `enter`). */
  bottomBarRoot?: Root;
  getVisible: () => Asset[];
  getAlbums: () => Album[];
  refresh: () => Promise<void>;
  /** Repaint the surfaces that read the mode: the grid, the toolbar row and
   *  the frame's app bar, whose `Select` becomes `Done`. */
  repaint: () => void;
  /**
   * Which of the bar's shelf swaps applies (§6: Trash → Restore) — optional
   * so this stays wireable without a breaking change. Left off, every shelf
   * reads as "normal" and the bar keeps the base Trash wording.
   */
  getShelfKind?: () => SelectionShelfKind;
  /** Is this the phone (§6, §15)? Gates which of the two arrangements
   *  renders — the desktop/PWA row in `selectionBarRoot`, or the head +
   *  `bottomBarRoot` split. Defaults to false (desktop/PWA), matching the
   *  test file's bare construction above. */
  isNarrow?: () => boolean;
}): Selection {
  let active = false;
  let busy = false;
  let anchor: string | null = null;
  let menuOpen = false;
  let labelled = true;
  let stopWidthObserver: (() => void) | null = null;
  const keys = new Set<string>();
  const shelfKind = getShelfKind ?? (() => "normal" as const);
  const narrow = isNarrow ?? (() => false);

  function replaceKeys(next: ReadonlySet<string>): void {
    keys.clear();
    for (const key of next) keys.add(key);
  }

  function onAway(e: globalThis.MouseEvent): void {
    // Queried against the whole document, not one region: the menu this
    // dismisses is desktop/PWA's inline popover (`.bar-menu-wrap`, rendered
    // inside `#toolbarMount`) — the phone's `PhoneAlbumSheet` has its own
    // explicit Cancel and is never this class.
    const wrap = document.querySelector(".bar-menu-wrap");
    if (wrap && !wrap.contains(e.target as Node)) {
      closeMenu();
      renderBar();
    }
  }
  function closeMenu(): void {
    if (!menuOpen) return;
    menuOpen = false;
    document.removeEventListener("click", onAway, true);
  }
  function toggleMenu(): void {
    if (menuOpen) {
      closeMenu();
      renderBar();
      return;
    }
    menuOpen = true;
    renderBar();
    document.addEventListener("click", onAway, true);
  }

  /** Add the selection to `album` and close whichever menu offered it — the
   *  desktop popover and the phone sheet both resolve here (PhoneAlbumSheet
   *  itself does no vault work; see its own header). */
  function pickAlbum(album: Album): void {
    closeMenu();
    // Albums are own-scope regardless of the chip selection
    // (albums-actions.ts) — resolved here, at the call site.
    const target = writeTarget("own");
    void runBatchAddToAlbum(
      [...keys],
      album,
      target.disabled ? null : target.scopeId,
      { current: null },
      { refresh, setBarBusy: setBusy, exitSelectMode: exit }
    );
  }

  function setBusy(on: boolean): void {
    busy = on;
    for (const container of [$("toolbarMount"), $("selectionBottomBar")]) {
      for (const btn of container.querySelectorAll("button")) btn.disabled = on;
    }
  }

  /**
   * Non-null the moment any selected row sits in a scope the member cannot
   * write to (§6): Favorite, Add to album and Trash/Restore disable with this
   * reason, stated inline rather than only in a tooltip. *Copy to ⟨vault⟩*
   * and Download are never disabled by it — both are legitimate from a
   * read-only audience (copying into a vault the member owns is not a write
   * on the audience; downloading isn't a write at all).
   *
   * Two sentences, both load-bearing (v4 handoff §6, prototype `selRefusal`):
   * the first names what's off and why (the grant, not a guess); the second
   * heads off the obvious follow-up question — "then why do the copy action
   * and Download still work?" — before the member has to ask it.
   */
  function readOnlyReason(): string | null {
    const scopes = mountedScopes();
    for (const key of keys) {
      const { scopeId } = parseAssetKey(key);
      if (canWriteScope(scopeId || null)) continue;
      const scope = scopes.find((s) => s.id === scopeId);
      const label = scope?.label ?? "This library";
      return `${label} is read and download only — Favorite, Add to album and Trash are unavailable.`;
    }
    return null;
  }

  /**
   * `#toolbarMount` is shared with the toolbar row (v4 §6 close-out): this
   * function only ever writes to it while a selection is active, so the
   * toolbar row's own render (app-root.tsx, only while one is not) is never
   * clobbered by this running after it, or vice versa.
   */
  function renderBar(): void {
    if (!active) return;
    if (narrow()) {
      // The row itself carries nothing on the phone while selecting — the
      // count, Select all and Done live in the frame's head instead
      // (app-root.tsx's `contributeAppBar`), and the five actions move to the
      // floating bottom bar (§6, §15).
      selectionBarRoot.render(null);
      bottomBarRoot?.render(
        <>
          {/* Above the action row, not below it — `#selectionBottomBar`
              stacks in plain document order (Chrome.module.css), so the
              sheet has to come first to read as a menu popping UP off the
              row it was opened from. */}
          {menuOpen ? (
            <PhoneAlbumSheet
              albums={getAlbums()}
              onPick={pickAlbum}
              onCancel={() => {
                closeMenu();
                renderBar();
              }}
            />
          ) : null}
          <SelectionBottomBar
            selectedIds={keys}
            visible={getVisible()}
            shelfKind={shelfKind()}
            readOnlyReason={readOnlyReason()}
            refresh={refresh}
            setBarBusy={setBusy}
            onExit={exit}
            onAddToAlbum={toggleMenu}
          />
        </>
      );
      return;
    }
    bottomBarRoot?.render(null);
    selectionBarRoot.render(
      <div className={styles.bar} role="toolbar" aria-label="Selection actions">
        <SelectionBarView
          selectedIds={keys}
          visible={getVisible()}
          albums={getAlbums()}
          shelfKind={shelfKind()}
          readOnlyReason={readOnlyReason()}
          menuOpen={menuOpen}
          busy={busy}
          labelled={labelled}
          refresh={refresh}
          setBarBusy={setBusy}
          onToggleMenu={toggleMenu}
          onCloseMenu={() => {
            closeMenu();
            renderBar();
          }}
          onExit={exit}
          onToggleAll={toggleAll}
        />
      </div>
    );
  }

  function enter(): void {
    active = true;
    anchor = null;
    document.body.classList.add("has-selection");
    repaint();
    renderBar();
    // Measure the bar itself (§6, §15) — never a surface flag. Desktop/PWA
    // only: the phone never shows labels (there is no width to cross the
    // breakpoint at), so it has nothing to measure.
    stopWidthObserver?.();
    if (!narrow()) {
      stopWidthObserver = observeWidth(
        $("toolbarMount"),
        LABEL_BREAKPOINT,
        (isBelowBreakpoint) => {
          labelled = !isBelowBreakpoint;
          renderBar();
        }
      );
    }
  }

  function exit(): void {
    active = false;
    keys.clear();
    anchor = null;
    document.body.classList.remove("has-selection");
    closeMenu();
    stopWidthObserver?.();
    stopWidthObserver = null;
    bottomBarRoot?.render(null);
    // `renderBar` is a no-op once `active` is false — `repaint()` is what
    // hands `#toolbarMount` back to the toolbar row (app-root.tsx's
    // `renderToolbarRow`, which only writes there while a selection is not
    // active).
    repaint();
  }

  function toggleAll(): void {
    if (busy) return;
    replaceKeys(
      toggleAllSelection(
        keys,
        getVisible().map((asset) => assetKey(asset))
      )
    );
    anchor = null;
    repaint();
    renderBar();
  }

  function toggle(key: string, shiftKey?: boolean): void {
    if (busy) return;
    const list = getVisible();
    if (shiftKey && anchor && anchor !== key) {
      const from = list.findIndex((x) => assetKey(x) === anchor);
      const to = list.findIndex((x) => assetKey(x) === key);
      if (from >= 0 && to >= 0) {
        replaceKeys(
          toggleSelectionRange(
            keys,
            list.map((asset) => assetKey(asset)),
            anchor,
            key
          )
        );
        anchor = key;
        repaint();
        renderBar();
        return;
      }
    }
    replaceKeys(toggleSelectionKey(keys, key));
    anchor = key;
    repaint();
    renderBar();
  }

  return {
    isActive: () => active,
    isBusy: () => busy,
    keys,
    enter,
    exit,
    toggle,
    toggleAll,
    prune: (present) => {
      replaceKeys(
        pruneSelection(
          keys,
          present.map((asset) => assetKey(asset))
        )
      );
    },
    renderBar,
    dispose: () => {
      document.removeEventListener("click", onAway, true);
      document.body.classList.remove("has-selection");
      stopWidthObserver?.();
      stopWidthObserver = null;
    },
  };
}
