import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { apps } from "@centraid/design";

import AppMark from "./AppMark.js";

describe(AppMark, () => {
  const app = apps.find((entry) => entry.id === "photos") ?? apps[0];

  it("renders a single-tone app mark with the solved identity ink", () => {
    if (!app) throw new Error("design-tokens must ship built-in apps");
    const html = renderToStaticMarkup(
      <AppMark colorKey={app.colorKey} iconKey={app.iconKey} size={30} />
    );
    expect(html).toContain('data-app-mark="single-tone"');
    expect(html).toContain("--app-mark-hue:var(--c-amber)");
    expect(html).toContain("--app-mark-ink:var(--c-amber-text)");
    expect(html).toContain('stroke-width="1.6"');
    expect(html).toContain('fill="none"');
  });

  it("keeps a real stroke at the smallest mark size", () => {
    if (!app) throw new Error("design-tokens must ship built-in apps");
    const html = renderToStaticMarkup(
      <AppMark colorKey={app.colorKey} iconKey={app.iconKey} size={14} />
    );
    expect(html).toContain('stroke-width="1.75"');
  });
});
