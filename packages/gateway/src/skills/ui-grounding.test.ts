// UI grounding blocks for builder turns (issue #545 B7).

import { describe, expect, test } from "vitest";

import { buildUiGroundingBlocks } from "./ui-grounding.js";

describe("ui-grounding", () => {
  test("buildUiGroundingBlocks returns the five design-system sections", () => {
    const blocks = buildUiGroundingBlocks();
    expect(blocks).toHaveLength(5);
    const titles = blocks.map((b) => b.split("\n")[0]);
    expect(titles).toStrictEqual([
      "### Design tokens (use these — do not invent colors or sizes)",
      "### Icon set",
      "### Component primitives — one vocabulary: `.kit-*`",
      "### UI/UX rules (non-negotiable)",
      "### Reference implementation",
    ]);
    const joined = blocks.join("\n\n");
    // Token CSS is inlined so the agent sees the live contract.
    expect(joined).toContain("--accent");
    expect(joined).toContain("```css");
  });

  // #686 A3/A4: one component vocabulary, and sizes come off the contract.
  test("grounds the kit vocabulary and the spacing scale", () => {
    const joined = buildUiGroundingBlocks().join("\n\n");
    for (const kitClass of [
      ".kit-btn",
      ".kit-input",
      ".kit-icon-btn",
      ".kit-muted",
      ".kit-empty",
      ".kit-banner",
    ]) {
      expect(joined, kitClass).toContain(kitClass);
    }
    // The retired parallel vocabulary must not be taught anymore.
    for (const retired of ['class="primary"', 'class="ghost"', 'class="del"']) {
      expect(joined, retired).not.toContain(retired);
    }
    expect(joined).toContain("var(--sp-1)");
    // The cascade trap must stay accurate: app.css loads first, so an
    // equal-specificity override of a kit class loses.
    expect(joined).toContain("loads `app.css` **before** `kit.css`");
  });

  test("buildUiGroundingBlocks is pure — identical successive calls", () => {
    expect(buildUiGroundingBlocks()).toStrictEqual(buildUiGroundingBlocks());
  });
});
