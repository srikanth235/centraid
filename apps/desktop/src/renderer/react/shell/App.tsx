import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { IconName } from '@centraid/design-tokens';
import type { ShellRoute } from '../../app-shell-context.js';
import PaletteScreen from '../screens/PaletteScreen.js';
import { type ShellActions, ShellActionsProvider } from './actions.js';
import { openConfirm } from './confirm.js';
import { buildPaletteGroups } from './routes/paletteData.js';
import ProfileSwitcherHead from './ProfileSwitcherHead.js';
import Sidebar, { type SidebarPage } from './Sidebar.js';
import ShellApp, { type ShellNav } from './ShellApp.js';
import { showToast } from './toast.js';
import { toSidebarApps } from './sidebarApps.js';
import { PageEmpty } from './status.js';
import { useActiveVault } from './useActiveVault.js';
import { useAppearance } from './useAppearance.js';
import { useBlockingCount } from './useBlockingCount.js';
import { useShellApps } from './useShellApps.js';
import { useStarred } from './useStarred.js';
import { closeVaultSwitcher, openVaultSwitcher } from './vaultSwitcher.js';
import ApprovalsRoute from './routes/ApprovalsRoute.js';
import AppViewRoute from './routes/AppViewRoute.js';
import AssistantRoute from './routes/AssistantRoute.js';
import AutomationsRoute from './routes/AutomationsRoute.js';
import AutomationViewRoute from './routes/AutomationViewRoute.js';
import BuilderRoute from './routes/BuilderRoute.js';
import DiscoverRoute from './routes/DiscoverRoute.js';
import HomeRoute from './routes/HomeRoute.js';
import InsightsRoute from './routes/InsightsRoute.js';
import RunViewRoute from './routes/RunViewRoute.js';
import SettingsRoute from './routes/SettingsRoute.js';
import StarredRoute from './routes/StarredRoute.js';
import TemplatesRoute from './routes/TemplatesRoute.js';

// Build the ShellActions surface for the current render. Navigation + toast +
// confirm are live; the remaining overlay actions (⌘K palette, the generic app
// context menu) are wired as their clusters land — until then they route to the
// builder or no-op so a consumer never crashes.
function makeActions(nav: ShellNav, openCommandPalette: () => void): ShellActions {
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
    openCommandPalette,
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
    case 'approvals':
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
  const { userApps, drafts, refresh, setUserApps } = useShellApps();
  const { isStarred, toggleStar } = useStarred();
  const activeVault = useActiveVault();
  const blockingCount = useBlockingCount();
  const navRef = useRef<ShellNav | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [vaultSwitcherOpen, setVaultSwitcherOpen] = useState(false);

  // Document-level shortcuts + external re-scope, ported from the vanilla app.ts
  // boot block. Bound once against the live nav (navRef, fed by ShellApp). A
  // gateway (#109) or vault (#289) change invalidates every gateway-scoped piece
  // of renderer state — drop it by re-listing apps + bouncing to Home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === '[') {
        e.preventDefault();
        navRef.current?.back();
      } else if (meta && e.key === ']') {
        e.preventDefault();
        navRef.current?.forward();
      } else if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKey);

    // The delegated builder (window.openBuilder) reaches back through
    // window.Centraid for nav actions (optional-chained). React owns routing
    // now, so publish a nav-backed shim in place of the retired vanilla app.ts.
    const go = (route: ShellRoute) => (): void => void navRef.current?.navigate(route);
    (window as unknown as { Centraid: unknown }).Centraid = {
      openApp: (id: string) => navRef.current?.navigate({ kind: 'app', id }),
      openSettings: go({ kind: 'settings' }),
      openSearch: () => {},
      openDiscover: go({ kind: 'discover' }),
      openStarred: go({ kind: 'starred' }),
      openAutomations: go({ kind: 'automations' }),
      openInsights: go({ kind: 'insights' }),
      renderHome: go({ kind: 'home' }),
      getRuntimeMode: () => undefined,
    };

    const reScope = (): void => {
      void refresh();
      navRef.current?.navigate({ kind: 'home' });
    };
    window.CentraidApi.onGatewayChanged?.(reScope);
    window.CentraidApi.onVaultChanged?.(reScope);
    return () => {
      document.removeEventListener('keydown', onKey);
      // The vault switcher is a body-portalled overlay outside React's tree —
      // drop it explicitly so it can't outlive the shell root (tests, HMR).
      closeVaultSwitcher();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderSidebar = useCallback(
    (nav: ShellNav) => {
      const { apps, drafts: draftApps } = toSidebarApps(userApps, drafts);
      const page = activePageFor(nav.route);
      const go = (route: ShellRoute) => () => nav.navigate(route);
      const appsCount = userApps.length + drafts.length;
      const headSlot = (
        <ProfileSwitcherHead
          active={
            activeVault.active
              ? {
                  id: activeVault.active.vaultId,
                  name: activeVault.active.name,
                  color: activeVault.active.color ?? '#4E68DD',
                  icon: (activeVault.active.icon as IconName) || 'Sparkle',
                }
              : undefined
          }
          subtitle={
            activeVault.loading || !activeVault.active
              ? '—'
              : `${appsCount} app${appsCount === 1 ? '' : 's'}`
          }
          open={vaultSwitcherOpen}
          onToggle={(anchor) => {
            setVaultSwitcherOpen(true);
            openVaultSwitcher({
              anchor,
              vaults: activeVault.vaults,
              activeVaultId: activeVault.activeVaultId,
              onSwitch: activeVault.switchVault,
              onManage: go({ kind: 'settings' }),
              onClose: () => setVaultSwitcherOpen(false),
            });
          }}
        />
      );
      return (
        <Sidebar
          apps={apps}
          drafts={draftApps}
          activePage={page}
          activeId={nav.route.kind === 'app' ? nav.route.id : undefined}
          headSlot={activeVault.loading || activeVault.vaults.length > 0 ? headSlot : undefined}
          onHome={go({ kind: 'home' })}
          onSearch={() => setPaletteOpen(true)}
          onAssistant={go({ kind: 'assistant' })}
          onInsights={go({ kind: 'insights' })}
          onDiscover={go({ kind: 'discover' })}
          onStarred={go({ kind: 'starred' })}
          onAutomations={go({ kind: 'automations' })}
          onApprovals={go({ kind: 'approvals' })}
          approvalsCount={blockingCount}
          onSettings={go({ kind: 'settings' })}
          onAppClick={(id) => nav.navigate({ kind: 'app', id })}
          onNewApp={() => nav.navigate({ kind: 'builder' })}
        />
      );
    },
    [userApps, drafts, activeVault, vaultSwitcherOpen, blockingCount],
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
        case 'approvals':
          return <ApprovalsRoute />;
        case 'automation-view':
          return <AutomationViewRoute automationId={nav.route.automationId} />;
        case 'run-view':
          return <RunViewRoute automationId={nav.route.automationId} runId={nav.route.runId} />;
        case 'discover':
          return (
            <DiscoverRoute userApps={userApps} setUserApps={setUserApps} refreshApps={refresh} />
          );
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
        case 'builder':
        case 'automation-builder':
          return (
            <BuilderRoute
              route={nav.route}
              nav={nav}
              userApps={userApps}
              setUserApps={setUserApps}
              renderSidebar={renderSidebar}
              prefs={prefs}
              onToggleSidebar={() => setPrefs({ sidebarOpen: !prefs.sidebarOpen })}
            />
          );
        case 'starred':
          return (
            <StarredRoute
              userApps={userApps}
              drafts={drafts}
              tileVariant={prefs.tileVariant}
              isStarred={isStarred}
              toggleStar={toggleStar}
            />
          );
        default:
          // Staged: ported one-by-one from the vanilla app-*.ts render fns.
          return <PageEmpty message="This screen is being migrated to React." />;
      }
    },
    [userApps, drafts, prefs, setPrefs, isStarred, toggleStar, refresh, setUserApps, renderSidebar],
  );

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  return (
    <>
      <ShellApp
        initialRoute={{ kind: 'home' }}
        sidebarOpen={prefs.sidebarOpen}
        onSidebarOpenChange={(open) => setPrefs({ sidebarOpen: open })}
        renderSidebar={renderSidebar}
        onNavReady={(nav) => {
          navRef.current = nav;
        }}
        renderScreen={(nav) => (
          <ShellActionsProvider value={makeActions(nav, () => setPaletteOpen(true))}>
            {renderRoute(nav)}
          </ShellActionsProvider>
        )}
        onNewApp={() => {
          /* new-app flow ported with the builder route (R3) */
        }}
      />
      {paletteOpen ? (
        <PaletteScreen
          onClose={closePalette}
          buildGroups={(query) =>
            buildPaletteGroups(query, {
              userApps,
              drafts,
              tileVariant: prefs.tileVariant,
              navigate: (route) => navRef.current?.navigate(route),
              enterBuilder: (initialPrompt) =>
                navRef.current?.navigate({
                  kind: 'builder',
                  ...(initialPrompt ? { initialPrompt } : {}),
                }),
              onClose: closePalette,
            })
          }
        />
      ) : null}
    </>
  );
}
