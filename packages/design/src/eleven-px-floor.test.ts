// The 11px floor (#708) — the ramp's own header in typography.ts
// says it plainly: "Nothing falls below 11px." This test is what enforces
// that promise on the two things an app actually reads: the emitted CSS
// (`toCss()`) and the native lowering (`toNativeTheme()`), not the source
// object a future edit could bypass.
//
// `--t-<role>` is a font SHORTHAND (`500 0.8125rem/1.1875rem var(--font-sans)`
// as of #708's rem conversion — "Emit `rem`, not `px`, so 200% OS text scale
// works"), not a bare size — the floor has to be parsed OUT of it, the same
// way a browser would, rather than assumed from the separate
// `--t-<role>-size` rung that happens to sit next to it in the sheet. Both
// halves are converted rem→px (×16, the root this repo never overrides — see
// `REM_BASE_PX` in typography.ts) so the floor this test enforces is a REAL
// 11px, not an 0.6875rem that would silently shrink under a smaller root.
import { describe, expect, test } from "vitest";

import { toCss } from "./css.js";
import { toNativeTheme } from "./native.js";
import { REM_BASE_PX, type } from "./typography.js";

const FLOOR = 11;

/** `rem` is the bare numeric string from the CSS (e.g. `"0.8125"`), not `"0.8125rem"`. */
const remToPx = (rem: string): number => Number(rem) * REM_BASE_PX;

/** Pull every `--t-<role>: <weight> <size>rem/<lineHeight>rem var(...);`
 *  declaration's size out of the `font` shorthand — deliberately NOT reading
 *  `--t-<role>-size`, which is a different (deduplicated) property this test
 *  must not depend on to prove the shorthand itself is correct. Converts
 *  rem→px so the FLOOR constant stays a real pixel value. */
function shorthandSizesFromCss(css: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  const re =
    /--t-(?<role>[a-z-]+):\s*\d+\s+(?<size>[\d.]+)rem\/[\d.]+rem\s+var\(--font-[a-z]+\);/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    const role = match.groups?.role;
    const size = match.groups?.size;
    if (!role || !size) continue;
    sizes[role] = remToPx(size);
  }
  return sizes;
}

describe("the 11px floor", () => {
  test("every --t-<role> shorthand in the emitted CSS carries a size >= 11px", () => {
    const css = toCss();
    const sizes = shorthandSizesFromCss(css);

    // Silent-no-op guard: a floor test that parsed zero roles is a floor
    // test that is checking nothing.
    expect(Object.keys(sizes).length).toBeGreaterThan(0);
    // Every role this package declares must show up in the parsed set —
    // otherwise the regex above has drifted from the shorthand's real shape
    // and the floor below is silently checking a partial list.
    for (const key of Object.keys(type)) {
      const role = key
        .replace(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
        .toLowerCase();
      expect(sizes, `--t-${role} parsed from the shorthand`).toHaveProperty(
        role
      );
    }

    for (const [role, size] of Object.entries(sizes)) {
      expect(size, `--t-${role} (${size}px)`).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  test("every --t-<role>-size rung in the emitted CSS is >= 11px", () => {
    const css = toCss();
    const re = /--t-(?<role>[a-z-]+)-size:\s*(?<size>[\d.]+)rem;/gu;
    const sizes: Record<string, number> = {};
    let match: RegExpExecArray | null;
    while ((match = re.exec(css))) {
      const role = match.groups?.role;
      const size = match.groups?.size;
      if (!role || !size) continue;
      sizes[role] = remToPx(size);
    }
    expect(Object.keys(sizes).length).toBeGreaterThan(0);
    for (const [role, size] of Object.entries(sizes)) {
      expect(size, `--t-${role}-size (${size}px)`).toBeGreaterThanOrEqual(
        FLOOR
      );
    }
  });

  test.each(["light", "dark"] as const)(
    "every role in toNativeTheme(%s).type is >= 11px",
    (scheme) => {
      const native = toNativeTheme(scheme);
      const roles = Object.keys(native.type);
      expect(roles.length).toBeGreaterThan(0);
      for (const role of roles) {
        const style = native.type[role as keyof typeof native.type];
        expect(
          style.fontSize,
          `native ${role} (${style.fontSize}px)`
        ).toBeGreaterThanOrEqual(FLOOR);
      }
    }
  );
});
