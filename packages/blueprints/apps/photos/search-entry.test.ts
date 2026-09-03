import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { appBar } from "./frame.tsx";
import type { AppBarState } from "./frame.tsx";

function state(extra: Partial<AppBarState> = {}): AppBarState {
  return {
    title: "Photos",
    count: 12,
    showSelect: true,
    selectMode: false,
    onToggleSelect: () => {},
    showImport: true,
    onImport: () => {},
    compact: false,
    ...extra,
  };
}

function render(s: AppBarState): string {
  const contribution = appBar(s);
  return renderToStaticMarkup(createElement("div", null, contribution.actions));
}

describe("the bar's own way to Search (§9)", () => {
  it("renders an outlined Search control on desktop/PWA when reachable", () => {
    const html = render(state({ onSearch: () => {} }));
    expect(html).toContain('aria-label="Search"');
    expect(html).not.toContain('aria-label="Search" class="kit-btn primary"');
  });

  it("is unreachable — the desktop entry regresses to nothing — once the callback is dropped", () => {
    const html = render(state({ onSearch: undefined }));
    expect(html).not.toContain('aria-label="Search"');
  });

  it("stands down on the compact form factor — the band already claims Search", () => {
    const html = render(state({ onSearch: () => {}, compact: true }));
    expect(html).not.toContain('aria-label="Search"');
  });
});
