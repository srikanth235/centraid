import type { ReactNode } from "react";

// The lightbox's render orchestrator — same shape as toolbar.jsx/picker.tsx:
// a small private slice of state (which asset id is open, the render-seq
// PanelBody keys off) plus its one root. It lives outside app.tsx so that file
// does not grow unbounded as regions (search/slideshow/duplicates) land beside
// it; the pure view is components/Lightbox.tsx.
import { assetKey } from "./asset-key.ts";
import { LightboxShell } from "./components/Lightbox.tsx";
import { $ } from "./dom.ts";
import type { Album, Asset, Place } from "./types.ts";

type Root = { render: (node: ReactNode) => void };

/** What a key pressed over an OPEN lightbox means. Pure, and exported, because
 *  the interesting half of it is a refusal: while the editor is up, ←/→ mean
 *  NOTHING. See `viewerKeyAction`. */
export type ViewerKeyAction =
  | "cancel-edit"
  | "close"
  | "step-prev"
  | "step-next"
  | null;

/**
 * THE EDITOR IS A DECISION SURFACE, AND A DECISION SURFACE DOES NOT LOSE THE
 * DECISION TO AN ADJACENT KEYSTROKE (§7.4, proto 4627: nothing is written
 * until Save).
 *
 * The viewer beneath the editor steps with ←/→, and the editor is mounted per
 * asset (`key={asset.asset_id}` in Lightbox.tsx) — so a step while an edit is
 * in progress silently throws away the member's crop and rotation, with no
 * prompt and nothing written anywhere. Hence: while editing, the arrows mean
 * nothing at all, and Escape CANCELS THE EDIT rather than closing the whole
 * viewer. Escape from the viewer itself still closes it — one Escape, one
 * layer, innermost first.
 */
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
  // The COMPOSITE key of the open row (asset-key.ts), non-null while open. A
  // bare `asset_id` would be ambiguous across scopes (#599).
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
  //
  // THE VIEWER KEEPS THE PHOTOGRAPH YOU STOPPED ON (§7.3). The slideshow's
  // status line promises exactly that, so the run reports where it stopped and
  // the viewer reopens there — not back at the photograph the run began on,
  // and not closed.
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

  // IS THE EDITOR UP? Asked of the DOM, not of a mirrored flag: `editing` is
  // LightboxShell's own state (components/Lightbox.tsx), and a second copy of
  // it here is a second thing that can be wrong. The editor marks its own root
  // (`data-editor="open"`, Editor.tsx) exactly so this question has one honest
  // answer, the same way the Tab trap below reads the live subtree rather than
  // a remembered focus list.
  const editorEl = (): HTMLElement | null =>
    $("lightbox").querySelector<HTMLElement>('[data-editor="open"]');

  return {
    openLightbox,
    closeLightbox,
    step,
    startSlideshow,
    isEditing: () => editorEl() !== null,
    /**
     * Cancel an edit in progress, returning to the viewer with the photograph
     * still open. Fired through the editor's OWN Cancel button rather than a
     * callback threaded down: the button is the one place that knows what
     * cancelling means (it is `onCancel` — Lightbox.tsx's `setEditing(false)`),
     * and going through it means the key and the click can never diverge.
     * Answers whether it did anything, so a caller can fall through.
     */
    cancelEdit: (): boolean => {
      const button = editorEl()?.querySelector<HTMLButtonElement>(
        "[data-editor-cancel]"
      );
      // A busy editor (a Save in flight) has a disabled Cancel — nothing is
      // cancelled, and nothing else happens either: the keystroke is spent.
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
