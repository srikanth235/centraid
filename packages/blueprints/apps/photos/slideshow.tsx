import type { ReactNode } from "react";

import { SlideshowView } from "./components/Slideshow.tsx";
import { $ } from "./dom.ts";
import type { Asset } from "./types.ts";

type Root = { render: (node: ReactNode) => void };

export function createSlideshow({ slideshowRoot }: { slideshowRoot: Root }) {
  let open = false;

  function closeSlideshow() {
    if (!open) return;
    open = false;
    $("slideshow").hidden = true;
    slideshowRoot.render(null);
  }

  function openSlideshow(
    list: Asset[],
    startAssetId: string | null,
    onStopped?: (stoppedOn: Asset | null) => void
  ) {
    open = true;
    $("slideshow").hidden = false;
    slideshowRoot.render(
      <SlideshowView
        list={list}
        startAssetId={startAssetId ?? null}
        onClose={(stoppedOn) => {
          closeSlideshow();
          onStopped?.(stoppedOn);
        }}
      />
    );
  }

  $("slideshow").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSlideshow();
  });

  return { openSlideshow, closeSlideshow, isOpen: () => open };
}
