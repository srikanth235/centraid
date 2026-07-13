import { type JSX, type ReactNode, useState } from 'react';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import { deleteApp, updateAppMeta } from '../../../gateway-client.js';
import { useShellActions } from '../actions.js';
import { iconSvg } from '../iconSvg.js';
import { openPrompt } from '../prompt.js';
import type { ShellNav } from '../ShellApp.js';
import ShellFrame from '../ShellFrame.js';
import AppFrame from './AppFrame.js';
import AppSettingsController from './AppSettingsController.js';
import styles from './AppViewRoute.module.css';
import chrome from '../chrome.module.css';

// React-owned app view — the full-bleed running-app runtime. Replaces the
// vanilla openApp (app-appview.ts): a brand-chip lead + Use/Build switch, the
// sandboxed app iframe (AppFrame, native), and the gear popover
// (AppSettingsController — knobs, linked automations, the vault pane).
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

  const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');
  const brandChip = (
    <span className={styles.brandChip}>
      <span
        className={styles.brandChipIcon}
        style={{
          background: finish.background,
          color: finish.glyphColor,
          boxShadow: finish.boxShadow || undefined,
        }}
        dangerouslySetInnerHTML={{ __html: iconSvg(app.iconKey, 11, 1.9) }}
      />
      <span className={styles.brandChipName}>{app.name}</span>
      <span className={styles.brandChipLive}>
        <span className={styles.brandChipLiveDot} />
        live
      </span>
    </span>
  );

  const titlebarRight = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      <div className={styles.modeSwitch}>
        <button className={styles.modeSeg} type="button" data-active="true">
          <span
            className={styles.modeSegIcon}
            dangerouslySetInnerHTML={{ __html: iconSvg('Eye', 12) }}
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
            dangerouslySetInnerHTML={{ __html: iconSvg('Sparkle', 12) }}
          />
          Build
        </button>
      </div>
      <span className={chrome.tbBtnWrap}>
        <button
          className={chrome.tbBtn}
          type="button"
          aria-label="App settings"
          aria-haspopup="dialog"
          data-open={settingsOpen ? 'true' : undefined}
          onClick={() => setSettingsOpen((open) => !open)}
          dangerouslySetInnerHTML={{ __html: iconSvg('Settings', 15) }}
        />
        <span className={chrome.tooltip}>App settings</span>
      </span>
      <button
        className={chrome.tbBtn}
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
      <div className={styles.view}>
        <div className={styles.body}>
          {/* data-fullbleed replaces the vanilla `app-view-fullbleed` class
              (mountUserApp added it imperatively): a hosted app fills the pane
              edge-to-edge — no padding, no max-width. */}
          <div className={styles.bodyInner} data-fullbleed="true">
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
