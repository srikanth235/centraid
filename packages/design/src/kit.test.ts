import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { KIT_DIR } from "./kit.js";

const KIT_CSS = readFileSync(path.join(KIT_DIR, "kit.css"), "utf8");

describe("design kit seam", () => {
  it("exports an absolute path to the on-disk kit layer", () => {
    expect(path.isAbsolute(KIT_DIR)).toBe(true);
    expect(path.basename(KIT_DIR)).toBe("kit");
    expect(existsSync(path.join(KIT_DIR, "kit.ts"))).toBe(true);
    expect(existsSync(path.join(KIT_DIR, "kit.css"))).toBe(true);
    expect(existsSync(path.join(KIT_DIR, "conversation-client.js"))).toBe(true);
  });

  it("keeps body-mounted overlays hidden and scoped to the v0 contract", () => {
    expect(KIT_CSS).not.toContain("COMPAT(product-grammar-legacy-app-css)");
    expect(KIT_CSS).toContain(":where(body > .kit-ask-ov[hidden])");
    expect(KIT_CSS).toContain(":where(body > .kit-popover[hidden])");
    expect(KIT_CSS).toContain(":where(.kit-ask-model-menu[hidden])");
    expect(KIT_CSS).toContain("data-kit-appearance-control");
    expect(KIT_CSS).not.toContain('button[aria-label="Theme"]');
  });

  it("keeps generic hover from repainting destructive fills", () => {
    expect(KIT_CSS).toMatch(/\.kit-btn:hover[^{]*:not\(\.destructiveFilled\)/u);
    expect(KIT_CSS).toContain(
      '.kit-btn[data-variant="destructiveFilled"]:hover:not(:disabled)'
    );
    expect(KIT_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(KIT_CSS).toContain(".kit-btn:focus-visible");
  });
});
