// The focus ring on a filled-ink control (#708).
//
// How the ring is actually drawn (packages/design/src/elements/kit.css, e.g. line
// ~334-337, and `themeProps()` in css.ts):
//
//   --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring-color);
//
// That's a DOUBLE box-shadow, not a single ring drawn flush against the
// control: the inner 2px band is `--bg` (the page), and only the OUTER 4px
// band is `--focus-ring-color`. Radially, from a focused element's own edge
// outward, the sequence is:
//
//   [control fill] — 2px --bg (the offset gap) — 4px ring colour — [page]
//
// So the ring colour is never actually adjacent to the control's fill — it
// is always bordered by `--bg` on both sides. shared.ts's own comment
// ("Separate from LINK so a focused filled-ink button gets a ring that is
// visible against black") describes the INTENT — visible against a filled
// ink button — but the offset technique is what MAKES that possible: light
// mode's filled-ink fill (`#141414`) and dark mode's inverted fill
// (`#EDEDEC`) sit at opposite luminance extremes from the two themes' own
// `--bg`, and a single ring colour cannot clear 3:1 against both a near-black
// AND a near-white surface at once (this is provable: dark mode's fill vs.
// bg alone spans ~190:1 already). The gap is the only way to make "visible
// against a filled ink control" true in both themes, so THIS is the real
// pair to measure, not a naive ring-vs-fill guess:
//
//   1. ring vs. gap (`--bg`)   — is the ring itself visible against what it
//                                is actually drawn next to?
//   2. gap (`--bg`) vs. fill   — is the gap band distinguishable from the
//                                control, so the ring assembly doesn't read
//                                as touching the button?
//
// Both legs have to clear WCAG 1.4.11's 3:1 floor for non-text UI, in both
// themes, for the ring to read as "visible against a filled ink button".
import { describe, expect, test } from "vitest";

import { contrastRatio } from "./color.js";
import { toNativeTheme } from "./native.js";
import { darkTheme, lightTheme } from "./themes/index.js";

const AA_LARGE = 3;

describe("the focus ring is visible against a filled ink control", () => {
  test.each([
    ["light", lightTheme],
    ["dark", darkTheme],
  ] as const)("%s", (_name, theme) => {
    const ring = theme.ring;
    const gap = theme.bg; // --focus-ring's inner 2px band
    const fill = theme.accentDeep; // --accent-fill, the filled-ink control

    const ringVsGap = contrastRatio(ring, gap);
    const gapVsFill = contrastRatio(gap, fill);

    expect(ringVsGap, "ring vs. its offset gap (--bg)").toBeGreaterThanOrEqual(
      AA_LARGE
    );
    expect(
      gapVsFill,
      "the offset gap (--bg) vs. the filled-ink control"
    ).toBeGreaterThanOrEqual(AA_LARGE);
  });

  test.each(["light", "dark"] as const)(
    "%s — the same pair holds off the native lowering",
    (scheme) => {
      const native = toNativeTheme(scheme);
      const ringVsGap = contrastRatio(
        native.colors.focusRingColor,
        native.colors.bg
      );
      const gapVsFill = contrastRatio(
        native.colors.bg,
        native.colors.accentFill
      );
      expect(ringVsGap, "native ring vs. bg").toBeGreaterThanOrEqual(AA_LARGE);
      expect(gapVsFill, "native bg vs. accentFill").toBeGreaterThanOrEqual(
        AA_LARGE
      );
    }
  );
});
