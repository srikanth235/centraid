import type { ReactNode } from "react";

// The lightbox's render orchestrator — same shape as toolbar.jsx/picker.tsx:
// a small private slice of state (which asset id is open, the render-seq
// PanelBody keys off) plus its one root. Pulled out of app.tsx to keep that
// file from growing unbounded as issue #352 adds regions (search/slideshow/
// duplicates) alongside it; the pure view still lives in
// components/Lightbox.tsx.
import { assetKey } from "./asset-key.ts";
import { LightboxShell } from "./components/Lightbox.tsx";
import { $ } from "./dom.ts";
import type { Album, Asset, Place } from "./types.ts";

type Root = { render: (node: ReactNode) => void };

export function createLightbox({
  lightboxRoot,
  findAsset,
  visibleAssets,
  getAlbums,
  getPlaces,
  refresh,
  slideshow,
}: {
  lightboxRoot: Root;
  findAsset: (key: string) => Asset | undefined;
  visibleAssets: () => Asset[];
  getAlbums: () => Album[];
  getPlaces: () => Place[];
  refresh: () => Promise<void>;
  slideshow: {
    openSlideshow: (list: Asset[], startAssetId: string | null) => void;
  };
}) {
  // The COMPOSITE key of the open row (asset-key.ts), non-null while open. A
  // bare `asset_id` would be ambiguous across scopes (issue #599).
  let openKey: string | null = null;
  let renderSeq = 0;
  let priorFocus: HTMLElement | null = null;

  function closeLightbox() {
    openKey = null;
    const box = $("lightbox");
    box.hidden = true;
    lightboxRoot.render(null);
    priorFocus?.focus();
    priorFocus = null;
  }

  function openLightbox(key: string) {
    if (openKey == null) {
      priorFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    openKey = key;
    renderLightbox();
  }

  function step(delta: number) {
    const list = visibleAssets();
    const idx = list.findIndex((a) => assetKey(a) === openKey);
    const next = idx < 0 ? undefined : list[idx + delta];
    if (!next) return;
    openKey = assetKey(next);
    renderLightbox();
  }

  // Closes the lightbox (same full-screen real estate, only one at a time)
  // and hands the slideshow the CURRENT visibleAssets() — the same
  // list/order the grid and lightbox were just showing (search/album/
  // favorites scoping included).
  function startSlideshow(id: string | null) {
    const list = visibleAssets();
    closeLightbox();
    slideshow.openSlideshow(list, id ?? null);
  }

  function renderLightbox() {
    const box = $("lightbox");
    if (openKey == null) {
      closeLightbox();
      return;
    }
    const asset = findAsset(openKey);
    if (!asset) {
      closeLightbox();
      return;
    }
    renderSeq += 1;
    const list = visibleAssets();
    const idx = list.findIndex((a) => assetKey(a) === assetKey(asset));
    lightboxRoot.render(
      <LightboxShell
        asset={asset}
        idx={idx}
        list={list}
        albums={getAlbums()}
        places={getPlaces()}
        renderSeq={renderSeq}
        onStep={step}
        refresh={refresh}
        onClose={closeLightbox}
        onSlideshow={() => startSlideshow(asset.asset_id)}
      />
    );
    box.hidden = false;
    queueMicrotask(() => {
      box.querySelector<HTMLElement>('button[aria-label="Close"]')?.focus();
    });
  }

  // A plain native listener directly on `#lightbox` (which doubles as this
  // region's React root container) — `e.stopPropagation()` inside a nested
  // component's onClick handler cannot save us here: React's own delegated
  // listener lives on this SAME node and is registered *after* this one (at
  // `createRoot()` time, in app.tsx's Boot), so a raw `addEventListener` here
  // would otherwise always fire first and close the box before React's
  // synthetic dispatch (and its stopPropagation calls) ever run — breaking
  // every click inside the lightbox (nav arrows, favorite, caption, chips…),
  // not just genuine backdrop clicks. Gating on `e.target === e.currentTarget`
  // sidesteps the race entirely: only a click that lands on the backdrop
  // itself (never on a descendant) closes it, regardless of listener order.
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeLightbox();
  });
  $("lightbox").addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [
      ...$("lightbox").querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ),
    ].filter((element) => !element.hidden);
    if (focusable.length === 0) {
      event.preventDefault();
      $("lightbox").focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (
      (event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last)
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  });

  return {
    openLightbox,
    closeLightbox,
    step,
    startSlideshow,
    isOpen: () => openKey != null,
    renderIfOpen: () => {
      if (openKey != null) renderLightbox();
    },
  };
}
