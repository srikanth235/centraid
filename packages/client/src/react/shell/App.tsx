// governance: allow-repo-hygiene file-size-limit (#382) the shell root wires
// every route plus the conversation actions; extracting route wiring is the
// right follow-up.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { JSX } from "react";

import { themes } from "@centraid/design";

import { relativeTime } from "../../app-format.js";
import type { ShellRoute } from "../../app-shell-context.js";
import { forgetDeviceMessage } from "../../devices-copy.js";
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
  syncWebNotifications,
} from "../../gateway-client.js";
import { isWebHost } from "../host-platform.js";
import PaletteScreen from "../screens/PaletteScreen.js";
import WhatsNewModal from "../screens/WhatsNewModal.js";
import Button from "../ui/Button.js";
import { ShellActionsProvider } from "./actions.js";
import type { ShellActions } from "./actions.js";
import AllAppsSheet from "./AllAppsSheet.js";
import { ambientStatusFor } from "./ambientStatus.js";
import {
  AssistantCompanionController,
  assistantContextLabel,
  readAssistantPageText,
} from "./assistant-companion/index.js";
import { isRouteAvailable, routeCapability } from "./capabilities.js";
import CapabilityWall from "./CapabilityWall.js";
import {
  commitAvailabilityFor,
  CommitAvailabilityProvider,
  OFFLINE_COMMIT_REASON,
} from "./commitAvailability.js";
import { openConfirm } from "./confirm.js";
import { openMenu } from "./contextMenu.js";
import type { ShellMenuAnchor } from "./contextMenu.js";
import {
  getCachedGatewayRows,
  openGatewayRegistry,
} from "./gatewayRegistry.js";
import {
  closeGatewaySwitcher,
  openGatewaySwitcher,
  updateGatewaySwitcherRows,
} from "./gatewaySwitcher.js";
import type { LauncherDestination, ShellPage } from "./launcherModel.js";
import { isOpsPage, opsBarDef, opsBarVerbs } from "./opsBar.js";
import type { OpsPage } from "./opsBar.js";
import { openPrompt } from "./prompt.js";
import { resetQueryCache } from "./queryCache.js";
import { routeKey } from "./router.js";
import ApprovalsRoute from "./routes/ApprovalsRoute.js";
import type { AssistantConversationEntry } from "./routes/AssistantConversations.js";
import AssistantConversations from "./routes/AssistantConversations.js";
import AssistantRoute from "./routes/AssistantRoute.js";
import AutomationEditorRoute from "./routes/AutomationEditorRoute.js";
import AutomationsRoute from "./routes/AutomationsRoute.js";
import AutomationViewRoute from "./routes/AutomationViewRoute.js";
import ConnectFlowModal from "./routes/ConnectFlowModal.js";
import ConnectorsRoute from "./routes/ConnectorsRoute.js";
import { downloadConversation } from "./routes/conversationExport.js";
import type { ExportFormat } from "./routes/conversationExport.js";
import {
  conversationScope,
  conversationScopes,
} from "./routes/conversationScopes.js";
import GatewayRoute from "./routes/GatewayRoute.js";
import HomeRoute from "./routes/HomeRoute.js";
import InlineAppRoute from "./routes/InlineAppRoute.js";
import { inlineAppLoader } from "./routes/inlineApps.js";
import InsightsRoute from "./routes/InsightsRoute.js";
import PairDeviceModal from "./routes/PairDeviceModal.js";
import { createPaletteConversationSearch } from "./routes/paletteConversationSearch.js";
import {
  buildPaletteGroups,
  buildPaletteSuggestions,
} from "./routes/paletteData.js";
import { createPaletteEntitySearch } from "./routes/paletteEntitySearch.js";
import { createPaletteRecents } from "./routes/paletteRecents.js";
import { loadSelfProfile } from "./routes/profileData.js";
import RenameGatewayModal from "./routes/RenameGatewayModal.js";
import RunViewRoute from "./routes/RunViewRoute.js";
import { forgetThisDeviceLocally } from "./routes/settingsAccountData.js";
import SettingsRoute from "./routes/SettingsRoute.js";
import StarredRoute from "./routes/StarredRoute.js";
import StorageRoute from "./routes/StorageRoute.js";
import TemplatesRoute from "./routes/TemplatesRoute.js";
import TestConnectionModal from "./routes/TestConnectionModal.js";
import VaultRoute from "./routes/VaultRoute.js";
import { readAllVerbs, readAllVitals, subscribeVitals } from "./routeVitals.js";
import type { RouteVerbs } from "./routeVitals.js";
import ShellApp from "./ShellApp.js";
import type { ShellAppBar, ShellNav } from "./ShellApp.js";
import { PageEmpty } from "./status.js";
import { postStatus, showUndoStatus } from "./statusChannel.js";
import StatusLine from "./StatusLine.js";
import Stem from "./Stem.js";
import { useAppearance } from "./useAppearance.js";
import { useAssistantConversations } from "./useAssistantConversations.js";
import { useAsyncData } from "./useAsyncData.js";
import { useNotificationsCounts } from "./useBlockingCount.js";
import {
  CapabilitiesProvider,
  useGatewayCapabilities,
} from "./useCapabilities.js";
import { useCompactLayout } from "./useCompactLayout.js";
import { useGatewayStatus } from "./useGatewayRuntime.js";
import { useOwnerScopes } from "./useOwnerScopes.js";
import { usePins } from "./usePins.js";
import { resetInstalledAppsCache, useShellApps } from "./useShellApps.js";
import { useStarred } from "./useStarred.js";
import {
  relaunchToUpdate,
  updatePillTitle,
  useUpdateStatus,
} from "./useUpdateStatus.js";

import chrome from "./chrome.module.css";

// `showToast` keeps its name (~40 callers) but there is no toast in this shell:
// every message lands on the one persistent status line (#707).
function makeActions(
  nav: ShellNav,
  openCommandPalette: () => void,
  refreshAssistantThreads: () => void
): ShellActions {
  return {
    showToast: postStatus,
    confirm: openConfirm,
    navigate: nav.navigate,
    replace: nav.replace,
    refreshAssistantThreads,
    openCommandPalette,
    openContextMenu: () => {
      /* wired inside HomeRoute */
    },
  };
}

// App-bar verbs the SHELL can honour on the six ops routes (#765): plain
// navigations only. A route's `publishRouteVerbs` outranks anything here.
function shellOpsVerbs(
  page: OpsPage,
  nav: ShellNav,
  openPairDevice: () => void
): RouteVerbs {
  switch (page) {
    case "automations":
      return {
        onCommit: () => nav.navigate({ kind: "automation-editor" }),
        onSecondary: () => nav.navigate({ kind: "templates" }),
      };
    case "household":
      return { onCommit: openPairDevice };
    // Listed rather than defaulted, so a seventh ops page must answer this;
    // these four claim the bar through `publishRouteVerbs`.
    case "approvals":
    case "atlas":
    case "connectors":
    case "insights":
      return {};
  }
}

function activePageFor(route: ShellRoute): ShellPage | undefined {
  switch (route.kind) {
    case "home":
    case "assistant":
    case "insights":
    case "starred":
    case "automations":
    case "connectors":
    case "approvals":
    case "household":
    case "atlas":
      return route.kind;
    case "gateway":
      return "gateway";
    case "storage":
      return "gateway";
    case "settings":
      return route.page === "connections" ? "connectors" : "settings";
    case "app":
    case "run-view":
    case "automation-view":
    case "automation-builder":
    case "automation-editor":
    case "templates":
      return undefined;
    default:
      return undefined;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Settings is an overlay, but callers still address `{kind: 'settings'}`: open
// the dialog and `replace` (not push) home, leaving no history entry.
export function SettingsRouteRedirect({
  nav,
  page,
  onOpen,
}: {
  nav: ShellNav;
  page: string | undefined;
  onOpen: (page: string) => void;
}): JSX.Element {
  useEffect(() => {
    onOpen(page ?? "");
    nav.replace({ kind: "home" });
  }, [nav, page, onOpen]);
  return <PageEmpty message="" />;
}

// The shell root: owns renderer state, drives ShellApp (chrome frame + router),
// and renders every route from `renderRoute`.
export default function App({
  seedSampleOnFirstRun = false,
}: {
  seedSampleOnFirstRun?: boolean;
}): JSX.Element {
  // Above the route: navigating away mid-fill must not start a second run.
  const [autoSeedSample, setAutoSeedSample] = useState(seedSampleOnFirstRun);
  const onAutoSeedStarted = useCallback(() => {
    setAutoSeedSample(false);
  }, []);
  const { prefs, setPrefs } = useAppearance();
  // `mutateApps` is deliberately not taken (#659).
  const { userApps, loading: appsLoading, refresh } = useShellApps();
  const assistantConversations = useAssistantConversations();
  // Hidden from the ledger for the delete undo window (§3).
  const [pendingConversationDeletes, setPendingConversationDeletes] = useState<
    Set<string>
  >(() => new Set());
  const { isStarred, toggleStar } = useStarred();
  const { pins, togglePin } = usePins();
  const [allAppsOpen, setAllAppsOpen] = useState(false);
  const compact = useCompactLayout();
  // A PWA cannot claim ⌘K, so the hint hides there — never the control (#707).
  const hasCommandKey = useMemo(() => !isWebHost(), []);
  const ownerScopes = useOwnerScopes();
  const notificationsCounts = useNotificationsCounts();
  const blockingCount = notificationsCounts.decisionCount;
  const updateStatus = useUpdateStatus();
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [whatsNewAutoChecked, setWhatsNewAutoChecked] = useState(false);
  // `null` closed, else the page id ("" = default). Out of the router on
  // purpose: changing a preference must not cost you your place.
  const [settingsPage, setSettingsPage] = useState<string | null>(null);
  const [pairDeviceOpen, setPairDeviceOpen] = useState(false);
  const [accountNonce, setAccountNonce] = useState(0);
  const accountState = useAsyncData(loadSelfProfile, [accountNonce]);
  const account =
    accountState.status === "ready" ? accountState.data : undefined;
  useEffect(() => {
    const bump = (): void => setAccountNonce((n) => n + 1);
    const offGateway = window.CentraidApi.onGatewayChanged?.(bump);
    const offVault = window.CentraidApi.onVaultChanged?.(bump);
    return () => {
      offGateway?.();
      offVault?.();
    };
  }, []);
  const logOut = useCallback((): void => {
    void (async () => {
      const ok = await openConfirm({
        confirmLabel: "Log out",
        danger: true,
        message: forgetDeviceMessage("device"),
        title: "Log out of this device?",
      });
      if (!ok) return;
      await forgetThisDeviceLocally(account?.gatewayId);
    })();
  }, [account?.gatewayId]);

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
  // Reachability verdict only, never the 5s heartbeat snapshot: that re-rendered
  // the active screen every five seconds (#659).
  const gatewayStatus = useGatewayStatus();
  // The ONE read of the capability map (C1, docs/platform-gating.md); everything
  // gated below reads this value, nothing asks the gateway again.
  const { capabilities, resolved: capabilitiesResolved } =
    useGatewayCapabilities();
  const navRef = useRef<ShellNav | null>(null);
  const switcherButtonRef = useRef<HTMLButtonElement | null>(null);
  const switcherActionRef = useRef<(() => void) | null>(null);
  const initialShellRoute = useMemo<ShellRoute>(
    () =>
      new URL(window.location.href).searchParams.has("notifications")
        ? { kind: "approvals" }
        : { kind: "home" },
    []
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteConversationSearch = useMemo(
    () =>
      createPaletteConversationSearch({
        search: (query, limit) =>
          searchConversations(ASSISTANT_APP_ID, query, limit),
      }),
    []
  );
  const paletteEntitySearch = useMemo(() => createPaletteEntitySearch(), []);
  const paletteRecents = useMemo(() => createPaletteRecents(), []);
  const [gatewaySwitcherOpen, setGatewaySwitcherOpen] = useState(false);
  // At the shell root: these must sit above the Settings dialog (#382).
  const [addGatewayOpen, setAddGatewayOpen] = useState(false);
  const [gatewaysRefreshKey, setGatewaysRefreshKey] = useState(0);
  const [testConnectionTarget, setTestConnectionTarget] = useState<{
    gatewayId: string;
    label: string;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    gatewayId: string;
    label: string;
  } | null>(null);
  // The unguarded primitive behind both drop-a-connection surfaces (#665).
  // reScope below lands the shell, so nothing here navigates.
  const dropGatewayConnection = useCallback(
    async (gatewayId: string): Promise<boolean> => {
      try {
        await window.CentraidApi.removeGateway({ id: gatewayId });
        setGatewaysRefreshKey((n) => n + 1);
        return true;
      } catch (error) {
        postStatus(`Couldn't disconnect: ${errMsg(error)}`);
        return false;
      }
    },
    []
  );

  const removeGatewayConnection = useCallback(
    (gatewayId: string, label: string): void => {
      void (async () => {
        const ok = await openConfirm({
          confirmLabel: "Remove",
          danger: true,
          message:
            "This device stops talking to it — the vaults it serves stay intact on their host.",
          title: `Remove ${label}?`,
        });
        if (!ok) return;
        await dropGatewayConnection(gatewayId);
      })();
    },
    [dropGatewayConnection]
  );

  // Bound once against the live nav (navRef, fed by ShellApp). A gateway (#109)
  // or vault (#289) change invalidates every gateway-scoped bit of state.
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
      } else if (meta && e.key === ",") {
        e.preventDefault();
        setSettingsPage((open) => (open === null ? "" : null));
      } else if (meta && e.shiftKey && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        switcherActionRef.current?.();
      }
    };
    document.addEventListener("keydown", onKey);

    const go = (route: ShellRoute) => (): void =>
      void navRef.current?.navigate(route);
    (window as unknown as { Centraid: unknown }).Centraid = {
      openApp: (id: string) => navRef.current?.navigate({ kind: "app", id }),
      openSettings: go({ kind: "settings" }),
      openAppVaultSettings: () =>
        window.dispatchEvent(
          new CustomEvent("centraid:open-app-vault-settings")
        ),
      openSearch: () => setPaletteOpen(true),
      openStarred: go({ kind: "starred" }),
      openAutomations: go({ kind: "automations" }),
      openConnectors: go({ kind: "connectors" }),
      openInsights: go({ kind: "insights" }),
      renderHome: go({ kind: "home" }),
      getRuntimeMode: () => undefined,
    };
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
        void Promise.all([syncWebDueNotifications(), syncWebNotifications()]);
    };
    navigator.serviceWorker?.addEventListener(
      "message",
      onServiceWorkerMessage
    );
    // Re-register an already-granted browser; never prompts at launch.
    if (
      "Notification" in window &&
      window.Notification.permission === "granted"
    )
      void enableWebPushWake(false);

    const reScope = (): void => {
      // Every cached answer describes the OLD gateway/vault; a stale row is a
      // correctness bug, not a slow refresh (#659). The installed set included:
      // an offline launch must not paint the previous vault's grid.
      resetQueryCache();
      resetInstalledAppsCache();
      void refresh();
      navRef.current?.navigate({ kind: "home" });
    };
    const offGatewayScope = window.CentraidApi.onGatewayChanged?.(reScope);
    const offVaultScope = window.CentraidApi.onVaultChanged?.(reScope);

    return () => {
      // Unsubscribe both, or a re-mounted shell stacks pairs and one gateway
      // change runs N re-scopes (#659).
      offGatewayScope?.();
      offVaultScope?.();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("centraid:notification-value", enablePush);
      window.removeEventListener("message", onPushMessage);
      navigator.serviceWorker?.removeEventListener(
        "message",
        onServiceWorkerMessage
      );
      // Body-portalled: drop it or it outlives the shell root (tests, HMR).
      closeGatewaySwitcher();
    };
  }, [refresh]);

  // The shell root owns the ledger's row actions: they reach the router (#707).
  // Delete runs a 6s undo window (§3) — the row hides at once, the FK-CASCADE
  // delete commits only when the window lapses.
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
      showUndoStatus(
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
                postStatus(
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

  // Optimistic (#659): a rejected commit restores the list and says why.
  const patchConversation = useCallback(
    (
      apply: (
        rows: CentraidConversationSummary[]
      ) => CentraidConversationSummary[],
      commit: () => Promise<unknown>,
      failure: (message: string) => string
    ) => {
      void assistantConversations
        .mutate(apply, commit)
        .catch((error: unknown) => postStatus(failure(errMsg(error))));
    },
    [assistantConversations]
  );

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
        patchConversation(
          (rows) =>
            rows.map((row) => (row.id === id ? { ...row, title: next } : row)),
          () =>
            renameConversation(
              ASSISTANT_APP_ID,
              id,
              next,
              conversationScope(id)
            ),
          (message) => `Couldn't rename: ${message}`
        );
      })();
    },
    [assistantConversations, patchConversation]
  );

  // The store sorts pinned first, so the local edit re-sorts too.
  const pinAssistantConversation = useCallback(
    (id: string, pinned: boolean) => {
      patchConversation(
        (rows) =>
          rows
            .map((row) => (row.id === id ? { ...row, pinned } : row))
            .toSorted(
              (left, right) => Number(right.pinned) - Number(left.pinned)
            ),
        () =>
          setConversationPinned(
            ASSISTANT_APP_ID,
            id,
            pinned,
            conversationScope(id)
          ),
        (message) => `Couldn't ${pinned ? "pin" : "unpin"}: ${message}`
      );
    },
    [patchConversation]
  );

  const archiveAssistantConversation = useCallback(
    (id: string, archived: boolean) => {
      patchConversation(
        (rows) =>
          rows.map((row) => (row.id === id ? { ...row, archived } : row)),
        () =>
          setConversationArchived(
            ASSISTANT_APP_ID,
            id,
            archived,
            conversationScope(id)
          ),
        (message) =>
          `Couldn't ${archived ? "archive" : "unarchive"}: ${message}`
      );
      const cur = navRef.current?.route;
      if (archived && cur?.kind === "assistant" && cur.conversationId === id) {
        navRef.current?.navigate({ kind: "assistant" });
      }
    },
    [patchConversation]
  );

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
          postStatus(`Couldn't export: ${errMsg(error)}`);
        }
      })();
    },
    []
  );

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

  // Lists VAULTS ONLY (#608, #665), flattened across gateways: a gateway is
  // transport, so picking a vault elsewhere switches both pointers at once.
  const openVaultSwitcher = useCallback(
    (anchor: DOMRect): void => {
      const activeGatewayId = ownerScopes.gatewayId ?? "";
      setGatewaySwitcherOpen(true);
      openGatewaySwitcher({
        anchor,
        activeGatewayId,
        scopes: ownerScopes.scopes.map((scope) => ({
          id: scope.id,
          label: scope.label,
          isActive: scope.id === ownerScopes.active?.id,
        })),
        rows: getCachedGatewayRows(activeGatewayId),
        onSelectVault: (gatewayId, vaultId) => {
          void (async () => {
            try {
              // Transport first, then the vault pointer — never one alone.
              if (gatewayId !== activeGatewayId)
                await window.CentraidApi.setActiveGateway({ id: gatewayId });
              await window.CentraidApi.setActiveVault({ vaultId });
            } catch (error) {
              postStatus(`Couldn't switch vault: ${errMsg(error)}`);
            }
          })();
        },
        onAddGateway: () => setAddGatewayOpen(true),
        onClose: () => setGatewaySwitcherOpen(false),
      });
      void openGatewayRegistry(activeGatewayId, updateGatewaySwitcherRows).then(
        updateGatewaySwitcherRows
      );
    },
    [ownerScopes]
  );

  // Stable, or the stem re-attaches the anchor every render.
  const setSwitcherButton = useCallback((el: HTMLButtonElement | null) => {
    switcherButtonRef.current = el;
  }, []);

  useEffect(() => {
    switcherActionRef.current = () => {
      const button = switcherButtonRef.current;
      if (button) openVaultSwitcher(button.getBoundingClientRect());
    };
    // This effect OWNS `switcherActionRef`: nothing else may null it out.
    return () => {
      switcherActionRef.current = null;
    };
  }, [openVaultSwitcher]);

  const gatewayLabel = ownerScopes.loading
    ? "—"
    : (ownerScopes.gatewayKind === "local"
        ? "This Mac"
        : ownerScopes.gatewayLabel) || "This Mac";
  // Rows carry a vault label only when it is NOT the owner's own — a
  // conversation belongs to one vault for life (#599).
  const assistantLedger = useMemo<AssistantConversationEntry[]>(() => {
    const scopeById = conversationScopes();
    const ownScopeId = ownerScopes.primary?.id;
    return assistantConversations.conversations
      .filter((c) => !pendingConversationDeletes.has(c.id))
      .map((c) => {
        const scopeId = scopeById[c.id];
        const label =
          scopeId && scopeId !== ownScopeId
            ? ownerScopes.scopes.find((s) => s.id === scopeId)?.label
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
  }, [
    assistantConversations,
    ownerScopes.primary?.id,
    ownerScopes.scopes,
    pendingConversationDeletes,
  ]);

  // ── The one status line (#707, invariant 5) ────────────────────────────
  //
  // Gateway alarm, update pill and notifications count land here and nowhere
  // else: badge counts and red dots are banned, so a count becomes a sentence,
  // worded by `ambientStatus.ts`.
  const ambientStatus = useMemo(
    () =>
      ambientStatusFor({
        blockingCount,
        gatewayStatus,
        hasUnreadNotices: notificationsCounts.hasUnreadNotices,
      }),
    [blockingCount, notificationsCounts.hasUnreadNotices, gatewayStatus]
  );

  useEffect(() => {
    if (!updateStatus?.available) return;
    const line = `${updatePillTitle(updateStatus)} · v${updateStatus.version}`;
    if (updateStatus.readyToInstall === false) postStatus(line);
    else
      postStatus(line, {
        action: { label: "Relaunch", run: relaunchToUpdate },
      });
  }, [updateStatus]);

  const statusLine = useMemo(
    () => (
      <StatusLine
        ambient={ambientStatus}
        offline={gatewayStatus === "down"}
        offlineReason={OFFLINE_COMMIT_REASON}
        offlineAction={{
          label: "Check gateway",
          run: () => navRef.current?.navigate({ kind: "gateway" }),
        }}
      />
    ),
    [ambientStatus, gatewayStatus]
  );

  const stemAccount = useMemo(
    () => ({
      name: account?.name?.trim() || "You",
      ...(account?.avatarColor ? { color: account.avatarColor } : {}),
      onMenu: (anchor: DOMRect): void => {
        openMenu(
          [
            { icon: "Settings", id: "settings", label: "Settings" },
            { icon: "Phone", id: "pair", label: "Pair device" },
            { icon: "Gift", id: "whats-new", label: "What's new" },
            ...(account
              ? ([
                  "sep" as const,
                  {
                    danger: true,
                    icon: "ArrowRight",
                    id: "logout",
                    label: "Log out",
                  },
                ] as const)
              : []),
          ],
          { kind: "rect", rect: anchor },
          (id) => {
            if (id === "settings") setSettingsPage("");
            if (id === "pair") setPairDeviceOpen(true);
            if (id === "whats-new") setWhatsNewOpen(true);
            if (id === "logout") logOut();
          },
          { matchAnchorWidth: true }
        );
      },
    }),
    [account, logOut]
  );

  // The stem (#707, invariant 1). Its identity head is the vault switcher's
  // ONLY anchor, so ⌘⇧G aims here too.
  const renderStem = useCallback(
    (nav: ShellNav) => (
      <Stem
        pins={pins}
        identity={{
          gateway: gatewayLabel,
          onActivate: openVaultSwitcher,
          open: gatewaySwitcherOpen,
          anchorRef: setSwitcherButton,
          vault: ownerScopes.active?.label ?? "Your vault",
          ...(ownerScopes.active?.icon
            ? { icon: ownerScopes.active.icon }
            : {}),
          ...(ownerScopes.active?.color
            ? { color: ownerScopes.active.color }
            : {}),
        }}
        activePage={activePageFor(nav.route)}
        scheme={themes[prefs.theme]?.kind ?? "dark"}
        compact={compact}
        capabilities={capabilities}
        hasCommandKey={hasCommandKey}
        onSelect={(destination: LauncherDestination) => {
          if (destination.id === "settings") setSettingsPage("");
          else nav.navigate(destination.route);
        }}
        onSearch={() => setPaletteOpen(true)}
        onNewConversation={() => nav.navigate({ kind: "assistant" })}
        onAllApps={() => setAllAppsOpen(true)}
        {...(account ? { account: stemAccount } : {})}
        {...(nav.route.kind === "assistant"
          ? {
              ledger: (
                <AssistantConversations
                  conversations={assistantLedger}
                  {...(nav.route.conversationId
                    ? { activeConversationId: nav.route.conversationId }
                    : {})}
                  onSelect={(id) =>
                    nav.navigate({ kind: "assistant", conversationId: id })
                  }
                  onNewChat={() => nav.navigate({ kind: "assistant" })}
                  onDelete={deleteAssistantConversation}
                  onMenu={conversationMenu}
                />
              ),
            }
          : {})}
      />
    ),
    [
      pins,
      prefs.theme,
      compact,
      capabilities,
      hasCommandKey,
      gatewayLabel,
      gatewaySwitcherOpen,
      // The whole scope, not three fields: react-compiler infers the object and
      // refuses to preserve a memo whose declared deps are narrower.
      ownerScopes.active,
      openVaultSwitcher,
      setSwitcherButton,
      assistantLedger,
      conversationMenu,
      deleteAssistantConversation,
      account,
      stemAccount,
    ]
  );

  // The app bar (#708, invariant 3). What a page SAYS is static (`opsBar.ts`);
  // what it says about data it just read arrives on `routeVitals.ts`, never
  // from an effect.
  const openPairDevice = useCallback(() => setPairDeviceOpen(true), []);
  const vitals = useSyncExternalStore(
    subscribeVitals,
    readAllVitals,
    readAllVitals
  );
  const routeVerbs = useSyncExternalStore(
    subscribeVitals,
    readAllVerbs,
    readAllVerbs
  );
  const renderAppBar = useCallback(
    (nav: ShellNav): ShellAppBar | undefined => {
      if (nav.route.kind === "home") return { title: "Home" };
      const page = nav.route.kind;
      if (!isOpsPage(page)) return undefined;
      // A walled route keeps its title but offers no verb it cannot honour.
      if (!isRouteAvailable(page, capabilities))
        return { title: opsBarDef(page).title };
      const vital = vitals[page];
      const verbs = opsBarVerbs(page, vital?.state);
      // A verb renders only once something can perform it: the route publishes
      // what only it can honour, the shell resolves plain navigations.
      const published = routeVerbs[page];
      const fallback = shellOpsVerbs(page, nav, openPairDevice);
      const onCommit = published?.onCommit ?? fallback.onCommit;
      const onSecondary = published?.onSecondary ?? fallback.onSecondary;
      const commit = verbs.commit && onCommit ? verbs.commit : undefined;
      const secondary =
        verbs.secondary && onSecondary ? verbs.secondary : undefined;
      const count = compact ? "" : (vital?.count ?? "");
      return {
        title: opsBarDef(page).title,
        ...(count
          ? { meta: <span className={chrome.opsCount}>{count}</span> }
          : {}),
        ...(commit || secondary
          ? {
              actions: (
                <>
                  {secondary ? (
                    <Button
                      label={secondary.label}
                      onClick={onSecondary}
                      size="chrome"
                      variant="secondary"
                    />
                  ) : null}
                  {commit ? (
                    <Button
                      label={commit.label}
                      onClick={onCommit}
                      size="chrome"
                      variant="primary"
                    />
                  ) : null}
                </>
              ),
            }
          : {}),
      };
    },
    [capabilities, compact, openPairDevice, routeVerbs, vitals]
  );

  const renderRoute = useCallback(
    (nav: ShellNav): JSX.Element => {
      // The capability wall (C1). Deep links and the `window.Centraid` shim
      // still ADDRESS gated routes the launcher hides, so one gate reads the
      // route table here — never a per-case `if` below.
      const gated = routeCapability(nav.route.kind);
      if (gated && !capabilities[gated]) {
        // Before the handshake the shell believes nothing is enabled
        // (`CAPABILITIES_OFF`), so the wall waits behind a blank frame rather
        // than accuse a gateway that has not spoken.
        if (!capabilitiesResolved) return <PageEmpty message="" />;
        return <CapabilityWall capability={gated} />;
      }
      switch (nav.route.kind) {
        case "home":
          return (
            <HomeRoute
              appsLoading={appsLoading}
              userApps={userApps}
              autoSeedSample={autoSeedSample}
              onAutoSeedStarted={onAutoSeedStarted}
            />
          );
        case "assistant":
          // Compact has no stem, so there the ledger is the route's own.
          return (
            <AssistantRoute
              conversationId={nav.route.conversationId}
              {...(compact ? { conversations: assistantLedger } : {})}
              onNewChat={() => nav.navigate({ kind: "assistant" })}
              onSelectConversation={(id) =>
                nav.navigate({ kind: "assistant", conversationId: id })
              }
              onDeleteConversation={deleteAssistantConversation}
              onConversationMenu={conversationMenu}
            />
          );
        case "insights":
          return <InsightsRoute />;
        case "automations":
          return <AutomationsRoute />;
        case "connectors":
          return <ConnectorsRoute />;
        case "approvals":
          return <ApprovalsRoute />;
        case "gateway":
          return (
            <GatewayRoute
              key={routeKey(nav.route)}
              initialTab={nav.route.tab}
              focus={nav.route.focus}
              cause={nav.route.cause}
              connections={{
                refreshKey: gatewaysRefreshKey,
                onRemove: removeGatewayConnection,
                onRename: (gatewayId, label) =>
                  setRenameTarget({ gatewayId, label }),
                onTest: (gatewayId, label) =>
                  setTestConnectionTarget({ gatewayId, label }),
              }}
            />
          );
        // Both kinds resolve to the one Vault custody surface so old deep links
        // land; the kind passes through as the bar's vitals channel.
        case "household":
          return <VaultRoute page="household" />;
        case "storage":
          return <StorageRoute />;
        case "atlas":
          return <VaultRoute page="atlas" />;
        case "automation-view":
          // Keyed so an in-place change remounts: traces, watched turn ids and
          // any open SSE belong to one automation (#541).
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
        case "templates":
          return <TemplatesRoute />;
        case "settings":
          // This legacy deep link reaches the Connectors surface, so it must
          // reach the same wall: the route table keys on `kind`.
          if (nav.route.page === "connections")
            return capabilities.connectors ? (
              <ConnectorsRoute />
            ) : (
              <CapabilityWall capability="connectors" />
            );
          return (
            <SettingsRouteRedirect
              nav={nav}
              page={nav.route.page}
              onOpen={setSettingsPage}
            />
          );
        case "app": {
          const id = nav.route.id;
          const app = userApps.find((a) => a.id === id);
          if (!app) return <PageEmpty message="App not found." />;
          const appId = app.centraidAppId ?? app.id;
          // Every app is an inline route (#799): an id with no inline loader is
          // nothing this client can open.
          const inlineLoader = inlineAppLoader(appId);
          if (!inlineLoader) return <PageEmpty message="App not found." />;
          return (
            <InlineAppRoute
              app={app}
              appId={appId}
              loader={inlineLoader}
              nav={nav}
              renderStem={renderStem}
              statusLine={statusLine}
              prefs={prefs}
              compact={compact}
            />
          );
        }
        case "automation-builder":
          return (
            <AutomationEditorRoute automationId={nav.route.automationId} />
          );
        case "starred":
          return (
            <StarredRoute
              userApps={userApps}
              tileVariant={prefs.tileVariant}
              isStarred={isStarred}
              toggleStar={toggleStar}
            />
          );
        default:
          return (
            <PageEmpty message="This screen is being migrated to React." />
          );
      }
    },
    [
      userApps,
      appsLoading,
      capabilities,
      capabilitiesResolved,
      prefs,
      isStarred,
      toggleStar,
      renderStem,
      statusLine,
      assistantLedger,
      deleteAssistantConversation,
      conversationMenu,
      compact,
      gatewaysRefreshKey,
      removeGatewayConnection,
      autoSeedSample,
      onAutoSeedStarted,
    ]
  );

  // Stable, so ShellApp's memoized outlet has something to compare: an inline
  // arrow rebuilds the whole route tree on every shell-root render (#659).
  const refreshAssistantThreads = useCallback(() => {
    void assistantConversations.refresh();
  }, [assistantConversations]);
  const openCommandPalette = useCallback(() => setPaletteOpen(true), []);
  const closeSettings = useCallback(() => setSettingsPage(null), []);
  const closePairDevice = useCallback(() => setPairDeviceOpen(false), []);
  const renderScreen = useCallback(
    (nav: ShellNav) => (
      <ShellActionsProvider
        value={makeActions(nav, openCommandPalette, refreshAssistantThreads)}
      >
        {renderRoute(nav)}
        {/* Inside the provider: these pages use `useShellActions`. */}
        {settingsPage === null ? null : (
          <SettingsRoute
            prefs={prefs}
            setPrefs={setPrefs}
            initialPage={settingsPage}
            onClose={closeSettings}
            onDisconnectVault={dropGatewayConnection}
          />
        )}
        {pairDeviceOpen ? <PairDeviceModal onClose={closePairDevice} /> : null}
      </ShellActionsProvider>
    ),
    [
      closePairDevice,
      closeSettings,
      dropGatewayConnection,
      openCommandPalette,
      pairDeviceOpen,
      prefs,
      refreshAssistantThreads,
      renderRoute,
      setPrefs,
      settingsPage,
    ]
  );

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    paletteConversationSearch.reset();
    paletteEntitySearch.reset();
    paletteRecents.reset();
    paletteConversationSearch.setOnResults(null);
    paletteEntitySearch.setOnResults(null);
    paletteRecents.setOnResults(null);
  }, [paletteConversationSearch, paletteEntitySearch, paletteRecents]);

  const renderAssistantCompanion = useCallback(
    (
      nav: ShellNav,
      companion: {
        open: boolean;
        setOpen: (open: boolean) => void;
        surface: "pointer" | "touch";
      }
    ) => {
      const handleOpenChange = (open: boolean): void => companion.setOpen(open);
      return (
        <AssistantCompanionController
          surface={companion.surface}
          open={companion.open}
          contextLabel={assistantContextLabel(nav.route)}
          getContextText={readAssistantPageText}
          onOpenChange={handleOpenChange}
          onOpenFull={() => {
            companion.setOpen(false);
            nav.navigate({ kind: "assistant" });
          }}
        />
      );
    },
    []
  );

  return (
    // The offline verdict travels once, from here, to the shared commit control
    // (#708) — modals included: a dialog's Save is a commit.
    <CapabilitiesProvider value={capabilities}>
      <CommitAvailabilityProvider value={commitAvailabilityFor(gatewayStatus)}>
        <ShellApp
          initialRoute={initialShellRoute}
          renderStem={renderStem}
          renderAppBar={renderAppBar}
          renderAssistantCompanion={renderAssistantCompanion}
          statusLine={statusLine}
          onNavReady={(nav) => {
            navRef.current = nav;
          }}
          renderScreen={renderScreen}
        />
        {allAppsOpen ? (
          <AllAppsSheet
            pins={pins}
            compact={compact}
            capabilities={capabilities}
            onTogglePin={togglePin}
            onSelect={(destination) => {
              setAllAppsOpen(false);
              if (destination.id === "settings") setSettingsPage("");
              else navRef.current?.navigate(destination.route);
            }}
            onClose={() => setAllAppsOpen(false)}
          />
        ) : null}
        {whatsNewOpen ? <WhatsNewModal onClose={closeWhatsNew} /> : null}
        {paletteOpen ? (
          <PaletteScreen
            onClose={closePalette}
            onReady={(refreshLocal) => {
              paletteConversationSearch.setOnResults(refreshLocal);
              paletteEntitySearch.setOnResults(refreshLocal);
              paletteRecents.setOnResults(refreshLocal);
            }}
            buildGroups={(query) =>
              buildPaletteGroups(query, {
                userApps,
                capabilities,
                tileVariant: prefs.tileVariant,
                navigate: (route) => navRef.current?.navigate(route),
                onClose: closePalette,
                conversationSearch: paletteConversationSearch,
                entitySearch: paletteEntitySearch,
                recents: paletteRecents,
              })
            }
            suggestions={() =>
              buildPaletteSuggestions({
                userApps,
                capabilities,
                tileVariant: prefs.tileVariant,
                navigate: (route) => navRef.current?.navigate(route),
                onClose: closePalette,
                recents: paletteRecents,
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
              postStatus(`Connected · ${result.displayLabel}`);
              // The commit already switched gateway+vault; reScope lands home.
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
                .then(() => {
                  postStatus(`Renamed · ${label}`);
                  setGatewaysRefreshKey((n) => n + 1);
                })
                .catch((error: unknown) =>
                  postStatus(
                    `Couldn't rename: ${error instanceof Error ? error.message : String(error)}`
                  )
                );
            }}
          />
        ) : null}
      </CommitAvailabilityProvider>
    </CapabilitiesProvider>
  );
}
