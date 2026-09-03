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
