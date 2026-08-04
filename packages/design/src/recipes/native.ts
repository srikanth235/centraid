import type { NativeColors, NativeTheme } from "../native";
import { RECIPES } from "./index";
import type { ButtonVariant, RecipeName } from "./index";

/**
 * Native lowering of the recipe table.  The object keeps role references
 * intact so a renderer can compose a style from the same solved theme rather
 * than inventing a parallel mobile vocabulary.
 */
export interface NativeRecipeLowering {
  name: RecipeName;
  rest: readonly string[];
  states: Readonly<Record<string, readonly string[]>>;
  capabilities: readonly ("web" | "blueprint" | "native")[];
}

export const NATIVE_RECIPES: Readonly<
  Record<RecipeName, NativeRecipeLowering>
> = Object.fromEntries(
  Object.entries(RECIPES).map(([name, recipe]) => [
    name,
    {
      capabilities: recipe.capabilities,
      name: recipe.name,
      rest: recipe.rest,
      states: recipe.states,
    },
  ])
) as Record<RecipeName, NativeRecipeLowering>;

export interface NativeButtonStyle {
  backgroundColor: string;
  borderColor: string;
  color: string;
  minHeight: number;
  borderRadius: number;
}

type NativeThemeParts = Pick<NativeTheme, "radii" | "targetMin"> & {
  colors: NativeColors;
};

/** Concrete RN button geometry and published foreground for a recipe variant. */
export function nativeButtonStyle(
  variant: ButtonVariant,
  theme: NativeThemeParts
): NativeButtonStyle {
  const recipe = NATIVE_RECIPES.Button;
  if (!recipe.capabilities.includes("native")) {
    throw new Error("Button recipe must support native lowering");
  }
  const { colors, radii, targetMin } = theme;
  switch (variant) {
    case "primary":
      return {
        backgroundColor: colors.accentFill,
        borderColor: "transparent",
        color: colors.textInv,
        minHeight: targetMin.coarse,
        borderRadius: radii.md,
      };
    case "destructiveFilled":
      return {
        backgroundColor: colors.danger,
        borderColor: "transparent",
        color: colors.textInv,
        minHeight: targetMin.coarse,
        borderRadius: radii.md,
      };
    case "destructive":
      return {
        backgroundColor: "transparent",
        borderColor: colors.danger,
        color: colors.danger,
        minHeight: targetMin.coarse,
        borderRadius: radii.md,
      };
    case "quiet":
      return {
        backgroundColor: "transparent",
        borderColor: "transparent",
        color: colors.textSoft,
        minHeight: targetMin.coarse,
        borderRadius: radii.md,
      };
    case "secondary":
      return {
        backgroundColor: colors.bgElev,
        borderColor: colors.line,
        color: colors.text,
        minHeight: targetMin.coarse,
        borderRadius: radii.md,
      };
  }
}
