import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import type { JSX, ReactNode } from "react";

import type { ShellRoute } from "../../app-shell-context.js";
import {
  canGoBack as canBack,
  canGoForward as canFwd,
  currentRoute,
  INITIAL_ROUTER,
  routeKey,
  routerReducer,
} from "./router.js";
import ShellFrame from "./ShellFrame.js";
import { useCompactLayout } from "./useCompactLayout.js";

// The navigation surface handed to the sidebar + outlet render-props. It
// exposes the current route and the history verbs, so callers dispatch
// navigations without touching the reducer.
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
  /** Persistent connection/sync state, including over full-bleed app covers. */
  statusBanner?: ReactNode;
}

const DEFAULT_FULL_BLEED = (r: ShellRoute): boolean =>
  r.kind === "app" || r.kind === "builder" || r.kind === "automation-builder";

/**
 * A real component boundary around a render-prop outlet (issue #659).
 *
 * `renderScreen(nav)` and `renderSidebar(nav)` were plain function calls, so
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
  renderSidebar,
  renderScreen,
  isFullBleed = DEFAULT_FULL_BLEED,
  onNewApp,
  sidebarOpen: sidebarOpenProp,
  onSidebarOpenChange,
  onNavReady,
  statusBanner,
}: ShellAppProps): JSX.Element {
  const [state, dispatch] = useReducer(routerReducer, INITIAL_ROUTER, (init) =>
    routerReducer(init, { type: "navigate", route: initialRoute })
  );
  // Sidebar open state is controllable — the eventual App root owns it in
  // prefs — but self-manages when the prop is omitted (tests, standalone).
  const [localOpen, setLocalOpen] = useState(sidebarOpenProp ?? true);
  const dockedOpen = sidebarOpenProp ?? localOpen;

  // Compact keeps its OWN open state, deliberately not the persisted pref: a
  // drawer is a transient thing you open, use, and dismiss, and letting those
  // dismissals write through would mean a session on a phone silently
  // collapses the rail the next time the desktop opens. The two never share a
  // value — only the toggle verb.
  const compact = useCompactLayout();
  const route = currentRoute(state) ?? initialRoute;
  const currentKey = routeKey(route);

  // The drawer remembers WHERE it was opened, so "navigating dismisses it"
  // falls out of a comparison instead of an effect that fires after the new
  // screen has already painted underneath it. Tapping a destination is the
  // dismiss gesture — leaving the rail covering the page would make every
  // trip a two-tap affair — and re-opening on the same page still works
  // because the toggle re-stamps the key.
  const [drawer, setDrawer] = useState({ open: false, at: currentKey });
  const drawerOpen = drawer.open && drawer.at === currentKey;
  // Above the breakpoint the drawer flag is simply not consulted, so leaving
  // compact hands control back to the pref with no state to reconcile.
  const sidebarOpen = compact ? drawerOpen : dockedOpen;

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

  const toggleSidebar = useCallback(() => {
    if (compact) {
      setDrawer((d) => ({
        open: !(d.open && d.at === currentKey),
        at: currentKey,
      }));
      return;
    }
    const next = !dockedOpen;
    if (onSidebarOpenChange) onSidebarOpenChange(next);
    else setLocalOpen(next);
  }, [compact, currentKey, dockedOpen, onSidebarOpenChange]);

  const dismissSidebar = useCallback(
    () => setDrawer((d) => ({ open: false, at: d.at })),
    []
  );

  useEffect(() => {
    onNavReady?.(nav);
  }, [nav, onNavReady]);

  const screen = <Outlet nav={nav} render={renderScreen} />;

  // Full-bleed routes render their own window frame (app view / builder),
  // so the shell frame steps aside entirely.
  if (isFullBleed(route))
    return (
      <>
        {statusBanner}
        {screen}
      </>
    );

  return (
    <ShellFrame
      sidebarOpen={sidebarOpen}
      compact={compact}
      onToggleSidebar={toggleSidebar}
      onDismissSidebar={dismissSidebar}
      sidebar={<Outlet nav={nav} render={renderSidebar} />}
      statusBanner={statusBanner}
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
