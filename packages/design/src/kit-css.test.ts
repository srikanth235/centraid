import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const KIT_CSS = readFileSync(
  path.resolve(import.meta.dirname, "elements/kit.css"),
  "utf8"
);

describe("element stylesheet contract", () => {
  it("keeps body-mounted overlays hidden and scoped to the v0 contract", () => {
    expect(KIT_CSS).not.toContain("COMPAT(product-grammar-legacy-app-css)");
    expect(KIT_CSS).toContain(":where(body > .kit-popover[hidden])");
    expect(KIT_CSS).toContain("data-kit-appearance-control");
    expect(KIT_CSS).not.toContain('button[aria-label="Theme"]');
  });

  it("styles only the Ask surface that still exists", () => {
    for (const live of [
      ".kit-ask-btn",
      ".kit-ask-panel",
      ".kit-ask-log",
      ".kit-ask-q",
      ".kit-ask-a",
      ".kit-ask-err",
      ".kit-ask-note",
      ".kit-ask-compose",
      ".kit-ask-input",
      ".kit-ask-send",
    ]) {
      expect(KIT_CSS, live).toContain(live);
    }
    for (const retired of [
      ".kit-ask-ov",
      ".kit-ask-model",
      ".kit-ask-history",
      ".kit-ask-chip",
      ".kit-ask-action",
      ".kit-ask-head",
      ".kit-ask-attach",
      ".kit-ask-pending",
      ".kit-aa-",
      ".kit-msg",
    ]) {
      expect(KIT_CSS, retired).not.toContain(retired);
    }
  });

  it("carries no custom-element host rules — the elements are gone", () => {
    for (const tag of [
      "kit-avatar,",
      "kit-meter,",
      "kit-skeleton,",
      "kit-status-line,",
    ]) {
      expect(KIT_CSS, tag).not.toContain(tag);
    }
    expect(KIT_CSS).toContain("[data-kit-host] {");
    expect(KIT_CSS).toContain(".kit-avatar {");
    expect(KIT_CSS).toContain(".kit-bar-fill {");
    expect(KIT_CSS).toContain(".kit-skeleton {");
  });

  it("keeps generic hover from repainting the primary and destructive variants", () => {
    expect(KIT_CSS).toMatch(
      /\.kit-btn:hover[^{]*:not\(\.primary\):not\(\.destructive\)/u
    );
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
    expect(KIT_CSS).not.toContain("kit-sweep");
  });
});
