import { describe, expect, it } from "vitest";

import { toNativeTheme } from "@centraid/design/native";

import { canonicalTheme, family, t, type } from "./native";

describe("direct native design adapter", () => {
  it("keeps both schemes equal to the canonical native lowering", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(canonicalTheme(scheme)).toStrictEqual(toNativeTheme(scheme));
    }
  });

  it("maps every type role without changing its metrics", () => {
    const canonical = toNativeTheme("light").type;
    expect(Object.keys(type).sort()).toStrictEqual(
      Object.keys(canonical).sort()
    );

    for (const key of Object.keys(canonical) as (keyof typeof canonical)[]) {
      expect(t(key).fontSize, `${key} size`).toBe(canonical[key].fontSize);
      expect(t(key).lineHeight, `${key} leading`).toBe(
        canonical[key].lineHeight
      );
      expect(t(key).fontFamily, `${key} family`).toBe(
        canonical[key].weight === "600" ? family.sansMedium : family.sansRegular
      );
    }
  });

  it("converts em tracking to React Native points", () => {
    const display = toNativeTheme("light").type.display;
    const expected =
      Math.round(
        Number(display.letterSpacing?.replace(/em$/u, "")) *
          display.fontSize *
          100
      ) / 100;
    expect(type.display.letterSpacing).toBe(expected);
  });

  it("uses the platform generic only for actual code", () => {
    expect(family.monoRegular).toBe("monospace");
    expect(family.monoMedium).toBe("monospace");
    expect(type.mono.fontFamily).toBe(family.sansRegular);
    expect(type.mono.fontVariant).toStrictEqual(["tabular-nums"]);
  });
});
