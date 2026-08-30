// Shared person-identity derivation (#708): a stable hue per person, inverse
// ink clearing AA in BOTH themes.

import { describe, expect, test } from "vitest";

import { contrastRatio } from "./color";
import {
  IDENTITY_COLORS,
  IDENTITY_HUE_KEYS,
  identityColor,
  identityFill,
  identityHueKey,
  partyHueKey,
  partyHueValue,
} from "./identity";
import { APP_HUES, paletteFor } from "./palette";
import { darkTheme, lightTheme } from "./themes";

/** WCAG AA for the 13px initials in a circle. */
const AA = 4.5;

describe(identityHueKey, () => {
  test("every key is a real point on the shipped hue wheel", () => {
    for (const key of IDENTITY_HUE_KEYS) expect(APP_HUES).toHaveProperty(key);
    // The BRAND ink default is deliberately absent.
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
    // The `--c-*` ring, not the `-text` rung.
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

describe(partyHueKey, () => {
  // ONE HUE PER PARTY (O-identity): the person and VAULT wheels are one hash
  // under different moduli, so the wrong one moves the person — and its extra
  // place can draw them as a black disc.
  const PARTIES = [
    "01JQ7Z0000000000000000000A",
    "01JQ7Z0000000000000000000B",
    "priya",
    "sam-nair",
    "",
  ];

  test("keys off the stable id, so a rename never moves anyone", () => {
    for (const id of PARTIES) expect(partyHueKey(id)).toBe(identityHueKey(id));
  });

  test("never lands on the ink brand — a person is not a black disc", () => {
    for (const id of PARTIES) {
      const key = partyHueKey(id);
      expect(key).not.toBeNull();
      expect(IDENTITY_HUE_KEYS).toContain(key);
    }
  });

  test("the vault wheel is a DIFFERENT question and stays different", () => {
    // Not to be unified: `identityColor` colours a vault, which is allowed
    // the ink default.
    expect(IDENTITY_COLORS).not.toHaveLength(IDENTITY_HUE_KEYS.length);
    expect(IDENTITY_COLORS).toContain(identityColor("any-vault", "brand"));
  });

  test("a stored wheel choice wins over the derived place", () => {
    const stored = partyHueValue("teal");
    expect(partyHueKey("whoever", stored)).toBe("teal");
    expect(partyHueValue("teal")).toBe("var(--c-teal)");
  });

  test("a stored literal the wheel does not name answers null, not a guess", () => {
    // The cue to use it verbatim: an imported hex is the member's choice, and
    // a KEY cannot carry it.
    expect(partyHueKey("whoever", "#8c4c61")).toBeNull();
    expect(partyHueKey("whoever", "var(--c-not-a-hue)")).toBeNull();
  });

  test("blank storage falls through to the wheel rather than answering null", () => {
    expect(partyHueKey("whoever", "   ")).toBe(identityHueKey("whoever"));
    expect(partyHueKey("whoever", null)).toBe(identityHueKey("whoever"));
  });
});
