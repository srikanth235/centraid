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

export interface ShellNav {
  route: ShellRoute;
  stemOpen: boolean;
  toggleStem: () => void;
  navigate: (route: ShellRoute) => void;
  replace: (route: ShellRoute) => void;
  back: () => void;
  forward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  assistantOpen?: boolean;
  toggleAssistant?: () => void;
}

export interface ShellAppBar {
  title?: string;
  meta?: ReactNode;
  count?: ReactNode;
  mark?: ReactNode;
  actions?: ReactNode;
  titleAction?: ShellFrameProps["appTitleAction"];
}

export interface ShellAppProps {
  initialRoute: ShellRoute;
  renderStem: (nav: ShellNav) => ReactNode;
  renderAppBar?: (nav: ShellNav) => ShellAppBar | undefined;
  renderScreen: (nav: ShellNav) => ReactNode;
  isFullBleed?: (route: ShellRoute) => boolean;
  onNavReady?: (nav: ShellNav) => void;
  statusLine?: ReactNode;
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
  r.kind === "app" || r.kind === "automation-builder";

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

const STEM_OPEN_KEY = "shell.stemOpen";

export default function ShellApp({
  initialRoute,
  renderStem,
  renderAppBar,
  renderScreen,
  isFullBleed = DEFAULT_FULL_BLEED,
  onNavReady,
  statusLine,
  renderAssistantCompanion,
}: ShellAppProps): JSX.Element {
  const [state, dispatch] = useReducer(routerReducer, INITIAL_ROUTER, (init) =>
    routerReducer(init, { type: "navigate", route: initialRoute })
  );
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
    >
      {screen}
    </ShellFrame>
  );
}
