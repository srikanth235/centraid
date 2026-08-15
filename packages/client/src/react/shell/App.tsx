// governance: allow-repo-hygiene file-size-limit (#382) the shell root wires
// every route plus the assistant's conversation actions and the surviving gateway
// switcher's popover callbacks. A route-wiring extraction remains the right
// follow-up; #599 shrank this file rather than growing it (the vault switcher's
// callbacks and the New-vault modal left for Household).
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
import { CaptureLauncher, CaptureOverlay } from "./CaptureOverlay.js";
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
import HouseholdRoute from "./routes/HouseholdRoute.js";
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

// Build the ShellActions surface for the current render. Navigation + status +
// confirm are live; the remaining overlay actions (⌘K palette, the generic app
// context menu) are wired as their clusters land — until then they route to the
// builder or no-op so a consumer never crashes.
//
// `showToast` keeps its NAME on the actions surface — ~40 screens call it — but
// the thing it does changed in #707: there is no toast anywhere in this shell,
// and every message it is handed lands on the one persistent status line.
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
      /* the home app-card context menu is wired inside HomeRoute */
    },
  };
}

/**
 * The app-bar verbs the SHELL can honour on the six operational routes (#765).
 *
 * These are the ones that are plain navigations or shell overlays, so they work
 * before the route has published anything — the bar is useful on the first
 * frame. Everything else (an export of the window a page is showing, a filter
 * reset, a review queue) needs state only the route has, and the route claims
 * it through `publishRouteVerbs`, which takes precedence over anything here.
 */
function shellOpsVerbs(
  page: OpsPage,
  nav: ShellNav,
  openPairDevice: () => void
): RouteVerbs {
  switch (page) {
    case "automations":
      return {
        // An automation is a trigger and a thing to do — the editor is where
        // both are said, and a draft exists from the moment you open it.
        onCommit: () => nav.navigate({ kind: "automation-editor" }),
        onSecondary: () => nav.navigate({ kind: "templates" }),
      };
    case "household":
      // Pairing is an act, not a preference, so it opens as its own modal
      // exactly as it does from the account menu — one door, two handles.
      return { onCommit: openPairDevice };
    // The remaining four have no verb the shell can honour on the first frame:
    // every one of theirs (export this window, reset these filters, review this
    // queue) needs state only the route holds, so they claim the bar through
    // `publishRouteVerbs` instead. Listed rather than defaulted so a seventh
    // ops page has to answer this question rather than silently getting none.
    case "approvals":
    case "atlas":
    case "connectors":
    case "insights":
      return {};
  }
}

// Map the current route to the launcher's active-page highlight.
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
      // Legacy deep link Settings → Connections → promote highlight to Connectors.
      return route.page === "connections" ? "connectors" : "settings";
    case "app":
    case "run-view":
    case "automation-view":
    case "automation-builder":
    case "automation-editor":
    case "templates":
      // Detail routes with no launcher destination — nothing to highlight.
      return undefined;
    default:
      return undefined;
  }
}

/** Compact error-message extractor for status-line copy. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Settings stopped being a destination and became an overlay, but the route
 * survives: the command palette, Household, Approvals, and the `window.Centraid`
 * shim all still address it as `{kind: 'settings'}`. Rather than rewrite every
 * caller, the route resolves here — open the dialog, and `replace` (not push)
 * home so a dismissed dialog doesn't leave a settings entry in history.
 */
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

// The React shell root — the single component the flip mounts on #root,
// replacing the vanilla app.ts IIFE + chrome.ts. It owns the real renderer
// state (appearance prefs, the live app/draft list, starred set) and drives
// ShellApp, which wires the chrome frame + router. Routes render from the
// renderRoute switch below; each is ported one at a time from the vanilla
// app-*.ts modules. NOT yet wired to #root while that work continues.
export default function App({
  seedSampleOnFirstRun = false,
}: {
  seedSampleOnFirstRun?: boolean;
}): JSX.Element {
  // The flag lives above the route so navigating away during the first sample
  // fill cannot mount Home again and start a second run.
  const [autoSeedSample, setAutoSeedSample] = useState(seedSampleOnFirstRun);
  const onAutoSeedStarted = useCallback(() => {
    setAutoSeedSample(false);
  }, []);
  const { prefs, setPrefs } = useAppearance();
  // `mutateApps` is deliberately NOT taken: its only caller was Home's app
  // context menu (App info / Rename / Uninstall), which left with the
  // springboard rewrite. The hook keeps it because the optimistic
  // rename/uninstall path (#659) is what re-homing those actions will need.
  const { userApps, loading: appsLoading, refresh } = useShellApps();
  const assistantConversations = useAssistantConversations();
  // Conversations mid-undo-window after a delete — optimistically hidden from
  // the ledger until the grace timer commits or the reader undoes (§3).
  const [pendingConversationDeletes, setPendingConversationDeletes] = useState<
    Set<string>
  >(() => new Set());
  const { isStarred, toggleStar } = useStarred();
  // Which destinations stand in the stem. User data, persisted (usePins).
  const { pins, togglePin } = usePins();
  const [allAppsOpen, setAllAppsOpen] = useState(false);
  const compact = useCompactLayout();
  // An installed PWA cannot claim ⌘K — the browser has it — so the hint is
  // hidden there. The Search CONTROL is never hidden: it is the guarantee, and
  // the shortcut is the extra (#707, per-surface behaviour).
  const hasCommandKey = useMemo(() => !isWebHost(), []);
  const ownerScopes = useOwnerScopes();
  const notificationsCounts = useNotificationsCounts();
  const blockingCount = notificationsCounts.decisionCount;
  const updateStatus = useUpdateStatus();
  // I12 / #501 — What's new re-wired to GitHub release notes (main changelog.ts).
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [whatsNewAutoChecked, setWhatsNewAutoChecked] = useState(false);
  // Settings is an overlay, not a destination: `null` closed, otherwise the
  // page id to open on ("" = the default page). Keeping it out of the router
  // is the point — changing a preference must not cost you your place in the
  // app, and dismissing returns you exactly where you were.
  const [settingsPage, setSettingsPage] = useState<string | null>(null);
  // Pairing a phone is an act, not a preference, so it opens from the account
  // menu as its own modal rather than as a Settings page (PairDeviceModal).
  const [pairDeviceOpen, setPairDeviceOpen] = useState(false);
  // The signed-in person, behind Settings since #707. Re-read whenever the
  // gateway or vault changes — a different gateway is a different household
  // and therefore a different roster.
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
        message:
          "This device drops its pairing, its offline copy, and its cached previews, and returns to onboarding. Your vault is untouched — the enrollment stays on its host until you revoke it from Household → Devices.",
        title: "Log out of this device?",
      });
      if (!ok) return;
      await forgetThisDeviceLocally(account?.gatewayId);
    })();
  }, [account?.gatewayId]);

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
  // Only the reachability verdict, not the whole 5s heartbeat snapshot — the
  // shell root renders a pill and a banner, and re-rendering the active screen
  // every five seconds to redraw them was the entire cost (issue #659).
  const gatewayStatus = useGatewayStatus();
  // The ONE read of the gateway's capability map (C1, docs/platform-gating.md).
  // Everything gated below — the launcher, the palette, the ops bar's verbs,
  // the route wall — reads this value; nothing asks the gateway again.
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
  const paletteEntitySearch = useMemo(() => createPaletteEntitySearch(), []);
  const paletteRecents = useMemo(() => createPaletteRecents(), []);
  const [gatewaySwitcherOpen, setGatewaySwitcherOpen] = useState(false);
  // The host-plumbing acts (issue #382) — "Test connection…", "Rename…",
  // "Remove" (Gateway → Components → Connections since #665) and the switcher's
  // footer "Add vault…" all open one of these small modals. They live at the
  // shell root because the Settings dialog is a lower z-index surface they must
  // sit above, and because the switcher has already closed by the time it
  // invokes a callback.
  const [addGatewayOpen, setAddGatewayOpen] = useState(false);
  // Bumped whenever a rename/remove commits, so the Connections section
  // re-reads the registry instead of showing what it listed a moment ago.
  const [gatewaysRefreshKey, setGatewaysRefreshKey] = useState(0);
  const [testConnectionTarget, setTestConnectionTarget] = useState<{
    gatewayId: string;
    label: string;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    gatewayId: string;
    label: string;
  } | null>(null);
  /**
   * Drop a connection — the unguarded primitive behind BOTH surfaces that can
   * ask for it (issue #665): the active vault's "On this device → Disconnect",
   * which confirms in vault words, and Diagnostics' host-framed "Remove". The
   * host falls back to the local gateway and broadcasts `onGatewayChanged`, so
   * the reScope effect below is what lands the shell somewhere sane; nothing
   * here needs to navigate.
   */
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

  // Diagnostics' destructive act. Host-framed on purpose: the Connections
  // section is the one surface where a machine is the subject.
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
      } else if (meta && e.key === ",") {
        // The platform-standard Preferences shortcut. Toggles, so the same
        // keystroke that opened the dialog dismisses it.
        e.preventDefault();
        setSettingsPage((open) => (open === null ? "" : null));
      } else if (meta && e.shiftKey && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        switcherActionRef.current?.();
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
        void Promise.all([syncWebDueNotifications(), syncWebNotifications()]);
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
      // A different gateway or vault is a different world: every cached answer
      // the shell holds describes the OLD one, and showing a stale row from it
      // is a correctness bug, not a slow refresh (issue #659).
      resetQueryCache();
      // Including the remembered installed set — an offline launch right after
      // a switch must not paint the previous vault's grid.
      resetInstalledAppsCache();
      void refresh();
      navRef.current?.navigate({ kind: "home" });
    };
    const offGatewayScope = window.CentraidApi.onGatewayChanged?.(reScope);
    const offVaultScope = window.CentraidApi.onVaultChanged?.(reScope);

    return () => {
      // These two outlived every remount before (issue #659): the shell root
      // subscribed on mount and never unsubscribed, so a re-mounted shell
      // stacked another pair and one gateway change ran N re-scopes.
      offGatewayScope?.();
      offVaultScope?.();
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

  // Conversation-row delete — mirrors the vanilla AssistantRoute's old
  // deleteThread confirm pattern. The LEDGER moved back into the assistant
  // surface in #707, but the shell root still owns the row ACTIONS, because
  // they reach the router (a deleted open thread has to bounce) and the shared
  // confirm/prompt overlays. Bounces off the fresh assistant route if the
  // conversation being deleted is the one currently open.
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

  // The three ledger row edits are optimistic (issue #659): the row changes on
  // the click and the PATCH confirms it, instead of the reader waiting a round
  // trip and then a full list refetch for a name they already typed. A rejected
  // commit puts the list back exactly as it was and says why.
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

  // Inline rename (§3) — the shared text-prompt dialog, then an optimistic PATCH.
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

  // Pin/unpin (§3) — the store sorts pinned threads first, so the local edit
  // re-sorts too or the row would visibly jump again after the refetch.
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

  // Archive/unarchive (§3). Archiving the open thread bounces to a fresh
  // assistant, mirroring delete (the row leaves the list).
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
          postStatus(`Couldn't export: ${errMsg(error)}`);
        }
      })();
    },
    []
  );

  // The ledger row ••• / right-click menu: Rename, Export, Pin, Archive, Delete.
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

  // The vault switcher, wired once. It lists VAULTS ONLY (#608, #665),
  // flattened across every registered gateway: a gateway is transport, so
  // picking a vault hosted by another one switches both pointers in a single
  // click. Explicit creation targets and conversation pins remain stronger
  // keys.
  //
  // It has one trigger, and that trigger is Home's TITLE (#708). The brief's
  // app bar is a display-face title over a mono meta line, and on Home the
  // title names the vault — so the name you would press to change is already
  // standing there at the size the brief gives it. A separate identity row
  // under the bar was a second answer to the question the title had already
  // asked.
  const openVaultSwitcher = useCallback(
    (anchor: DOMRect): void => {
      const activeGatewayId = ownerScopes.gatewayId ?? "";
      setGatewaySwitcherOpen(true);
      // Paint instantly from whatever a prior open cached, then probe every
      // registered gateway concurrently and patch rows in place as each
      // settles (stale-while-revalidate).
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
              // Atomic from the owner's side: a vault on another gateway
              // needs the transport moved first, then the vault pointer —
              // never one without the other.
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

  // ⌘⇧G reaches the same one switcher through its own trigger, so the keyboard
  // path and the pointer path open the popover anchored to the same control.
  // A ref callback rather than the ref object itself — see `StemIdentity`.
  // Stable, so the stem does not detach and re-attach the anchor every render.
  const setSwitcherButton = useCallback((el: HTMLButtonElement | null) => {
    switcherButtonRef.current = el;
  }, []);

  useEffect(() => {
    switcherActionRef.current = () => {
      const button = switcherButtonRef.current;
      if (button) openVaultSwitcher(button.getBoundingClientRect());
    };
    // This effect OWNS the ref. It used to be re-armed as a side effect of
    // rendering the identity row, which healed itself on every paint; an
    // effect that runs only when the switcher changes does not, so nothing
    // else may null it out from a cleanup of its own.
    return () => {
      switcherActionRef.current = null;
    };
  }, [openVaultSwitcher]);

  /** The gateway in the owner's own words — the bar's meta line on Home. */
  const gatewayLabel = ownerScopes.loading
    ? "—"
    : (ownerScopes.gatewayKind === "local"
        ? "This Mac"
        : ownerScopes.gatewayLabel) || "This Mac";
  // The assistant's conversation ledger. It was the sidebar's Recents zone
  // until #707; the stem holds the launcher and nothing else, so the ledger
  // moved into the assistant surface as app content and this is where its data
  // is shaped. Rows carry their vault only when it is NOT the owner's own — a
  // conversation belongs to one vault for life (#599), and saying so on every
  // row would drown the useful case.
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
  // Three affordances the sidebar carried land here, and nowhere else: the
  // gateway alarm (was a foot row in the danger tone), the update pill (was a
  // foot button), and the Notifications badge count + unread dot — the
  // Binding Layer bans badge counts and red dots outright, so the number
  // becomes a sentence in the numeric register instead of a mark on a nav row.
  // The sentence itself lives in `ambientStatus.ts` — the shell composes the
  // line, it does not own the wording rule.
  const ambientStatus = useMemo(
    () =>
      ambientStatusFor({
        blockingCount,
        gatewayStatus,
        hasUnreadNotices: notificationsCounts.hasUnreadNotices,
      }),
    [blockingCount, notificationsCounts.hasUnreadNotices, gatewayStatus]
  );

  // A newer build on disk used to be a pill pinned above the account row. It
  // is news, not a place, so it says so once on the line and offers the one
  // bounded action that acts on it.
  useEffect(() => {
    if (!updateStatus?.available) return;
    const line = `${updatePillTitle(updateStatus)} · v${updateStatus.version}`;
    // A download still in flight has nothing to act on yet, so it says so and
    // offers no control rather than a control that would refuse.
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

  // The foot's account menu. Settings, Pair device, What's new and Log out are
  // each a handful-of-times act, so they live behind the owner's own name
  // rather than each taking a standing row — the arrangement the sidebar had
  // before #707. The menu matches the row's width and opens upward, so it reads
  // as the band opening rather than a popover floating inside it.
  const stemAccount = useMemo(
    () => ({
      // Empty while the owner still carries the placeholder label.
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

  // The stem (#707, invariant 1): the vault switcher, Search, the pinned
  // launcher, and a foot of All apps + Settings. Every destination the launcher
  // does not show is still one tap away in the All-apps sheet, which is what
  // lets the launcher itself stay short.
  //
  // The identity head is the switcher's ONLY anchor, so ⌘⇧G aims here too — see
  // the effect that owns `switcherActionRef`.
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
          // The vault's own mark and hue, so two vaults are told apart in the
          // one place that names which of them you are in.
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
          // Settings is an overlay rather than a destination: changing a
          // preference must not cost you your place in the app.
          if (destination.id === "settings") setSettingsPage("");
          else nav.navigate(destination.route);
        }}
        onSearch={() => setPaletteOpen(true)}
        // Navigating to the assistant with no conversation id IS "start a new
        // one" — the same call the ledger's own New chat makes, so the two
        // entry points cannot drift into two different meanings of new.
        onNewConversation={() => nav.navigate({ kind: "assistant" })}
        onAllApps={() => setAllAppsOpen(true)}
        {...(account ? { account: stemAccount } : {})}
        // Only while you are IN the assistant. A ledger that stood on every
        // route would be a third zone in the band; one that appears with the
        // surface it belongs to is the surface's own navigation, in the one
        // column this window has for navigation.
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
      // The whole scope, not three fields: react-compiler infers the object
      // here (three optional reads of one object) and refuses to preserve a
      // memo whose declared deps are narrower than what it inferred.
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

  // The app bar (#708, invariant 3). The brief gives every screen a title in
  // the display face, a meta line in the numeric register, and at most two
  // actions of which at most one is the filled ink.
  //
  // Home's bar names the screen, not the vault: the vault is at the head of the
  // stem, true on every route, and saying it twice on one screen would make the
  // reader check whether the two are the same thing. Home has no title-bar
  // action: the stem's Search control and the keyboard shortcut remain the
  // global search entry points, while All apps lives in the stem's foot.
  //
  // The six operational routes (#765) take the same bar rather than each
  // drawing its own in-content header: one title, one count line, and the same
  // two verbs in the same two places on every one of them. What each page SAYS
  // is static (`opsBar.ts`), so the title is never wrong even for a frame; what
  // it says about the data it just read arrives on `routeVitals.ts` from the
  // route's own loader, which is also why the bar is not set from an effect.
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
      // A walled route keeps its title — the bar is the frame, and a blank one
      // over the wall would read as a broken screen — but it offers no verb.
      // "New automation" above a page explaining that automations are off is
      // a control that cannot do the thing it names.
      if (!isRouteAvailable(page, capabilities))
        return { title: opsBarDef(page).title };
      const vital = vitals[page];
      const verbs = opsBarVerbs(page, vital?.state);
      // A verb renders only once something can perform it: the route publishes
      // the handlers only it can honour (an export of the window it is showing,
      // a filter reset), and the shell resolves the ones that are plain
      // navigations. A control that would do nothing is worse than a bar with
      // one control on it.
      const published = routeVerbs[page];
      const fallback = shellOpsVerbs(page, nav, openPairDevice);
      const onCommit = published?.onCommit ?? fallback.onCommit;
      const onSecondary = published?.onSecondary ?? fallback.onSecondary;
      const commit = verbs.commit && onCommit ? verbs.commit : undefined;
      const secondary =
        verbs.secondary && onSecondary ? verbs.secondary : undefined;
      // The count line is the first thing a phone bar sheds — it is a second
      // row of identity in a bar that is already over-subscribed, and every
      // number in it is stated again in the page beneath.
      const count = compact ? "" : (vital?.count ?? "");
      return {
        title: opsBarDef(page).title,
        ...(count
          ? { meta: <span className={chrome.opsCount}>{count}</span> }
          : {}),
        ...(commit || secondary
          ? {
              // Quiet first, the one filled commit last — the same order on
              // every route, so the commit is always under the same thumb.
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
      // The capability wall (C1). Deep links, stale history entries and the
      // `window.Centraid.openAutomations` shim all still ADDRESS these routes
      // after the launcher stops offering them, and every one of them must be
      // answered rather than silently dropped. One gate for every gated kind,
      // read from the one route table — a per-case `if` in the switch below is
      // how the automation editor ends up walled and the run viewer does not.
      const gated = routeCapability(nav.route.kind);
      if (gated && !capabilities[gated]) {
        // Until the handshake answers, the shell believes nothing is enabled
        // (`CAPABILITIES_OFF`). That belief is right for the launcher — hiding
        // beats flashing — but it must not accuse a gateway that has not
        // spoken yet, so the wall waits for a verdict behind a blank frame.
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
          // The ledger lives in the stem on desktop — one column of navigation
          // per window. Compact has no stem to put it in (the band is a row of
          // tabs), so there it stays the route's own disclosure.
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
        case "household":
          return <HouseholdRoute />;
        case "storage":
          return <StorageRoute />;
        case "atlas":
          return <VaultRoute />;
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
        case "templates":
          return <TemplatesRoute />;
        case "settings":
          // Legacy deep link: Settings → Connections now lives at Connectors.
          // It reaches the same surface, so it reaches the same wall — the
          // route table keys on `kind`, and this one kind renders two places.
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
          // Every app is an inline route rendered by this shell (issue #799):
          // the served-app plane — the sandboxed iframe host and the builder
          // that produced apps for it — is retired, so an id with no inline
          // loader is nothing this client can open.
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
          // The assistant's automation handoff route. Normal automation
          // editing lives on `automation-editor`; both render the same editor.
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
          // Staged: ported one-by-one from the vanilla app-*.ts render fns.
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

  // Stable so ShellApp's memoized outlet has something to compare (issue
  // #659): an inline arrow here meant every shell-root render — every
  // heartbeat, every toast — rebuilt the whole route tree.
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
        {/* Inside the provider, not beside it: the dialog's pages use
            `useShellActions` for toasts, confirms, and navigation. */}
        {settingsPage === null ? null : (
          <SettingsRoute
            prefs={prefs}
            setPrefs={setPrefs}
            initialPage={settingsPage}
            onClose={closeSettings}
            onDisconnectVault={dropGatewayConnection}
            {...(account ? { onLogOut: logOut } : {})}
            onPairDevice={() => setPairDeviceOpen(true)}
            onWhatsNew={() => setWhatsNewOpen(true)}
          />
        )}
        {pairDeviceOpen ? <PairDeviceModal onClose={closePairDevice} /> : null}
      </ShellActionsProvider>
    ),
    [
      account,
      closePairDevice,
      closeSettings,
      dropGatewayConnection,
      logOut,
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
    // The refresh() belongs to the palette instance that is going away.
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
    // The offline verdict travels once, from here, and the shared commit
    // control reads it (issue #708, C7). It wraps the modals and sheets too —
    // a dialog's Save is as much a commit as a route's is.
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
