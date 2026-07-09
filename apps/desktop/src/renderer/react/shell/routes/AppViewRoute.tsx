import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import { deleteApp, updateAppMeta } from '../../../gateway-client.js';
import { useShellActions } from '../actions.js';
import { el } from '../el.js';
import { iconSvg } from '../iconSvg.js';
import { openPrompt } from '../prompt.js';
import type { ShellNav } from '../ShellApp.js';
import ShellFrame from '../ShellFrame.js';
import AppFrame from './AppFrame.js';
import AppSettingsController from './AppSettingsController.js';

// React-owned app view — the full-bleed running-app runtime. Replaces the
// vanilla openApp (app-appview.ts): its own .cd-window with a brand-chip lead +
// Use/Build switch, the sandboxed iframe (AppFrame, native), and the per-app
// agentic chat. The chat is window.AppChat — a large vanilla subsystem that
// appends a FAB + panel to the app-view container; React renders that container
// and delegates the chat mount into it via an effect (it survives as foreign
// DOM at the container tail). The gear opens the React app-settings popover
// (AppSettingsController) — knobs, linked automations, and the vault pane.
export interface AppViewRouteProps {
  app: AppMetaResolvedType;
  appId: string;
  nav: ShellNav;
  renderSidebar: (nav: ShellNav) => ReactNode;
  prefs: AppearancePrefs;
  onToggleSidebar: () => void;
}

export default function AppViewRoute({
  app,
  appId,
  nav,
  renderSidebar,
  prefs,
  onToggleSidebar,
}: AppViewRouteProps): JSX.Element {
  const { confirm, enterBuilder, openNewAppSheet, showToast } = useShellActions();
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const renameFlow = async (): Promise<void> => {
    const next = await openPrompt({
      title: 'Rename app',
      initial: app.name,
      placeholder: 'App name',
      confirmLabel: 'Rename',
    });
    if (!next) return;
    try {
      await updateAppMeta({ id: app.id, name: next });
      showToast(`Renamed to "${next}"`);
    } catch (err) {
      showToast(`Could not rename: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deleteFlow = async (): Promise<void> => {
    const ok = await confirm({
      confirmLabel: 'Delete',
      danger: true,
      title: 'Delete app?',
      message: `Delete "${app.name}"? This removes it from the gateway and wipes its local app files.`,
    });
    if (!ok) return;
    try {
      await deleteApp({ id: app.id });
      showToast(`Deleted "${app.name}"`);
      nav.navigate({ kind: 'home' });
    } catch (err) {
      showToast(`Could not delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Delegate the per-app agentic chat to the vanilla window.AppChat, mounted
  // into the app-view container (it appends its FAB + panel; React keeps the
  // AppFrame child stable so the foreign nodes persist).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !appId || !window.AppChat) return;
    const dispose = window.AppChat.mount({ view, app, appId, el });
    return () => dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');
  const brandChip = (
    <span className="cd-brand-chip">
      <span
        className="cd-brand-chip-icon"
        style={{ background: finish.background, color: finish.glyphColor, boxShadow: finish.boxShadow || undefined }}
        dangerouslySetInnerHTML={{ __html: iconSvg(app.iconKey, 11, 1.9) }}
      />
      <span className="cd-brand-chip-name">{app.name}</span>
      <span className="cd-brand-chip-live">
        <span className="cd-brand-chip-live-dot" />
        live
      </span>
    </span>
  );

  const titlebarRight = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      <div className="cd-mode-switch">
        <button className="cd-mode-seg" type="button" data-active="true">
          <span className="cd-mode-seg-icon" dangerouslySetInnerHTML={{ __html: iconSvg('Eye', 12) }} />
          Use
        </button>
        <button className="cd-mode-seg" type="button" onClick={() => enterBuilder({ appContext: app })}>
          <span className="cd-mode-seg-icon" dangerouslySetInnerHTML={{ __html: iconSvg('Sparkle', 12) }} />
          Build
        </button>
      </div>
      <span className="cd-tb-btn-wrap">
        <button
          className="cd-tb-btn"
          type="button"
          aria-label="App settings"
          aria-haspopup="dialog"
          data-open={settingsOpen ? 'true' : undefined}
          onClick={() => setSettingsOpen((open) => !open)}
          dangerouslySetInnerHTML={{ __html: iconSvg('Settings', 15) }}
        />
        <span className="cd-tooltip">App settings</span>
      </span>
      <button
        className="cd-tb-btn"
        type="button"
        aria-label="More"
        title="More"
        dangerouslySetInnerHTML={{ __html: iconSvg('MoreHoriz', 14) }}
      />
    </span>
  );

  return (
    <ShellFrame
      sidebarOpen={prefs.sidebarOpen}
      onToggleSidebar={onToggleSidebar}
      sidebar={renderSidebar(nav)}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => nav.back()}
      onForward={() => nav.forward()}
      showNewChat
      onNewChat={openNewAppSheet}
      titlebarLead={brandChip}
      titlebarRight={titlebarRight}
    >
      <div
        ref={viewRef}
        className="app-view"
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div className="app-body">
          <div className="app-body-inner">
            <AppFrame appId={appId} accentColor={app.color} theme={prefs.theme} bgL={prefs.bgL} />
          </div>
        </div>
        {settingsOpen ? (
          <AppSettingsController
            app={app}
            appId={appId}
            onClose={() => setSettingsOpen(false)}
            onOpenAutomations={() => {
              setSettingsOpen(false);
              nav.navigate({ kind: 'automations' });
            }}
            onOpenOrder={(ref) => {
              setSettingsOpen(false);
              nav.navigate({ kind: 'automation-view', automationId: ref });
            }}
            onRename={() => {
              setSettingsOpen(false);
              void renameFlow();
            }}
            onShare={() => showToast('Sharing isn’t available yet.')}
            onReveal={() => void window.CentraidApi.openAppFolder({ id: app.id })}
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
