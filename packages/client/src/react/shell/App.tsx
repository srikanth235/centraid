// governance: allow-repo-hygiene file-size-limit (#382) the shell root
// wiring every route + the grouped switcher's popover callbacks crossed 500
// by 16 lines; a route-wiring extraction is a reasonable follow-up but not
// warranted for this margin.
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { IconName } from '@centraid/design-tokens';
import type { ShellRoute } from '../../app-shell-context.js';
import PaletteScreen from '../screens/PaletteScreen.js';
import WhatsNewModal from '../screens/WhatsNewModal.js';
import { type ShellActions, ShellActionsProvider } from './actions.js';
import { openConfirm } from './confirm.js';
import { relativeTime } from '../../app-format.js';
import { ASSISTANT_APP_ID, deleteConversation } from '../../gateway-client.js';
import { buildPaletteGroups } from './routes/paletteData.js';
import ProfileSwitcherHead from './ProfileSwitcherHead.js';
import Sidebar, { type SidebarConversation, type SidebarPage } from './Sidebar.js';
import ShellApp, { type ShellNav } from './ShellApp.js';
import { showToast } from './toast.js';
import { toSidebarApps } from './sidebarApps.js';
import { PageEmpty } from './status.js';
import { useActiveVault } from './useActiveVault.js';
import { useAppearance } from './useAppearance.js';
import { useAssistantConversations } from './useAssistantConversations.js';
import { useBlockingCount } from './useBlockingCount.js';
import { useGatewayRuntime } from './useGatewayRuntime.js';
import { useShellApps } from './useShellApps.js';
import { useStarred } from './useStarred.js';
import { relaunchToUpdate, useUpdateStatus } from './useUpdateStatus.js';
import { applySelection, resolveSelection, type PairRow } from './flatVaultSwitcher-core.js';
import { getCachedGroupedRows, openGroupedVaultRegistry } from './flatVaultSwitcherRegistry.js';
import { closeVaultSwitcher, openVaultSwitcher, updateVaultSwitcherRows } from './vaultSwitcher.js';
import ApprovalsRoute from './routes/ApprovalsRoute.js';
import AppViewRoute from './routes/AppViewRoute.js';
import AssistantRoute from './routes/AssistantRoute.js';
import AutomationEditorRoute from './routes/AutomationEditorRoute.js';
import AutomationsRoute from './routes/AutomationsRoute.js';
import AutomationViewRoute from './routes/AutomationViewRoute.js';
import BuilderRoute from './routes/BuilderRoute.js';
import ConnectFlowModal from './routes/ConnectFlowModal.js';
import DiscoverRoute from './routes/DiscoverRoute.js';
import GatewayRoute from './routes/GatewayRoute.js';
import HomeRoute from './routes/HomeRoute.js';
import InsightsRoute from './routes/InsightsRoute.js';
import RenameGatewayModal from './routes/RenameGatewayModal.js';
import RunViewRoute from './routes/RunViewRoute.js';
import SettingsRoute from './routes/SettingsRoute.js';
import SpaceModal, { DEFAULT_SPACE_ICON, randomSpaceColor } from './routes/SpaceModal.js';
import { createSpace } from './routes/spaceModals.js';
import StarredRoute from './routes/StarredRoute.js';
import TemplatesRoute from './routes/TemplatesRoute.js';
import TestConnectionModal from './routes/TestConnectionModal.js';

// Build the ShellActions surface for the current render. Navigation + toast +
// confirm are live; the remaining overlay actions (⌘K palette, the generic app
// context menu) are wired as their clusters land — until then they route to the
// builder or no-op so a consumer never crashes.
function makeActions(
  nav: ShellNav,
  openCommandPalette: () => void,
  refreshAssistantThreads: () => void,
): ShellActions {
  return {
    showToast,
    confirm: openConfirm,
    navigate: nav.navigate,
    replace: nav.replace,
    refreshAssistantThreads,
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
    case 'gateway':
    case 'settings':
      return route.kind;
    case 'app':
    case 'builder':
    case 'run-view':
    case 'automation-view':
    case 'automation-builder':
    case 'automation-editor':
    case 'templates':
      // Detail routes with no corresponding sidebar nav item — nothing to highlight.
      return undefined;
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
  const assistantConversations = useAssistantConversations();
  const { isStarred, toggleStar } = useStarred();
  const activeVault = useActiveVault();
  const blockingCount = useBlockingCount();
  const updateStatus = useUpdateStatus();
  const gatewayStatus = useGatewayRuntime()?.status;
  const navRef = useRef<ShellNav | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [vaultSwitcherOpen, setVaultSwitcherOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  // The switcher's per-gateway actions (issue #382) — "New space…", "Test
  // connection…", "Rename…" and the footer "Add gateway…" all open one of
  // these small modals; the switcher popover itself already closed by the
  // time any of them fires (vaultSwitcher.ts closes before invoking a
  // callback), so there's never a stacking concern.
  const [addGatewayOpen, setAddGatewayOpen] = useState(false);
  const [newSpaceGatewayId, setNewSpaceGatewayId] = useState<string | null>(null);
  const [testConnectionTarget, setTestConnectionTarget] = useState<{
    gatewayId: string;
    label: string;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ gatewayId: string; label: string } | null>(
    null,
  );

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#325) mount-once shim/listener wiring, deliberately []
  }, []);

  // Auto-open "What's new" once per version, matching Claude Code. On boot,
  // compare the running build's version (from the changelog read) against the
  // version we last showed the modal for (persisted in settings). When they
  // differ AND there are notes to show, open the modal and record the version
  // so it won't re-open on the next launch. Skipped offline / on a cold error
  // (no releases), and no-op if the bridge is stubbed (tests).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settings, changelog] = await Promise.all([
          window.CentraidApi.getSettings?.(),
          window.CentraidApi.getChangelog?.(),
        ]);
        if (cancelled || !changelog) return;
        const { currentVersion, releases } = changelog;
        if (!currentVersion || releases.length === 0) return;
        if (settings?.changelogSeenVersion === currentVersion) return;
        setWhatsNewOpen(true);
        await window.CentraidApi.saveSettings?.({ changelogSeenVersion: currentVersion });
      } catch {
        // Offline / bridge unavailable — no auto-open, no persisted version.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sidebar "Chats" row delete — mirrors the vanilla AssistantRoute's old
  // deleteThread confirm pattern, now living here since the sidebar (not
  // AssistantRoute) owns the conversation list + row actions. Bounces off
  // the fresh assistant route if the conversation being deleted is the one
  // currently open.
  const deleteAssistantConversation = useCallback(
    (id: string) => {
      const target = assistantConversations.conversations.find((c) => c.id === id);
      void (async () => {
        const yes = await openConfirm({
          title: 'Delete conversation?',
          message: `“${target?.title || 'New conversation'}” will be removed from this vault's history.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!yes) return;
        await deleteConversation(ASSISTANT_APP_ID, id).catch((err: unknown) =>
          showToast(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`),
        );
        await assistantConversations.refresh();
        const cur = navRef.current?.route;
        if (cur?.kind === 'assistant' && cur.conversationId === id) {
          navRef.current?.navigate({ kind: 'assistant' });
        }
      })();
    },
    [assistantConversations],
  );

  const renderSidebar = useCallback(
    (nav: ShellNav) => {
      const { apps, drafts: draftApps } = toSidebarApps(userApps, drafts);
      const page = activePageFor(nav.route);
      const go = (route: ShellRoute) => () => nav.navigate(route);
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
              : // (#382) the switcher IS the pair manager now — the sidebar
                // head's subtitle always names the active gateway (not just
                // remote ones, and no longer the app count), so "which pair
                // am I in" reads at a glance for every gateway kind.
                (activeVault.activeGatewayKind === 'local'
                  ? 'This Mac'
                  : activeVault.activeGatewayLabel) || 'This Mac'
          }
          open={vaultSwitcherOpen}
          onToggle={(anchor) => {
            setVaultSwitcherOpen(true);
            const activeGatewayId = activeVault.activeGatewayId;
            if (!activeGatewayId) return;
            const active = { gatewayId: activeGatewayId, vaultId: activeVault.activeVaultId };
            const select = (row: PairRow): void => {
              const plan = resolveSelection(row, active.gatewayId);
              void applySelection(plan, {
                setActiveGateway: (input) => window.CentraidApi.setActiveGateway(input),
                setActiveVault: (input) => window.CentraidApi.setActiveVault(input),
              });
            };
            // Grouped (gateway, vault) switcher (#382): paint instantly from
            // whatever's cached from a prior open, then refresh every
            // registered gateway concurrently and patch the list in place
            // as each settles (stale-while-revalidate).
            openVaultSwitcher({
              anchor,
              groups: getCachedGroupedRows(active),
              onAddGateway: () => setAddGatewayOpen(true),
              onNewSpace: (gatewayId) => setNewSpaceGatewayId(gatewayId),
              onRemoveGateway: (gatewayId) => {
                void (async () => {
                  const ok = await openConfirm({
                    confirmLabel: 'Remove',
                    danger: true,
                    message:
                      'This desktop stops talking to it — the gateway and its vaults are untouched.',
                    title: 'Remove this gateway connection?',
                  });
                  if (!ok) return;
                  await window.CentraidApi.removeGateway({ id: gatewayId }).catch((err: unknown) =>
                    showToast(
                      `Couldn't remove: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                  );
                })();
              },
              onRenameGateway: (gatewayId) => {
                const label =
                  getCachedGroupedRows(active).find((g) => g.gatewayId === gatewayId)
                    ?.gatewayLabel ?? '';
                setRenameTarget({ gatewayId, label });
              },
              onSelectVault: select,
              onTestConnection: (gatewayId) => {
                const label =
                  getCachedGroupedRows(active).find((g) => g.gatewayId === gatewayId)
                    ?.gatewayLabel ?? gatewayId;
                setTestConnectionTarget({ gatewayId, label });
              },
              onClose: () => setVaultSwitcherOpen(false),
            });
            void openGroupedVaultRegistry(active, updateVaultSwitcherRows).then(({ rows }) =>
              updateVaultSwitcherRows(rows),
            );
          }}
        />
      );
      const conversations: SidebarConversation[] = assistantConversations.conversations.map(
        (c) => ({
          id: c.id,
          title: c.title || 'New conversation',
          timeLabel: relativeTime(new Date(c.updatedAt).toISOString()),
        }),
      );
      return (
        <Sidebar
          apps={apps}
          drafts={draftApps}
          activePage={page}
          activeId={nav.route.kind === 'app' ? nav.route.id : undefined}
          conversations={conversations}
          activeConversationId={
            nav.route.kind === 'assistant' ? nav.route.conversationId : undefined
          }
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
          onGateway={go({ kind: 'gateway' })}
          gatewayStatus={gatewayStatus}
          onSettings={go({ kind: 'settings' })}
          onAppClick={(id) => nav.navigate({ kind: 'app', id })}
          onNewApp={() => nav.navigate({ kind: 'builder' })}
          onNewChat={() => nav.navigate({ kind: 'assistant' })}
          onSelectConversation={(id) => nav.navigate({ kind: 'assistant', conversationId: id })}
          onDeleteConversation={deleteAssistantConversation}
          onWhatsNew={() => setWhatsNewOpen(true)}
          {...(updateStatus?.available
            ? { updateVersion: updateStatus.version, onRelaunchToUpdate: relaunchToUpdate }
            : {})}
        />
      );
    },
    [
      userApps,
      drafts,
      activeVault,
      vaultSwitcherOpen,
      blockingCount,
      updateStatus,
      gatewayStatus,
      assistantConversations,
      deleteAssistantConversation,
    ],
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
          return <AssistantRoute conversationId={nav.route.conversationId} />;
        case 'insights':
          return <InsightsRoute />;
        case 'automations':
          return <AutomationsRoute />;
        case 'approvals':
          return <ApprovalsRoute />;
        case 'gateway':
          return <GatewayRoute />;
        case 'automation-view':
          return <AutomationViewRoute automationId={nav.route.automationId} />;
        case 'automation-editor':
          return (
            <AutomationEditorRoute
              automationId={nav.route.automationId}
              templateId={nav.route.templateId}
            />
          );
        case 'run-view':
          return <RunViewRoute automationId={nav.route.automationId} runId={nav.route.runId} />;
        case 'discover':
          return (
            <DiscoverRoute userApps={userApps} setUserApps={setUserApps} refreshApps={refresh} />
          );
        case 'templates':
          return <TemplatesRoute />;
        case 'settings':
          return <SettingsRoute prefs={prefs} setPrefs={setPrefs} initialPage={nav.route.page} />;
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
          <ShellActionsProvider
            value={makeActions(
              nav,
              () => setPaletteOpen(true),
              () => {
                void assistantConversations.refresh();
              },
            )}
          >
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
      {whatsNewOpen ? <WhatsNewModal onClose={() => setWhatsNewOpen(false)} /> : null}
      {addGatewayOpen ? (
        <ConnectFlowModal
          context="switcher"
          onCancel={() => setAddGatewayOpen(false)}
          onDone={(result) => {
            setAddGatewayOpen(false);
            showToast(`Connected · ${result.displayLabel}`);
            // The commit already switched the active gateway+vault, which
            // fires onGatewayChanged/onVaultChanged — the reScope effect
            // above picks it up and refreshes the app list + navigates home.
          }}
        />
      ) : null}
      {newSpaceGatewayId ? (
        <SpaceModal
          mode="add"
          initial={{ color: randomSpaceColor(), icon: DEFAULT_SPACE_ICON }}
          onCancel={() => setNewSpaceGatewayId(null)}
          onCommit={(data) => {
            const gatewayId = newSpaceGatewayId;
            setNewSpaceGatewayId(null);
            void (async () => {
              try {
                // `createVault`/`createSpace` operate on the ACTIVE gateway —
                // switch first when the target isn't already active, so "New
                // space" on a non-active gateway's header row is one action
                // from the user's point of view (design doc step C note).
                if (gatewayId !== activeVault.activeGatewayId) {
                  await window.CentraidApi.setActiveGateway({ id: gatewayId });
                }
                await createSpace(data);
                showToast(`Space created · ${data.name}`);
              } catch (err) {
                showToast(
                  `Couldn't create space: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            })();
          }}
        />
      ) : null}
      {testConnectionTarget ? (
        <TestConnectionModal
          gatewayId={testConnectionTarget.gatewayId}
          gatewayLabel={testConnectionTarget.label}
          onClose={() => setTestConnectionTarget(null)}
        />
      ) : null}
      {renameTarget ? (
        <RenameGatewayModal
          initialLabel={renameTarget.label}
          onCancel={() => setRenameTarget(null)}
          onCommit={(label) => {
            const { gatewayId } = renameTarget;
            setRenameTarget(null);
            void window.CentraidApi.renameGateway({ id: gatewayId, label })
              .then(() => showToast(`Renamed · ${label}`))
              .catch((err: unknown) =>
                showToast(`Couldn't rename: ${err instanceof Error ? err.message : String(err)}`),
              );
          }}
        />
      ) : null}
    </>
  );
}
