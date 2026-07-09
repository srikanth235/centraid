import { type JSX, useCallback } from 'react';
import type { ShellRoute } from '../../app-shell-context.js';
import { type ShellActions, ShellActionsProvider } from './actions.js';
import { openConfirm } from './confirm.js';
import Sidebar, { type SidebarPage } from './Sidebar.js';
import ShellApp, { type ShellNav } from './ShellApp.js';
import PageScroll from './PageScroll.js';
import { showToast } from './toast.js';
import { toSidebarApps } from './sidebarApps.js';
import { PageEmpty } from './status.js';
import { useAppearance } from './useAppearance.js';
import { useShellApps } from './useShellApps.js';
import { useStarred } from './useStarred.js';
import AppViewRoute from './routes/AppViewRoute.js';
import AssistantRoute from './routes/AssistantRoute.js';
import AutomationsRoute from './routes/AutomationsRoute.js';
import AutomationViewRoute from './routes/AutomationViewRoute.js';
import DiscoverRoute from './routes/DiscoverRoute.js';
import HomeRoute from './routes/HomeRoute.js';
import InsightsRoute from './routes/InsightsRoute.js';
import RunViewRoute from './routes/RunViewRoute.js';
import SettingsRoute from './routes/SettingsRoute.js';
import TemplatesRoute from './routes/TemplatesRoute.js';

// Build the ShellActions surface for the current render. Navigation + toast +
// confirm are live; the remaining overlay actions (⌘K palette, the generic app
// context menu) are wired as their clusters land — until then they route to the
// builder or no-op so a consumer never crashes.
function makeActions(nav: ShellNav): ShellActions {
  return {
    showToast,
    confirm: openConfirm,
    navigate: nav.navigate,
    enterBuilder: (opts) =>
      nav.navigate({
        kind: 'builder',
        ...(opts.appContext ? { appContext: opts.appContext } : {}),
        ...(opts.initialPrompt ? { initialPrompt: opts.initialPrompt } : {}),
      }),
    openNewAppSheet: () => nav.navigate({ kind: 'builder' }),
    openCommandPalette: () => {
      /* ⌘K palette ported with PaletteRoute */
    },
    openContextMenu: () => {
      /* the home app-card context menu is wired inside HomeRoute */
    },
  };
}

// Map the current route to the sidebar's active-page highlight.
function activePageFor(route: ShellRoute): SidebarPage | undefined {
  switch (route.kind) {
    case 'home':
    case 'assistant':
    case 'insights':
    case 'discover':
    case 'starred':
    case 'automations':
    case 'settings':
      return route.kind;
    default:
      return undefined;
  }
}

// The React shell root — the single component the flip mounts on #root,
// replacing the vanilla app.ts IIFE + chrome.ts. It owns the real renderer
// state (appearance prefs, the live app/draft list, starred set) and drives
// ShellApp, which wires the chrome frame + router. Routes render from the
// renderRoute switch below; each is ported one at a time from the vanilla
// app-*.ts modules. NOT yet wired to #root while that work continues.
export default function App(): JSX.Element {
  const { prefs, setPrefs } = useAppearance();
  const { userApps, drafts, refresh } = useShellApps();
  const { isStarred, toggleStar } = useStarred();

  const renderSidebar = useCallback(
    (nav: ShellNav) => {
      const { apps, drafts: draftApps } = toSidebarApps(userApps, drafts);
      const page = activePageFor(nav.route);
      const go = (route: ShellRoute) => () => nav.navigate(route);
      return (
        <Sidebar
          apps={apps}
          drafts={draftApps}
          activePage={page}
          activeId={nav.route.kind === 'app' ? nav.route.id : undefined}
          onHome={go({ kind: 'home' })}
          onAssistant={go({ kind: 'assistant' })}
          onInsights={go({ kind: 'insights' })}
          onDiscover={go({ kind: 'discover' })}
          onStarred={go({ kind: 'starred' })}
          onAutomations={go({ kind: 'automations' })}
          onSettings={go({ kind: 'settings' })}
          onAppClick={(id) => nav.navigate({ kind: 'app', id })}
          onNewApp={() => nav.navigate({ kind: 'builder' })}
        />
      );
    },
    [userApps, drafts],
  );

  const renderRoute = useCallback(
    (nav: ShellNav): JSX.Element => {
      switch (nav.route.kind) {
        case 'home':
          return (
            <HomeRoute
              userApps={userApps}
              drafts={drafts}
              tileVariant={prefs.tileVariant}
              isStarred={isStarred}
              toggleStar={toggleStar}
              refreshApps={refresh}
            />
          );
        case 'assistant':
          return <AssistantRoute />;
        case 'insights':
          return <InsightsRoute />;
        case 'automations':
          return <AutomationsRoute />;
        case 'automation-view':
          return <AutomationViewRoute automationId={nav.route.automationId} />;
        case 'run-view':
          return <RunViewRoute automationId={nav.route.automationId} runId={nav.route.runId} />;
        case 'discover':
          return <DiscoverRoute />;
        case 'templates':
          return <TemplatesRoute />;
        case 'settings':
          return <SettingsRoute prefs={prefs} setPrefs={setPrefs} />;
        case 'app': {
          const id = nav.route.id;
          const app = [...userApps, ...drafts].find((a) => a.id === id);
          if (!app) return <PageEmpty message="App not found." />;
          const ua = userApps.find((a) => a.id === id);
          const appId = ua?.centraidAppId ?? app.id;
          return (
            <AppViewRoute
              app={app}
              appId={appId}
              nav={nav}
              renderSidebar={renderSidebar}
              prefs={prefs}
              onToggleSidebar={() => setPrefs({ sidebarOpen: !prefs.sidebarOpen })}
            />
          );
        }
        case 'starred':
          // Port of the vanilla renderStarred — a pure empty-state page.
          return (
            <PageScroll title="Starred" subtitle="Apps you star show up here for quick access.">
              <PageEmpty message="Nothing starred yet. Hover an app tile and tap the star." />
            </PageScroll>
          );
        default:
          // Staged: ported one-by-one from the vanilla app-*.ts render fns.
          return <PageEmpty message="This screen is being migrated to React." />;
      }
    },
    [userApps, drafts, prefs, setPrefs, isStarred, toggleStar, refresh],
  );

  return (
    <ShellApp
      initialRoute={{ kind: 'home' }}
      sidebarOpen={prefs.sidebarOpen}
      onSidebarOpenChange={(open) => setPrefs({ sidebarOpen: open })}
      renderSidebar={renderSidebar}
      renderScreen={(nav) => (
        <ShellActionsProvider value={makeActions(nav)}>{renderRoute(nav)}</ShellActionsProvider>
      )}
      onNewApp={() => {
        /* new-app flow ported with the builder route (R3) */
      }}
    />
  );
}
