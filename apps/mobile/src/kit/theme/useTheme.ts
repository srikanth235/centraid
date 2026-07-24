import { useColorScheme } from 'react-native';
import { resolveTheme, type ThemeValue } from './resolve';
import { resolveScheme, useAppearance } from './appearance';

// Dark-mode-aware theme hook. Folds the device-local Appearance preference over
// the OS color scheme (see appearance.ts), so pinning Light/Dark in Settings
// re-renders every themed surface; 'System' follows `useColorScheme()`. The
// returned `colors` keeps a stable identity per scheme (see resolve.ts), so
// `useMemo(() => makeStyles(colors), [colors])` in screens is cheap.
export function useTheme(): ThemeValue {
  return resolveTheme(resolveScheme(useAppearance(), useColorScheme()));
}
