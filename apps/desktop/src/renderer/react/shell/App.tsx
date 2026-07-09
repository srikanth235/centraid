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
import AutomationsRoute from './routes/AutomationsRoute.js';
import AutomationViewRoute from './routes/AutomationViewRoute.js';
import InsightsRoute from './routes/InsightsRoute.js';

// Build the ShellActions surface for the current render. Navigation + toast are
// live; the overlay actions (builder, new-app sheet, ⌘K palette, context menu)
// are ported from the vanilla cardsMod/autoMod one cluster at a time — until
// then they route to the builder or no-op so a consumer never crashes.
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
      /* context menu ported with the card-action cluster */
    },
  };
}

// The React shell root — the single component the flip mounts on #root,
// replacing the vanilla app.ts IIFE + chrome.ts. It owns the real renderer
// state (appearance prefs, the live app/draft list) and drives ShellApp, which
// wires the chrome frame + router. Each route is rendered by an entry in the
// registry; entries are ported one at a time from the vanilla app-*.ts modules
// (Insights is done — the rest render a staged placeholder until ported, and
// this component is NOT yet wired to #root while that work continues).

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

function renderRoute(nav: ShellNav): JSX.Element {
  switch (nav.route.kind) {
    case 'insights':
      return <InsightsRoute />;
    case 'automations':
      return <AutomationsRoute />;
    case 'automation-view':
      return <AutomationViewRoute automationId={nav.route.automationId} />;
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
}

export default function App(): JSX.Element {
  const { prefs, setPrefs } = useAppearance();
  const { userApps, drafts } = useShellApps();

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
