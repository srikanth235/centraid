// governance: allow-repo-hygiene file-size-limit (#382) the shell root
// wiring every route + the grouped switcher's popover callbacks crossed 500
// by 16 lines; a route-wiring extraction is a reasonable follow-up but not
// warranted for this margin.
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IconName } from '@centraid/design-tokens';
import type { ShellRoute } from '../../app-shell-context.js';
import PaletteScreen from '../screens/PaletteScreen.js';
import { type ShellActions, ShellActionsProvider } from './actions.js';
import { openConfirm } from './confirm.js';
import { openMenu } from './contextMenu.js';
import { openPrompt } from './prompt.js';
import { showUndoToast } from './undoToast.js';
import { relativeTime } from '../../app-format.js';
import {
  ASSISTANT_APP_ID,
  deleteConversation,
  loadConversation,
  renameConversation,
  searchConversations,
  setConversationArchived,
  setConversationPinned,
} from '../../gateway-client.js';
import { buildPaletteGroups } from './routes/paletteData.js';
import { createPaletteConversationSearch } from './routes/paletteConversationSearch.js';
import { downloadConversation, type ExportFormat } from './routes/conversationExport.js';
import ProfileSwitcherHead from './ProfileSwitcherHead.js';
import Sidebar, {
  type ShellMenuAnchor,
  type SidebarConversation,
  type SidebarPage,
} from './Sidebar.js';
import ShellApp, { type ShellNav } from './ShellApp.js';
import { showToast } from './toast.js';
import { toSidebarApps } from './sidebarApps.js';
import { PageEmpty } from './status.js';
import { useActiveVault } from './useActiveVault.js';
import { useAppearance } from './useAppearance.js';
import { useBuilderEnabled } from './useBuilderEnabled.js';
import { useAssistantConversations } from './useAssistantConversations.js';
import { useBlockingCount } from './useBlockingCount.js';
import { useGatewayRuntime } from './useGatewayRuntime.js';
import { useShellApps } from './useShellApps.js';
import { useStarred } from './useStarred.js';
import WhatsNewModal from '../screens/WhatsNewModal.js';
import { relaunchToUpdate, updatePillTitle, useUpdateStatus } from './useUpdateStatus.js';
import { applySelection, resolveSelection, type PairRow } from './flatVaultSwitcher-core.js';
import { getCachedGroupedRows, openGroupedVaultRegistry } from './flatVaultSwitcherRegistry.js';
import { closeVaultSwitcher, openVaultSwitcher, updateVaultSwitcherRows } from './vaultSwitcher.js';
import ApprovalsRoute from './routes/ApprovalsRoute.js';
import AppViewRoute from './routes/AppViewRoute.js';
import InlineAppRoute from './routes/InlineAppRoute.js';
import { inlineAppLoader } from './routes/inlineApps.js';
import AtlasRoute from './routes/AtlasRoute.js';
import AssistantRoute from './routes/AssistantRoute.js';
import AutomationEditorRoute from './routes/AutomationEditorRoute.js';
import AutomationsRoute from './routes/AutomationsRoute.js';
import AutomationViewRoute from './routes/AutomationViewRoute.js';
import BackupsRoute from './routes/BackupsRoute.js';
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
  builderEnabled: boolean,
): ShellActions {
  return {
    showToast,
    builderEnabled,
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
    case 'backups':
    case 'atlas':
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

/** Compact error-message extractor for toast copy. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Drafts are builder artifacts (issue #434, Phase 3) — when the builder is
// hidden they never render anywhere. A shared frozen empty list keeps the
// gated-off case referentially stable so the render callbacks don't churn.
const NO_DRAFTS: readonly DraftAppMeta[] = [];

// Guard for a `builder` / `automation-builder` route reached while the builder
// is hidden (issue #434, Phase 3) — e.g. a stale persisted/programmatic route.
// Swaps the current history entry for Home in place (replace, not navigate) so
// there's no dead builder frame to Back into, and renders nothing meanwhile.
export function BuilderRouteRedirect({ nav }: { nav: ShellNav }): JSX.Element {
  useEffect(() => {
    nav.replace({ kind: 'home' });
  }, [nav]);
  return <PageEmpty message="" />;
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
  // Conversations mid-undo-window after a delete — optimistically hidden from
  // the sidebar until the grace timer commits or the reader undoes (§3).
  const [pendingConversationDeletes, setPendingConversationDeletes] = useState<Set<string>>(
    () => new Set(),
  );
  const { isStarred, toggleStar } = useStarred();
  const activeVault = useActiveVault();
  const blockingCount = useBlockingCount();
  const updateStatus = useUpdateStatus();
  // I12 / #501 — What's new re-wired to GitHub release notes (main changelog.ts).
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [whatsNewAutoChecked, setWhatsNewAutoChecked] = useState(false);

  // I12: auto-open What's new once per installed version after a successful
  // changelog fetch (changelogSeenVersion in desktop settings).
  useEffect(() => {
    if (whatsNewAutoChecked) return;
    let alive = true;
    void (async () => {
      try {
        const get = window.CentraidApi.getChangelog;
        const getSettings = window.CentraidApi.getSettings;
        if (!get || !getSettings) {
          if (alive) setWhatsNewAutoChecked(true);
          return;
        }
        const [changelog, settings] = await Promise.all([get(), getSettings()]);
        if (!alive) return;
        setWhatsNewAutoChecked(true);
        const current = changelog.currentVersion?.replace(/^v/i, '') ?? '';
        const seen = (settings.changelogSeenVersion ?? '').replace(/^v/i, '');
        if (current && current !== seen && changelog.releases.length > 0) {
          setWhatsNewOpen(true);
        }
      } catch {
        if (alive) setWhatsNewAutoChecked(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [whatsNewAutoChecked]);

  const closeWhatsNew = useCallback(() => {
    setWhatsNewOpen(false);
    void (async () => {
      try {
        const changelog = await window.CentraidApi.getChangelog?.();
        const ver = changelog?.currentVersion;
        if (ver) {
          await window.CentraidApi.saveSettings?.({ changelogSeenVersion: ver });
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);
  const gatewayStatus = useGatewayRuntime()?.status;
  // Dev flag (issue #434, Phase 3): the builder + every entry point into it are
  // hidden from the first release unless this is set. Threaded into ShellActions
  // (menus/palette read it), used to gate drafts + the "Build new" affordances
  // here, and to redirect the builder routes below.
  const builderEnabled = useBuilderEnabled();
  const navRef = useRef<ShellNav | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The palette's injected refresh() (issue #420) — held so the async
  // conversation-search source can re-run buildPaletteGroups when hits land.
  const paletteRefreshRef = useRef<(() => void) | null>(null);
  const paletteConversationSearch = useMemo(
    () =>
      createPaletteConversationSearch({
        search: (query, limit) => searchConversations(ASSISTANT_APP_ID, query, limit),
        onResults: () => paletteRefreshRef.current?.(),
      }),
    [],
  );
  const [vaultSwitcherOpen, setVaultSwitcherOpen] = useState(false);
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

  // Sidebar "Chats" row delete — mirrors the vanilla AssistantRoute's old
  // deleteThread confirm pattern, now living here since the sidebar (not
  // AssistantRoute) owns the conversation list + row actions. Bounces off
  // the fresh assistant route if the conversation being deleted is the one
  // currently open.
  // Delete with a 6s undo grace window (§3): the row hides immediately and the
  // open thread bounces to a fresh one, but the FK-CASCADE delete only commits
  // when the window lapses — an Undo restores the row untouched.
  const deleteAssistantConversation = useCallback(
    (id: string) => {
      const target = assistantConversations.conversations.find((c) => c.id === id);
      setPendingConversationDeletes((prev) => new Set(prev).add(id));
      const cur = navRef.current?.route;
      if (cur?.kind === 'assistant' && cur.conversationId === id) {
        navRef.current?.navigate({ kind: 'assistant' });
      }
      const unhide = (): void =>
        setPendingConversationDeletes((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      showUndoToast(`Deleted “${target?.title || 'New conversation'}”`, unhide, {
        onExpire: () => {
          void (async () => {
            await deleteConversation(ASSISTANT_APP_ID, id).catch((err: unknown) =>
              showToast(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`),
            );
            unhide();
            await assistantConversations.refresh();
          })();
        },
      });
    },
    [assistantConversations],
  );

  // Inline rename (§3) — the shared text-prompt dialog, then a PATCH + refresh.
  const renameAssistantConversation = useCallback(
    (id: string) => {
      const target = assistantConversations.conversations.find((c) => c.id === id);
      void (async () => {
        const next = await openPrompt({
          title: 'Rename conversation',
          initial: target?.title ?? '',
          placeholder: 'Conversation name',
          confirmLabel: 'Rename',
        });
        if (!next) return;
        await renameConversation(ASSISTANT_APP_ID, id, next).catch((err: unknown) =>
          showToast(`Couldn't rename: ${err instanceof Error ? err.message : String(err)}`),
        );
        await assistantConversations.refresh();
      })();
    },
    [assistantConversations],
  );

  // Pin/unpin (§3) — a PATCH + refresh; the store sorts pinned threads first.
  const pinAssistantConversation = useCallback(
    (id: string, pinned: boolean) => {
      void (async () => {
        await setConversationPinned(ASSISTANT_APP_ID, id, pinned).catch((err: unknown) =>
          showToast(`Couldn't ${pinned ? 'pin' : 'unpin'}: ${errMsg(err)}`),
        );
        await assistantConversations.refresh();
      })();
    },
    [assistantConversations],
  );

  // Archive/unarchive (§3) — a PATCH + refresh. Archiving the open thread
  // bounces to a fresh assistant, mirroring delete (the row leaves the list).
  const archiveAssistantConversation = useCallback(
    (id: string, archived: boolean) => {
      void (async () => {
        await setConversationArchived(ASSISTANT_APP_ID, id, archived).catch((err: unknown) =>
          showToast(`Couldn't ${archived ? 'archive' : 'unarchive'}: ${errMsg(err)}`),
        );
        const cur = navRef.current?.route;
        if (archived && cur?.kind === 'assistant' && cur.conversationId === id) {
          navRef.current?.navigate({ kind: 'assistant' });
        }
        await assistantConversations.refresh();
      })();
    },
    [assistantConversations],
  );

  // Export (§3) — fetch the full transcript, then serialize + download.
  const exportAssistantConversation = useCallback((id: string, format: ExportFormat) => {
    void (async () => {
      try {
        const conv = await loadConversation(ASSISTANT_APP_ID, id);
        downloadConversation(conv, format);
      } catch (err: unknown) {
        showToast(`Couldn't export: ${errMsg(err)}`);
      }
    })();
  }, []);

  // The sidebar row ••• / right-click menu: Rename, Export, Pin, Archive, Delete.
  const conversationMenu = useCallback(
    (id: string, anchor: ShellMenuAnchor) => {
      const conv = assistantConversations.conversations.find((c) => c.id === id);
      const pinned = conv?.pinned ?? false;
      const archived = conv?.archived ?? false;
      openMenu(
        [
          { id: 'rename', label: 'Rename', icon: 'Pencil' },
          { id: 'export-md', label: 'Export as Markdown', icon: 'Share' },
          { id: 'export-json', label: 'Export as JSON', icon: 'Share' },
          'sep',
          pinned
            ? { id: 'unpin', label: 'Unpin', icon: 'Star' }
            : { id: 'pin', label: 'Pin', icon: 'Star' },
          archived
            ? { id: 'unarchive', label: 'Unarchive', icon: 'History' }
            : { id: 'archive', label: 'Archive', icon: 'Folder' },
          'sep',
          { id: 'delete', label: 'Delete', icon: 'Trash', danger: true },
        ],
        anchor,
        (picked) => {
          if (picked === 'rename') renameAssistantConversation(id);
          else if (picked === 'export-md') exportAssistantConversation(id, 'markdown');
          else if (picked === 'export-json') exportAssistantConversation(id, 'json');
          else if (picked === 'pin') pinAssistantConversation(id, true);
          else if (picked === 'unpin') pinAssistantConversation(id, false);
          else if (picked === 'archive') archiveAssistantConversation(id, true);
          else if (picked === 'unarchive') archiveAssistantConversation(id, false);
          else if (picked === 'delete') deleteAssistantConversation(id);
        },
      );
    },
    [
      assistantConversations,
      renameAssistantConversation,
      exportAssistantConversation,
      pinAssistantConversation,
      archiveAssistantConversation,
      deleteAssistantConversation,
    ],
  );

  const renderSidebar = useCallback(
    (nav: ShellNav) => {
      const { apps, drafts: draftApps } = toSidebarApps(
        userApps,
        builderEnabled ? drafts : NO_DRAFTS,
      );
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
      const conversations: SidebarConversation[] = assistantConversations.conversations
        .filter((c) => !pendingConversationDeletes.has(c.id))
        .map((c) => ({
          id: c.id,
          title: c.title || 'New conversation',
          timeLabel: relativeTime(new Date(c.updatedAt).toISOString()),
          pinned: c.pinned,
          archived: c.archived,
        }));
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
          onBackups={go({ kind: 'backups' })}
          onAtlas={go({ kind: 'atlas' })}
          onSettings={go({ kind: 'settings' })}
          onAppClick={(id) => nav.navigate({ kind: 'app', id })}
          {...(builderEnabled ? { onNewApp: () => nav.navigate({ kind: 'builder' }) } : {})}
          onNewChat={() => nav.navigate({ kind: 'assistant' })}
          onSelectConversation={(id) => nav.navigate({ kind: 'assistant', conversationId: id })}
          onDeleteConversation={deleteAssistantConversation}
          onConversationMenu={conversationMenu}
          onWhatsNew={() => setWhatsNewOpen(true)}
          {...(updateStatus?.available
            ? {
                updateVersion: updateStatus.version,
                onRelaunchToUpdate: relaunchToUpdate,
                updatePillTitle: updatePillTitle(updateStatus),
                updateReadyToInstall: updateStatus.readyToInstall !== false,
              }
            : {})}
        />
      );
    },
    [
      userApps,
      drafts,
      builderEnabled,
      activeVault,
      vaultSwitcherOpen,
      blockingCount,
      updateStatus,
      gatewayStatus,
      assistantConversations,
      deleteAssistantConversation,
      conversationMenu,
      pendingConversationDeletes,
    ],
  );

  const renderRoute = useCallback(
    (nav: ShellNav): JSX.Element => {
      // Drafts are builder artifacts — hide them everywhere when the builder is
      // off (issue #434, Phase 3). Gated once here so Home, Starred, the app
      // lookup, and the sidebar all agree.
      const visibleDrafts = builderEnabled ? drafts : NO_DRAFTS;
      switch (nav.route.kind) {
        case 'home':
          return (
            <HomeRoute
              userApps={userApps}
              drafts={visibleDrafts}
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
        case 'backups':
          return <BackupsRoute />;
        case 'atlas':
          return <AtlasRoute />;
        case 'automation-view':
          return <AutomationViewRoute automationId={nav.route.automationId} />;
        case 'automation-editor':
          return (
            <AutomationEditorRoute
              automationId={nav.route.automationId}
              templateId={nav.route.templateId}
              watchEntity={nav.route.watchEntity}
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
          const app = [...userApps, ...visibleDrafts].find((a) => a.id === id);
          if (!app) return <PageEmpty message="App not found." />;
          const ua = userApps.find((a) => a.id === id);
          const appId = ua?.centraidAppId ?? app.id;
          // Bundled (blueprint) apps converted to an inline route render
          // in-shell (no iframe) and offline-capable, REGARDLESS of builder
          // state. The builder is a separate route (`kind: 'builder'`) reached
          // via the Build button — which InlineAppRoute itself renders — and it
          // remixes a blueprint into a NEW user app with its own id; it never
          // edits the shipped blueprint source in place, so the inline and
          // served paths render identical code and there is no divergence to
          // protect against here. User apps have no inline loader and fall
          // through to AppViewRoute as before (issue #505).
          const inlineLoader = inlineAppLoader(appId);
          if (inlineLoader) {
            return (
              <InlineAppRoute
                app={app}
                appId={appId}
                loader={inlineLoader}
                nav={nav}
                renderSidebar={renderSidebar}
                prefs={prefs}
                onToggleSidebar={() => setPrefs({ sidebarOpen: !prefs.sidebarOpen })}
              />
            );
          }
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
        case 'automation-builder':
          // Builder handoff route — gated with the builder (issue #434, Phase
          // 3). Normal automation editing lives on `automation-editor`.
          if (!builderEnabled) return <BuilderRouteRedirect nav={nav} />;
          return <AutomationEditorRoute automationId={nav.route.automationId} />;
        case 'builder':
          if (!builderEnabled) return <BuilderRouteRedirect nav={nav} />;
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
              drafts={visibleDrafts}
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
    [
      userApps,
      drafts,
      builderEnabled,
      prefs,
      setPrefs,
      isStarred,
      toggleStar,
      refresh,
      setUserApps,
      renderSidebar,
    ],
  );

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    paletteConversationSearch.reset();
  }, [paletteConversationSearch]);

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
              builderEnabled,
            )}
          >
            {renderRoute(nav)}
          </ShellActionsProvider>
        )}
        {...(builderEnabled
          ? { onNewApp: () => navRef.current?.navigate({ kind: 'builder' }) }
          : {})}
      />
      {whatsNewOpen ? <WhatsNewModal onClose={closeWhatsNew} /> : null}
      {paletteOpen ? (
        <PaletteScreen
          onClose={closePalette}
          onReady={(refresh) => {
            paletteRefreshRef.current = refresh;
          }}
          buildGroups={(query) =>
            buildPaletteGroups(query, {
              userApps,
              drafts: builderEnabled ? drafts : NO_DRAFTS,
              builderEnabled,
              tileVariant: prefs.tileVariant,
              navigate: (route) => navRef.current?.navigate(route),
              enterBuilder: (initialPrompt) =>
                navRef.current?.navigate({
                  kind: 'builder',
                  ...(initialPrompt ? { initialPrompt } : {}),
                }),
              onClose: closePalette,
              conversationSearch: paletteConversationSearch,
            })
          }
        />
      ) : null}
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
