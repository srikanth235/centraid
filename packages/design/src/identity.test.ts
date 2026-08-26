// Shared person-identity derivation (#708): hue stable per person everywhere;
// the circle's inverse ink clears AA in BOTH themes.

import { describe, expect, test } from "vitest";

import { contrastRatio } from "./color";
import { IDENTITY_HUE_KEYS, identityFill, identityHueKey } from "./identity";
import { APP_HUES, paletteFor } from "./palette";
import { darkTheme, lightTheme } from "./themes";

/** WCAG AA for the 13px initials a face circle carries. */
const AA = 4.5;

describe(identityHueKey, () => {
  test("every key is a real point on the shipped hue wheel", () => {
    for (const key of IDENTITY_HUE_KEYS) expect(APP_HUES).toHaveProperty(key);
    // The BRAND ink default is deliberately absent (see identity.ts).
    expect([...IDENTITY_HUE_KEYS].sort()).toStrictEqual(
      Object.keys(APP_HUES).sort()
    );
  });

  test("the same id derives the same hue on every call", () => {
    const id = "party_01HQ7Z0000000000000000000";
    const first = identityHueKey(id);
    for (let i = 0; i < 50; i += 1) expect(identityHueKey(id)).toBe(first);
  });

  test("different people generally land on different hues", () => {
    const keys = new Set(
      Array.from({ length: 40 }, (_, i) => identityHueKey(`party_${i}`))
    );
    // One bucket for everybody is the failure this guards.
    expect(keys.size).toBeGreaterThan(4);
  });

  test("an id is not its display name — renaming cannot move the circle", () => {
    expect(identityHueKey("party_ana")).toBe(identityHueKey("party_ana"));
    expect(identityHueKey("Ana Ruiz")).not.toBe(identityHueKey("party_ana"));
  });

  test("surrounding whitespace does not change the answer", () => {
    expect(identityHueKey("  party_ana \n")).toBe(identityHueKey("party_ana"));
  });

  test("an empty id still yields a hue, never a hole", () => {
    expect(IDENTITY_HUE_KEYS).toContain(identityHueKey(""));
  });
});

describe(identityFill, () => {
  test("resolves the key on the ring the theme actually paints", () => {
    for (const scheme of ["light", "dark"] as const) {
      const id = "party_01HQ7Z0000000000000000000";
      expect(identityFill(id, scheme)).toBe(
        paletteFor(scheme)[identityHueKey(id)]
      );
    }
  });

  test("carries `textInv` at AA in both themes", () => {
    // The `--c-*` ring, NOT the solved `--c-*-text` rung.
    for (const [theme, scheme] of [
      [lightTheme, "light"],
      [darkTheme, "dark"],
    ] as const) {
      for (const key of IDENTITY_HUE_KEYS) {
        const ratio = contrastRatio(theme.textInv, paletteFor(scheme)[key]);
        expect(
          ratio,
          `${scheme}/${key} initials on the face circle`
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });
});
