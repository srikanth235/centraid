// governance: allow-repo-hygiene file-size-limit route-module split out of app.ts (#227)
// The app-view subsystem: opening a centraid app into the windowed view
// (openApp → mountUserApp → sandboxed iframe + per-app agentic chat), plus the
// per-app Settings drawer (knobs persisted to the app's settings.json,
// standing-order automations with live run timelines). Extracted from app.ts.
//
// `appSettingsCleanup` is module-local. Shell state (prefs, userApps, the live
// sidebar setter, currentCleanup, automationRunState) is reached through the
// ShellContext accessors; sibling surfaces (builder, automation/run views,
// share, card actions) through ctx.shell.* and the ctx card-action forwarders.
import {
  appLiveUrl,
  appSettings,
  appSettingWrite,
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
import { formatDuration, prettyJson, triggersSummary } from './app-format.js';
import { manifestVaultBlock, renderVaultPane } from './app-vault.js';
import { requireReactBridge } from './react/bridge.js';
import type { AppSettingsSnapshot } from './react/bridge.js';
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
      // since the agent operates the app's vault data via the gateway.
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
  // Values persist in the app's `settings.json` via
  // `PUT /centraid/_apps/<id>/settings` (issue #286 phase 2 — the old
  // `__centraid_settings` SQL table died with the per-app data.sqlite).
  // Keys stay camelCase (`appFont`) on the wire; the runtime's
  // settings-merge kebab-cases them into `<html data-app-<key>="...">`
  // on next load, and the inline bridge in each template applies live
  // `centraid:settings` postMessage updates from the shell so the change
  // is visible immediately.

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

  async function fetchAppKnobValues(appId: string): Promise<Record<string, string>> {
    try {
      const settings = await appSettings({ id: appId });
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings)) {
        // Knob values are plain strings; skip non-knob shapes (and any
        // runtime-owned key the gateway might ever echo).
        if (typeof value === 'string' && !key.startsWith('__')) out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  async function writeAppKnobValue(appId: string, key: string, value: string): Promise<void> {
    // camelCase key as-is — the runtime kebab-cases at bake time.
    await appSettingWrite({ id: appId, key, value });
  }

  // Settings key (camelCase, e.g. `appFont`) → the kebab name shared by
  // the data-attr and CSS-var paths. Mirrors `camelTailToKebab` in
  // `app-engine/src/settings/settings-merge.ts` so the live update lands
  // on the same target the runtime will bake on next reload.
  function appKnobKebab(key: string): string {
    // Strip the `app` prefix, lowercase first letter, kebab the rest.
    const tail = key.startsWith('app') ? key.slice(3) : key;
    return `app-${tail.charAt(0).toLowerCase()}${tail.slice(1).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
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

  // Phase 3 (#325) — React app-settings popover. The vanilla app-view keeps the
  // iframe host, chrome, and per-app chat; only this popover moves to React. The
  // gateway I/O (knob persistence + live iframe push, automation run/toggle
  // streams) stays here and pushes a snapshot; the two deep sub-trees (the lazy
  // run-history timeline and the vault consent pane) stay vanilla and are
  // injected into React-provided host divs. The DOM builder below is the runnable
  // fallback for any build without the React bundle.
  function openAppSettingsReact(
    app: AppMetaResolvedType,
    anchor: HTMLElement,
    view: HTMLElement,
    appId: string | undefined,
    mount: NonNullable<Window['CentraidReact']>['mountAppSettings'],
  ): void {
    closeAppSettings();
    anchor.dataset.open = 'true';

    const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');
    const iconSvg = Icon[app.iconKey] ? Icon[app.iconKey]({ size: 15, strokeWidth: 1.85 }) : '';

    let knobs: AppKnob[] | null = null;
    const knobValues: Record<string, string> = {};
    let orders: CentraidAutomationRow[] = [];
    let vaultVisible = false;
    let automationsBadge: number | null = null;
    let vaultBadge: number | null = null;
    let update: ((s: AppSettingsSnapshot) => void) | null = null;

    const runDto = (ref: string): AppSettingsSnapshot['orders'][number]['run'] => {
      const s = automationRunState.get(ref);
      if (!s) return { kind: 'idle' };
      if (s.kind === 'running') return { kind: 'running' };
      const label = s.ok
        ? `Ran in ${formatDuration(s.durationMs)}`
        : s.error
          ? `Failed: ${s.error}`
          : `Failed in ${formatDuration(s.durationMs)}`;
      return { kind: 'done', ok: s.ok, label };
    };

    const buildSnapshot = (): AppSettingsSnapshot => ({
      appName: app.name,
      iconSvg,
      iconBg: finish.background,
      iconColor: finish.glyphColor,
      iconShadow: finish.boxShadow ?? null,
      accent: app.color,
      vaultVisible,
      automationsBadge,
      vaultBadge,
      knobs: knobs
        ? knobs.map((k) => ({
            key: k.key,
            label: k.label,
            type: k.type,
            value: knobValues[k.key] ?? k.default,
            options: k.options,
          }))
        : null,
      orders: orders.map((row) => ({
        id: row.id,
        ref: row.ref,
        name: row.name,
        schedule: triggersSummary(row.triggers),
        prompt: row.manifest.prompt,
        appsLabel:
          (row.manifest.apps ?? []).length > 0
            ? `Apps: ${(row.manifest.apps ?? []).join(', ')}`
            : 'No apps linked',
        enabled: row.enabled,
        run: runDto(row.ref),
      })),
    });

    const push = (): void => {
      if (update) update(buildSnapshot());
    };

    const host = el('div', {});

    // Live-push a knob to the iframe, persist it, revert + toast on failure.
    const commitKnob = (key: string, value: string): void => {
      pushKnobToAppFrame(view, key, value);
      const def = knobs?.find((k) => k.key === key)?.default ?? '';
      const prior = knobValues[key] ?? def;
      knobValues[key] = value;
      if (!appId) return;
      void writeAppKnobValue(appId, key, value).catch((err) => {
        showToast(`Saving ${key} failed: ${String(err)}`);
        if (document.contains(host)) {
          knobValues[key] = prior;
          pushKnobToAppFrame(view, key, prior);
          push();
        }
      });
    };

    const runOrder = async (ref: string): Promise<void> => {
      automationRunState.set(ref, { kind: 'running' });
      push();
      try {
        const { runId } = await runAutomationNow({ automationId: ref });
        const rec = await waitForAutomationRun(runId);
        automationRunState.set(ref, {
          kind: 'done',
          ok: rec.ok,
          durationMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
          ...(rec.error ? { error: rec.error } : {}),
          finishedAt: Date.now(),
        });
      } catch (err) {
        automationRunState.set(ref, {
          kind: 'done',
          ok: false,
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
        });
      }
      if (document.contains(host)) push();
    };

    const toggleOrder = async (ref: string, enabled: boolean): Promise<void> => {
      const row = orders.find((r) => r.ref === ref);
      if (!row) return;
      const prior = row.enabled;
      row.enabled = enabled;
      push();
      try {
        await setAutomationEnabled({ automationId: ref, enabled });
      } catch (err) {
        row.enabled = prior;
        if (document.contains(host)) {
          push();
          showToast(
            `Could not ${enabled ? 'enable' : 'disable'} ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };

    const dispose = mount(host, {
      onReady: (u) => {
        update = u;
        u(buildSnapshot());
      },
      onClose: closeAppSettings,
      onKnobCommit: commitKnob,
      onRunOrder: (ref) => void runOrder(ref),
      onToggleOrder: (ref, enabled) => void toggleOrder(ref, enabled),
      onOpenOrder: (ref) => ctx.shell.renderAutomationView(ref),
      onOpenAutomations: () => {
        closeAppSettings();
        ctx.shell.renderAutomations();
      },
      onRename: () => {
        closeAppSettings();
        void renameAppFromSettings(app);
      },
      onShare: () => {
        closeAppSettings();
        ctx.shell.openShareDialog(app);
      },
      onReveal: () => {
        closeAppSettings();
        void ctx.revealApp(app);
      },
      onDelete: () => {
        closeAppSettings();
        void ctx.handleDeleteApp(app);
      },
      onMountRuns: (ref, runsHost) => void loadRunsInto(ref, runsHost),
      onMountVault: (vaultHost) => {
        if (!appId) return;
        void fetchAppManifestRaw(appId).then((raw) => {
          const block = manifestVaultBlock(raw);
          if (!block || !document.contains(host)) return;
          void renderVaultPane({
            el,
            appId,
            block,
            host: vaultHost,
            onAccessChanged: () => reloadAppFrame(view),
            onParkedCount: (count) => {
              vaultBadge = count === 0 ? null : count;
              push();
            },
            showToast,
          });
        });
      },
    });

    view.append(host);

    appSettingsCleanup = (): void => {
      dispose();
      host.remove();
      delete anchor.dataset.open;
    };

    // Resolve appearance knobs, the vault tab's visibility, and linked
    // automations, then push each result into the live snapshot.
    if (appId) {
      const manifestRaw = fetchAppManifestRaw(appId);
      void Promise.all([manifestRaw, fetchAppKnobValues(appId)]).then(([raw, stored]) => {
        if (!document.contains(host)) return;
        const manifest = knobsManifestFrom(raw);
        if (manifest && manifest.knobs.length > 0) {
          knobs = manifest.knobs;
          Object.assign(knobValues, stored);
        }
        push();
      });
      void manifestRaw.then((raw) => {
        if (!document.contains(host)) return;
        if (manifestVaultBlock(raw)) {
          vaultVisible = true;
          push();
        }
      });
      void listAutomations().then((all) => {
        if (!document.contains(host)) return;
        orders = all.filter((r) => r.manifest.apps?.includes(appId));
        automationsBadge = orders.length === 0 ? null : orders.length;
        push();
      });
    }
  }

  function openAppSettings(
    app: AppMetaResolvedType,
    anchor: HTMLElement,
    view: HTMLElement,
    appId: string | undefined,
  ): void {
    openAppSettingsReact(app, anchor, view, appId, requireReactBridge().mountAppSettings);
  }

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

  // Issue #80 — render the per-automation runs panel into the host div the
  // React settings panel provides via onMountRuns; this function lazy-loads on
  // first open and caches via the `data-loaded` flag so re-toggling doesn't
  // refetch.
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
