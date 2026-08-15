import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The hand-authored stylesheet the element layer renders against
// (`@centraid/design/kit.css`, loaded once by the shell route host). Read by
// path rather than imported: this is a Node suite over the sheet's text, and
// nothing in the token layer may pull a stylesheet into its module graph.
const KIT_CSS = readFileSync(
  path.resolve(import.meta.dirname, "elements/kit.css"),
  "utf8"
);

describe("element stylesheet contract", () => {
  it("keeps body-mounted overlays hidden and scoped to the v0 contract", () => {
    expect(KIT_CSS).not.toContain("COMPAT(product-grammar-legacy-app-css)");
    expect(KIT_CSS).toContain(":where(body > .kit-ask-ov[hidden])");
    expect(KIT_CSS).toContain(":where(body > .kit-popover[hidden])");
    expect(KIT_CSS).toContain(":where(.kit-ask-model-menu[hidden])");
    expect(KIT_CSS).toContain("data-kit-appearance-control");
    expect(KIT_CSS).not.toContain('button[aria-label="Theme"]');
  });

  it("keeps generic hover from repainting the primary and destructive variants", () => {
    expect(KIT_CSS).toMatch(
      /\.kit-btn:hover[^{]*:not\(\.primary\):not\(\.destructive\)/u
    );
    // `prefers-reduced-motion` is honoured in ONE global rule (toCss()'s
    // emitted sheet, packages/design/src/css.ts) — kit.css itself declares no
    // per-component `@media` copy of its own (issue #708 §"One motion and
    // feedback grammar"). Explanatory comments in kit.css mention the term in
    // prose, so this checks for a live media rule, not the bare substring.
    expect(KIT_CSS).not.toContain("@media (prefers-reduced-motion");
    expect(KIT_CSS).toContain(".kit-btn:focus-visible");
  });

  it("retires the destructiveFilled variant — destructive is outlined, never filled", () => {
    expect(KIT_CSS).not.toContain("destructiveFilled");
    expect(KIT_CSS).not.toContain(".kit-btn.primary.danger");
  });

  it("replaces the toast stack with one persistent status line", () => {
    expect(KIT_CSS).not.toContain(".kit-toasts");
    expect(KIT_CSS).not.toMatch(/\.kit-toast\b/u);
    expect(KIT_CSS).toContain(".kit-status-line {");
    expect(KIT_CSS).toContain(".kit-status-line-track");
    expect(KIT_CSS).toContain(".kit-status-line-fill");
    // Loading is determinate-only with static skeletons — no shimmer sweep.
    expect(KIT_CSS).not.toContain("kit-sweep");
  });
});
