import { spacing } from "../density";
import type { NativeColors, NativeTheme } from "../native";
import { RECIPES } from "./index";
import type { ButtonVariant } from "./index";

export interface NativeButtonStyle {
  backgroundColor: string;
  borderColor: string;
  color: string;
  minHeight: number;
  borderRadius: number;
  paddingHorizontal: number;
}

type NativeThemeParts = Pick<NativeTheme, "radii" | "targetMin"> & {
  colors: NativeColors;
};

/**
 * Concrete RN button geometry and published foreground for a recipe variant.
 *
 * `disabled` overrides every variant to the same recipe (D19): a filled
 * control that cannot be pressed stops being filled, so a disabled primary
 * must not stay filled any more than a disabled secondary would.
 */
export function nativeButtonStyle(
  variant: ButtonVariant,
  theme: NativeThemeParts,
  disabled = false
): NativeButtonStyle {
  const recipe = RECIPES.Button;
  if (!recipe.capabilities.includes("native")) {
    throw new Error("Button recipe must support native lowering");
  }
  const { colors, radii } = theme;
  const minHeight = theme.targetMin.coarse;
  const paddingHorizontal = spacing[4];
  if (disabled) {
    return {
      backgroundColor: "transparent",
      borderColor: colors.line,
      color: colors.textDisabled,
      minHeight,
      borderRadius: radii.md,
      paddingHorizontal,
    };
  }
  switch (variant) {
    case "primary":
      return {
        backgroundColor: colors.accentFill,
        borderColor: "transparent",
        color: colors.textInv,
        minHeight,
        borderRadius: radii.md,
        paddingHorizontal,
      };
    case "destructive":
      return {
        backgroundColor: "transparent",
        borderColor: colors.danger,
        color: colors.danger,
        minHeight,
        borderRadius: radii.md,
        paddingHorizontal,
      };
    case "quiet":
      return {
        backgroundColor: "transparent",
        borderColor: "transparent",
        color: colors.text,
        minHeight,
        borderRadius: radii.md,
        paddingHorizontal,
      };
    case "secondary":
      return {
        backgroundColor: "transparent",
        borderColor: colors.lineStrong,
        color: colors.textSoft,
        minHeight,
        borderRadius: radii.md,
        paddingHorizontal,
      };
  }
}
