import type { ReactNode } from "react";

import { assetKey } from "./asset-key.ts";
import { LightboxShell } from "./components/Lightbox.tsx";
import { $ } from "./dom.ts";
import type { Album, Asset, Place } from "./types.ts";

type Root = { render: (node: ReactNode) => void };

export type ViewerKeyAction =
  | "cancel-edit"
  | "close"
  | "step-prev"
  | "step-next"
  | null;

export function viewerKeyAction(
  key: string,
  editing: boolean
): ViewerKeyAction {
  if (editing) return key === "Escape" ? "cancel-edit" : null;
  if (key === "Escape") return "close";
  if (key === "ArrowLeft") return "step-prev";
  if (key === "ArrowRight") return "step-next";
  return null;
}

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
    openSlideshow: (
      list: Asset[],
      startAssetId: string | null,
      onStopped?: (stoppedOn: Asset | null) => void
    ) => void;
  };
}) {
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

  function startSlideshow(id: string | null) {
    const list = visibleAssets();
    const wasOpen = openKey != null;
    closeLightbox();
    slideshow.openSlideshow(list, id ?? null, (stoppedOn) => {
      if (!wasOpen || !stoppedOn) return;
      openLightbox(assetKey(stoppedOn));
    });
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

  const editorEl = (): HTMLElement | null =>
    $("lightbox").querySelector<HTMLElement>('[data-editor="open"]');

  return {
    openLightbox,
    closeLightbox,
    step,
    startSlideshow,
    isEditing: () => editorEl() !== null,
    cancelEdit: (): boolean => {
      const button = editorEl()?.querySelector<HTMLButtonElement>(
        "[data-editor-cancel]"
      );
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    isOpen: () => openKey != null,
    renderIfOpen: () => {
      if (openKey != null) renderLightbox();
    },
  };
}
