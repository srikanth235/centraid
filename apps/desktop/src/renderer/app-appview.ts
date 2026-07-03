// governance: allow-repo-hygiene file-size-limit route-module split out of app.ts (#227)
// The app-view subsystem: opening a centraid app into the windowed view
// (openApp → mountUserApp → sandboxed iframe + per-app agentic chat), plus the
// per-app Settings drawer (knobs persisted to the app's SQLite, standing-order
// automations with live run timelines). Extracted from app.ts.
//
// `appSettingsCleanup` is module-local. Shell state (prefs, userApps, the live
// sidebar setter, currentCleanup, automationRunState) is reached through the
// ShellContext accessors; sibling surfaces (builder, automation/run views,
// share, card actions) through ctx.shell.* and the ctx card-action forwarders.
import {
  appLiveUrl,
  appQuery,
  listAutomationRunNodes,
  listAutomationRuns,
  listAutomations,
  pinAutomationRun,
  readAutomationRun,
  runAutomationNow,
  setAutomationEnabled,
  streamAutomationRun,
  updateAppMeta,
} from './gateway-client.js';
import {
  appKnobKebab,
  formatDuration,
  prettyJson,
  sqlString,
  triggersSummary,
} from './app-format.js';
import { manifestVaultBlock, renderVaultPane } from './app-vault.js';
import type { ShellContext } from './app-shell-context.js';

export interface AppViewModule {
  openApp(id: string): void;
  closeAppSettings(): void;
}

export function createAppViewModule(ctx: ShellContext): AppViewModule {
  const {
    el,
    clear,
    showToast,
    recordRoute,
    recordRecent,
    chromeNav,
    root,
    findApp,
    findUserApp,
    isDraft,
    persist,
    getPrefs,
    automationRunState,
    buildHomeSidebar,
    toggleSidebar,
    setSidebarOpenSetter,
  } = ctx;

  function openApp(id: string): void {
    const app = findApp(id);
    if (!app) {
      return;
    }
    recordRecent(id);
    // A draft with no built index.html has nothing to serve — route to the
    // builder so the click still does something. Drafts that *have* a build
    // mount in the app view just like published apps (their tile id is the
    // app id — see `enterBuilder`'s appId note).
    if (isDraft(app) && !app.hasIndex) {
      ctx.shell.enterBuilder({ appContext: app });
      return;
    }
    recordRoute({ id, kind: 'app' });
    // Published apps carry their app id on the UserAppMeta; drafts use
    // their tile id directly (tile id == app id for unpublished apps).
    // Every code path in v0 produces a defined app id — addUserApp
    // requires `appId` and drafts use their own id — so the fallback
    // chain never bottoms out on undefined.
    const ua = findUserApp(id);
    const appId = ua?.centraidAppId ?? app.id;
    clear();

    // Main area: the running app fills the canvas inside a scrollable column.
    // Declared before the titlebar so the per-app settings popover (anchored
    // to the gear button) can capture `view` cleanly via closure — the panel
    // is inserted as a child of `view` when opened.
    const main = el('div', {});
    const view = el('div', {
      class: 'app-view',
      style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    });
    const body = el('div', { class: 'app-body' });
    const inner = el('div', { class: 'app-body-inner' });
    body.append(inner);
    view.append(body);
    main.append(view);
    inner.style.setProperty('--accent-color', app.color);

    // Titlebar identity lockup: a gradient app-icon tile + name + a LIVE
    // status chip, then the Use / Build switch, the gear, and a ⋯ button —
    // the same shape the refined Builder titlebar uses.
    const brandChip = el('span', { class: 'cd-brand-chip' });
    const brandFinish = window.CentraidTokens.tileFinish(app.color, 'gradient');
    const brandIcon = el('span', {
      class: 'cd-brand-chip-icon',
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 11, strokeWidth: 1.9 }) : '',
    });
    brandIcon.style.background = brandFinish.background;
    brandIcon.style.color = brandFinish.glyphColor;
    if (brandFinish.boxShadow) brandIcon.style.boxShadow = brandFinish.boxShadow;
    brandChip.append(brandIcon);
    brandChip.append(el('span', { class: 'cd-brand-chip-name' }, app.name));
    brandChip.append(
      el('span', { class: 'cd-brand-chip-live' }, [
        el('span', { class: 'cd-brand-chip-live-dot' }),
        'live',
      ]),
    );

    // Notion-style per-app customization popover, anchored to the gear.
    // The button toggles the panel; the panel closes on Esc, click-outside,
    // or another gear press.
    const gearWrap = el('span', { class: 'cd-tb-btn-wrap' });
    const gearBtn = el('button', {
      class: 'cd-tb-btn',
      type: 'button',
      'aria-label': 'App settings',
      'aria-haspopup': 'dialog',
      trustedHtml: Icon.Settings ? Icon.Settings({ size: 15 }) : '',
      onClick: () => toggleAppSettings(app, gearBtn, view, appId),
    });
    gearWrap.append(gearBtn);
    gearWrap.append(el('span', { class: 'cd-tooltip' }, 'App settings'));

    // §D4/§G4 — Use / Build segmented switch replaces the floating Edit
    // sparkle. "Use" is the running app (current); "Build" returns to the
    // builder. The rename matters: "Edit" read like editing a list row,
    // not switching into the build experience.
    const useSeg = el('button', { class: 'cd-mode-seg', type: 'button', 'data-active': 'true' }, [
      el('span', { class: 'cd-mode-seg-icon', trustedHtml: Icon.Eye({ size: 12 }) }),
      'Use',
    ]);
    const buildSeg = el(
      'button',
      {
        class: 'cd-mode-seg',
        type: 'button',
        onClick: () => ctx.shell.enterBuilder({ appContext: app }),
      },
      [el('span', { class: 'cd-mode-seg-icon', trustedHtml: Icon.Sparkle({ size: 12 }) }), 'Build'],
    );
    const modeSwitch = el('div', { class: 'cd-mode-switch' }, [useSeg, buildSeg]);
    const moreBtn = el('button', {
      class: 'cd-tb-btn',
      type: 'button',
      'aria-label': 'More',
      title: 'More',
      trustedHtml: Icon.MoreHoriz ? Icon.MoreHoriz({ size: 14 }) : '',
    });
    // The identity lockup hugs the back/forward arrows on the left
    // (titlebarLead) — matching the builder and the other views. The
    // Use/Build switch, the gear, and the ⋯ button form the trailing
    // cluster on the right.
    const titlebarRight = el('span', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
    });
    titlebarRight.append(modeSwitch);
    titlebarRight.append(gearWrap);
    titlebarRight.append(moreBtn);

    const sidebar = buildHomeSidebar({ appId: app.id });
    const { root: shell, setSidebarOpen } = window.Chrome.buildWindow({
      ...chromeNav(),
      main,
      onNewChat: () => ctx.shell.openNewAppSheet(),
      onToggleSidebar: toggleSidebar,
      showNewChat: true,
      sidebar,
      sidebarOpen: getPrefs().sidebarOpen,
      titlebarLead: brandChip,
      titlebarRight,
    });
    setSidebarOpenSetter(setSidebarOpen);
    root.append(shell);

    try {
      mountUserApp(app, appId, inner);
      // Per-app agentic chat: only wire it up for centraid-backed apps,
      // since the agent reads the app's data.sqlite via the gateway.
      if (appId) {
        ctx.setCurrentCleanup(
          window.AppChat.mount({
            view,
            app,
            appId: appId,
            el,
          }),
        );
      } else {
        ctx.setCurrentCleanup(null);
      }
    } catch (error) {
      console.error('App crashed:', error);
      inner.append(el('div', { class: 'empty' }, `Something went wrong loading ${app.name}.`));
    }
  }

  function mountUserApp(app: AppMetaResolvedType, appId: string, container: HTMLElement): void {
    // Every centraid app — published or draft — has an app id.
    // We host its iframe served by the openclaw plugin; the frame fills
    // the main pane edge-to-edge and the app supplies its own chrome.
    container.classList.add('app-view-fullbleed');
    const frameWrap = el('div', { class: 'app-view-frame' });
    const frame = el('iframe', {
      src: 'about:blank',
      sandbox: 'allow-scripts allow-forms allow-same-origin',
      referrerpolicy: 'no-referrer',
    }) as HTMLIFrameElement;
    // Tag so ctx.applyPrefs() can find every running app iframe and
    // postMessage the latest theme on slider/toggle changes.
    frame.dataset.centraidApp = '1';
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow?.postMessage(
          { type: 'centraid:theme', theme: ctx.iframeThemeKind(), bgL: getPrefs().bgL },
          '*',
        );
      } catch {
        /* noop */
      }
    });
    frameWrap.append(frame);
    container.append(frameWrap);
    void app; // suppress unused arg — frame paints from the app id alone

    // Resolve the live URL and load it. We carry the global theme in
    // BOTH the query string (so the runtime's settings injection bakes
    // `data-theme` / `--bg-l` into the served `index.html` server-side)
    // AND the hash (read by the inline live-settings bridge before paint,
    // covering the builder-preview path that bypasses the runtime).
    // Iframe theme is resolved to its light/dark kind — third-party
    // shell themes don't ship template-side CSS, so apps stay in the
    // Centraid look while the shell wears the named theme.
    void appLiveUrl({ id: appId })
      .then((r) => {
        const qsep = r.url.includes('?') ? '&' : '?';
        const themeQs = `theme=${ctx.iframeThemeKind()}&bgL=${getPrefs().bgL}`;
        frame.src = `${r.url}${qsep}${themeQs}#${themeQs}`;
      })
      .catch(() => {
        frameWrap.innerHTML =
          '<div class="empty">Could not reach the gateway. Check Settings.</div>';
      });
  }

  // ---------- Per-app settings popover ----------
  // Notion-style customization surface anchored to the gear button in the
  // app-view titlebar.
  //
  // Theme / accent / density stay GLOBAL — baked into the iframe URL so
  // every mini-app inherits the Centraid shell theme and the workspace
  // reads as one product. True per-app *aesthetics* (font, page width,
  // corner radius, etc.) live here. Each template declares its knobs in
  // `app.json#knobs[]` (see `packages/blueprints`); the scaffolder
  // copies that manifest into the cloned app; the gateway serves it
  // as a static file. We fetch the cloned copy at panel-open so the
  // controls match the app's CSS, not whatever the bundled template
  // might have evolved to since the clone.
  //
  // Values persist in the per-app `__centraid_settings` SQLite table via
  // `CentraidApi.appQuery` SQL writes. The runtime's settings-merge bakes
  // them into `<html data-app-<key>="...">` on next load; the inline
  // bridge in each template applies live `centraid:settings` postMessage
  // updates from the shell so the change is visible immediately.

  interface AppKnobOption {
    value: string;
    label: string;
  }
  interface AppKnob {
    key: string;
    label: string;
    /** `segmented` for discrete values, `swatch` for colour choices. */
    type: 'segmented' | 'swatch';
    default: string;
    options: AppKnobOption[];
  }
  interface AppKnobsManifest {
    version: number;
    knobs: AppKnob[];
  }

  let appSettingsCleanup: (() => void) | null = null;

  function closeAppSettings(): void {
    if (appSettingsCleanup) {
      appSettingsCleanup();
      appSettingsCleanup = null;
    }
  }

  function toggleAppSettings(
    app: AppMetaResolvedType,
    anchor: HTMLElement,
    view: HTMLElement,
    appId: string | undefined,
  ): void {
    if (appSettingsCleanup) {
      closeAppSettings();
      return;
    }
    openAppSettings(app, anchor, view, appId);
  }

  async function ensureAppSettingsTable(appId: string): Promise<void> {
    await appQuery({
      id: appId,
      sql: 'CREATE TABLE IF NOT EXISTS __centraid_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    });
  }

  async function fetchAppKnobValues(appId: string): Promise<Record<string, string>> {
    try {
      await ensureAppSettingsTable(appId);
      const result = await appQuery({
        id: appId,
        sql: 'SELECT key, value FROM __centraid_settings',
      });
      if (result.kind !== 'rows') return {};
      const out: Record<string, string> = {};
      for (const row of result.rows) {
        const key = typeof row.key === 'string' ? row.key : String(row.key);
        const raw = typeof row.value === 'string' ? row.value : String(row.value);
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed === 'string') out[key] = parsed;
        } catch {
          /* skip malformed row */
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  async function writeAppKnobValue(appId: string, key: string, value: string): Promise<void> {
    const sql =
      `INSERT INTO __centraid_settings (key, value) VALUES (${sqlString(key)}, ${sqlString(JSON.stringify(value))}) ` +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value';
    await appQuery({ id: appId, sql });
  }

  function pushKnobToAppFrame(view: HTMLElement, key: string, value: string): void {
    const frame = view.querySelector<HTMLIFrameElement>('iframe[data-centraid-app]');
    if (!frame) return;
    const name = appKnobKebab(key);
    // Mirror the runtime's app-knob routing: keys ending in Color/Accent
    // land as CSS vars (continuous colour values); everything else lands
    // as data attributes (discrete states). Keeping the two paths in
    // sync means a live edit and a hard reload produce identical DOM.
    const isCss = /(?:Color|Accent)$/.test(key);
    const dataAttrs = isCss ? {} : { [name]: value };
    const cssVars = isCss ? { [name]: value } : {};
    frame.contentWindow?.postMessage({ type: 'centraid:settings', dataAttrs, cssVars }, '*');
  }

  async function fetchAppManifestRaw(appId: string): Promise<Record<string, unknown> | null> {
    try {
      const live = await appLiveUrl({ id: appId });
      // `appLiveUrl` returns `${gateway}/centraid/<id>/`. The app
      // manifest sits next to `index.html` inside the same app; we fetch
      // the cloned copy (not the bundled template) so knobs + vault block
      // match the app's own files. Shared by the Appearance knobs and the
      // Vault tab so the popover fetches `app.json` once.
      const url = `${live.url.replace(/\/?$/, '/')}app.json`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const parsed = (await res.json()) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  // Knobs live under the manifest's `knobs[]` array (folded in from the
  // old `app-knobs.json` sidecar).
  function knobsManifestFrom(raw: Record<string, unknown> | null): AppKnobsManifest | null {
    if (!raw || !Array.isArray(raw.knobs)) return null;
    const version = typeof raw.manifestVersion === 'number' ? raw.manifestVersion : 1;
    return { version, knobs: raw.knobs as AppKnob[] };
  }

  /** Hard-reload the app iframe — vault access just changed under it. */
  function reloadAppFrame(view: HTMLElement): void {
    const frame = view.querySelector<HTMLIFrameElement>('iframe[data-centraid-app]');
    if (!frame) return;
    // Cross-origin frame: re-setting `src` is the one reload we may do.
    const src = frame.src;
    frame.src = src;
  }

  function openAppSettings(
    app: AppMetaResolvedType,
    anchor: HTMLElement,
    view: HTMLElement,
    appId: string | undefined,
  ): void {
    closeAppSettings();
    anchor.dataset.open = 'true';

    const backdrop = el('div', { class: 'cd-app-settings-backdrop' });
    const panel = el('div', {
      class: 'cd-app-settings-panel',
      role: 'dialog',
      'aria-label': 'App settings',
    });
    // Carry the app's hue into the popover so the standing-order rail
    // and toggle pick up the same accent the iframe + brand chip use.
    // CSS vars cascade downward only; `inner` (where openApp sets this)
    // is a sibling, not a parent, of the panel.
    panel.style.setProperty('--accent-color', app.color);

    // Stop the panel's own clicks from bubbling to the backdrop, which would
    // close it. Backdrop click closes; Esc closes globally.
    panel.addEventListener('click', (e) => e.stopPropagation());
    backdrop.addEventListener('click', closeAppSettings);

    // Header — gradient app-icon tile + name + an "APP SETTINGS" mono
    // eyebrow, then a close button.
    const header = el('div', { class: 'cd-app-settings-header' });
    const settingsFinish = window.CentraidTokens.tileFinish(app.color, 'gradient');
    const iconTile = el('span', {
      class: 'cd-app-settings-icon',
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 15, strokeWidth: 1.85 }) : '',
    });
    iconTile.style.background = settingsFinish.background;
    iconTile.style.color = settingsFinish.glyphColor;
    if (settingsFinish.boxShadow) iconTile.style.boxShadow = settingsFinish.boxShadow;
    const headerText = el('div', { class: 'cd-app-settings-header-text' }, [
      el('div', { class: 'cd-app-settings-name' }, app.name),
      el('div', { class: 'cd-app-settings-eyebrow' }, 'App settings'),
    ]);
    const closeBtn = el('button', {
      class: 'cd-app-settings-close',
      type: 'button',
      'aria-label': 'Close',
      trustedHtml: Icon.X({ size: 12 }),
      onClick: closeAppSettings,
    });
    header.append(iconTile, headerText, closeBtn);
    panel.append(header);

    // §E1 — tabbed popover: Appearance · Automations · Vault · Manage.
    // Each tab does one job instead of one flat stack. The Vault tab stays
    // hidden unless the app's manifest declares a `vault` block.
    type AppSettingsTab = 'appearance' | 'automations' | 'vault' | 'manage';
    const panes: Record<AppSettingsTab, HTMLElement> = {
      appearance: el('div', { class: 'cd-app-settings-pane' }),
      automations: el('div', { class: 'cd-app-settings-pane' }),
      vault: el('div', { class: 'cd-app-settings-pane' }),
      manage: el('div', { class: 'cd-app-settings-pane' }),
    };
    const tabBarWrap = el('div', { class: 'cd-app-settings-tabs-wrap' });
    const tabBar = el('div', { class: 'cd-app-settings-tabs' });
    tabBarWrap.append(tabBar);
    const tabButtons = new Map<AppSettingsTab, HTMLElement>();
    const showAppSettingsTab = (id: AppSettingsTab): void => {
      for (const [tid, btn] of tabButtons) btn.dataset.active = String(tid === id);
      for (const [pid, pane] of Object.entries(panes)) pane.hidden = pid !== id;
    };
    // Tab glyphs — the shared icon set lacks palette/wrench, so the
    // popover carries small inline SVGs that match the proposal.
    const tabGlyph: Record<AppSettingsTab, string> = {
      appearance:
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h2a4 4 0 0 0 4-4 10 10 0 0 0-10-8z"/></svg>',
      automations:
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
      vault:
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v5c0 5-3.5 9-8 11-4.5-2-8-6-8-11V6z"/></svg>',
      manage:
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4l-5.6 5.6a2 2 0 1 0 2.8 2.8l5.6-5.6a4 4 0 0 1 5.4-5.4l-3 3-2.2-2.2 3-3z"/></svg>',
    };
    for (const [id, label] of [
      ['appearance', 'Appearance'],
      ['automations', 'Automations'],
      ['vault', 'Vault'],
      ['manage', 'Manage'],
    ] as const) {
      const btn = el('button', {
        class: 'cd-app-settings-tab',
        type: 'button',
        onClick: () => showAppSettingsTab(id),
      });
      btn.append(
        el('span', { class: 'cd-app-settings-tab-glyph', trustedHtml: tabGlyph[id] }),
        el('span', { class: 'cd-app-settings-tab-label' }, label),
      );
      if (id === 'automations' || id === 'vault') {
        btn.append(el('span', { class: 'cd-app-settings-tab-badge', hidden: '' }, '0'));
      }
      // The Vault tab is for vault-declaring apps only; unhidden when the
      // manifest resolves with a `vault` block.
      if (id === 'vault') btn.hidden = true;
      tabButtons.set(id, btn);
      tabBar.append(btn);
    }
    panel.append(tabBarWrap);
    panel.append(panes.appearance, panes.automations, panes.vault, panes.manage);

    // Appearance — per-app knobs (font / width / corners / App color).
    // Only meaningful for centraid-backed apps; an empty host fills in
    // when the manifest + current values resolve.
    let prefsHost: HTMLElement | null = el('div', { class: 'cd-app-settings-section-host' });
    prefsHost.append(
      el('div', { class: 'cd-app-settings-note' }, 'No appearance options for this app.'),
    );
    panes.appearance.append(prefsHost);
    const manifestRaw = appId
      ? fetchAppManifestRaw(appId)
      : Promise.resolve<Record<string, unknown> | null>(null);
    if (appId) {
      void Promise.all([manifestRaw, fetchAppKnobValues(appId)]).then(([raw, stored]) => {
        const manifest = knobsManifestFrom(raw);
        if (!prefsHost || !document.contains(panel)) return;
        if (!manifest || manifest.knobs.length === 0) return;
        prefsHost.replaceChildren(renderKnobsSection(manifest.knobs, stored, view, appId, panel));
      });
    }

    // Vault (duaility §12) — the owner consent surface for this app.
    // Tab + pane only materialize for manifests that declare a `vault`
    // block; the pane owns its own refresh after every owner act.
    const vaultHost = el('div', { class: 'cd-app-settings-section-host' });
    panes.vault.append(vaultHost);
    if (appId) {
      void manifestRaw.then((raw) => {
        const block = manifestVaultBlock(raw);
        if (!block || !document.contains(panel)) return;
        const vaultTabBtn = tabButtons.get('vault');
        if (vaultTabBtn) vaultTabBtn.hidden = false;
        void renderVaultPane({
          el,
          appId,
          block,
          host: vaultHost,
          onAccessChanged: () => reloadAppFrame(view),
          onParkedCount: (count) => {
            const badge = vaultTabBtn?.querySelector('.cd-app-settings-tab-badge');
            if (badge instanceof HTMLElement) {
              badge.textContent = String(count);
              badge.hidden = count === 0;
            }
          },
          showToast,
        });
      });
    }

    // Automations (issue #91) — reverse lookup: automations are
    // user-owned apps that declare which apps they touch via
    // `manifest.apps`, so this tab lists the automations associated
    // with this app.
    const automationsHost = el('div', { class: 'cd-app-settings-section-host' });
    automationsHost.append(
      el('div', { class: 'cd-app-settings-note' }, 'No automations linked to this app yet.'),
    );
    panes.automations.append(automationsHost);
    if (appId) {
      void listAutomations().then((all) => {
        if (!document.contains(panel)) return;
        const rows = all.filter((r) => r.manifest.apps?.includes(appId));
        if (rows.length === 0) return;
        const badge = tabButtons.get('automations')?.querySelector('.cd-app-settings-tab-badge');
        if (badge instanceof HTMLElement) {
          badge.textContent = String(rows.length);
          badge.hidden = false;
        }
        automationsHost.replaceChildren(renderAutomationsSection(rows, panel));
      });
    }
    // §E3 — graduates to the top-level Automations destination.
    panes.automations.append(
      el(
        'button',
        {
          class: 'cd-app-settings-pane-link',
          type: 'button',
          onClick: () => {
            closeAppSettings();
            ctx.shell.renderAutomations();
          },
        },
        'Open Automations →',
      ),
    );

    // Manage — Rename / Share / Reveal as icon-tiled rows, then a Danger
    // zone whose Delete arms a confirmation step before it fires (§E1).
    const manage = el('div', { class: 'cd-app-settings-manage' });
    manage.append(
      appSettingsMenuItem('Pencil', 'Rename', `Currently · ${app.name}`, () => {
        closeAppSettings();
        void renameAppFromSettings(app);
      }),
      appSettingsMenuItem('Share', 'Share…', 'Link or read-only invite', () => {
        closeAppSettings();
        ctx.shell.openShareDialog(app);
      }),
      appSettingsMenuItem('Folder', 'Reveal in Finder', 'Open the app folder', () => {
        closeAppSettings();
        void ctx.revealApp(app);
      }),
    );
    panes.manage.append(manage);

    const dangerZone = el('div', { class: 'cd-app-settings-danger' });
    dangerZone.append(el('div', { class: 'cd-app-settings-danger-label' }, 'Danger zone'));
    let deleteArmed = false;
    const deleteBtn = el('button', {
      class: 'cd-app-settings-menu-item cd-app-settings-danger-item',
      type: 'button',
      'data-danger': 'true',
    });
    const deleteIconTile = el('span', {
      class: 'cd-app-settings-menu-icon',
      trustedHtml: Icon.Trash ? Icon.Trash({ size: 13 }) : '',
    });
    const deleteText = el('span', { class: 'cd-app-settings-menu-text' }, [
      el('span', { class: 'cd-app-settings-menu-label' }, 'Delete app'),
      el(
        'span',
        { class: 'cd-app-settings-menu-sub' },
        'Removes the app, its data, and its scheduled automations.',
      ),
    ]);
    const deleteConfirm = el(
      'span',
      { class: 'cd-app-settings-confirm-pill', hidden: '' },
      'click to confirm',
    );
    deleteBtn.append(deleteIconTile, deleteText, deleteConfirm);
    deleteBtn.addEventListener('click', () => {
      if (!deleteArmed) {
        deleteArmed = true;
        deleteBtn.dataset.armed = 'true';
        deleteConfirm.hidden = false;
        return;
      }
      closeAppSettings();
      void ctx.handleDeleteApp(app);
    });
    dangerZone.append(deleteBtn);
    panes.manage.append(dangerZone);

    showAppSettingsTab('appearance');

    view.append(backdrop);
    view.append(panel);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAppSettings();
      }
    };
    window.addEventListener('keydown', onKey);

    appSettingsCleanup = (): void => {
      window.removeEventListener('keydown', onKey);
      backdrop.remove();
      panel.remove();
      prefsHost = null;
      delete anchor.dataset.open;
    };
  }

  // `automationRunState` (per-automation run state, keyed by `${appId}:${name}`)
  // is shell state on the ShellContext — destructured at the top of this module.

  function renderAutomationsSection(
    rows: CentraidAutomationRow[],
    panel: HTMLElement,
  ): HTMLElement {
    const section = el('div', { class: 'cd-app-settings-section cd-app-orders' });
    section.append(
      el('div', { class: 'cd-app-settings-section-label cd-app-orders-label' }, 'Standing orders'),
    );

    const list = el('div', { class: 'cd-app-orders-list' });
    for (const row of rows) {
      list.append(renderStandingOrder(row, panel));
    }
    section.append(list);
    return section;
  }

  function renderStandingOrder(row: CentraidAutomationRow, panel: HTMLElement): HTMLElement {
    const card = el('article', {
      class: 'cd-app-order',
      'data-enabled': String(row.enabled),
      'data-automation-id': row.id,
    });

    // Left rail — thin colored bar. Accent when on, neutral when off.
    // Decorative only; the toggle is the keyboard target.
    card.append(el('span', { class: 'cd-app-order-rail', 'aria-hidden': 'true' }));

    const body = el('div', { class: 'cd-app-order-body' });

    // Header line: automation name + schedule · run-now affordance.
    const head = el('div', { class: 'cd-app-order-head' });
    head.append(
      el(
        'button',
        {
          class: 'cd-app-order-name',
          type: 'button',
          title: `Open ${row.name}`,
          onClick: () => ctx.shell.renderAutomationView(row.ref),
        },
        row.name,
      ),
      el('span', { class: 'cd-app-order-schedule' }, triggersSummary(row.triggers)),
    );

    const stateKey = row.ref;
    const runBtn = el('button', {
      class: 'cd-app-order-run',
      type: 'button',
      onClick: () => void onRunStandingOrder(row, panel),
    }) as HTMLButtonElement;
    const runState = automationRunState.get(stateKey);
    runBtn.disabled = runState?.kind === 'running';
    runBtn.textContent = runState?.kind === 'running' ? 'Running…' : 'Run now';
    head.append(runBtn);
    body.append(head);

    // The user's NL prompt, treated as a quoted instruction.
    const promptEl = el('blockquote', { class: 'cd-app-order-prompt' });
    promptEl.textContent = row.manifest.prompt;
    body.append(promptEl);

    // Foot: associated apps + result chip when present.
    const foot = el('div', { class: 'cd-app-order-foot' });
    const apps = row.manifest.apps ?? [];
    foot.append(
      el(
        'span',
        { class: 'cd-app-order-handler' },
        apps.length > 0 ? `Apps: ${apps.join(', ')}` : 'No apps linked',
      ),
    );

    if (runState?.kind === 'done') {
      const chip = el('span', {
        class: 'cd-app-order-result',
        'data-ok': String(runState.ok),
      });
      if (runState.ok) {
        chip.textContent = `Ran in ${formatDuration(runState.durationMs)}`;
      } else {
        chip.textContent = runState.error
          ? `Failed: ${runState.error}`
          : `Failed in ${formatDuration(runState.durationMs)}`;
      }
      foot.append(chip);
    }

    // Run audit affordance (issue #80). The "Runs" link expands a
    // per-automation history panel below the card with the last 25
    // runs (timestamp, ok/error, duration, summary). Clicking a run
    // expands its node timeline (ordinal, kind, name, duration, +
    // expandable args/output JSON).
    const runsToggle = el('button', {
      class: 'cd-app-order-runs-toggle',
      type: 'button',
      'aria-expanded': 'false',
    }) as HTMLButtonElement;
    runsToggle.textContent = 'Runs';
    const runsHost = el('div', { class: 'cd-app-order-runs', hidden: 'true' });
    runsToggle.addEventListener('click', () => {
      const open = runsToggle.getAttribute('aria-expanded') === 'true';
      const next = !open;
      runsToggle.setAttribute('aria-expanded', String(next));
      runsHost.hidden = !next;
      if (next && !runsHost.dataset.loaded) {
        void loadRunsInto(row.ref, runsHost);
      }
    });
    foot.append(runsToggle);

    body.append(foot);
    body.append(runsHost);
    card.append(body);

    // Toggle column — pill switch. The label wraps the input so the
    // visual hit-area and the keyboard control align.
    const toggle = el('label', {
      class: 'cd-app-order-toggle',
      'aria-label': `${row.enabled ? 'Disable' : 'Enable'} ${row.name}`,
    });
    const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = row.enabled;
    input.addEventListener('change', () => {
      void onToggleStandingOrder(row, input, card, panel);
    });
    toggle.append(input);
    toggle.append(el('span', { class: 'cd-app-order-toggle-track', 'aria-hidden': 'true' }));
    card.append(toggle);

    return card;
  }

  async function onToggleStandingOrder(
    row: CentraidAutomationRow,
    input: HTMLInputElement,
    card: HTMLElement,
    panel: HTMLElement,
  ): Promise<void> {
    const next = input.checked;
    card.dataset.enabled = String(next);
    try {
      await setAutomationEnabled({ automationId: row.ref, enabled: next });
      // The in-memory row stored by closure is now stale; reflect the
      // new state so a subsequent toggle reads the right "current."
      (row as { enabled: boolean }).enabled = next;
    } catch (err) {
      // Revert UI so it doesn't lie about persisted state.
      input.checked = row.enabled;
      card.dataset.enabled = String(row.enabled);
      if (document.contains(panel)) {
        showToast(
          `Could not ${next ? 'enable' : 'disable'} ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Bounded poll of the run ledger until a run finishes — the fallback for
  // `waitForAutomationRun` when the live stream can't be established.
  async function pollForAutomationRun(runId: string): Promise<CentraidAutomationRunRecord> {
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      const rec = await readAutomationRun({ runId });
      if (rec && rec.endedAt !== undefined) return rec;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('run did not finish within 6 minutes');
  }

  // Await a run's completion. Used where the caller needs the run-now outcome
  // but has no live viewer (the standing-order panel in app settings). Rides
  // the SSE stream (issue #158): resolve as soon as `run.end` lands, then read
  // the authoritative final record. Falls back to polling if the stream
  // fails or closes without a terminal event.
  async function waitForAutomationRun(runId: string): Promise<CentraidAutomationRunRecord> {
    const ac = new AbortController();
    let sawEnd = false;
    try {
      await streamAutomationRun(
        runId,
        (ev) => {
          if (ev.type === 'run.end') {
            sawEnd = true;
            ac.abort();
          }
        },
        ac.signal,
      );
    } catch {
      return pollForAutomationRun(runId);
    } finally {
      ac.abort();
    }
    if (sawEnd) {
      const rec = await readAutomationRun({ runId });
      if (rec && rec.endedAt !== undefined) return rec;
    }
    // Stream closed without a terminal event we could act on — poll to settle.
    return pollForAutomationRun(runId);
  }

  async function onRunStandingOrder(row: CentraidAutomationRow, panel: HTMLElement): Promise<void> {
    const stateKey = row.ref;
    automationRunState.set(stateKey, { kind: 'running' });
    // Repaint just this card so the rest of the panel doesn't blink.
    rerenderOrderCard(row, panel);
    try {
      // run-now fires in the background and returns the run id; poll the
      // ledger for the finished record to report the card's outcome.
      const { runId } = await runAutomationNow({ automationId: row.ref });
      const rec = await waitForAutomationRun(runId);
      automationRunState.set(stateKey, {
        kind: 'done',
        ok: rec.ok,
        durationMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
        ...(rec.error ? { error: rec.error } : {}),
        finishedAt: Date.now(),
      });
    } catch (err) {
      automationRunState.set(stateKey, {
        kind: 'done',
        ok: false,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
        finishedAt: Date.now(),
      });
    }
    rerenderOrderCard(row, panel);
  }

  // Issue #80 — render the per-automation runs panel inline below the
  // standing-order card. The host element is created hidden in
  // renderStandingOrder; this function lazy-loads on first open and
  // caches via the `data-loaded` flag so re-toggling doesn't refetch.
  async function loadRunsInto(automationId: string, host: HTMLElement): Promise<void> {
    host.dataset.loaded = 'true';
    host.replaceChildren(el('div', { class: 'cd-app-runs-empty' }, 'Loading…'));
    let runs: CentraidAutomationRunRecord[];
    try {
      runs = await listAutomationRuns({ automationId, limit: 25 });
    } catch (err) {
      host.replaceChildren(
        el(
          'div',
          { class: 'cd-app-runs-empty' },
          `Failed to load runs: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (runs.length === 0) {
      host.replaceChildren(el('div', { class: 'cd-app-runs-empty' }, 'No runs recorded yet.'));
      return;
    }
    const wrap = el('div', { class: 'cd-app-runs' });
    const list = el('div', { class: 'cd-app-runs-list' });
    for (const run of runs) list.append(renderRunRow(automationId, run, host));
    wrap.append(list);
    host.replaceChildren(wrap);
  }

  async function onTogglePin(
    automationId: string,
    run: CentraidAutomationRunRecord,
    host: HTMLElement,
  ): Promise<void> {
    try {
      await pinAutomationRun({ runId: run.runId, pinned: !run.pinned });
    } catch (err) {
      showToast(`Could not update pin: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    delete host.dataset.loaded;
    void loadRunsInto(automationId, host);
  }

  function renderRunRow(
    automationId: string,
    run: CentraidAutomationRunRecord,
    host: HTMLElement,
  ): HTMLElement {
    const card = el('div', {
      class: 'cd-app-run',
      'data-ok': String(run.ok),
      'data-pinned': String(run.pinned),
    });
    const head = el('button', {
      type: 'button',
      class: 'cd-app-run-head',
      'aria-expanded': 'false',
    }) as HTMLButtonElement;
    const when = new Date(run.startedAt).toLocaleString();
    const duration = run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : '…';
    head.append(
      el('span', { class: 'cd-app-run-status' }, run.ok ? '✓' : '✗'),
      el('span', { class: 'cd-app-run-when' }, when),
      el('span', { class: 'cd-app-run-trigger' }, run.triggerKind),
      el('span', { class: 'cd-app-run-duration' }, duration),
      el(
        'span',
        { class: 'cd-app-run-summary' },
        run.ok ? (run.summary ?? '—') : (run.error ?? 'failed'),
      ),
    );
    if (run.pinned) {
      head.append(
        el('span', { class: 'cd-app-run-pin-flag', title: 'Pinned replay fixture' }, '📌'),
      );
    }
    const nodesHost = el('div', { class: 'cd-app-run-nodes', hidden: 'true' });
    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      const next = !open;
      head.setAttribute('aria-expanded', String(next));
      nodesHost.hidden = !next;
      if (next && !nodesHost.dataset.loaded) {
        void loadNodesInto(run.runId, nodesHost);
      }
    });
    const actions = el('div', { class: 'cd-app-run-actions' });
    const pinBtn = el('button', {
      type: 'button',
      class: 'cd-app-run-pin',
    }) as HTMLButtonElement;
    pinBtn.textContent = run.pinned ? 'Unpin' : 'Pin';
    pinBtn.title = run.pinned
      ? 'Stop using this run as a replay fixture'
      : 'Pin this run as a replay fixture';
    pinBtn.addEventListener('click', () => void onTogglePin(automationId, run, host));
    actions.append(pinBtn);
    card.append(head, actions, nodesHost);
    return card;
  }

  async function loadNodesInto(runId: string, host: HTMLElement): Promise<void> {
    host.dataset.loaded = 'true';
    host.replaceChildren(el('div', { class: 'cd-app-runs-empty' }, 'Loading nodes…'));
    let nodes: CentraidAutomationRunNode[];
    try {
      nodes = await listAutomationRunNodes({ runId });
    } catch (err) {
      host.replaceChildren(
        el(
          'div',
          { class: 'cd-app-runs-empty' },
          `Failed to load nodes: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (nodes.length === 0) {
      host.replaceChildren(el('div', { class: 'cd-app-runs-empty' }, 'No nodes recorded.'));
      return;
    }
    host.replaceChildren(renderNodeTimeline(nodes, 0));
  }

  // Render the run as a DAG rather than a flat list: nodes that share a
  // `batchId` (a `Promise.all` frontier) sit in one parallel lane;
  // `ctx.invoke` nodes expand to their child run's own nested timeline.
  function renderNodeTimeline(nodes: CentraidAutomationRunNode[], depth: number): HTMLElement {
    const wrap = el('div', { class: 'cd-app-run-timeline' });
    let i = 0;
    while (i < nodes.length) {
      const node = nodes[i]!;
      const bid = node.batchId;
      if (bid !== undefined) {
        const group: CentraidAutomationRunNode[] = [];
        while (i < nodes.length && nodes[i]!.batchId === bid) {
          group.push(nodes[i]!);
          i++;
        }
        if (group.length > 1) {
          const lane = el('div', { class: 'cd-app-run-lane' });
          lane.append(el('div', { class: 'cd-app-run-lane-label' }, `parallel ×${group.length}`));
          const laneNodes = el('div', { class: 'cd-app-run-lane-nodes' });
          for (const g of group) laneNodes.append(renderNodeCard(g, depth));
          lane.append(laneNodes);
          wrap.append(lane);
          continue;
        }
        wrap.append(renderNodeCard(group[0]!, depth));
        continue;
      }
      wrap.append(renderNodeCard(node, depth));
      i++;
    }
    return wrap;
  }

  function renderNodeCard(node: CentraidAutomationRunNode, depth: number): HTMLElement {
    const wrap = el('div', {
      class: 'cd-app-run-node',
      'data-ok': String(node.ok),
      'data-kind': node.kind,
    });
    const head = el('div', { class: 'cd-app-run-node-head' }, [
      el('span', { class: 'cd-app-run-node-pos' }, `#${node.ordinal}`),
      el('span', { class: 'cd-app-run-node-kind' }, node.kind),
      el('span', { class: 'cd-app-run-node-name' }, node.name ?? node.model ?? node.kind),
      el(
        'span',
        { class: 'cd-app-run-node-duration' },
        node.durationMs !== undefined ? formatDuration(node.durationMs) : '—',
      ),
    ]);
    wrap.append(head);
    if (node.error) {
      wrap.append(el('div', { class: 'cd-app-run-node-error' }, node.error));
    }
    if (node.argsJson) {
      const det = el('details', { class: 'cd-app-run-node-payload' });
      det.append(el('summary', {}, 'args'), el('pre', {}, prettyJson(node.argsJson)));
      wrap.append(det);
    }
    if (node.outputJson) {
      const det = el('details', { class: 'cd-app-run-node-payload' });
      det.append(el('summary', {}, 'output'), el('pre', {}, prettyJson(node.outputJson)));
      wrap.append(det);
    }
    // ctx.invoke node — nest the child run's own timeline.
    const childRunId = node.childRunId;
    if (node.kind === 'invoke' && childRunId && depth < 4) {
      const childHost = el('div', { class: 'cd-app-run-node-children', hidden: 'true' });
      const toggle = el('button', {
        type: 'button',
        class: 'cd-app-run-node-expand',
        'aria-expanded': 'false',
      }) as HTMLButtonElement;
      toggle.textContent = 'child run ▸';
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        const next = !open;
        toggle.setAttribute('aria-expanded', String(next));
        toggle.textContent = next ? 'child run ▾' : 'child run ▸';
        childHost.hidden = !next;
        if (next && !childHost.dataset.loaded) {
          void loadChildNodes(childRunId, childHost, depth);
        }
      });
      wrap.append(toggle, childHost);
    }
    return wrap;
  }

  async function loadChildNodes(runId: string, host: HTMLElement, depth: number): Promise<void> {
    host.dataset.loaded = 'true';
    host.replaceChildren(el('div', { class: 'cd-app-runs-empty' }, 'Loading child run…'));
    let nodes: CentraidAutomationRunNode[];
    try {
      nodes = await listAutomationRunNodes({ runId });
    } catch (err) {
      host.replaceChildren(
        el(
          'div',
          { class: 'cd-app-runs-empty' },
          `Failed to load child run: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (nodes.length === 0) {
      host.replaceChildren(
        el('div', { class: 'cd-app-runs-empty' }, 'Child run recorded no nodes.'),
      );
      return;
    }
    host.replaceChildren(renderNodeTimeline(nodes, depth + 1));
  }

  function rerenderOrderCard(row: CentraidAutomationRow, panel: HTMLElement): void {
    if (!document.contains(panel)) return;
    const card = panel.querySelector<HTMLElement>(
      `.cd-app-order[data-automation-id="${CSS.escape(row.id)}"]`,
    );
    if (card) card.replaceWith(renderStandingOrder(row, panel));
  }

  function renderKnobsSection(
    knobs: AppKnob[],
    stored: Record<string, string>,
    view: HTMLElement,
    appId: string,
    panel: HTMLElement,
  ): HTMLElement {
    const rows: HTMLElement[] = [];
    for (const knob of knobs) {
      const current = stored[knob.key] ?? knob.default;
      const commit = (next: string): void => {
        // Live push first so the user sees the change immediately; then
        // persist. If the SQL write fails, toast + revert to the prior
        // value so the popover doesn't lie about what's saved.
        pushKnobToAppFrame(view, knob.key, next);
        const prior = stored[knob.key] ?? knob.default;
        stored[knob.key] = next;
        void writeAppKnobValue(appId, knob.key, next).catch((err) => {
          showToast(`Saving ${knob.label.toLowerCase()} failed: ${String(err)}`);
          if (document.contains(panel)) {
            stored[knob.key] = prior;
            pushKnobToAppFrame(view, knob.key, prior);
          }
        });
      };
      const control =
        knob.type === 'swatch'
          ? makeKnobSwatches(knob.options, current, commit)
          : makeSegmentedLabeled(
              knob.options.map((o) => o.value),
              Object.fromEntries(knob.options.map((o) => [o.value, o.label])),
              current,
              commit,
            );
      rows.push(
        el('div', { class: 'cd-app-settings-row' }, [
          el('span', { class: 'cd-app-settings-row-label' }, knob.label),
          control,
        ]),
      );
    }
    return el('div', { class: 'cd-app-settings-section' }, [
      el('div', { class: 'cd-app-settings-section-label' }, 'Preferences'),
      ...rows,
    ]);
  }

  // Render swatches for `type: 'swatch'` knobs (e.g. `appColor`). Each
  // option's `value` is taken as a CSS-compatible colour; the `label` is
  // surfaced via `title=` for hover-tooltips. Visually matches the global
  // accent swatches in the Settings page.
  function makeKnobSwatches(
    options: readonly AppKnobOption[],
    selected: string,
    onSelect: (value: string) => void,
  ): HTMLElement {
    const wrap = el('div', { class: 'cd-swatches', role: 'radiogroup' });
    for (const opt of options) {
      const isActive = opt.value === selected;
      const btn = el('button', {
        'aria-checked': String(isActive),
        'aria-label': opt.label,
        class: 'cd-swatch',
        'data-active': String(isActive),
        role: 'radio',
        style: { background: opt.value },
        title: opt.label,
        type: 'button',
      });
      btn.innerHTML = Icon.Check({ size: 14, strokeWidth: 2.5 });
      btn.addEventListener('click', () => {
        for (const child of wrap.children) {
          (child as HTMLElement).dataset.active = 'false';
          child.setAttribute('aria-checked', 'false');
        }
        btn.dataset.active = 'true';
        btn.setAttribute('aria-checked', 'true');
        onSelect(opt.value);
      });
      wrap.append(btn);
    }
    return wrap;
  }

  // makeSegmented variant that lets the caller supply a separate label per
  // option (instead of reusing the value string). The template's
  // `app.json#knobs[]` may want `{ value: "sans", label: "Sans" }` etc.
  function makeSegmentedLabeled(
    options: readonly string[],
    labels: Record<string, string>,
    selected: string,
    onSelect: (value: string) => void,
  ): HTMLElement {
    const wrap = el('div', { class: 'seg', role: 'tablist' });
    for (const opt of options) {
      const btn = el(
        'button',
        {
          'data-active': String(opt === selected),
          onClick: () => {
            for (const child of wrap.children) {
              (child as HTMLElement).dataset.active = 'false';
            }
            btn.dataset.active = 'true';
            onSelect(opt);
          },
          role: 'tab',
        },
        labels[opt] ?? opt,
      );
      wrap.append(btn);
    }
    return wrap;
  }

  function appSettingsMenuItem(
    iconKey: IconNameType,
    label: string,
    sub: string,
    onClick: () => void,
    opts: { destructive?: boolean } = {},
  ): HTMLElement {
    const btn = el('button', {
      class: 'cd-app-settings-menu-item',
      type: 'button',
      'data-danger': opts.destructive ? 'true' : undefined,
      onClick,
    });
    btn.append(
      el('span', {
        class: 'cd-app-settings-menu-icon',
        trustedHtml: Icon[iconKey] ? Icon[iconKey]({ size: 13 }) : '',
      }),
      el('span', { class: 'cd-app-settings-menu-text' }, [
        el('span', { class: 'cd-app-settings-menu-label' }, label),
        el('span', { class: 'cd-app-settings-menu-sub' }, sub),
      ]),
    );
    return btn;
  }

  // Inline rename from the settings panel — the home-grid inline editor
  // relies on the card being in the DOM, which it isn't from the app view.
  // A prompt is the lowest-friction substitute and matches the rest of the
  // shell's "manage app" affordances.
  async function renameAppFromSettings(app: AppMetaResolvedType): Promise<void> {
    const input = window.prompt('Rename app', app.name);
    if (input == null) return;
    const next = input.trim().replace(/\s+/g, ' ');
    if (!next || next === app.name) return;
    try {
      await updateAppMeta({ id: app.id, name: next });
      const ua = findUserApp(app.id);
      if (ua) {
        ua.name = next;
        ua.updatedAt = new Date().toISOString();
        persist();
      }
      showToast(`Renamed to "${next}"`);
      openApp(app.id);
    } catch (err) {
      showToast(`Rename failed: ${String(err)}`);
    }
  }

  return { openApp, closeAppSettings };
}
