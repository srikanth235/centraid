import { useColorScheme } from "react-native";

import { resolveScheme, useAppearance } from "./appearance";
import { resolveTheme } from "./resolve";
import type { ThemeValue } from "./resolve";

export function useTheme(): ThemeValue {
  return resolveTheme(resolveScheme(useAppearance(), useColorScheme()));
}
