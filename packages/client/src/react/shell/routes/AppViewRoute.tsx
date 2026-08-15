import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

import type { AppearancePrefs } from "../../../app-shell-context.js";
import { deleteApp, updateAppMeta } from "../../../gateway-client.js";
import AppMark from "../../ui/AppMark.js";
import { useShellActions } from "../actions.js";
import { iconSvg } from "../iconSvg.js";
import { openPrompt } from "../prompt.js";
import type { ShellNav } from "../ShellApp.js";
import ShellFrame from "../ShellFrame.js";
import { useAsyncData } from "../useAsyncData.js";
import AppFrame from "./AppFrame.js";
import AppSettingsController from "./AppSettingsController.js";
import { loadAppTemplates } from "./templatesData.js";

import chrome from "../chrome.module.css";
import styles from "./AppViewRoute.module.css";

// React-owned app view — the full-bleed running-app runtime. Replaces the
// vanilla openApp (app-appview.ts): a brand-chip lead + Use/Build switch, the
// sandboxed app iframe (AppFrame, native), and the optional per-app management
// popover (AppSettingsController — knobs, linked automations, the vault pane).
//
// The desktop shell's own "Ask <App>" FAB + slide-in chat panel (formerly
// AppChatPanel/useAppChat) was removed: it was the only entry point to that
// feature (no command-palette or keyboard-shortcut opener existed outside the
// component itself), and it overlapped the in-app kit Ask panel every
// blueprint app already ships — the shell FAB's hit area intercepted pointer
// events meant for the kit panel's send button. The kit panel is the sole
// Ask affordance now.
export interface AppViewRouteProps {
  app: AppMetaResolvedType;
  appId: string;
  nav: ShellNav;
  renderStem: (nav: ShellNav) => ReactNode;
  /** The frame's one status line — full-bleed hosts mount their own frame,
   *  so they are handed the same node rather than inheriting it. */
  statusLine?: ReactNode;
  prefs: AppearancePrefs;
}

export default function AppViewRoute({
  app,
  appId,
  nav,
  renderStem,
  statusLine,
  prefs,
}: AppViewRouteProps): JSX.Element {
  const { confirm, enterBuilder, openNewAppSheet, showToast, builderEnabled } =
    useShellActions();
  const handleToggleStem = nav.toggleStem;
  // Photos owns its toolbar and follows the handoff without the generic shell
  // settings sheet. Other app types retain their management affordance.
  const appSettingsEnabled = app.id !== "photos";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"appearance" | "vault">(
    "appearance"
  );

  useEffect(() => {
    if (!appSettingsEnabled) return undefined;
    const openVaultSettings = (): void => {
      setSettingsTab("vault");
      setSettingsOpen(true);
    };
    window.addEventListener(
      "centraid:open-app-vault-settings",
      openVaultSettings
    );
    return () =>
      window.removeEventListener(
        "centraid:open-app-vault-settings",
        openVaultSettings
      );
  }, [appSettingsEnabled]);

  // A bundled app-template id is RESERVED (issue #434) and an installed bundled
  // app keeps its blueprint id, so an app whose id is in the catalog serves in
  // place — its gear-popover verb is Uninstall (access revoked, data stays), not
  // Delete (wipe local files). Anything else is a code-store app that keeps
  // Delete. Best-effort: an empty/failed load degrades to code-store (Delete).
  const bundledState = useAsyncData(() => loadAppTemplates(), []);
  const bundled =
    bundledState.status === "ready" &&
    bundledState.data.some((t) => t.id === app.id);

  const renameFlow = async (): Promise<void> => {
    const next = await openPrompt({
      title: "Rename app",
      initial: app.name,
      placeholder: "App name",
      confirmLabel: "Rename",
    });
    if (!next) return;
    try {
      await updateAppMeta({ id: app.id, name: next });
      showToast(`Renamed to "${next}"`);
    } catch (error) {
      showToast(
        `Could not rename: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Code-store apps only: the panel gives a bundled app no danger zone at all
  // (issue #708 — it reinstalls at every vault mount, so there is nothing an
  // uninstall could durably mean).
  const deleteFlow = async (): Promise<void> => {
    const ok = await confirm({
      confirmLabel: "Delete",
      danger: true,
      title: "Delete app?",
      message: `Delete "${app.name}"? This removes it from the gateway and wipes its local app files.`,
    });
    if (!ok) return;
    try {
      await deleteApp({ id: app.id });
      showToast(`Deleted "${app.name}"`);
      nav.navigate({ kind: "home" });
    } catch (error) {
      showToast(
        `Could not delete: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const brandChip = (
    <span className={styles.brandChip}>
      <AppMark
        className={styles.brandChipIcon}
        colorKey={app.colorKey}
        iconKey={app.iconKey}
        size={20}
      />
      <span className={styles.brandChipName}>{app.name}</span>
      <span className={styles.brandChipLive}>
        <span className={styles.brandChipLiveDot} />
        live
      </span>
    </span>
  );

  const titlebarRight = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
      {/* The Use/Build switch is a builder entry point (issue #434, Phase 3) —
          hidden with the builder. "Use" alone is meaningless, so the whole
          toggle goes; the app just runs. */}
      {builderEnabled ? (
        <div className={styles.modeSwitch}>
          <button className={styles.modeSeg} type="button" data-active="true">
            <span
              className={styles.modeSegIcon}
              // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
              dangerouslySetInnerHTML={{ __html: iconSvg("Eye", 12) }}
            />
            Use
          </button>
          <button
            className={styles.modeSeg}
            type="button"
            onClick={() => enterBuilder({ appContext: app })}
          >
            <span
              className={styles.modeSegIcon}
              // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
              dangerouslySetInnerHTML={{ __html: iconSvg("Sparkle", 12) }}
            />
            Build
          </button>
        </div>
      ) : null}
      {appSettingsEnabled ? (
        <span className={chrome.tbBtnWrap}>
          <button
            className={chrome.tbBtn}
            type="button"
            aria-label="App settings"
            aria-haspopup="dialog"
            data-open={settingsOpen ? "true" : undefined}
            onClick={() => {
              setSettingsTab("appearance");
              setSettingsOpen((open) => !open);
            }}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("Settings", 15) }}
          />
          <span className={chrome.tooltip}>App settings</span>
        </span>
      ) : null}
      <button
        className={chrome.tbBtn}
        type="button"
        aria-label="More"
        title="More"
        // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
        dangerouslySetInnerHTML={{ __html: iconSvg("MoreHoriz", 14) }}
      />
    </span>
  );

  return (
    <ShellFrame
      stem={renderStem(nav)}
      onToggleStem={handleToggleStem}
      stemOpen={nav.stemOpen}
      statusLine={statusLine}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => nav.back()}
      onForward={() => nav.forward()}
      showNewChat={builderEnabled}
      onNewChat={openNewAppSheet}
      assistantOpen={nav.assistantOpen}
      {...(nav.toggleAssistant
        ? { onToggleAssistant: nav.toggleAssistant }
        : {})}
      titlebarLead={brandChip}
      titlebarRight={titlebarRight}
    >
      <div className={styles.view} data-testid="app-view">
        <div className={styles.body}>
          {/* data-fullbleed replaces the vanilla `app-view-fullbleed` class
              (mountUserApp added it imperatively): a hosted app fills the pane
              edge-to-edge — no padding, no max-width. */}
          <div className={styles.bodyInner} data-fullbleed="true">
            <AppFrame
              appId={appId}
              accentColor={app.color}
              theme={prefs.theme}
            />
          </div>
        </div>
        {appSettingsEnabled && settingsOpen ? (
          <AppSettingsController
            app={app}
            appId={appId}
            initialTab={settingsTab}
            {...(bundled ? { bundled: true } : {})}
            onClose={() => setSettingsOpen(false)}
            onOpenAutomations={() => {
              setSettingsOpen(false);
              nav.navigate({ kind: "automations" });
            }}
            onOpenOrder={(ref) => {
              setSettingsOpen(false);
              nav.navigate({ kind: "automation-view", automationId: ref });
            }}
            onRename={() => {
              setSettingsOpen(false);
              void renameFlow();
            }}
            onShare={() => showToast("Sharing isn’t available yet.")}
            onReveal={() =>
              void window.CentraidApi.openAppFolder({ id: app.id })
            }
            onDelete={() => {
              setSettingsOpen(false);
              void deleteFlow();
            }}
            showToast={showToast}
          />
        ) : null}
      </div>
    </ShellFrame>
  );
}
