import { type JSX, type ReactNode, useEffect, useRef } from 'react';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import { useShellActions } from '../actions.js';
import { el } from '../el.js';
import { iconSvg } from '../iconSvg.js';
import type { ShellNav } from '../ShellApp.js';
import ShellFrame from '../ShellFrame.js';
import AppFrame from './AppFrame.js';

// React-owned app view — the full-bleed running-app runtime. Replaces the
// vanilla openApp (app-appview.ts): its own .cd-window with a brand-chip lead +
// Use/Build switch, the sandboxed iframe (AppFrame, native), and the per-app
// agentic chat. The chat is window.AppChat — a large vanilla subsystem that
// appends a FAB + panel to the app-view container; React renders that container
// and delegates the chat mount into it via an effect (it survives as foreign
// DOM at the container tail). Gear/more (the settings popover) is stubbed here
// and follows with the per-app chat's own React conversion.
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
  const { enterBuilder, openNewAppSheet, showToast } = useShellActions();
  const viewRef = useRef<HTMLDivElement | null>(null);

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
          onClick={() => showToast('App settings are moving to React.')}
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
      onBack={nav.back}
      onForward={nav.forward}
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
      </div>
    </ShellFrame>
  );
}
