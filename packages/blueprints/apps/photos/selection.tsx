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
  keys: Set<string>;
  enter: () => void;
  exit: () => void;
  toggle: (key: string, shiftKey?: boolean) => void;
  toggleAll: () => void;
  prune: (present: readonly Asset[]) => void;
  renderBar: () => void;
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
  selectionBarRoot: Root;
  bottomBarRoot?: Root;
  getVisible: () => Asset[];
  getAlbums: () => Album[];
  refresh: () => Promise<void>;
  repaint: () => void;
  getShelfKind?: () => SelectionShelfKind;
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

  function pickAlbum(album: Album): void {
    closeMenu();
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

  function renderBar(): void {
    if (!active) return;
    if (narrow()) {
      selectionBarRoot.render(null);
      bottomBarRoot?.render(
        <>
          {/* First in document order so the sheet pops UP off the row. */}
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
