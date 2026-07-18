// Full-screen slideshow (issue #352 phase 3): its own tiny render
// orchestrator, same shape as picker.tsx/toolbar.jsx — a small private slice
// of state (whether it's open) plus one root. Read-only viewing, so unlike
// the lightbox it never needs to re-render on refresh(): once open, it owns
// its own auto-advance/pause/step state entirely inside
// components/Slideshow.tsx (React state, not app.tsx module state).
import { SlideshowView } from './components/Slideshow.tsx';
import { $ } from './dom.ts';
import type { ReactNode } from './react-core.min.js';
import type { Asset } from './types.ts';

type Root = { render: (node: ReactNode) => void };

export function createSlideshow({ slideshowRoot }: { slideshowRoot: Root }) {
  let open = false;

  function closeSlideshow() {
    if (!open) return;
    open = false;
    $('slideshow').hidden = true;
    slideshowRoot.render(null);
  }

  // `list` is the caller's current visibleAssets() snapshot — the slideshow
  // walks the same photos the grid/lightbox were just showing, in the same
  // order. `startAssetId` seeds where it opens; null starts at the first
  // photo (the toolbar entry point has no "current" asset).
  function openSlideshow(list: Asset[], startAssetId: string | null) {
    open = true;
    $('slideshow').hidden = false;
    slideshowRoot.render(
      <SlideshowView list={list} startAssetId={startAssetId ?? null} onClose={closeSlideshow} />,
    );
  }

  // Same backdrop-click-only-closes contract as the lightbox/picker (see
  // their identical comments): a raw listener on this React root's own
  // container node fires before React's synthetic dispatch, so it must gate
  // on `e.target === e.currentTarget` to avoid eating clicks meant for the
  // nav buttons underneath.
  $('slideshow').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSlideshow();
  });

  return { openSlideshow, closeSlideshow, isOpen: () => open };
}
