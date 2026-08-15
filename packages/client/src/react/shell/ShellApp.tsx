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
  routerReducer,
} from "./router.js";
import ShellFrame from "./ShellFrame.js";
import type { ShellFrameProps } from "./ShellFrame.js";
import { Store } from "./store.js";
import { useCompactLayout } from "./useCompactLayout.js";

import styles from "./ShellApp.module.css";

// The navigation surface handed to the stem + outlet render-props. It exposes
// the current route and the history verbs, so callers dispatch navigations
// without touching the reducer.
export interface ShellNav {
  route: ShellRoute;
  /** Whether the desktop navigation stem is visible in the current frame. */
  stemOpen: boolean;
  /** Toggle the persistent desktop navigation stem. */
  toggleStem: () => void;
  navigate: (route: ShellRoute) => void;
  /** Swap the current history entry in place (no new back-stack entry). */
  replace: (route: ShellRoute) => void;
  back: () => void;
  forward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Full-bleed route-owned frames use the same Assistant state as the shell. */
  assistantOpen?: boolean;
  toggleAssistant?: () => void;
}

/**
 * What a screen says in the app bar (issue #708, invariant 3).
 *
 * The brief models this as per-app configuration — a title, a meta line, and
 * at most two actions, of which at most one is the filled ink. It is data
 * rather than a context a screen writes into, because the bar renders in the
 * frame ABOVE the outlet: a screen that set it from an effect would paint one
 * frame with the previous route's title, which is the flicker the whole
 * "chrome is persistent" invariant exists to prevent.
 */
export interface ShellAppBar {
  /** The app's own title; a full identity lockup promotes it to display. */
  title?: string;
  /** The line under it, in the numeric register. */
  meta?: ReactNode;
  /** A count BESIDE the title, on the same line — see `ShellFrameProps.appCount`. */
  count?: ReactNode;
  /** The app's mark, leading the title — see `ShellFrameProps.appMark`. */
  mark?: ReactNode;
  /** The app's actions, trailing. Quiet first, the one commit control last. */
  actions?: ReactNode;
  /** Makes the title a control — see `ShellFrameProps.appTitleAction`. */
  titleAction?: ShellFrameProps["appTitleAction"];
}

export interface ShellAppProps {
  /** Where the shell opens (usually `{ kind: 'home' }`). */
  initialRoute: ShellRoute;
  /** The navigation stem for the current route (gets the nav surface). */
  renderStem: (nav: ShellNav) => ReactNode;
  /** What the current route says in the app bar. A route that returns nothing
   *  gets the bare frame bar (history + new app), which is what a full-bleed
   *  surface drawing its own header wants. */
  renderAppBar?: (nav: ShellNav) => ShellAppBar | undefined;
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
  /** The Assistant is frame state, not a route. This renderer receives the
   *  one open state shared by app-bar controls, keyboard shortcut, and rail. */
  renderAssistantCompanion?: (
    nav: ShellNav,
    state: {
      open: boolean;
      setOpen: (open: boolean) => void;
      surface: "pointer" | "touch";
    }
  ) => ReactNode;
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

/** Where the stem's open/closed preference lives. Persisted, because a member
 *  who reclaims the band on a narrow window means it for more than one session. */
const STEM_OPEN_KEY = "shell.stemOpen";

export default function ShellApp({
  initialRoute,
  renderStem,
  renderAppBar,
  renderScreen,
  isFullBleed = DEFAULT_FULL_BLEED,
  onNewApp,
  onNavReady,
  statusLine,
  renderAssistantCompanion,
}: ShellAppProps): JSX.Element {
  const [state, dispatch] = useReducer(routerReducer, INITIAL_ROUTER, (init) =>
    routerReducer(init, { type: "navigate", route: initialRoute })
  );
  // The stem can be reclaimed (⌘B), but it never becomes a DRAWER: hidden is a
  // persisted preference, not a mode you fall into. Nothing dismisses it for
  // you, nothing floats it over the content, and there is no scrim — the three
  // affordances the pre-#707 three-zone sidebar needed and this one still does
  // not. Compact ignores the preference entirely: the band is the navigation
  // there, and a phone with no way to move is not a phone.
  const compact = useCompactLayout();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const toggleAssistant = useCallback(
    () => setAssistantOpen((open) => !open),
    []
  );
  const [stemOpen, setStemOpen] = useState(() =>
    Store.get<boolean>(STEM_OPEN_KEY, true)
  );
  const toggleStem = useCallback(() => {
    setStemOpen((open) => {
      Store.set(STEM_OPEN_KEY, !open);
      return !open;
    });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      if (event.key !== "b" && event.key !== "B") return;
      event.preventDefault();
      toggleStem();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleStem]);
  const route = currentRoute(state) ?? initialRoute;

  const nav = useMemo<ShellNav>(
    () => ({
      route,
      stemOpen,
      toggleStem,
      navigate: (r) => dispatch({ type: "navigate", route: r }),
      replace: (r) => dispatch({ type: "replace", route: r }),
      back: () => dispatch({ type: "back" }),
      forward: () => dispatch({ type: "forward" }),
      canGoBack: canBack(state),
      canGoForward: canFwd(state),
      ...(compact && renderAssistantCompanion
        ? { assistantOpen, toggleAssistant }
        : {}),
    }),
    [
      assistantOpen,
      compact,
      renderAssistantCompanion,
      route,
      state,
      stemOpen,
      toggleAssistant,
      toggleStem,
    ]
  );

  useEffect(() => {
    onNavReady?.(nav);
  }, [nav, onNavReady]);

  const screen = <Outlet nav={nav} render={renderScreen} />;

  const assistantCompanion = renderAssistantCompanion?.(nav, {
    open: assistantOpen,
    setOpen: setAssistantOpen,
    surface: compact ? "touch" : "pointer",
  });

  // Full-bleed routes render their own window frame (app view / builder),
  // so the ordinary shell frame steps aside. The Assistant remains frame
  // state, however: this host reserves its pointer rail while the route-owned
  // frame opens the touch sheet from its ordinary app-bar Assistant glyph.
  if (isFullBleed(route))
    return (
      <div
        className={styles.fullBleedCompanionHost}
        data-assistant={assistantOpen ? "open" : undefined}
        data-surface={compact ? "touch" : "pointer"}
      >
        <div className={styles.fullBleedStage} data-assistant-page="true">
          {screen}
        </div>
        {assistantCompanion}
      </div>
    );

  const bar = renderAppBar?.(nav);

  return (
    <ShellFrame
      compact={compact}
      {...(compact ? {} : { onToggleStem: toggleStem, stemOpen })}
      stem={<Outlet nav={nav} render={renderStem} />}
      {...(bar?.title === undefined ? {} : { appTitle: bar.title })}
      {...(bar?.meta === undefined ? {} : { appMeta: bar.meta })}
      {...(bar?.count === undefined ? {} : { appCount: bar.count })}
      {...(bar?.mark === undefined ? {} : { appMark: bar.mark })}
      {...(bar?.actions === undefined ? {} : { titlebarRight: bar.actions })}
      {...(bar?.titleAction === undefined
        ? {}
        : { appTitleAction: bar.titleAction })}
      statusLine={statusLine}
      assistantCompanion={assistantCompanion}
      assistantOpen={assistantOpen}
      {...(compact && renderAssistantCompanion
        ? { onToggleAssistant: toggleAssistant }
        : {})}
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
