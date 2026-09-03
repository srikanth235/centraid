import { describe, expect, test } from "vitest";

import { BLUEPRINT_TOKEN_CONTRACT, SHELL_TOKEN_CONTRACT } from "../contract.js";
import { toNativeTheme } from "../native.js";
import {
  BUTTON_VARIANTS,
  RECIPES,
  RECIPE_NAMES,
  RECIPE_ROLE_REFERENCES,
  getRecipe,
} from "./index.js";
import { nativeButtonStyle } from "./native.js";

describe("revision 3 recipe registry", () => {
  test("publishes the complete 26-recipe inventory", () => {
    expect(RECIPE_NAMES).toHaveLength(26);
    expect(Object.keys(RECIPES).sort()).toStrictEqual([...RECIPE_NAMES].sort());
    for (const name of RECIPE_NAMES) {
      const recipe = getRecipe(name);
      expect(recipe.rest.length, `${name} rest`).toBeGreaterThan(0);
      expect(recipe.states.rest).toStrictEqual(recipe.rest);
      expect(recipe.states.focus.length).toBeGreaterThan(0);
      expect(recipe.a11y.length, `${name} accessibility`).toBeGreaterThan(0);
    }
  });

  test("keeps button variants explicit and finite", () => {
    expect(BUTTON_VARIANTS).toStrictEqual([
      "primary",
      "secondary",
      "quiet",
      "destructive",
    ]);
    expect(new Set(BUTTON_VARIANTS).size).toBe(BUTTON_VARIANTS.length);
  });

  test("recipe references only resolve to shared contract roles", () => {
    const contract = new Set([
      ...SHELL_TOKEN_CONTRACT,
      ...BLUEPRINT_TOKEN_CONTRACT,
    ]);
    for (const reference of RECIPE_ROLE_REFERENCES) {
      expect(
        contract.has(reference),
        `${reference} is not a contract role`
      ).toBe(true);
    }
  });

  test("lowers the canonical button recipe to native styles", () => {
    const theme = toNativeTheme("light");
    for (const variant of BUTTON_VARIANTS) {
      const style = nativeButtonStyle(variant, theme);
      expect(style.minHeight).toBe(theme.targetMin.coarse);
      expect(style.borderRadius).toBe(theme.radii.md);
      expect(style.color).toMatch(/^#/u);
    }
    expect(nativeButtonStyle("destructive", theme).backgroundColor).toBe(
      "transparent"
    );
    expect(nativeButtonStyle("secondary", theme).backgroundColor).toBe(
      "transparent"
    );
    expect(nativeButtonStyle("secondary", theme).borderColor).toBe(
      theme.colors.lineStrong
    );
    expect(nativeButtonStyle("quiet", theme).color).toBe(theme.colors.text);
    for (const scheme of ["light", "dark"] as const) {
      const schemeTheme = toNativeTheme(scheme);
      expect(nativeButtonStyle("primary", schemeTheme).color).toBe(
        schemeTheme.colors.textInv
      );
    }
    expect(nativeButtonStyle("quiet", theme).paddingHorizontal).toBe(
      theme.spacing[4]
    );

    for (const variant of BUTTON_VARIANTS) {
      const disabledStyle = nativeButtonStyle(variant, theme, true);
      expect(disabledStyle.backgroundColor).toBe("transparent");
      expect(disabledStyle.borderColor).toBe(theme.colors.line);
      expect(disabledStyle.color).toBe(theme.colors.textDisabled);
      expect(disabledStyle.minHeight).toBe(theme.targetMin.coarse);
    }
  });

  test("rejects a button recipe without native capability", () => {
    const recipe = RECIPES.Button;
    const originalCapabilities = recipe.capabilities;
    recipe.capabilities = ["web", "blueprint"];
    try {
      expect(() =>
        nativeButtonStyle("primary", toNativeTheme("light"))
      ).toThrow("Button recipe must support native lowering");
    } finally {
      recipe.capabilities = originalCapabilities;
    }
  });
});
