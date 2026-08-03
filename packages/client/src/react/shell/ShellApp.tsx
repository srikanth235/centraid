import { memo, useEffect, useMemo, useReducer } from "react";
import type { JSX, ReactNode } from "react";

import type { ShellRoute } from "../../app-shell-context.js";
import {
  canGoBack as canBack,
  canGoForward as canFwd,
  currentRoute,
  INITIAL_ROUTER,
  routerReducer,
} from "./router.js";
import ShellFrame from "./ShellFrame.js";
import { useCompactLayout } from "./useCompactLayout.js";

// The navigation surface handed to the stem + outlet render-props. It exposes
// the current route and the history verbs, so callers dispatch navigations
// without touching the reducer.
export interface ShellNav {
  route: ShellRoute;
  navigate: (route: ShellRoute) => void;
  /** Swap the current history entry in place (no new back-stack entry). */
  replace: (route: ShellRoute) => void;
  back: () => void;
  forward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ShellAppProps {
  /** Where the shell opens (usually `{ kind: 'home' }`). */
  initialRoute: ShellRoute;
  /** The navigation stem for the current route (gets the nav surface). */
  renderStem: (nav: ShellNav) => ReactNode;
  /** The page body for the current route (the outlet). */
  renderScreen: (nav: ShellNav) => ReactNode;
  /** Routes that paint their own full window (app view, builder) and so
   *  bypass the chrome frame. Defaults to app + builder kinds. */
  isFullBleed?: (route: ShellRoute) => boolean;
  /** New-app affordance in the app bar. */
  onNewApp?: () => void;
  /** Receives the current nav surface whenever it changes, so the App root can
   *  wire document-level shortcuts + external re-scope (gateway/vault change)
   *  against live navigation without owning the router. */
  onNavReady?: (nav: ShellNav) => void;
  /** The one persistent status line. Full-bleed routes mount their own frame
   *  and are handed the same node directly, so this is the framed case only. */
  statusLine?: ReactNode;
}

const DEFAULT_FULL_BLEED = (r: ShellRoute): boolean =>
  r.kind === "app" || r.kind === "builder" || r.kind === "automation-builder";

/**
 * A real component boundary around a render-prop outlet (issue #659).
 *
 * `renderScreen(nav)` and `renderStem(nav)` were plain function calls, so
 * every re-render of the shell root rebuilt the whole route's element tree —
 * including for state the route does not read, like the 5s gateway heartbeat.
 * A function call has no boundary React can stop at; a memoized component does.
 * It re-renders when the nav or the render function changes, which is why both
 * callers keep those stable.
 */
const Outlet = memo(
  ({
    nav,
    render,
  }: {
    nav: ShellNav;
    render: (nav: ShellNav) => ReactNode;
  }): JSX.Element => <>{render(nav)}</>
);
Outlet.displayName = "Outlet";

export default function ShellApp({
  initialRoute,
  renderStem,
  renderScreen,
  isFullBleed = DEFAULT_FULL_BLEED,
  onNewApp,
  onNavReady,
  statusLine,
}: ShellAppProps): JSX.Element {
  const [state, dispatch] = useReducer(routerReducer, INITIAL_ROUTER, (init) =>
    routerReducer(init, { type: "navigate", route: initialRoute })
  );
  // The stem never hides (issue #707, invariant 1): it does not scroll away,
  // it does not change width, and there is no toggle. So the open/closed
  // state, the drawer, the scrim, and the "navigating dismisses the rail"
  // rule that the three-zone sidebar needed are all simply gone. Compact is a
  // layout signal only — the same stem becomes the bottom band.
  const compact = useCompactLayout();
  const route = currentRoute(state) ?? initialRoute;

  const nav = useMemo<ShellNav>(
    () => ({
      route,
      navigate: (r) => dispatch({ type: "navigate", route: r }),
      replace: (r) => dispatch({ type: "replace", route: r }),
      back: () => dispatch({ type: "back" }),
      forward: () => dispatch({ type: "forward" }),
      canGoBack: canBack(state),
      canGoForward: canFwd(state),
    }),
    [route, state]
  );

  useEffect(() => {
    onNavReady?.(nav);
  }, [nav, onNavReady]);

  const screen = <Outlet nav={nav} render={renderScreen} />;

  // Full-bleed routes render their own window frame (app view / builder),
  // so the shell frame steps aside entirely.
  if (isFullBleed(route)) return <>{screen}</>;

  return (
    <ShellFrame
      compact={compact}
      stem={<Outlet nav={nav} render={renderStem} />}
      statusLine={statusLine}
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
