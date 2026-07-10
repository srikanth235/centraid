import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { ShellRoute } from '../../app-shell-context.js';
import {
  canGoBack as canBack,
  canGoForward as canFwd,
  currentRoute,
  INITIAL_ROUTER,
  routerReducer,
} from './router.js';
import ShellFrame from './ShellFrame.js';

// The navigation surface handed to the sidebar + outlet render-props. It
// exposes the current route and the history verbs, so callers dispatch
// navigations without touching the reducer.
export interface ShellNav {
  route: ShellRoute;
  navigate: (route: ShellRoute) => void;
  back: () => void;
  forward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ShellAppProps {
  /** Where the shell opens (usually `{ kind: 'home' }`). */
  initialRoute: ShellRoute;
  /** Sidebar contents for the current route (gets the nav surface). */
  renderSidebar: (nav: ShellNav) => ReactNode;
  /** The page body for the current route (the outlet). */
  renderScreen: (nav: ShellNav) => ReactNode;
  /** Routes that paint their own full window (app view, builder) and so
   *  bypass the chrome frame. Defaults to app + builder kinds. */
  isFullBleed?: (route: ShellRoute) => boolean;
  /** New-app affordance in the collapsed titlebar. */
  onNewApp?: () => void;
  sidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
  /** Receives the current nav surface whenever it changes, so the App root can
   *  wire document-level shortcuts + external re-scope (gateway/vault change)
   *  against live navigation without owning the router. */
  onNavReady?: (nav: ShellNav) => void;
}

const DEFAULT_FULL_BLEED = (r: ShellRoute): boolean =>
  r.kind === 'app' || r.kind === 'builder' || r.kind === 'automation-builder';

export default function ShellApp({
  initialRoute,
  renderSidebar,
  renderScreen,
  isFullBleed = DEFAULT_FULL_BLEED,
  onNewApp,
  sidebarOpen: sidebarOpenProp,
  onSidebarOpenChange,
  onNavReady,
}: ShellAppProps): JSX.Element {
  const [state, dispatch] = useReducer(routerReducer, INITIAL_ROUTER, (init) =>
    routerReducer(init, { type: 'navigate', route: initialRoute }),
  );
  // Sidebar open state is controllable — the eventual App root owns it in
  // prefs — but self-manages when the prop is omitted (tests, standalone).
  const [localOpen, setLocalOpen] = useState(sidebarOpenProp ?? true);
  const sidebarOpen = sidebarOpenProp ?? localOpen;

  const route = currentRoute(state) ?? initialRoute;

  const nav = useMemo<ShellNav>(
    () => ({
      route,
      navigate: (r) => dispatch({ type: 'navigate', route: r }),
      back: () => dispatch({ type: 'back' }),
      forward: () => dispatch({ type: 'forward' }),
      canGoBack: canBack(state),
      canGoForward: canFwd(state),
    }),
    [route, state],
  );

  const toggleSidebar = useCallback(() => {
    const next = !sidebarOpen;
    if (onSidebarOpenChange) onSidebarOpenChange(next);
    else setLocalOpen(next);
  }, [sidebarOpen, onSidebarOpenChange]);

  useEffect(() => {
    onNavReady?.(nav);
  }, [nav, onNavReady]);

  const screen = renderScreen(nav);

  // Full-bleed routes render their own window frame (app view / builder),
  // so the shell frame steps aside entirely.
  if (isFullBleed(route)) return <>{screen}</>;

  return (
    <ShellFrame
      sidebarOpen={sidebarOpen}
      onToggleSidebar={toggleSidebar}
      sidebar={renderSidebar(nav)}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => nav.back()}
      onForward={() => nav.forward()}
      showNewChat={Boolean(onNewApp)}
      onNewChat={onNewApp}
    >
      {screen}
    </ShellFrame>
  );
}
