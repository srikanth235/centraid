// governance: allow-repo-hygiene file-size-limit (#382) the shell root wires
// every route plus the sidebar's conversation actions and the surviving gateway
// switcher's popover callbacks. A route-wiring extraction remains the right
// follow-up; #599 shrank this file rather than growing it (the space switcher's
// callbacks and the New-space modal left for Household).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { relativeTime } from "../../app-format.js";
import type { ShellRoute } from "../../app-shell-context.js";
import {
  ASSISTANT_APP_ID,
  deleteConversation,
  enableWebPushWake,
  loadConversation,
  renameConversation,
  searchConversations,
  setConversationArchived,
  setConversationPinned,
  syncWebDueNotifications,
} from "../../gateway-client.js";
import PaletteScreen from "../screens/PaletteScreen.js";
import WhatsNewModal from "../screens/WhatsNewModal.js";
import { ShellActionsProvider } from "./actions.js";
import type { ShellActions } from "./actions.js";
import { CaptureLauncher, CaptureOverlay } from "./CaptureOverlay.js";
import { openConfirm } from "./confirm.js";
import { openMenu } from "./contextMenu.js";
import {
  getCachedGatewayRows,
  openGatewayRegistry,
} from "./gatewayRegistry.js";
import {
  closeGatewaySwitcher,
  openGatewaySwitcher,
  updateGatewaySwitcherRows,
} from "./gatewaySwitcher.js";
import IdentityHead from "./IdentityHead.js";
import { openPrompt } from "./prompt.js";
import ApprovalsRoute from "./routes/ApprovalsRoute.js";
import AppViewRoute from "./routes/AppViewRoute.js";
import AssistantRoute from "./routes/AssistantRoute.js";
import AtlasRoute from "./routes/AtlasRoute.js";
import AutomationEditorRoute from "./routes/AutomationEditorRoute.js";
import AutomationsRoute from "./routes/AutomationsRoute.js";
import AutomationViewRoute from "./routes/AutomationViewRoute.js";
import BuilderRoute from "./routes/BuilderRoute.js";
import ConnectFlowModal from "./routes/ConnectFlowModal.js";
import ConnectorsRoute from "./routes/ConnectorsRoute.js";
import { downloadConversation } from "./routes/conversationExport.js";
import type { ExportFormat } from "./routes/conversationExport.js";
import {
  conversationScope,
  conversationScopes,
} from "./routes/conversationScopes.js";
import DiscoverRoute from "./routes/DiscoverRoute.js";
import GatewayRoute from "./routes/GatewayRoute.js";
import HomeRoute from "./routes/HomeRoute.js";
import HouseholdRoute from "./routes/HouseholdRoute.js";
import InlineAppRoute from "./routes/InlineAppRoute.js";
import { inlineAppLoader } from "./routes/inlineApps.js";
import InsightsRoute from "./routes/InsightsRoute.js";
import { createPaletteConversationSearch } from "./routes/paletteConversationSearch.js";
import { buildPaletteGroups } from "./routes/paletteData.js";
import RenameGatewayModal from "./routes/RenameGatewayModal.js";
import RunViewRoute from "./routes/RunViewRoute.js";
import SettingsRoute from "./routes/SettingsRoute.js";
import StarredRoute from "./routes/StarredRoute.js";
import StorageRoute from "./routes/StorageRoute.js";
import TemplatesRoute from "./routes/TemplatesRoute.js";
import TestConnectionModal from "./routes/TestConnectionModal.js";
import ShellApp from "./ShellApp.js";
import type { ShellNav } from "./ShellApp.js";
import Sidebar from "./Sidebar.js";
import type {
  ShellMenuAnchor,
  SidebarConversation,
  SidebarPage,
} from "./Sidebar.js";
import { PageEmpty } from "./status.js";
import { showToast } from "./toast.js";
import { showUndoToast } from "./undoToast.js";
import { useAppearance } from "./useAppearance.js";
import { useAssistantConversations } from "./useAssistantConversations.js";
import { useBlockingCount } from "./useBlockingCount.js";
import { useBuilderEnabled } from "./useBuilderEnabled.js";
import { useGatewayRuntime } from "./useGatewayRuntime.js";
import { useMemberScopes } from "./useMemberScopes.js";
import { useShellApps } from "./useShellApps.js";
import { useStarred } from "./useStarred.js";
import {
  relaunchToUpdate,
  updatePillTitle,
  useUpdateStatus,
} from "./useUpdateStatus.js";

import chrome from "./chrome.module.css";

// Build the ShellActions surface for the current render. Navigation + toast +
// confirm are live; the remaining overlay actions (⌘K palette, the generic app
// context menu) are wired as their clusters land — until then they route to the
// builder or no-op so a consumer never crashes.
function makeActions(
  nav: ShellNav,
  openCommandPalette: () => void,
  refreshAssistantThreads: () => void,
  builderEnabled: boolean
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
        kind: "builder",
        ...(opts.appContext ? { appContext: opts.appContext } : {}),
        ...(opts.initialPrompt ? { initialPrompt: opts.initialPrompt } : {}),
      }),
    openNewAppSheet: () => nav.navigate({ kind: "builder" }),
    openCommandPalette,
    openContextMenu: () => {
      /* the home app-card context menu is wired inside HomeRoute */
    },
  };
}

// Map the current route to the sidebar's active-page highlight.
function activePageFor(route: ShellRoute): SidebarPage | undefined {
  switch (route.kind) {
    case "home":
    case "assistant":
    case "insights":
    case "discover":
    case "starred":
    case "automations":
    case "connectors":
    case "approvals":
    case "household":
    case "atlas":
      return route.kind;
    case "gateway":
    case "storage":
      return "gateway";
    case "settings":
      // Legacy deep link Settings → Connections → promote highlight to Connectors.
      return route.page === "connections" ? "connectors" : "settings";
    case "app":
    case "builder":
    case "run-view":
    case "automation-view":
    case "automation-builder":
    case "automation-editor":
    case "templates":
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
    nav.replace({ kind: "home" });
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
  const [pendingConversationDeletes, setPendingConversationDeletes] = useState<
    Set<string>
  >(() => new Set());
  const { isStarred, toggleStar } = useStarred();
  const memberScopes = useMemberScopes();
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
        const current = changelog.currentVersion?.replace(/^v/iu, "") ?? "";
        const seen = (settings.changelogSeenVersion ?? "").replace(/^v/iu, "");
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
          await window.CentraidApi.saveSettings?.({
            changelogSeenVersion: ver,
          });
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);
  const gatewayRuntime = useGatewayRuntime();
  const gatewayStatus = gatewayRuntime?.status;
  // Dev flag (issue #434, Phase 3): the builder + every entry point into it are
  // hidden from the first release unless this is set. Threaded into ShellActions
  // (menus/palette read it), used to gate drafts + the "Build new" affordances
  // here, and to redirect the builder routes below.
  const builderEnabled = useBuilderEnabled();
  const navRef = useRef<ShellNav | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(() =>
    new URL(window.location.href).searchParams.has("capture")
  );
  const captureInitialText = useMemo(() => sharedCaptureText(), []);
  // The palette's injected refresh() (issue #420) — held so the async
  // conversation-search source can re-run buildPaletteGroups when hits land.
  // Created once per mount; the palette hands it its `refresh()` on mount via
  // `setOnResults` (see `onReady` below), so nothing here has to hold that
  // callback in a ref and reach for it during render.
  const paletteConversationSearch = useMemo(
    () =>
      createPaletteConversationSearch({
        search: (query, limit) =>
          searchConversations(ASSISTANT_APP_ID, query, limit),
      }),
    []
  );
  const [gatewaySwitcherOpen, setGatewaySwitcherOpen] = useState(false);
  // The switcher's per-gateway actions (issue #382) — "Test connection…",
  // "Rename…" and the footer "Add gateway…" all open one of these small modals;
  // the popover itself already closed by the time any of them fires
  // (gatewaySwitcher.ts closes before invoking a callback), so there's never a
  // stacking concern.
  const [addGatewayOpen, setAddGatewayOpen] = useState(false);
  const [testConnectionTarget, setTestConnectionTarget] = useState<{
    gatewayId: string;
    label: string;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    gatewayId: string;
    label: string;
  } | null>(null);

  // Document-level shortcuts + external re-scope, ported from the vanilla app.ts
  // boot block. Bound once against the live nav (navRef, fed by ShellApp). A
  // gateway (#109) or vault (#289) change invalidates every gateway-scoped piece
  // of renderer state — drop it by re-listing apps + bouncing to Home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "[") {
        e.preventDefault();
        navRef.current?.back();
      } else if (meta && e.key === "]") {
        e.preventDefault();
        navRef.current?.forward();
      } else if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (
        !meta &&
        (e.key === "c" || e.key === "C") &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        setCaptureOpen(true);
      } else if (meta && e.shiftKey && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Switch space or gateway"]'
          )
          ?.click();
      }
    };
    document.addEventListener("keydown", onKey);

    // The delegated builder (window.openBuilder) reaches back through
    // window.Centraid for nav actions (optional-chained). React owns routing
    // now, so publish a nav-backed shim in place of the retired vanilla app.ts.
    const go = (route: ShellRoute) => (): void =>
      void navRef.current?.navigate(route);
    (window as unknown as { Centraid: unknown }).Centraid = {
      openApp: (id: string) => navRef.current?.navigate({ kind: "app", id }),
      openSettings: go({ kind: "settings" }),
      openAppVaultSettings: () =>
        window.dispatchEvent(
          new CustomEvent("centraid:open-app-vault-settings")
        ),
      openCapture: () => setCaptureOpen(true),
      openSearch: () => setPaletteOpen(true),
      openDiscover: go({ kind: "discover" }),
      openStarred: go({ kind: "starred" }),
      openAutomations: go({ kind: "automations" }),
      openConnectors: go({ kind: "connectors" }),
      openInsights: go({ kind: "insights" }),
      renderHome: go({ kind: "home" }),
      getRuntimeMode: () => undefined,
    };
    const onOpenCapture = (): void => setCaptureOpen(true);
    window.addEventListener("centraid:open-capture", onOpenCapture);
    const enablePush = (): void => {
      void enableWebPushWake(true);
    };
    const onPushMessage = (event: MessageEvent): void => {
      if (
        event.origin === window.location.origin &&
        (event.data as { type?: unknown } | null)?.type ===
          "centraid:notification-value"
      )
        enablePush();
    };
    window.addEventListener("centraid:notification-value", enablePush);
    window.addEventListener("message", onPushMessage);
    const onServiceWorkerMessage = (event: MessageEvent): void => {
      if (
        (event.data as { type?: unknown } | null)?.type === "centraid:push-wake"
      )
        void syncWebDueNotifications();
    };
    navigator.serviceWorker?.addEventListener(
      "message",
      onServiceWorkerMessage
    );
    // Re-register an already-granted browser after a service-worker or gateway
    // change; this never prompts at launch.
    if (
      "Notification" in window &&
      window.Notification.permission === "granted"
    )
      void enableWebPushWake(false);

    const reScope = (): void => {
      void refresh();
      navRef.current?.navigate({ kind: "home" });
    };
    window.CentraidApi.onGatewayChanged?.(reScope);
    window.CentraidApi.onVaultChanged?.(reScope);

    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("centraid:open-capture", onOpenCapture);
      window.removeEventListener("centraid:notification-value", enablePush);
      window.removeEventListener("message", onPushMessage);
      navigator.serviceWorker?.removeEventListener(
        "message",
        onServiceWorkerMessage
      );
      // The gateway switcher is a body-portalled overlay outside React's tree —
      // drop it explicitly so it can't outlive the shell root (tests, HMR).
      closeGatewaySwitcher();
    };
  }, [refresh]);

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
      const target = assistantConversations.conversations.find(
        (c) => c.id === id
      );
      setPendingConversationDeletes((prev) => new Set(prev).add(id));
      const cur = navRef.current?.route;
      if (cur?.kind === "assistant" && cur.conversationId === id) {
        navRef.current?.navigate({ kind: "assistant" });
      }
      const unhide = (): void =>
        setPendingConversationDeletes((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      showUndoToast(
        `Deleted “${target?.title || "New conversation"}”`,
        unhide,
        {
          onExpire: () => {
            void (async () => {
              await deleteConversation(
                ASSISTANT_APP_ID,
                id,
                conversationScope(id)
              ).catch((error: unknown) =>
                showToast(
                  `Couldn't delete: ${error instanceof Error ? error.message : String(error)}`
                )
              );
              unhide();
              await assistantConversations.refresh();
            })();
          },
        }
      );
    },
    [assistantConversations]
  );

  // Inline rename (§3) — the shared text-prompt dialog, then a PATCH + refresh.
  const renameAssistantConversation = useCallback(
    (id: string) => {
      const target = assistantConversations.conversations.find(
        (c) => c.id === id
      );
      void (async () => {
        const next = await openPrompt({
          title: "Rename conversation",
          initial: target?.title ?? "",
          placeholder: "Conversation name",
          confirmLabel: "Rename",
        });
        if (!next) return;
        await renameConversation(
          ASSISTANT_APP_ID,
          id,
          next,
          conversationScope(id)
        ).catch((error: unknown) =>
          showToast(
            `Couldn't rename: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        await assistantConversations.refresh();
      })();
    },
    [assistantConversations]
  );

  // Pin/unpin (§3) — a PATCH + refresh; the store sorts pinned threads first.
  const pinAssistantConversation = useCallback(
    (id: string, pinned: boolean) => {
      void (async () => {
        await setConversationPinned(
          ASSISTANT_APP_ID,
          id,
          pinned,
          conversationScope(id)
        ).catch((error: unknown) =>
          showToast(`Couldn't ${pinned ? "pin" : "unpin"}: ${errMsg(error)}`)
        );
        await assistantConversations.refresh();
      })();
    },
    [assistantConversations]
  );

  // Archive/unarchive (§3) — a PATCH + refresh. Archiving the open thread
  // bounces to a fresh assistant, mirroring delete (the row leaves the list).
  const archiveAssistantConversation = useCallback(
    (id: string, archived: boolean) => {
      void (async () => {
        await setConversationArchived(
          ASSISTANT_APP_ID,
          id,
          archived,
          conversationScope(id)
        ).catch((error: unknown) =>
          showToast(
            `Couldn't ${archived ? "archive" : "unarchive"}: ${errMsg(error)}`
          )
        );
        const cur = navRef.current?.route;
        if (
          archived &&
          cur?.kind === "assistant" &&
          cur.conversationId === id
        ) {
          navRef.current?.navigate({ kind: "assistant" });
        }
        await assistantConversations.refresh();
      })();
    },
    [assistantConversations]
  );

  // Export (§3) — fetch the full transcript, then serialize + download.
  const exportAssistantConversation = useCallback(
    (id: string, format: ExportFormat) => {
      void (async () => {
        try {
          const conv = await loadConversation(
            ASSISTANT_APP_ID,
            id,
            conversationScope(id)
          );
          downloadConversation(conv, format);
        } catch (error: unknown) {
          showToast(`Couldn't export: ${errMsg(error)}`);
        }
      })();
    },
    []
  );

  // The sidebar row ••• / right-click menu: Rename, Export, Pin, Archive, Delete.
  const conversationMenu = useCallback(
    (id: string, anchor: ShellMenuAnchor) => {
      const conv = assistantConversations.conversations.find(
        (c) => c.id === id
      );
      const pinned = conv?.pinned ?? false;
      const archived = conv?.archived ?? false;
      openMenu(
        [
          { id: "rename", label: "Rename", icon: "Pencil" },
          { id: "export-md", label: "Export as Markdown", icon: "Share" },
          { id: "export-json", label: "Export as JSON", icon: "Share" },
          "sep",
          pinned
            ? { id: "unpin", label: "Unpin", icon: "Star" }
            : { id: "pin", label: "Pin", icon: "Star" },
          archived
            ? { id: "unarchive", label: "Unarchive", icon: "History" }
            : { id: "archive", label: "Archive", icon: "Folder" },
          "sep",
          { id: "delete", label: "Delete", icon: "Trash", danger: true },
        ],
        anchor,
        (picked) => {
          if (picked === "rename") renameAssistantConversation(id);
          else if (picked === "export-md")
            exportAssistantConversation(id, "markdown");
          else if (picked === "export-json")
            exportAssistantConversation(id, "json");
          else if (picked === "pin") pinAssistantConversation(id, true);
          else if (picked === "unpin") pinAssistantConversation(id, false);
          else if (picked === "archive") archiveAssistantConversation(id, true);
          else if (picked === "unarchive")
            archiveAssistantConversation(id, false);
          else if (picked === "delete") deleteAssistantConversation(id);
        }
      );
    },
    [
      assistantConversations,
      renameAssistantConversation,
      exportAssistantConversation,
      pinAssistantConversation,
      archiveAssistantConversation,
      deleteAssistantConversation,
    ]
  );

  const renderSidebar = useCallback(
    (nav: ShellNav) => {
      const page = activePageFor(nav.route);
      const go = (route: ShellRoute) => () => nav.navigate(route);
      // The identity head names the active space and gateway and opens the
      // combined switcher (#608). Spaces are the frequent context change;
      // explicit creation targets and conversation pins remain stronger keys.
      const activeGatewayId = memberScopes.gatewayId ?? "";
      const openGatewayPicker = (anchor: DOMRect): void => {
        setGatewaySwitcherOpen(true);
        const labelOf = (gatewayId: string): string =>
          getCachedGatewayRows(activeGatewayId).find(
            (g) => g.gatewayId === gatewayId
          )?.gatewayLabel ?? gatewayId;
        // Paint instantly from whatever a prior open cached, then probe every
        // registered gateway concurrently and patch rows in place as each
        // settles (stale-while-revalidate).
        openGatewaySwitcher({
          anchor,
          spaces: memberScopes.scopes.map((scope) => ({
            id: scope.id,
            label: scope.label,
            role: scope.role,
            isActive: scope.id === memberScopes.active?.id,
          })),
          rows: getCachedGatewayRows(activeGatewayId),
          onSelectSpace: (vaultId) => {
            void window.CentraidApi.setActiveVault({ vaultId }).catch(
              (error: unknown) =>
                showToast(`Couldn't switch space: ${errMsg(error)}`)
            );
          },
          onAddGateway: () => setAddGatewayOpen(true),
          onSelectGateway: (gatewayId) => {
            void window.CentraidApi.setActiveGateway({ id: gatewayId }).catch(
              (error: unknown) =>
                showToast(`Couldn't switch gateway: ${errMsg(error)}`)
            );
          },
          onRemoveGateway: (gatewayId) => {
            void (async () => {
              const ok = await openConfirm({
                confirmLabel: "Remove",
                danger: true,
                message:
                  "This device stops talking to it — the gateway and its spaces are untouched.",
                title: "Remove this gateway connection?",
              });
              if (!ok) return;
              await window.CentraidApi.removeGateway({ id: gatewayId }).catch(
                (error: unknown) =>
                  showToast(`Couldn't remove: ${errMsg(error)}`)
              );
            })();
          },
          onRenameGateway: (gatewayId) =>
            setRenameTarget({ gatewayId, label: labelOf(gatewayId) }),
          onTestConnection: (gatewayId) =>
            setTestConnectionTarget({ gatewayId, label: labelOf(gatewayId) }),
          onClose: () => setGatewaySwitcherOpen(false),
        });
        void openGatewayRegistry(
          activeGatewayId,
          updateGatewaySwitcherRows
        ).then(updateGatewaySwitcherRows);
      };
      const headSlot = (
        <IdentityHead
          {...(memberScopes.active
            ? {
                space: {
                  name: memberScopes.active.label,
                  color: memberScopes.active.color ?? "#4E68DD",
                  icon: memberScopes.active.icon ?? "Sparkle",
                },
              }
            : {})}
          gatewayLabel={
            memberScopes.loading
              ? "—"
              : (memberScopes.gatewayKind === "local"
                  ? "This Mac"
                  : memberScopes.gatewayLabel) || "This Mac"
          }
          onOpenHousehold={() => nav.navigate({ kind: "household" })}
          onSwitchGateway={openGatewayPicker}
          switcherOpen={gatewaySwitcherOpen}
        />
      );
      // Rows carry their space only when it is NOT the member's own — a
      // conversation belongs to one space for life (#599), and saying so on
      // every row would drown the useful case.
      const scopeById = conversationScopes();
      const ownScopeId = memberScopes.primary?.id;
      const conversations: SidebarConversation[] =
        assistantConversations.conversations
          .filter((c) => !pendingConversationDeletes.has(c.id))
          .map((c) => {
            const scopeId = scopeById[c.id];
            const label =
              scopeId && scopeId !== ownScopeId
                ? memberScopes.scopes.find((s) => s.id === scopeId)?.label
                : undefined;
            return {
              id: c.id,
              title: c.title || "New conversation",
              timeLabel: relativeTime(new Date(c.updatedAt).toISOString()),
              pinned: c.pinned,
              archived: c.archived,
              ...(label ? { scopeLabel: label } : {}),
            };
          });
      return (
        <Sidebar
          activePage={page}
          conversations={conversations}
          activeConversationId={
            nav.route.kind === "assistant"
              ? nav.route.conversationId
              : undefined
          }
          headSlot={headSlot}
          onHome={go({ kind: "home" })}
          onSearch={() => setPaletteOpen(true)}
          onAssistant={go({ kind: "assistant" })}
          onInsights={go({ kind: "insights" })}
          onDiscover={go({ kind: "discover" })}
          onAutomations={go({ kind: "automations" })}
          onConnectors={go({ kind: "connectors" })}
          onApprovals={go({ kind: "approvals" })}
          approvalsCount={blockingCount}
          onGateway={go({ kind: "gateway" })}
          gatewayStatus={gatewayStatus}
          onHousehold={go({ kind: "household" })}
          onAtlas={go({ kind: "atlas" })}
          onSettings={go({ kind: "settings" })}
          {...(builderEnabled
            ? { onNewApp: () => nav.navigate({ kind: "builder" }) }
            : {})}
          onNewChat={() => nav.navigate({ kind: "assistant" })}
          onSelectConversation={(id) =>
            nav.navigate({ kind: "assistant", conversationId: id })
          }
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
      builderEnabled,
      memberScopes,
      gatewaySwitcherOpen,
      blockingCount,
      updateStatus,
      gatewayStatus,
      assistantConversations,
      deleteAssistantConversation,
      conversationMenu,
      pendingConversationDeletes,
    ]
  );

  const renderRoute = useCallback(
    (nav: ShellNav): JSX.Element => {
      // Drafts are builder artifacts — hide them everywhere when the builder is
      // off (issue #434, Phase 3). Gated once here so Home, Starred, the app
      // lookup, and the sidebar all agree.
      const visibleDrafts = builderEnabled ? drafts : NO_DRAFTS;
      switch (nav.route.kind) {
        case "home":
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
        case "assistant":
          return <AssistantRoute conversationId={nav.route.conversationId} />;
        case "insights":
          return <InsightsRoute />;
        case "automations":
          return <AutomationsRoute />;
        case "connectors":
          return <ConnectorsRoute />;
        case "approvals":
          return <ApprovalsRoute />;
        case "gateway":
          return <GatewayRoute />;
        case "household":
          return <HouseholdRoute />;
        case "storage":
          return <StorageRoute />;
        case "atlas":
          return <AtlasRoute />;
        case "automation-view":
          // Keyed so an in-place automation change remounts: traces, watched
          // turn ids, and any open SSE all belong to one automation (#541).
          return (
            <AutomationViewRoute
              key={nav.route.automationId}
              automationId={nav.route.automationId}
            />
          );
        case "automation-editor":
          return (
            <AutomationEditorRoute
              automationId={nav.route.automationId}
              templateId={nav.route.templateId}
              watchEntity={nav.route.watchEntity}
            />
          );
        case "run-view":
          return (
            <RunViewRoute
              automationId={nav.route.automationId}
              runId={nav.route.runId}
            />
          );
        case "discover":
          return (
            <DiscoverRoute
              userApps={userApps}
              setUserApps={setUserApps}
              refreshApps={refresh}
            />
          );
        case "templates":
          return <TemplatesRoute />;
        case "settings":
          // Legacy deep link: Settings → Connections now lives at Connectors.
          if (nav.route.page === "connections") return <ConnectorsRoute />;
          return (
            <SettingsRoute
              prefs={prefs}
              setPrefs={setPrefs}
              initialPage={nav.route.page}
            />
          );
        case "app": {
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
                onToggleSidebar={() =>
                  setPrefs({ sidebarOpen: !prefs.sidebarOpen })
                }
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
              onToggleSidebar={() =>
                setPrefs({ sidebarOpen: !prefs.sidebarOpen })
              }
            />
          );
        }
        case "automation-builder":
          // Builder handoff route — gated with the builder (issue #434, Phase
          // 3). Normal automation editing lives on `automation-editor`.
          if (!builderEnabled) return <BuilderRouteRedirect nav={nav} />;
          return (
            <AutomationEditorRoute automationId={nav.route.automationId} />
          );
        case "builder":
          if (!builderEnabled) return <BuilderRouteRedirect nav={nav} />;
          return (
            <BuilderRoute
              route={nav.route}
              nav={nav}
              userApps={userApps}
              setUserApps={setUserApps}
              renderSidebar={renderSidebar}
              prefs={prefs}
              onToggleSidebar={() =>
                setPrefs({ sidebarOpen: !prefs.sidebarOpen })
              }
            />
          );
        case "starred":
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
          return (
            <PageEmpty message="This screen is being migrated to React." />
          );
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
    ]
  );

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    paletteConversationSearch.reset();
    // The refresh() belongs to the palette instance that is going away.
    paletteConversationSearch.setOnResults(null);
  }, [paletteConversationSearch]);

  return (
    <>
      <ShellApp
        initialRoute={{ kind: "home" }}
        sidebarOpen={prefs.sidebarOpen}
        onSidebarOpenChange={(open) => setPrefs({ sidebarOpen: open })}
        renderSidebar={renderSidebar}
        statusBanner={
          gatewayStatus === "down" ? (
            <output className={chrome.connectionBanner}>
              <span>
                Offline · changes stay on this device until sync resumes
              </span>
              <button
                type="button"
                onClick={() => navRef.current?.navigate({ kind: "gateway" })}
              >
                Check gateway
              </button>
            </output>
          ) : gatewayStatus === "up" ? (
            <output
              className={chrome.syncIndicator}
              aria-label="Sync status: connected"
            >
              Synced
            </output>
          ) : null
        }
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
              builderEnabled
            )}
          >
            {renderRoute(nav)}
          </ShellActionsProvider>
        )}
        {...(builderEnabled
          ? { onNewApp: () => navRef.current?.navigate({ kind: "builder" }) }
          : {})}
      />
      <CaptureLauncher onOpen={() => setCaptureOpen(true)} />
      {captureOpen ? (
        <CaptureOverlay
          initialText={captureInitialText}
          onClose={() => {
            setCaptureOpen(false);
            clearSharedCaptureQuery();
          }}
        />
      ) : null}
      {whatsNewOpen ? <WhatsNewModal onClose={closeWhatsNew} /> : null}
      {paletteOpen ? (
        <PaletteScreen
          onClose={closePalette}
          onReady={(refreshLocal) => {
            paletteConversationSearch.setOnResults(refreshLocal);
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
                  kind: "builder",
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
              .catch((error: unknown) =>
                showToast(
                  `Couldn't rename: ${error instanceof Error ? error.message : String(error)}`
                )
              );
          }}
        />
      ) : null}
    </>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches("input, textarea, select, [role='textbox']"))
  );
}

function sharedCaptureText(): string {
  const params = new URL(window.location.href).searchParams;
  return [params.get("title"), params.get("text"), params.get("url")]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
}

function clearSharedCaptureQuery(): void {
  const url = new URL(window.location.href);
  for (const key of ["capture", "title", "text", "url"])
    url.searchParams.delete(key);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}
