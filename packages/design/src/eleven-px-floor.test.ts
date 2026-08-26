// The 11px floor (#708), enforced on emitted CSS and native lowering; sizes
// parsed OUT of the --t-<role> font shorthand.
import { describe, expect, test } from "vitest";

import { toCss } from "./css.js";
import { toNativeTheme } from "./native.js";
import { REM_BASE_PX, type } from "./typography.js";

const FLOOR = 11;

const remToPx = (rem: string): number => Number(rem) * REM_BASE_PX;

/** Sizes parsed from each `--t-<role>` font shorthand — never from
 *  `--t-<role>-size`, a different property. */
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

    // Zero parses checks nothing; a missing role means regex drift.
    expect(Object.keys(sizes).length).toBeGreaterThan(0);
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
