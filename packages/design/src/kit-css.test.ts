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
    expect(KIT_CSS).toContain(":where(body > .kit-popover[hidden])");
    expect(KIT_CSS).toContain("data-kit-appearance-control");
    expect(KIT_CSS).not.toContain('button[aria-label="Theme"]');
  });

  it("styles only the Ask surface that still exists", () => {
    // There is no served assistant plane (#799). The inline panel
    // (`packages/client/src/react/blueprints/kit-ask-inline.ts`) is the only
    // Ask surface kit.css dresses, and it emits exactly these classes — there
    // is no overlay, model picker, history drawer, suggestion chip or
    // proposed-action card, so the sheet must not carry rules for them.
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
    // #799 deleted the last four `kit-*` custom elements and the `KitElement`
    // base, so their `display: contents` host neutralisers styled tags
    // nothing constructs any more.
    for (const tag of [
      "kit-avatar,",
      "kit-meter,",
      "kit-skeleton,",
      "kit-status-line,",
    ]) {
      expect(KIT_CSS, tag).not.toContain(tag);
    }
    // `[data-kit-host]` survives them, but only as a marker an app sets by
    // hand (Locker's overlay layer) — nothing stamps it at runtime.
    expect(KIT_CSS).toContain("[data-kit-host] {");
    // The classes those elements rendered INTO survive — React blocks and
    // `feedback.ts` emit them directly now.
    expect(KIT_CSS).toContain(".kit-avatar {");
    expect(KIT_CSS).toContain(".kit-bar-fill {");
    expect(KIT_CSS).toContain(".kit-skeleton {");
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
