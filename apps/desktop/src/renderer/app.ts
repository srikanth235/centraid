// Centraid shell — renders the home screen and routes to apps.
// governance: allow-repo-hygiene file-size-limit shell-entry-point — the shell core (#227)
// Every app the user sees is centraid-backed: cloned from a template or
// authored in the builder, published to the gateway, rendered through a
// sandboxed iframe. The home grid also shows uninstalled templates inline
// so they're one tap away from being cloned & deployed.
//
// This file is the shell CORE: appearance/prefs, navigation, profiles, the
// sidebar, the Home screen, the shared render primitives, and the ShellContext
// wiring + boot sequence. Every other surface lives in a route module it
// constructs below (app-insights, app-discover, app-automations, app-palette,
// app-cards, app-appview, app-settings), wired through ./app-shell-context.

import {
  deleteAutomation,
  getUserPrefs,
  listApps,
  listAutomations,
  runAutomationNow,
  saveUserPrefs,
} from './gateway-client.js';
import { chevronDown, colorForIcon, relativeTime, triggersSummary } from './app-format.js';
import { buildLayoutToggle } from './app-glyphs.js';
import { auStatusForRow } from './automation-identity.js';
import { ACCENT_PALETTE } from './app-shell-context.js';
import type {
  AccentKey,
  AppearancePrefs,
  AutomationRunState,
  GatewayProfile,
  GatewaySummary,
  ShellContext,
  ShellEntries,
  ShellRoute,
  ThemeName,
} from './app-shell-context.js';
import { createInsightsModule } from './app-insights.js';
import { createAutomationsModule, type AutomationFeedEntry } from './app-automations.js';
import { createPaletteModule } from './app-palette.js';
import { createCardsModule } from './app-cards.js';
import { createDiscoverModule } from './app-discover.js';
import { createSettingsModule } from './app-settings.js';
import { createAppViewModule } from './app-appview.js';

(function () {
  const root = document.querySelector('#root') as HTMLElement;

  // Apps the user has installed (cloned from a template or built themselves).
  // The home grid renders these plus uninstalled templates inline.
  let userApps = Store.get<UserAppMeta[]>('home.userApps', []);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Renderer prefs — appearance settings live here (vs gateway settings,
  // which live in the main process via window.CentraidApi.getSettings).
  // ThemeName mirrors the keys of @centraid/design-tokens' THEME_PRESETS;
  // any string read off the gateway is validated against this set at the
  // pickAppearance boundary, so unknown names never reach `applyPrefs`.
  // AppearancePrefs and its member unions (ThemeName/Density/TileVariant/
  // AccentKey/CardVariant) live in app-shell-context.ts so the extracted
  // settings module shares the exact same types.
  // ACCENT_PALETTE lives in app-shell-context.ts (shared with app-settings).
  const DEFAULT_PREFS: AppearancePrefs = {
    accent: 'teal',
    bgL: 5,
    cardVariant: 'outlined',
    coolBlueCast: true,
    density: 'regular',
    sidebarOpen: true,
    // Bold · Atmospheric is built around the dark blue-tinted ramp + the
    // brand teal accent (the logo hue). Light theme still works but won't
    // carry the atmospheric glow — dark is the design's home turf.
    theme: 'dark',
    // Design uses the vertical-darkening gradient for app icons (155deg,
    // top→bottom hue, -25 shade). Matches the Bold home screenshot.
    tileVariant: 'gradient',
  };

  // Local Store value is the FAST-PAINT CACHE — applied synchronously so the
  // shell renders in the user's chosen theme before any IPC round-trip. The
  // gateway-side `centraid-user.sqlite` is the source of truth; we hydrate
  // from it immediately after first paint and reconcile if it disagrees.
  let prefs: AppearancePrefs = {
    ...DEFAULT_PREFS,
    ...Store.get<Partial<AppearancePrefs>>('appearance', {}),
    // Dark shade is locked to 5 — slider rendered read-only in Settings.
    bgL: 5,
  };

  function applyPrefs(): void {
    const html = document.documentElement;
    html.dataset.theme = prefs.theme;
    html.dataset.density = prefs.density;
    html.dataset.cards = prefs.cardVariant;
    html.dataset.coolCast = prefs.coolBlueCast ? 'on' : 'off';
    // The dark ramp's lightness anchor — light theme ignores it (its
    // surfaces are literal hex), but writing it unconditionally is harmless.
    html.style.setProperty('--bg-l', `${prefs.bgL}%`);
    const swatch = ACCENT_PALETTE[prefs.accent];
    html.style.setProperty('--accent', swatch.accent);
    html.style.setProperty('--accent-light', swatch.light);
    html.style.setProperty('--accent-deep', swatch.deep);
    // Broadcast to every mounted user-app iframe so they retune in lock-step
    // with the shell. The tiny bridge script in each template
    // (packages/blueprints/*/index.html) listens for this and flips its
    // own <html> data-attrs / CSS vars to match.
    broadcastSettingsToFrames();
    // §C2 — let an open Appearance settings page refresh its live-preview
    // tile (tile/card/density variants aren't pure CSS-var swaps).
    if (onAppearanceApplied) onAppearanceApplied();
  }

  // §C2 — set by the Appearance settings page so its preview tile can
  // re-render on every pref change; cleared on page teardown.
  let onAppearanceApplied: (() => void) | null = null;

  // App the renderer's typed prefs into the same `dataAttrs` / `cssVars`
  // shape the runtime uses for server-side injection. The bridge inside each
  // app applies them as `<html data-…>` attrs and `--…` CSS vars — symmetric
  // with what the gateway bakes on first paint.
  // Iframes (blueprints, user apps) only know how to style
  // `data-theme='light'|'dark'`. Third-party shell themes (Monokai, Nord…)
  // still resolve to one of those two on the iframe side; the shell
  // itself wears the full named theme.
  function iframeThemeKind(): 'light' | 'dark' {
    return window.CentraidTokens.themes[prefs.theme]?.kind ?? 'dark';
  }

  function buildIframeSettings(): {
    dataAttrs: Record<string, string>;
    cssVars: Record<string, string>;
  } {
    const remote = toRemoteShape(prefs);
    const dataAttrs: Record<string, string> = {};
    const cssVars: Record<string, string> = {};
    if (typeof remote.theme === 'string') dataAttrs['theme'] = iframeThemeKind();
    if (typeof remote.density === 'string') dataAttrs['density'] = remote.density;
    if (typeof remote.cards === 'string') dataAttrs['cards'] = remote.cards;
    if (typeof remote.coolCast === 'boolean')
      dataAttrs['cool-cast'] = remote.coolCast ? 'on' : 'off';
    if (typeof prefs.bgL === 'number' && Number.isFinite(prefs.bgL))
      cssVars['bg-l'] = `${prefs.bgL}%`;
    if (typeof remote.accent === 'string') cssVars['accent'] = remote.accent;
    if (typeof remote.accentLight === 'string') cssVars['accent-light'] = remote.accentLight;
    if (typeof remote.accentDeep === 'string') cssVars['accent-deep'] = remote.accentDeep;
    return { dataAttrs, cssVars };
  }

  function broadcastSettingsToFrames(): void {
    const settings = buildIframeSettings();
    const settingsPayload = { type: 'centraid:settings', ...settings };
    const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-centraid-app]');
    frames.forEach((f) => {
      try {
        f.contentWindow?.postMessage(settingsPayload, '*');
      } catch {
        // cross-origin postMessage cannot throw, but contentWindow access can
      }
    });
  }
  applyPrefs();

  // Reconcile from the gateway after first paint. We pull every key the
  // renderer recognises, fold it into `prefs`, and reapply — so a fresh
  // device picks up the user's theme/density/accent on launch without
  // a flash of default styling. Failures are silent: the local cache is a
  // perfectly good fallback when the gateway is unreachable.
  void (async () => {
    try {
      const remote = await getUserPrefs();
      const recognised = pickAppearance(remote);
      if (Object.keys(recognised).length > 0) {
        prefs = { ...prefs, ...recognised, bgL: 5 };
        Store.set('appearance', prefs);
        applyPrefs();
      }
    } catch {
      /* gateway unreachable — local cache stands in */
    }
  })();

  // App an arbitrary remote prefs object onto the AppearancePrefs shape,
  // dropping unknown keys and rejecting values that don't match the union
  // types. Mirrors the gateway-side `KNOWN_KEYS` list — if you add a new
  // pref there, add it here too.
  function pickAppearance(remote: Record<string, unknown>): Partial<AppearancePrefs> {
    const out: Partial<AppearancePrefs> = {};
    if (typeof remote.theme === 'string' && remote.theme in window.CentraidTokens.themes) {
      out.theme = remote.theme as ThemeName;
    }
    if (
      remote.density === 'compact' ||
      remote.density === 'regular' ||
      remote.density === 'comfy'
    ) {
      out.density = remote.density;
    }
    if (remote.cards === 'flat' || remote.cards === 'outlined' || remote.cards === 'elevated') {
      out.cardVariant = remote.cards;
    }
    if (typeof remote.coolCast === 'boolean') out.coolBlueCast = remote.coolCast;
    // Accent: the semantic key (e.g. "teal") lives under `accentKey`; the
    // resolved hex swatches under `accent` / `accentLight` / `accentDeep` are
    // for the runtime's CSS-var injection only and are not re-derivable to
    // a key. Older gateways may still carry a key in `accent` (pre-fix), so
    // accept that as a fallback before defaulting.
    if (typeof remote.accentKey === 'string' && remote.accentKey in ACCENT_PALETTE) {
      out.accent = remote.accentKey as AccentKey;
    } else if (typeof remote.accent === 'string' && remote.accent in ACCENT_PALETTE) {
      out.accent = remote.accent as AccentKey;
    }
    return out;
  }

  // Convert the renderer's typed prefs back into the wire shape the gateway
  // expects. Symmetric with `pickAppearance` — the gateway uses the keys in
  // its `KNOWN_KEYS` map, not our internal type names.
  function toRemoteShape(patch: Partial<AppearancePrefs>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (patch.theme !== undefined) out.theme = patch.theme;
    if (patch.density !== undefined) out.density = patch.density;
    if (patch.cardVariant !== undefined) out.cards = patch.cardVariant;
    if (patch.coolBlueCast !== undefined) out.coolCast = patch.coolBlueCast;
    if (patch.accent !== undefined) {
      // `accentKey` carries the semantic key (e.g. "teal") so a second device
      // can restore the exact swatch the user picked. `accent` / `accentLight`
      // / `accentDeep` carry the resolved hex values for the runtime to bake
      // directly into `<html style="…">` — the gateway has no knowledge of
      // the renderer's ACCENT_PALETTE, so resolution must happen here.
      out.accentKey = patch.accent;
      const swatch = ACCENT_PALETTE[patch.accent];
      if (swatch) {
        out.accent = swatch.accent;
        out.accentLight = swatch.light;
        out.accentDeep = swatch.deep;
      }
    }
    return out;
  }

  function setPrefs(patch: Partial<AppearancePrefs>): void {
    prefs = { ...prefs, ...patch };
    Store.set('appearance', prefs);
    applyPrefs();
    // Mirror to the gateway. Fire-and-forget — the local cache is already
    // updated, so a network failure just means the next device launch will
    // see the previous gateway value (and reapply it if it diverges).
    const remotePatch = toRemoteShape(patch);
    if (Object.keys(remotePatch).length > 0) {
      void saveUserPrefs(remotePatch).catch(() => undefined);
    }
  }

  // Track the current cd-window setter so the sidebar toggle can flip the
  // animated grid without rebuilding the page. Reset on every clear().
  let currentSetSidebarOpen: ((open: boolean) => void) | null = null;

  // Cached runtime mode powering the sidebar's Local/Remote badge. Read
  // from the main process on boot and refreshed whenever the user saves
  // settings (modeSeg / saveBtn / testBtn). Undefined until the first
  // settings fetch resolves, which suppresses the badge rather than
  // flashing a stale value.
  // Cache of the active gateway's kind ('local' | 'remote') for any
  // UI affordance that surfaces "where is this app running". After
  // #109 this comes from `settings.activeGatewayKind`, not the old
  // top-level `runtimeMode` field.
  let currentRuntimeMode: 'local' | 'remote' | undefined;
  // Compact summary of the active gateway — fed into `buildSidebar` so
  // the head row renders without having to await an IPC every rebuild.
  // Refreshed on boot, on `onGatewayChanged`, and whenever the
  // switcher mutates state (add / rename / remove / activate).
  let currentGateway: GatewaySummary | undefined;
  function refreshRuntimeMode(): Promise<void> {
    return window.CentraidApi.getSettings()
      .then((s) => {
        currentRuntimeMode = s.activeGatewayKind;
        currentGateway = {
          activeId: s.activeGatewayId,
          activeKind: s.activeGatewayKind,
          activeLabel: s.activeGatewayLabel,
          activeDisplayName: s.activeProfileDisplayName,
          activeAvatarColor: s.activeProfileAvatarColor,
        };
      })
      .catch(() => {
        /* ignore — badge stays hidden until the next save */
      });
  }

  const navStack: ShellRoute[] = [];
  let navIndex = -1;
  let applyingNav = false;

  function routeKey(route: ShellRoute): string {
    if (route.kind === 'home') return 'home';
    if (route.kind === 'settings') return 'settings';
    if (route.kind === 'insights') return 'insights';
    if (route.kind === 'discover') return 'discover';
    if (route.kind === 'starred') return 'starred';
    if (route.kind === 'automations') return 'automations';
    if (route.kind === 'templates') return 'templates';
    if (route.kind === 'automation-view') return `automation-view:${route.automationId}`;
    if (route.kind === 'run-view') return `run-view:${route.runId}`;
    if (route.kind === 'app') return `app:${route.id}`;
    if (route.kind === 'automation-builder') return `automation-builder:${route.automationId}`;
    if (route.appContext) return `builder:${route.appContext.id}`;
    return `builder:new:${route.initialPrompt ?? ''}`;
  }

  function recordRoute(route: ShellRoute): void {
    if (applyingNav) return;
    if (navIndex >= 0 && routeKey(navStack[navIndex]!) === routeKey(route)) return;
    navStack.splice(navIndex + 1);
    navStack.push(route);
    navIndex = navStack.length - 1;
  }

  function canGoBack(): boolean {
    return navIndex > 0;
  }

  function canGoForward(): boolean {
    return navIndex >= 0 && navIndex < navStack.length - 1;
  }

  function chromeNav(): Pick<
    ChromeBuildWindowOpts,
    'canGoBack' | 'canGoForward' | 'onBack' | 'onForward'
  > {
    return {
      canGoBack: canGoBack(),
      canGoForward: canGoForward(),
      onBack: goBack,
      onForward: goForward,
    };
  }

  function applyRoute(route: ShellRoute): void {
    applyingNav = true;
    try {
      if (route.kind === 'home') {
        renderHome();
      } else if (route.kind === 'settings') {
        renderSettings();
      } else if (route.kind === 'insights') {
        renderInsights();
      } else if (route.kind === 'discover') {
        renderDiscover();
      } else if (route.kind === 'starred') {
        renderStarred();
      } else if (route.kind === 'automations') {
        renderAutomations();
      } else if (route.kind === 'templates') {
        renderAutomationTemplates();
      } else if (route.kind === 'automation-view') {
        renderAutomationView(route.automationId);
      } else if (route.kind === 'run-view') {
        renderRunView(route.automationId, route.runId);
      } else if (route.kind === 'app') {
        openApp(route.id);
      } else if (route.kind === 'automation-builder') {
        enterAutomationBuilder({ automationId: route.automationId });
      } else {
        enterBuilder({ appContext: route.appContext, initialPrompt: route.initialPrompt });
      }
    } finally {
      applyingNav = false;
    }
  }

  function goBack(): void {
    if (!canGoBack()) return;
    navIndex -= 1;
    applyRoute(navStack[navIndex]!);
  }

  function goForward(): void {
    if (!canGoForward()) return;
    navIndex += 1;
    applyRoute(navStack[navIndex]!);
  }

  function toggleSidebar(): void {
    const next = !prefs.sidebarOpen;
    setPrefs({ sidebarOpen: next });
    if (currentSetSidebarOpen) currentSetSidebarOpen(next);
  }

  // Build the sidebar contents for the current home/app-view context. The
  // builder builds its own (it knows which app is active).
  function buildHomeSidebar(active: { page?: SidebarPage; appId?: string } = {}): HTMLElement {
    const apps: ChromeSidebarApp[] = userApps.map((a) => ({
      color: a.color,
      iconKey: a.iconKey,
      id: a.id,
      name: a.name,
      status: 'new',
    }));
    const draftEntries: ChromeSidebarApp[] = drafts.map((d) => ({
      color: d.color,
      iconKey: d.iconKey,
      id: d.id,
      name: d.name,
      status: 'draft',
    }));
    return window.Chrome.buildSidebar({
      activeId: active.appId,
      activePage: active.page,
      apps,
      drafts: draftEntries,
      ...(currentGateway ? { headSlot: buildProfileSwitcherHead() } : {}),
      // Selecting a sidebar app always shows its app (Use) view — the
      // builder is reached from the top-bar Use/Build switch, not by
      // clicking the row. `openApp` still falls back to the builder for
      // drafts that have no runnable build yet.
      onAppClick: (id) => openApp(id),
      // Both right-click on the row and the hover-revealed `•••` route
      // through the same context menu used on the home grid — keeps the
      // verb set (Rename, Reveal in Finder, Delete, …) in lockstep across
      // surfaces.
      onAppContext: (id, anchor) => {
        const app = findApp(id);
        if (app) openContextMenu(app, anchor);
      },
      onHome: renderHome,
      onNewApp: openNewAppSheet,
      onSearch: openCommandPalette,
      onInsights: renderInsights,
      onDiscover: renderDiscover,
      onStarred: renderStarred,
      onAutomations: renderAutomations,
      onSettings: renderSettings,
    });
  }

  // ── Profile switcher controller ─────────────────────────────────────
  // A "profile" is a separate space (its own home grid of apps) — backed
  // by a gateway: name ↔ displayName, color ↔ avatarColor, switch ↔
  // setActiveGateway. Icon + description have no backend field, so they
  // live client-side in window.Store (via window.Profiles.metaFor/saveMeta).
  // Presentation lives in profiles.ts; this controller owns the data and
  // the IPC wiring. Switch / add / delete that touch the ACTIVE profile
  // re-render through the onGatewayChanged broadcast; edits or deletes of a
  // non-active profile re-render the current route directly.

  let profileModalCtl: { close: () => void } | null = null;
  let profileDeleteCtl: { close: () => void } | null = null;

  function activeAppsCount(): number {
    return getAppsWithDrafts().length;
  }

  function toProfileView(p: GatewayProfile, activeId: string): ProfileView {
    const meta = window.Profiles.metaFor(p.id);
    const view: ProfileView = {
      id: p.id,
      name: p.displayName,
      color: p.avatarColor,
      icon: meta.icon,
      blurb: meta.blurb,
      kind: p.kind,
      primordial: p.id === 'local',
    };
    if (p.id === activeId) view.appsCount = activeAppsCount();
    return view;
  }

  // Build the sidebar-head switcher row from the cached active gateway.
  function buildProfileSwitcherHead(): HTMLElement {
    const gw = currentGateway;
    const id = gw ? gw.activeId : 'local';
    const meta = window.Profiles.metaFor(id);
    const active: ProfileView = {
      id,
      name: gw ? gw.activeDisplayName : 'Local',
      color: gw ? gw.activeAvatarColor : (window.Profiles.PROFILE_COLORS[0] ?? '#4E68DD'),
      icon: meta.icon,
      blurb: meta.blurb,
      kind: gw ? gw.activeKind : 'local',
      primordial: id === 'local',
      appsCount: activeAppsCount(),
    };
    return window.Profiles.buildSwitcherHeader({
      active,
      onToggle: (rect) => void openProfileSwitcher(rect),
    });
  }

  // Anchor rect for the dropdown when not opened from the head row itself
  // (keyboard shortcut / Settings deep-link). Falls back to a fixed point
  // near where the head row sits if the sidebar isn't mounted.
  function profileHeadAnchor(): DOMRect {
    const row = document.querySelector<HTMLElement>('.cd-prof-head');
    return row ? row.getBoundingClientRect() : new DOMRect(12, 64, 200, 44);
  }

  async function openProfileSwitcher(anchor: DOMRect): Promise<void> {
    const [profiles, settings] = await Promise.all([
      window.CentraidApi.listGateways(),
      window.CentraidApi.getSettings(),
    ]);
    const activeId = settings.activeGatewayId;
    window.Profiles.openDropdown({
      anchor,
      activeId,
      profiles: profiles.map((p) => toProfileView(p, activeId)),
      onSwitch: (id) => void switchProfile(id),
      onEdit: (p) => openProfileModal('edit', p),
      onAdd: () => openProfileModal('add'),
      onManage: () => renderSettings('profiles'),
    });
  }

  async function switchProfile(id: string): Promise<void> {
    if (currentGateway && id === currentGateway.activeId) return;
    try {
      const profiles = await window.CentraidApi.listGateways();
      const name = profiles.find((p) => p.id === id)?.displayName ?? id;
      await window.CentraidApi.setActiveGateway({ id });
      // main broadcasts onGatewayChanged → refresh + bounce to home.
      window.Profiles.toast({ msg: `Switched · ${name}`, kind: 'ok' });
    } catch (err) {
      window.Profiles.toast({ msg: `Switch failed: ${String(err)}`, kind: 'del' });
    }
  }

  function randomProfileColor(): string {
    const colors = window.Profiles.PROFILE_COLORS;
    return colors[Math.floor(Math.random() * colors.length)] ?? colors[0] ?? '#4E68DD';
  }

  function openProfileModal(mode: 'add' | 'edit', profile?: ProfileView): void {
    profileModalCtl?.close();
    profileModalCtl = window.Profiles.openModal({
      mode,
      initial:
        mode === 'edit' && profile
          ? { name: profile.name, icon: profile.icon, color: profile.color, blurb: profile.blurb }
          : { icon: window.Profiles.DEFAULT_ICON, color: randomProfileColor() },
      onCancel: () => {
        profileModalCtl?.close();
        profileModalCtl = null;
      },
      onCommit: (data) => void commitProfile(mode, profile, data),
      onDelete:
        mode === 'edit' && profile && !profile.primordial
          ? () => {
              profileModalCtl?.close();
              profileModalCtl = null;
              requestDeleteProfile(profile);
            }
          : null,
    });
  }

  async function commitProfile(
    mode: 'add' | 'edit',
    profile: ProfileView | undefined,
    data: { name: string; icon: IconNameType; color: string; blurb: string },
  ): Promise<void> {
    try {
      if (mode === 'add') {
        const created = await window.CentraidApi.addLocalGateway({
          label: data.name,
          displayName: data.name,
          avatarColor: data.color,
        });
        window.Profiles.saveMeta(created.id, { icon: data.icon, blurb: data.blurb });
        profileModalCtl?.close();
        profileModalCtl = null;
        window.Profiles.toast({ msg: `Profile created · ${data.name}`, kind: 'ok' });
        // Mirror the reference: a freshly created profile becomes active,
        // re-scoping the home grid to the (empty) new space.
        await window.CentraidApi.setActiveGateway({ id: created.id });
      } else if (profile) {
        await window.CentraidApi.updateProfileMetadata({
          id: profile.id,
          displayName: data.name,
          avatarColor: data.color,
        });
        window.Profiles.saveMeta(profile.id, { icon: data.icon, blurb: data.blurb });
        profileModalCtl?.close();
        profileModalCtl = null;
        window.Profiles.toast({ msg: `Saved · ${data.name}`, kind: 'ok' });
        if (currentGateway && profile.id === currentGateway.activeId) {
          await refreshRuntimeMode();
        }
        await reRenderShellForRoute();
      }
    } catch (err) {
      window.Profiles.toast({ msg: `Save failed: ${String(err)}`, kind: 'del' });
    }
  }

  function requestDeleteProfile(profile: ProfileView): void {
    profileDeleteCtl?.close();
    profileDeleteCtl = window.Profiles.openDeleteDialog({
      profile,
      onCancel: () => {
        profileDeleteCtl?.close();
        profileDeleteCtl = null;
      },
      onConfirm: () => void confirmDeleteProfile(profile),
    });
  }

  async function confirmDeleteProfile(profile: ProfileView): Promise<void> {
    try {
      await window.CentraidApi.removeGateway({ id: profile.id });
      window.Profiles.forgetMeta(profile.id);
      profileDeleteCtl?.close();
      profileDeleteCtl = null;
      window.Profiles.toast({ msg: `Deleted · ${profile.name}`, kind: 'del' });
      // removeGateway *always* emits GATEWAY_CHANGED from main (active or
      // not — the list changed and caches must drop). The onGatewayChanged
      // handler owns the refresh: it re-scopes to Home if the active space
      // changed, or refreshes the current route in place otherwise (so a
      // non-active delete from Settings updates the manage list without
      // yanking the user off the page). Re-rendering here too would race
      // that broadcast and stack two shells, so we deliberately don't.
    } catch (err) {
      window.Profiles.toast({ msg: `Delete failed: ${String(err)}`, kind: 'del' });
    }
  }

  // Re-render the current shell route after a label/state change that
  // doesn't trigger the broader gateway-changed re-mount. Falls back
  // to a home render if there is no current navigable route. Used by
  // inline rename (the active gateway's label change has to be
  // reflected in the sidebar head row).
  function reRenderShellForRoute(): Promise<void> {
    const route = navStack[navIndex];
    if (!route) {
      renderHome();
      return Promise.resolve();
    }
    if (route.kind === 'home') renderHome();
    else if (route.kind === 'settings') renderSettings(lastSettingsPage);
    else if (route.kind === 'insights') renderInsights();
    else if (route.kind === 'discover') renderDiscover();
    else if (route.kind === 'starred') renderStarred();
    else if (route.kind === 'automations') renderAutomations();
    // Other route kinds (builder, app-view, …) own their own sidebar
    // rebuild via the existing nav apply path — no extra work here.
    return Promise.resolve();
  }

  function persist(): void {
    Store.set('home.userApps', userApps);
  }

  // Drafts: apps that exist on disk under <appsDir>/<id>/ but were
  // never "Add to home"-d. Hydrated from listApps() on each home render
  // so newly scaffolded apps show up without a manual refresh.
  let drafts: DraftAppMeta[] = [];

  function getApps(): AppMetaResolvedType[] {
    return userApps;
  }
  function getAppsWithDrafts(): AppMetaResolvedType[] {
    return [...getApps(), ...drafts];
  }
  function findApp(id: string): AppMetaResolvedType | undefined {
    return getAppsWithDrafts().find((a) => a.id === id);
  }
  function findUserApp(id: string): UserAppMeta | undefined {
    return userApps.find((a) => a.id === id);
  }

  function isDraft(app: AppMetaResolvedType): app is DraftAppMeta {
    return (app as DraftAppMeta).__draft === true;
  }

  let currentCleanup: (() => void) | null = null;

  // Render-generation guard. Async renders follow a clear() → await →
  // append() shape; if a second render starts during the await, both
  // clear root early and both append late, stacking two full UIs in the
  // window (see the boot note on the first renderHome, and the
  // delete-from-Settings path where a GATEWAY_CHANGED broadcast races the
  // route refresh). Every clear() bumps `renderSeq`; an async render
  // captures the value right after clearing and must re-check it via
  // `isCurrentRender(seq)` before appending — a stale render skips its
  // append and lets the latest one win.
  let renderSeq = 0;
  function isCurrentRender(seq: number): boolean {
    return seq === renderSeq;
  }

  // The Settings inner-page the user last opened, so an in-place re-render
  // of the Settings route (e.g. after deleting a non-active profile from
  // the Profiles page) restores that page instead of snapping back to
  // Appearance. Set by showSettingsPage; consumed by reRenderShellForRoute.
  let lastSettingsPage: string | undefined;

  // Per-automation run state, keyed by `${appId}:${name}`. Shell state shared
  // with the app-view's standing-order popover (via ctx.automationRunState) so
  // a user who closes during a run still sees the result chip on next open.
  const automationRunState = new Map<string, AutomationRunState>();

  // Run the current view's teardown and invalidate any in-flight render,
  // WITHOUT touching the DOM. Async renders call this up front to cancel
  // stale work while keeping the old screen visible until their new shell
  // is ready (see renderHomeAsync); synchronous renders go through clear().
  function teardownCurrent(): void {
    if (typeof currentCleanup === 'function') {
      try {
        currentCleanup();
      } catch {
        /* swallow */
      }
    }
    currentCleanup = null;
    currentSetSidebarOpen = null;
    closeContextMenu();
    closeAppSettings();
    closeCommandPalette();
    renderSeq += 1;
  }

  function clear(): void {
    teardownCurrent();
    root.innerHTML = '';
  }

  function el(tag: string, attrs: ElAttrs = {}, children: ElChild | ElChild[] = []): HTMLElement {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class' && typeof v === 'string') {
        node.className = v;
      } else if (k === 'style' && typeof v === 'object' && v !== null) {
        Object.assign(node.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'trustedHtml' && typeof v === 'string') {
        // Static SVG/icon markup only. User-provided content must stay in text nodes.
        node.innerHTML = v;
      } else if (v != null) {
        node.setAttribute(k, String(v));
      }
    }
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c == null || c === false) {
        continue;
      }
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function showToast(message: string): void {
    const existing = document.querySelector('.global-toast');
    if (existing) {
      existing.remove();
    }
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    const toast = el('div', { class: 'preview-toast global-toast' }, [
      el('span', { trustedHtml: Icon.Check({ size: 13, strokeWidth: 2.5 }) }),
      el('span', {}, message),
    ]);
    Object.assign(toast.style, {
      left: '50%',
      position: 'fixed',
      top: '60px',
      transform: 'translateX(-50%)',
      zIndex: '90',
    });
    document.body.append(toast);
    toastTimer = setTimeout(() => toast.remove(), 2000);
  }

  // Refresh `drafts` from disk. Drafts = apps on disk whose ids aren't
  // already in `userApps` (= already pinned to home, with full metadata).
  // Automation apps (`kind: 'automation'`) live in the same `appsDir` but
  // belong to the Automations surface — skip them here so My apps stays
  // app-only.
  async function hydrateDrafts(): Promise<void> {
    try {
      const projs = await listApps();
      const knownIds = new Set(getApps().map((a) => a.id));
      drafts = projs
        .filter((p) => p.kind !== 'automation')
        .filter((p) => !knownIds.has(p.id))
        .map((p) => {
          // Drafts default to the Sparkle icon (no inference has run yet);
          // its canonical colour is accent-violet so every draft reads as
          // "draft" at a glance rather than picking a random hue per id.
          return {
            __draft: true,
            color: colorForIcon('Sparkle'),
            colorKey: 'violet',
            // Prefer the real `app.json#description` when present (carried
            // over from the template manifest on clone, or set by the user
            // in the builder). Fall back to the status string for older
            // scaffolds without a description.
            desc: p.description || 'Draft — not yet published',
            hasIndex: !!p.hasIndex,
            iconKey: 'Sparkle',
            id: p.id,
            name: p.name || p.id,
          } as DraftAppMeta;
        });
    } catch {
      drafts = [];
    }
  }

  // ── Starred + recently-viewed (Refined Screens §A2/§A3) ─────────────
  let starred = Store.get<Record<string, boolean>>('home.starred', {});
  function isStarred(id: string): boolean {
    return starred[id] === true;
  }
  function toggleStar(id: string): void {
    const next = { ...starred };
    if (next[id]) delete next[id];
    else next[id] = true;
    starred = next;
    Store.set('home.starred', starred);
  }

  // Recently-viewed app ids, most-recent first, capped at 8.
  function recordRecent(id: string): void {
    const list = Store.get<string[]>('home.recent', []).filter((x) => x !== id);
    list.unshift(id);
    Store.set('home.recent', list.slice(0, 8));
  }
  function recentApps(): AppMetaResolvedType[] {
    return Store.get<string[]>('home.recent', [])
      .map((id) => findApp(id))
      .filter((a): a is AppMetaResolvedType => !!a);
  }

  // "NEW" applies only for the first 24h after an app is created (§A3).
  // Keyed off the immutable `createdAt` stamp, not `updatedAt`, so a
  // republish doesn't re-show NEW.

  // Chains a teardown callback onto `currentCleanup` so page-scoped
  // timers (rotating placeholders, etc.) stop when the page is replaced.
  function registerCleanup(fn: () => void): void {
    const prev = currentCleanup;
    currentCleanup = (): void => {
      if (prev) prev();
      fn();
    };
  }

  function renderHome(): void {
    void renderHomeAsync();
  }

  async function renderHomeAsync(): Promise<void> {
    recordRoute({ kind: 'home' });
    // Tear down the current view and invalidate in-flight renders, but
    // leave its DOM on screen while we load Home's data below. Calling
    // clear() here would blank the window for the duration of the three
    // IPC round-trips that follow, which reads as a flicker on every
    // navigation to Home. We swap the built shell in atomically at the end.
    teardownCurrent();
    const seq = renderSeq;
    await hydrateDrafts();
    // Home now shows the user's real apps and automations directly (not the
    // template catalog — that moved behind each section's "Browse templates"
    // link). Load the installed automations + their recent run feed so the
    // Automations section can paint live status + a recent-runs rail. Both
    // are best-effort: a cold/standalone gateway with no automations should
    // still render the rest of Home, so we swallow load errors to [].
    const [automationRows, runEntries] = await Promise.all([
      listAutomations().catch(() => [] as CentraidAutomationRow[]),
      collectAutomationRuns().catch(() => [] as AutomationFeedEntry[]),
    ]);
    if (!isCurrentRender(seq)) return;

    // `has-wall` paints the device-wall crosshatch behind everything.
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);

    // Home is always the composer-led layout — centered composer hero +
    // tabbed discovery shelf — regardless of how many apps exist. The
    // shelf's "Browse all →" is the only path to the alternate (Discover)
    // page; the workspace never auto-switches based on app count.
    renderDay1Home(scroll, automationRows, runEntries);

    const sidebar = buildHomeSidebar({ page: 'home' });
    const { root: shell, setSidebarOpen } = window.Chrome.buildWindow({
      ...chromeNav(),
      main,
      onNewChat: openNewAppSheet,
      onToggleSidebar: toggleSidebar,
      showNewChat: true,
      sidebar,
      sidebarOpen: prefs.sidebarOpen,
    });
    currentSetSidebarOpen = setSidebarOpen;
    // Atomic swap: replace the old view with the freshly-built shell in a
    // single mutation, so there's never a blank frame between the two.
    root.replaceChildren(shell);
  }

  // Home: centered composer hero, then ONE unified "library" shelf that clubs
  // the user's apps and automations together — mirroring Discover. A segmented
  // All / Apps / Automations filter sits in the shelf header; below it the two
  // kinds render as kind-grouped sections of matching cards.
  function renderDay1Home(
    scroll: HTMLElement,
    automationRows: CentraidAutomationRow[],
    runEntries: AutomationFeedEntry[],
  ): void {
    scroll.classList.add('cd-day1-scroll');
    scroll.append(buildHomeHero());
    scroll.append(buildHomeLibrary(automationRows, runEntries));
  }

  // Shared composer behaviour — wires submit/keydown onto a textarea +
  // build button pair. Used by the Day-1 hero.
  function wireComposer(ta: HTMLTextAreaElement, buildBtn: HTMLElement): void {
    const submit = (): void => {
      const v = ta.value.trim();
      if (v) enterBuilder({ initialPrompt: v });
    };
    ta.addEventListener('input', () => {
      if (ta.value.trim()) buildBtn.removeAttribute('disabled');
      else buildBtn.setAttribute('disabled', '');
    });
    ta.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if (k.key === 'Enter' && (k.metaKey || k.ctrlKey)) {
        k.preventDefault();
        submit();
      }
    });
    buildBtn.addEventListener('click', submit);
  }

  // Microphone glyph — not in the shared icon set; inlined to match the
  // design's voice affordance.
  const MIC_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="9" y="2" width="6" height="11" rx="3"/>' +
    '<path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></svg>';

  // Today's date as the hero eyebrow, e.g. "TUESDAY · 19 MAY". Renderer
  // code, so `new Date()` is fine here (the workflow-script ban doesn't apply).
  function heroDateLabel(): string {
    const d = new Date();
    const weekday = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    return `${weekday} · ${d.getDate()} ${month}`;
  }

  // Example prompts under the composer — clicking one seeds the box and
  // focuses it (a starting point, not an auto-submit).
  const HERO_SUGGESTIONS = ['Habit tracker', 'Weekly review', 'Inbox digest', 'Invoice filer'];

  function buildHomeHero(): HTMLElement {
    const wrap = el('div', { class: 'cd-hero' });

    // Date eyebrow + heading, kept tight together above the composer.
    wrap.append(
      el('div', { class: 'cd-hero-head' }, [
        el('div', { class: 'cd-hero-date' }, heroDateLabel()),
        // Personalized heading — no user-profile source exists in the
        // renderer, so we fall back to the un-named form rather than fake one.
        el('h1', {}, 'What should we build?'),
      ]),
    );

    // Day1Composer — bg-elev card with descriptive placeholder + toolbar.
    const composer = el('div', { class: 'cd-composer' });
    const ta = el('textarea', {
      class: 'cd-composer-input',
      placeholder: 'Describe an app you want — a habit tracker, a journal, a tiny tool…',
      rows: '2',
    }) as HTMLTextAreaElement;

    const buildBtn = el('button', { class: 'cd-composer-send', type: 'button', disabled: '' });
    buildBtn.innerHTML = Icon.ArrowRight({ size: 14 });
    wireComposer(ta, buildBtn);

    const toolbar = el('div', { class: 'cd-composer-toolbar' }, [
      el('button', {
        class: 'cd-icon-btn cd-composer-attach',
        type: 'button',
        title: 'Attach',
        trustedHtml: Icon.Plus({ size: 14 }),
      }),
      el('span', { class: 'cd-composer-spacer' }),
      el('span', { class: 'cd-composer-mode' }, [
        el('span', { trustedHtml: Icon.Sparkle({ size: 11 }) }),
        el('span', {}, 'Build'),
        el('span', { trustedHtml: chevronDown(9) }),
      ]),
      el('button', {
        class: 'cd-icon-btn cd-composer-mic',
        type: 'button',
        title: 'Voice',
        trustedHtml: MIC_SVG,
      }),
      el('span', { class: 'cd-kbd cd-composer-kbd' }, '⌘↵'),
      buildBtn,
    ]);

    composer.append(ta, toolbar);

    // Suggestion chips sit just under the composer; clicking one fills the
    // textarea (firing `input` so the build button enables) and focuses it.
    const chips = el('div', { class: 'cd-hero-suggestions' });
    for (const s of HERO_SUGGESTIONS) {
      chips.append(
        el(
          'button',
          {
            class: 'cd-chip',
            type: 'button',
            onClick: () => {
              ta.value = s;
              ta.dispatchEvent(new Event('input'));
              ta.focus();
            },
          },
          s,
        ),
      );
    }

    wrap.append(el('div', { class: 'cd-hero-composer-wrap' }, [composer, chips]));
    return wrap;
  }

  function homeSectionEmpty(icon: IconNameType, title: string, sub: string): HTMLElement {
    return el('div', { class: 'cd-shelf-empty' }, [
      el('div', {
        class: 'cd-shelf-empty-icon',
        trustedHtml: (Icon[icon] ?? Icon.Sparkle)({ size: 20 }),
      }),
      el('div', { class: 'cd-shelf-empty-title' }, title),
      el('div', { class: 'cd-shelf-empty-sub' }, sub),
    ]);
  }

  // Home → Library: one shelf that clubs the user's apps and automations
  // together — the Discover pattern applied to the user's own stuff. A
  // segmented All / Apps / Automations filter rides the header; the body
  // paints kind-grouped sections of matching cards (apps via renderAppCard,
  // automations via renderHomeAutomationCard). The automation status summary
  // and a "Browse templates →" link to Discover sit opposite the filter.
  function buildHomeLibrary(
    automationRows: readonly CentraidAutomationRow[],
    entries: readonly AutomationFeedEntry[],
  ): HTMLElement {
    const apps: AppMetaResolvedType[] = [...getApps(), ...drafts];

    // Most-recent run per automation — drives each card's status pill + the
    // header's "needs attention" count.
    const runs = entries
      .filter((e) => e.automationId)
      .slice()
      .sort((a, b) => b.run.startedAt - a.run.startedAt);
    const lastByRef = new Map<string, AutomationFeedEntry>();
    for (const e of runs) if (!lastByRef.has(e.automationId)) lastByRef.set(e.automationId, e);

    let attention = 0;
    for (const r of automationRows) {
      const last = lastByRef.get(r.ref);
      if (last && !last.run.ok) attention += 1;
    }

    const section = el('section', { class: 'cd-hsec cd-home-lib' });

    // ── Kind filter — segmented control, reusing Discover's pill styling. ──
    let kind: 'all' | 'app' | 'automation' = 'all';
    // Tiles (the repeat()-grid default) vs. Rows (full-width compact strips).
    // Session-only: defaults to tiles on every Home render, no pref write.
    let layout: 'tiles' | 'rows' = 'tiles';
    const seg = el('div', {
      class: 'cd-disc-seg',
      role: 'tablist',
      'aria-label': 'Filter your library by kind',
    });
    const sync = (): void => {
      for (const b of seg.querySelectorAll<HTMLElement>('.cd-disc-seg-b'))
        b.dataset.active = String(b.dataset.k === kind);
    };
    const segDefs = [
      { k: 'all', label: 'All', count: apps.length + automationRows.length, icon: null },
      { k: 'app', label: 'Apps', count: apps.length, icon: 'Home' },
      { k: 'automation', label: 'Automations', count: automationRows.length, icon: 'Bolt' },
    ] as const;
    for (const d of segDefs) {
      seg.append(
        el(
          'button',
          {
            class: 'cd-disc-seg-b',
            type: 'button',
            role: 'tab',
            'data-k': d.k,
            onClick: () => {
              kind = d.k;
              sync();
              paint();
            },
          },
          [
            ...(d.icon
              ? [
                  el('span', {
                    class: 'cd-disc-seg-ic',
                    'aria-hidden': 'true',
                    trustedHtml: Icon[d.icon]({ size: 13 }),
                  }),
                ]
              : []),
            el('span', {}, d.label),
            el('span', { class: 'cd-disc-seg-n' }, `· ${d.count}`),
          ],
        ),
      );
    }

    // Status summary — only the "⚠ N needs attention" badge (shown when a
    // most-recent run failed); the "N active" count was dropped.
    const head = el('div', { class: 'cd-home-lib-head' }, [
      seg,
      el('span', { class: 'cd-hsec-spacer' }),
    ]);
    if (attention > 0) {
      head.append(
        el('div', { class: 'cd-hsec-status' }, [
          el('span', { class: 'cd-hsec-stat', 'data-tone': 'attention' }, [
            el('span', { 'aria-hidden': 'true', trustedHtml: Icon.AlertTriangle({ size: 13 }) }),
            el('span', {}, `${attention} needs attention`),
          ]),
        ]),
      );
    }
    head.append(
      el('button', { class: 'cd-hsec-browse', type: 'button', onClick: renderDiscover }, [
        el('span', {}, 'Browse templates'),
        el('span', { 'aria-hidden': 'true', trustedHtml: Icon.ChevronRight({ size: 14 }) }),
      ]),
    );

    // ── Layout toggle — Tiles | Rows, far right of the header. Flips the
    // grid's data-layout (read by paint on repaint); the chosen layout lives
    // only for this Home session. Shared with Discover. ──
    head.append(
      buildLayoutToggle(
        el,
        () => layout,
        (mode) => {
          layout = mode;
          paint();
        },
      ),
    );

    // ── Body — ONE unified grid (apps + automations in a single tile/row
    // grid, no per-kind sub-headers), matching the gallery spec. The kind
    // filter narrows what the grid holds; the grid repaints in place. ──
    const body = el('div', { class: 'cd-home-lib-body' });

    function paint(): void {
      // Apps lead, automations follow — one mixed grid (the segmented filter
      // above is the only kind divider, per the design).
      const cards: HTMLElement[] = [];
      if (kind === 'all' || kind === 'app') cards.push(...apps.map((a) => renderAppCard(a, true)));
      if (kind === 'all' || kind === 'automation')
        cards.push(...automationRows.map((r) => renderHomeAutomationCard(r, lastByRef.get(r.ref))));

      if (cards.length === 0) {
        const empty =
          kind === 'automation'
            ? homeSectionEmpty(
                'Bolt',
                'No automations yet',
                'A saved conversation that fires on a trigger. Start from a template, or describe one from scratch.',
              )
            : kind === 'app'
              ? homeSectionEmpty(
                  'Sparkle',
                  'No apps yet',
                  'Describe an app in the box above — Centraid will build it for you.',
                )
              : homeSectionEmpty(
                  'Sparkle',
                  'Nothing here yet',
                  'Describe an app or automation in the box above to get started.',
                );
        body.replaceChildren(empty);
        return;
      }

      body.replaceChildren(
        el('div', { class: 'cd-apps-grid cd-apps-grid--small', 'data-layout': layout }, cards),
      );
    }

    section.append(head, body);
    sync();
    paint();
    return section;
  }

  // One automation as a Home library card — built in the app-card visual
  // family (.cd-app-card--small) so apps and automations sit in one uniform
  // grid. The identity hue glyph tile + status pill stand in for the app icon
  // and state strip; the trigger summary fills the blurb line. Clicking opens
  // the automation viewer.
  function renderHomeAutomationCard(
    row: CentraidAutomationRow,
    last: AutomationFeedEntry | undefined,
  ): HTMLElement {
    const integrations = row.manifest.requires.mcps ?? [];
    const isStar = isStarred(row.ref);
    const wrap = el('div', { class: 'cd-app-card-wrap' });
    wrap.dataset.starred = String(isStar);
    const card = el('button', {
      class: 'cd-app-card cd-app-card--small',
      type: 'button',
      onClick: () => renderAutomationView(row.ref),
    });
    card.dataset.kind = 'automation';
    // Blurb is the automation's own description; the schedule moves into the
    // trigger chip below so the two read as distinct facts (matches the spec).
    const blurb = row.manifest.description || triggersSummary(row.triggers);
    card.append(
      el('div', { class: 'cd-app-card-head' }, [
        autoMod.autoGlyphTile(row.id, { size: 52, glyphSize: 24 }),
        el('div', { class: 'cd-app-card-head-text' }, [
          el('div', { class: 'cd-app-card-name-row' }, [
            el('div', { class: 'cd-app-card-name' }, row.name),
          ]),
          el('div', { class: 'cd-app-card-desc' }, blurb),
        ]),
      ]),
    );
    // Meta strip — status pill · trigger chip · integration dots. Sits in the
    // card body (tiles) / inline (rows); the footer below carries the kind
    // badge + last-run time.
    const isWebhook =
      row.triggers.some((t) => t.kind === 'webhook') &&
      !row.triggers.some((t) => t.kind === 'cron');
    const metaStrip = el('div', { class: 'cd-app-card-meta' }, [
      autoMod.auStatusPill(auStatusForRow(row.enabled, !!last)),
      el('span', { class: 'cd-app-card-trig' }, [
        el('span', {
          'aria-hidden': 'true',
          trustedHtml: (isWebhook ? Icon.Webhook : Icon.Clock)({ size: 12 }),
        }),
        el('span', {}, triggersSummary(row.triggers)),
      ]),
    ]);
    if (integrations.length > 0) metaStrip.append(autoMod.integrationDots([...integrations]));
    card.append(metaStrip);
    // Footer — AUTOMATION kind badge (left) + last-run time (right), the time
    // led by a success tick when the most recent run succeeded.
    const foot = el('div', { class: 'cd-app-card-foot' });
    foot.append(cardsMod.kindBadgeEl('automation'));
    const okTone = last?.run.ok ? 'true' : undefined;
    const timeEl = el('span', { class: 'cd-app-card-foot-time', 'data-ok': okTone });
    if (last?.run.ok) {
      timeEl.append(
        el('span', { 'aria-hidden': 'true', trustedHtml: Icon.CheckCircle({ size: 13 }) }),
      );
    }
    timeEl.append(
      el(
        'span',
        {},
        last ? relativeTime(new Date(last.run.startedAt).toISOString()) : 'No runs yet',
      ),
    );
    foot.append(timeEl);
    card.append(foot);
    wrap.append(card);

    // Inline hover toolbar — Run now, Star, overflow ⋯ (Open / Edit / Delete).
    // Matches the app card's toolbar so both kinds share one action pattern.
    const runNow = (): void => {
      void (async () => {
        try {
          const { runId } = await runAutomationNow({ automationId: row.ref });
          renderRunView(row.ref, runId);
        } catch (err) {
          showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };
    const confirmDelete = (): void => {
      void (async () => {
        const ok = await cardsMod.openConfirm({
          title: 'Delete automation?',
          message: `Delete "${row.name}"? This removes it from the gateway and deletes its run history. This can't be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteAutomation({ automationId: row.ref });
          showToast(`Deleted "${row.name}"`);
          renderHome();
        } catch (err) {
          showToast(
            `Could not delete ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    };
    // Single overflow ⋯ affordance — Run / Edit / Star / Delete all live in the
    // menu so the card stays clean (no multi-button hover toolbar). A persistent
    // gold star flag marks starred rows when idle; hovering swaps in the ⋯.
    const moreBtn = el('button', {
      class: 'cd-card-act cd-card-act-more',
      type: 'button',
      'aria-label': 'Automation actions',
      'aria-haspopup': 'menu',
      trustedHtml: Icon.MoreHoriz({ size: 16 }),
      onClick: (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const t = e.currentTarget as HTMLElement;
        t.dataset.open = 'true';
        cardsMod.openMenu(
          [
            { icon: 'Eye', id: 'open', label: 'Open' },
            { icon: 'Play', id: 'run', label: 'Run now' },
            { icon: 'Pencil', id: 'edit', label: 'Edit in builder' },
            { icon: 'Star', id: 'star', label: isStar ? 'Unstar' : 'Star' },
            'sep',
            { danger: true, icon: 'Trash', id: 'delete', label: 'Delete' },
          ],
          { kind: 'rect', rect: t.getBoundingClientRect() },
          (id) => {
            if (id === 'open') renderAutomationView(row.ref);
            else if (id === 'run') runNow();
            else if (id === 'edit') enterAutomationBuilder({ automationId: row.id });
            else if (id === 'star') {
              toggleStar(row.ref);
              renderHome();
            } else if (id === 'delete') confirmDelete();
          },
        );
      },
    });
    wrap.append(el('div', { class: 'cd-card-actions' }, [moreBtn]));
    if (isStar)
      wrap.append(
        el('span', {
          class: 'cd-card-star-flag',
          'aria-hidden': 'true',
          trustedHtml: Icon.Star({ size: 14 }),
        }),
      );
    return wrap;
  }

  // ---------- Sidebar destination pages ----------
  // Discover / Starred / Automations are top-level sidebar destinations
  // added by Refined Screens §G3. Discover surfaces the template gallery
  // (which §A3 removes from Home); Starred and Automations are wired here
  // with their list/empty states — the per-app star toggle (§A3) and the
  // scheduler backing Automations (§E3) land in later steps.

  function renderSimpleEmpty(message: string): HTMLElement {
    return el('div', { class: 'cd-page-empty' }, [
      el('div', { class: 'cd-page-empty-icon', trustedHtml: Icon.Sparkle({ size: 22 }) }),
      el('div', { class: 'cd-page-empty-text' }, message),
    ]);
  }

  function mountShellPage(page: SidebarPage, main: HTMLElement, seq?: number): void {
    // Async callers pass the render-seq captured after their clear(); bail
    // if a newer render has since superseded this one (avoids stacking).
    if (seq !== undefined && !isCurrentRender(seq)) return;
    const sidebar = buildHomeSidebar({ page });
    const { root: shell, setSidebarOpen } = window.Chrome.buildWindow({
      ...chromeNav(),
      main,
      onNewChat: openNewAppSheet,
      onToggleSidebar: toggleSidebar,
      showNewChat: true,
      sidebar,
      sidebarOpen: prefs.sidebarOpen,
    });
    currentSetSidebarOpen = setSidebarOpen;
    // Atomic swap. After a synchronous clear() the root is already empty so
    // this is equivalent to append; for async renders that defer the wipe
    // (teardownCurrent + load, e.g. Discover) it replaces the old view in a
    // single mutation, so there's never a blank frame mid-load.
    root.replaceChildren(shell);
  }

  function pageScroll(title: string, subtitle: string): { main: HTMLElement; scroll: HTMLElement } {
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);
    scroll.append(
      el('div', { class: 'cd-page-head' }, [el('h1', {}, title), el('p', {}, subtitle)]),
    );
    return { main, scroll };
  }

  // Route modules extracted from this shell (see imports): app-insights,
  // app-discover, app-automations, app-palette, app-cards, app-appview,
  // app-settings. app.ts keeps the shell core: appearance/prefs, navigation,
  // profiles, sidebar, Home, the shared primitives, and the wiring below.

  // ── Shell context + render registry ───────────────────────────────────────
  // The single ShellContext handed to every route module split out of this
  // file. `shellEntries` is the late-bound registry: in this transitional
  // state every slot points at a function still living in app.ts; as each
  // cluster is extracted, its slot is rebound to the module's implementation
  // (and the matching `const renderX = mod.renderX` shadows the local name so
  // applyRoute / window.Centraid keep working unchanged). Modules reach back
  // into the shell through `ctx.shell.*`, never via a direct import — that's
  // what keeps the module graph acyclic.
  const shellEntries = {} as ShellEntries;

  const ctx: ShellContext = {
    root,
    el,
    clear,
    teardownCurrent,
    showToast,
    registerCleanup,
    mountShellPage,
    pageScroll,
    renderSimpleEmpty,
    recordRoute,
    applyRoute,
    chromeNav,
    // openConfirm + loadAvailableTemplates + revealApp + handleDeleteApp live
    // in app-cards.ts; forward lazily so modules that consume them through ctx
    // resolve the module's implementation once cardsMod is built below.
    openConfirm: (opts) => cardsMod.openConfirm(opts),
    revealApp: (app) => cardsMod.revealApp(app),
    handleDeleteApp: (app) => cardsMod.handleDeleteApp(app),
    iframeThemeKind,
    applyPrefs,
    getPrefs: () => prefs,
    setPrefs,
    getApps,
    getAppsWithDrafts,
    findApp,
    findUserApp,
    getUserApps: () => userApps,
    setUserApps: (next) => {
      userApps = next;
    },
    persist,
    hydrateDrafts,
    getDrafts: () => drafts,
    isDraft,
    recentApps,
    loadAvailableTemplates: () => cardsMod.loadAvailableTemplates(),
    loadAutomationTemplates: () => autoMod.loadAutomationTemplates(),
    integrationDots: (names) => autoMod.integrationDots(names),
    getRuntimeMode: () => currentRuntimeMode,
    getGateway: () => currentGateway,
    getRenderSeq: () => renderSeq,
    isCurrentRender,
    isStarred,
    toggleStar,
    recordRecent,
    getCurrentCleanup: () => currentCleanup,
    setCurrentCleanup: (fn) => {
      currentCleanup = fn;
    },
    automationRunState,
    getLastSettingsPage: () => lastSettingsPage,
    setLastSettingsPage: (page) => {
      lastSettingsPage = page;
    },
    setOnAppearanceApplied: (fn) => {
      onAppearanceApplied = fn;
    },
    setSidebarOpenSetter: (fn) => {
      currentSetSidebarOpen = fn;
    },
    applySidebarOpen: (open) => {
      if (currentSetSidebarOpen) currentSetSidebarOpen(open);
    },
    toggleSidebar,
    buildHomeSidebar,
    toProfileView,
    switchProfile,
    openProfileModal,
    requestDeleteProfile,
    shell: shellEntries,
  };

  // Route modules — each factory closes over `ctx` and returns its render
  // entry points. The bound `const renderX = …Mod.renderX` shadows the name
  // the function had while it lived in app.ts, so applyRoute / window.Centraid
  // / shellEntries keep referring to it unchanged.
  const renderInsights = createInsightsModule(ctx).renderInsights;

  const discoverMod = createDiscoverModule(ctx);
  const renderDiscover = discoverMod.renderDiscover;
  const renderStarred = discoverMod.renderStarred;

  const autoMod = createAutomationsModule(ctx);
  const renderAutomations = autoMod.renderAutomations;
  const renderAutomationView = autoMod.renderAutomationView;
  const renderRunView = autoMod.renderRunView;
  const renderAutomationTemplates = autoMod.renderAutomationTemplates;
  const createAndOpenAutomationBuilder = autoMod.createAndOpenAutomationBuilder;
  const enterAutomationBuilder = autoMod.enterAutomationBuilder;
  // openAutomationTemplatePreview is exposed for discover via ctx.shell; the
  // collectAutomationRuns is consumed by the Home page below. The Home library
  // builds its automation cards directly via autoMod (glyph tile + status pill),
  // so the overview row/run renderers aren't re-bound here.
  const openAutomationTemplatePreview = autoMod.openAutomationTemplatePreview;
  const collectAutomationRuns = autoMod.collectAutomationRuns;

  const paletteMod = createPaletteModule(ctx);
  const openCommandPalette = paletteMod.openCommandPalette;
  const closeCommandPalette = paletteMod.closeCommandPalette;

  // App tiles + context menu + new-app sheet + builder entry. ctx.openConfirm
  // and ctx.loadAvailableTemplates forward into this module (see ctx above).
  const settingsMod = createSettingsModule(ctx);
  const renderSettings = settingsMod.renderSettings;
  const openShareDialog = settingsMod.openShareDialog;

  const appViewMod = createAppViewModule(ctx);
  const openApp = appViewMod.openApp;
  const closeAppSettings = appViewMod.closeAppSettings;

  // ctx.openConfirm / ctx.loadAvailableTemplates / ctx.revealApp /
  // ctx.handleDeleteApp forward into this module; addUserApp / syncUserAppMeta /
  // inferAppMeta are wired inside the module's enterBuilder. Only the bindings
  // app.ts itself calls are named here.
  const cardsMod = createCardsModule(ctx);
  const renderAppCard = cardsMod.renderAppCard;
  const closeContextMenu = cardsMod.closeContextMenu;
  const openContextMenu = cardsMod.openContextMenu;
  const openTemplateContextMenu = cardsMod.openTemplateContextMenu;
  const openTemplatePreview = cardsMod.openTemplatePreview;
  const openNewAppSheet = cardsMod.openNewAppSheet;
  const enterBuilder = cardsMod.enterBuilder;
  const isContextMenuOpen = cardsMod.isContextMenuOpen;

  // Populate the late-bound registry now that every entry (module-backed or
  // still-local) is initialized. `satisfies` keeps it exhaustive.
  Object.assign(shellEntries, {
    renderHome,
    renderInsights,
    renderDiscover,
    renderStarred,
    renderAutomations,
    renderAutomationView,
    renderRunView,
    renderAutomationTemplates,
    renderSettings,
    openApp,
    openNewAppSheet,
    openShareDialog,
    openTemplatePreview,
    openTemplateContextMenu,
    openAutomationTemplatePreview,
    openCommandPalette,
    openContextMenu,
    enterBuilder,
    enterAutomationBuilder,
    createAndOpenAutomationBuilder,
  } satisfies ShellEntries);

  // Expose helpers to other modules.
  window.Centraid = {
    el,
    openApp,
    openAppContext: (id, anchor) => {
      const app = findApp(id);
      if (app) openContextMenu(app, anchor);
    },
    openBuilder: openNewAppSheet,
    openShare: openShareDialog,
    openSettings: renderSettings,
    openInsights: renderInsights,
    openDiscover: renderDiscover,
    openStarred: renderStarred,
    openAutomations: renderAutomations,
    openSearch: openCommandPalette,
    renderHome,
    getRuntimeMode: () => currentRuntimeMode,
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isContextMenuOpen()) {
      closeContextMenu();
      return;
    }
    // §F — ⌘K opens the command palette from anywhere.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '[') {
      e.preventDefault();
      goBack();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ']') {
      e.preventDefault();
      goForward();
      return;
    }
    // ⌘⇧G opens the profile switcher dropdown, anchored to the sidebar
    // head row (or a fixed point near it when the sidebar is collapsed).
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      void openProfileSwitcher(profileHeadAnchor());
      return;
    }
    // ⌘1…⌘9 jumps directly to the Nth profile (Linear-style
    // workspace-shortcut pattern). Order matches the switcher's
    // rendered order — local-first then remote-by-createdAt, same
    // as `listGateways`. Without shift, plain digits stay free for
    // text input; we explicitly skip when shift / alt are held so
    // the system shortcuts (⌘⇧1, ⌘⌥1) keep firing. Bound at the
    // document level so the user doesn't have to open the switcher
    // first — feels native to anyone who has used Linear.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
      // Skip when the user is typing into a real input — ⌘1 in a
      // text field shouldn't punt them out of their workspace.
      const t = e.target as HTMLElement | null;
      const inEditable =
        t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable === true;
      if (inEditable) return;
      const n = parseInt(e.key, 10) - 1;
      void (async (): Promise<void> => {
        const profiles = await window.CentraidApi.listGateways();
        const target = profiles[n];
        if (!target) return;
        e.preventDefault();
        const current = await window.CentraidApi.getSettings();
        if (target.id === current.activeGatewayId) return;
        try {
          await window.CentraidApi.setActiveGateway({ id: target.id });
          showToast(`Switched to ${target.displayName}`);
        } catch (err) {
          showToast(`Switch failed: ${String(err)}`);
        }
      })();
    }
  });

  // Prime the sidebar's Local/Remote badge BEFORE the first renderHome
  // so the badge is present on cold-boot Home. Racing renderHome()
  // against a later applyRoute() rebuild produced two concurrent
  // renderHomeAsync() calls — both cleared root, both appended, and the
  // window ended up showing a stacked duplicate of the entire UI. The
  // settings IPC is a local file read, so awaiting it doesn't make the
  // first paint noticeably slower.
  //
  // First-run gate: when `onboardingCompletedAt` is absent we mount the
  // welcome view instead of home. The view owns `root` until the user
  // submits, then we run the normal boot sequence (refreshRuntimeMode +
  // renderHome). The submit callback writes the user's chosen name +
  // color to the primordial local profile and flips the persisted
  // settings flag so future launches skip straight to home.
  void (async (): Promise<void> => {
    const settings = await window.CentraidApi.getSettings();
    if (!settings.onboardingCompletedAt) {
      window.Onboarding.mount({
        root,
        onComplete: async ({ displayName, avatarColor }) => {
          // Persist the user's identity onto the primordial local
          // profile. updateProfileMetadata validates the color server-
          // side (#RRGGBB) and trims the name; we let any throw bubble
          // up to the onboarding view's error display.
          await window.CentraidApi.updateProfileMetadata({
            id: 'local',
            displayName,
            avatarColor,
          });
          // Mark onboarding done so a relaunch skips this view. We
          // could also flip a Store key client-side, but persisting in
          // main keeps the source of truth in one place — and means
          // wiping settings.json (e.g. for QA) cleanly resets to the
          // welcome flow.
          await window.CentraidApi.saveSettings({
            onboardingCompletedAt: new Date().toISOString(),
          });
          // The metadata update fires `GATEWAY_CHANGED` from main, but
          // our `onGatewayChanged` handler bounces to home — so home
          // renders with the freshly-named sidebar without us having to
          // call renderHome() explicitly. We still nudge the runtime
          // mode here so the very first home render has it primed.
          await refreshRuntimeMode();
          renderHome();
        },
      });
      return;
    }
    await refreshRuntimeMode();
    renderHome();
  })();

  // Multi-gateway (#109): when the active gateway flips, every
  // gateway-scoped piece of renderer state goes stale at once — the
  // home shelf's app list belongs to gateway A, the builder is
  // editing gateway A's workspace, the iframe is loading from gateway
  // A's appsDir, the agent session is rooted in gateway A. Drop all
  // of it by re-priming the badge and bouncing back to Home (which
  // refetches the app list against the new active gateway). Main
  // already invalidates its HTTP-client caches before broadcasting,
  // so the next IPC after Home renders sees the new URL+token.
  window.CentraidApi.onGatewayChanged(() => {
    void (async (): Promise<void> => {
      const prevActiveId = currentGateway?.activeId;
      await refreshRuntimeMode();
      // Re-scope to Home only when the *active* space actually flipped (a
      // switch, or deleting the active profile and falling back to local).
      // A broadcast that leaves the active space intact — renaming or
      // deleting a non-active profile — should refresh the current route
      // in place so the user isn't yanked off Settings; bouncing home
      // there is both jarring and (racing a same-tick refresh) a way to
      // stack two shells.
      if (currentGateway?.activeId !== prevActiveId) {
        applyRoute({ kind: 'home' });
      } else {
        void reRenderShellForRoute();
      }
    })();
  });
})();
