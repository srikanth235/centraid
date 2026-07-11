// The lightbox's render orchestrator — same shape as toolbar.jsx/picker.jsx:
// a small private slice of state (which asset id is open, the render-seq
// PanelBody keys off) plus its one root. Pulled out of app.jsx to keep that
// file from growing unbounded as issue #352 adds regions (search/slideshow/
// duplicates) alongside it; the pure view still lives in
// components/Lightbox.jsx.
import { LightboxShell } from './components/Lightbox.jsx';
import { $ } from './dom.js';

export function createLightbox({
  lightboxRoot,
  findAsset,
  visibleAssets,
  getAlbums,
  getPlaces,
  refresh,
  slideshow,
}) {
  let assetId = null; // non-null while the lightbox is open
  let renderSeq = 0;

  function closeLightbox() {
    assetId = null;
    const box = $('lightbox');
    box.hidden = true;
    lightboxRoot.render(null);
  }

  function openLightbox(id) {
    assetId = id;
    renderLightbox();
  }

  function step(delta) {
    const list = visibleAssets();
    const idx = list.findIndex((a) => a.asset_id === assetId);
    const next = idx < 0 ? undefined : list[idx + delta];
    if (!next) return;
    assetId = next.asset_id;
    renderLightbox();
  }

  // Closes the lightbox (same full-screen real estate, only one at a time)
  // and hands the slideshow the CURRENT visibleAssets() — the same
  // list/order the grid and lightbox were just showing (search/album/
  // favorites scoping included).
  function startSlideshow(id) {
    const list = visibleAssets();
    closeLightbox();
    slideshow.openSlideshow(list, id ?? null);
  }

  function renderLightbox() {
    const box = $('lightbox');
    const asset = findAsset(assetId);
    if (!asset) {
      closeLightbox();
      return;
    }
    renderSeq += 1;
    const list = visibleAssets();
    const idx = list.findIndex((a) => a.asset_id === asset.asset_id);
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
      />,
    );
    box.hidden = false;
  }

  // A plain native listener directly on `#lightbox` (which doubles as this
  // region's React root container) — `e.stopPropagation()` inside a nested
  // component's onClick handler cannot save us here: React's own delegated
  // listener lives on this SAME node and is registered *after* this one (at
  // `createRoot()` time, in app.jsx's Boot), so a raw `addEventListener` here
  // would otherwise always fire first and close the box before React's
  // synthetic dispatch (and its stopPropagation calls) ever run — breaking
  // every click inside the lightbox (nav arrows, favorite, caption, chips…),
  // not just genuine backdrop clicks. Gating on `e.target === e.currentTarget`
  // sidesteps the race entirely: only a click that lands on the backdrop
  // itself (never on a descendant) closes it, regardless of listener order.
  $('lightbox').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLightbox();
  });

  return {
    openLightbox,
    closeLightbox,
    step,
    startSlideshow,
    isOpen: () => assetId != null,
    renderIfOpen: () => {
      if (assetId != null) renderLightbox();
    },
  };
}
