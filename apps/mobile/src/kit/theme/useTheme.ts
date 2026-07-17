import { useColorScheme } from 'react-native';
import { resolveTheme, type ThemeValue } from './resolve';

// Dark-mode-aware theme hook. Re-renders when the OS color scheme flips;
// the returned `colors` keeps a stable identity per scheme (see resolve.ts),
// so `useMemo(() => makeStyles(colors), [colors])` in screens is cheap.
export function useTheme(): ThemeValue {
  return resolveTheme(useColorScheme());
}
