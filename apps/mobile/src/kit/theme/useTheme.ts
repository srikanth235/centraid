import { useColorScheme } from "react-native";

import { useAccent } from "./accent";
import { resolveScheme, useAppearance } from "./appearance";
import { resolveTheme } from "./resolve";
import type { ThemeValue } from "./resolve";

// Dark-mode-aware theme hook. Folds the device-local Appearance preference over
// the OS color scheme (see appearance.ts), so pinning Light/Dark in Settings
// re-renders every themed surface; 'System' follows `useColorScheme()`. The
// returned `colors` keeps a stable identity per scheme (see resolve.ts), so
// `useMemo(() => makeStyles(colors), [colors])` in screens is cheap.
export function useTheme(): ThemeValue {
  return resolveTheme(
    resolveScheme(useAppearance(), useColorScheme()),
    useAccent()
  );
}
