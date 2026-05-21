// Centraid shell — renders the home screen and routes to apps.
// Every app the user sees is centraid-backed: cloned from a template or
// authored in the builder, published to the gateway, rendered through a
// sandboxed iframe. The home grid also shows uninstalled templates inline
// so they're one tap away from being cloned & deployed.
// governance: allow-repo-hygiene file-size-limit shell-entry-point pending split into route modules

(function () {
  const root = document.querySelector('#root') as HTMLElement;

  // Canonical icon → palette-hue mapping, lifted from the Centraid Redesign
  // bold.jsx APPS fixture. Every app type has a fixed colour identity in
  // the design (Todos is always indigo, Habits always rose, etc.). Used
  // when minting a new app, when hydrating drafts off disk, and to migrate
  // existing userApps to their canonical hue. Sparkle is the default icon
  // for drafts and freshly-prompted apps before an icon is inferred — it
  // gets the violet sub-accent.
  const CANONICAL_ICON_COLOR_KEY: Record<string, ColorKeyType> = {
    Gift: 'violet',
    Habit: 'rose',
    Journal: 'amber',
    Mood: 'violet',
    Plant: 'slate',
    Pomodoro: 'forest',
    Sparkle: 'violet',
    Spend: 'ochre',
    Todo: 'indigo',
    Water: 'teal',
  };

  function colorForIcon(iconKey: IconNameType | string): ColorHexType {
    const key = CANONICAL_ICON_COLOR_KEY[iconKey];
    if (key) {
      const c = (ICON_PALETTE as unknown as Record<string, ColorHexType>)[key];
      if (c) return c;
    }
    return (
      (ICON_PALETTE as unknown as Record<string, ColorHexType>)['violet'] ??
      ('#7C5BD9' as ColorHexType)
    );
  }

  // "X ago" relative-time formatter. Mirrors builder.ts:relativeWhen, but
  // co-located here so app.ts doesn't need to reach into the builder IIFE.
  function relativeTime(iso?: string): string {
    if (!iso) return 'Recently';
    try {
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return 'Recently';
      const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (s < 60) return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.floor(h / 24);
      if (d < 30) return `${d}d ago`;
      return new Date(iso).toLocaleDateString();
    } catch {
      return 'Recently';
    }
  }

  // Apps the user has installed (cloned from a template or built themselves).
  // The home grid renders these plus uninstalled templates inline.
  let userApps = Store.get<UserAppMeta[]>('home.userApps', []);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Renderer prefs — appearance settings live here (vs gateway settings,
  // which live in the main process via window.CentraidApi.getSettings).
  type ThemeName = 'light' | 'dark';
  type Density = 'compact' | 'regular' | 'comfy';
  type TileVariant = 'solid' | 'gradient' | 'glassy' | 'flat';
  type AccentKey = 'blue' | 'violet' | 'teal' | 'ochre' | 'rose';
  type CardVariant = 'flat' | 'outlined' | 'elevated';
  interface AppearancePrefs {
    theme: ThemeName;
    density: Density;
    tileVariant: TileVariant;
    sidebarOpen: boolean;
    /** Dark ramp lightness anchor (10–35). Drives `--bg-l`. */
    bgL: number;
    /** Hue 222 + 11% sat when true, neutral grey (hue 0, 0% sat) when false. */
    coolBlueCast: boolean;
    accent: AccentKey;
    cardVariant: CardVariant;
  }
  // Accent palette mirrors the Tweaks panel swatches (Centraid Redesign).
  const ACCENT_PALETTE: Record<AccentKey, { accent: string; light: string; deep: string }> = {
    blue: { accent: '#4950F6', light: '#6B72FF', deep: '#2D34D9' },
    ochre: { accent: '#B47B3F', light: '#CB9359', deep: '#92622F' },
    rose: { accent: '#E55772', light: '#EE7D92', deep: '#BF3E57' },
    teal: { accent: '#2EA098', light: '#4CBBB1', deep: '#218079' },
    violet: { accent: '#7C5BD9', light: '#9D80E6', deep: '#5D3EB3' },
  };
  const DEFAULT_PREFS: AppearancePrefs = {
    accent: 'blue',
    bgL: 5,
    cardVariant: 'outlined',
    coolBlueCast: true,
    density: 'regular',
    sidebarOpen: true,
    // Bold · Atmospheric is built around the dark blue-tinted ramp + Electric
    // Blue accent (see Centraid Redesign brief). Light theme still works but
    // won't carry the atmospheric glow — dark is the design's home turf.
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

  // Idempotent enforcement of the design's icon→colour contract and the
  // `updatedAt` field. Runs on every load; becomes a no-op once every app
  // already matches. Cheaper than a versioned migration and avoids carrying
  // dead schema bumps around the codebase.
  {
    let touched = false;
    const nowIso = new Date().toISOString();
    for (const a of userApps) {
      const canonical = colorForIcon(a.iconKey);
      if (a.color !== canonical) {
        a.color = canonical;
        touched = true;
      }
      if (!a.updatedAt) {
        a.updatedAt = nowIso;
        touched = true;
      }
      // Backfill createdAt from updatedAt for apps that predate the field
      // (§A3 NEW badge keys off it). New apps get a real stamp at creation.
      if (!a.createdAt) {
        a.createdAt = a.updatedAt;
        touched = true;
      }
    }
    if (touched) Store.set('home.userApps', userApps);
  }

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
    // (packages/app-templates/*/index.html) listens for this and flips its
    // own <html> data-attrs / CSS vars to match.
    broadcastSettingsToFrames();
    // §C2 — let an open Appearance settings page refresh its live-preview
    // tile (tile/card/density variants aren't pure CSS-var swaps).
    if (onAppearanceApplied) onAppearanceApplied();
  }

  // §C2 — set by the Appearance settings page so its preview tile can
  // re-render on every pref change; cleared on page teardown.
  let onAppearanceApplied: (() => void) | null = null;

  // Project the renderer's typed prefs into the same `dataAttrs` / `cssVars`
  // shape the runtime uses for server-side injection. The bridge inside each
  // app applies them as `<html data-…>` attrs and `--…` CSS vars — symmetric
  // with what the gateway bakes on first paint.
  function buildIframeSettings(): {
    dataAttrs: Record<string, string>;
    cssVars: Record<string, string>;
  } {
    const remote = toRemoteShape(prefs);
    const dataAttrs: Record<string, string> = {};
    const cssVars: Record<string, string> = {};
    if (typeof remote.theme === 'string') dataAttrs['theme'] = remote.theme;
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
    // New canonical payload — full settings update.
    const settingsPayload = { type: 'centraid:settings', ...settings };
    // Legacy payload — kept for any old `theme-bridge.js` still in the wild
    // (older published apps that haven't been re-served since the bridge
    // moved inline). New inline bridges accept both.
    const legacyPayload = { type: 'centraid:theme', theme: prefs.theme, bgL: prefs.bgL };
    const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-centraid-app]');
    frames.forEach((f) => {
      try {
        f.contentWindow?.postMessage(settingsPayload, '*');
        f.contentWindow?.postMessage(legacyPayload, '*');
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
      const remote = await window.CentraidApi.getUserPrefs();
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

  // Project an arbitrary remote prefs object onto the AppearancePrefs shape,
  // dropping unknown keys and rejecting values that don't match the union
  // types. Mirrors the gateway-side `KNOWN_KEYS` list — if you add a new
  // pref there, add it here too.
  function pickAppearance(remote: Record<string, unknown>): Partial<AppearancePrefs> {
    const out: Partial<AppearancePrefs> = {};
    if (remote.theme === 'dark' || remote.theme === 'light') out.theme = remote.theme;
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
      void window.CentraidApi.saveUserPrefs(remotePatch).catch(() => undefined);
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
  let currentRuntimeMode: 'local' | 'remote' | undefined;
  function refreshRuntimeMode(): Promise<void> {
    return window.CentraidApi.getSettings()
      .then((s) => {
        currentRuntimeMode = s.runtimeMode;
      })
      .catch(() => {
        /* ignore — badge stays hidden until the next save */
      });
  }

  type ShellRoute =
    | { kind: 'home' }
    | { kind: 'settings' }
    | { kind: 'insights' }
    | { kind: 'discover' }
    | { kind: 'starred' }
    | { kind: 'automations' }
    | { id: string; kind: 'app' }
    | { appContext?: AppMetaResolvedType; initialPrompt?: string; kind: 'builder' };

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
    if (route.kind === 'app') return `app:${route.id}`;
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
      } else if (route.kind === 'app') {
        openApp(route.id);
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
  // builder builds its own (it knows which project is active).
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

  function persist(): void {
    Store.set('home.userApps', userApps);
  }

  // Drafts: projects that exist on disk under <projectsDir>/<id>/ but were
  // never "Add to home"-d. Hydrated from listProjects() on each home render
  // so newly scaffolded projects show up without a manual refresh.
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

  function clear(): void {
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

  // Refresh `drafts` from disk. Drafts = projects on disk whose ids aren't
  // already in `userApps` (= already pinned to home, with full metadata).
  async function hydrateDrafts(): Promise<void> {
    try {
      const projs = await window.CentraidApi.listProjects();
      const knownIds = new Set(getApps().map((a) => a.id));
      drafts = projs
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
  function isRecentlyCreated(iso?: string): boolean {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && Date.now() - t < 24 * 60 * 60 * 1000;
  }

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
    clear();
    await hydrateDrafts();
    const availableTemplates = await loadAvailableTemplates();

    // `has-wall` paints the device-wall crosshatch behind everything.
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);

    // Home is always the composer-led layout — centered composer hero +
    // tabbed discovery shelf — regardless of how many apps exist. The
    // shelf's "Browse all →" is the only path to the alternate (Discover)
    // page; the workspace never auto-switches based on app count.
    renderDay1Home(scroll, availableTemplates);

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
    root.append(shell);
  }

  // §A1 — Day-1 home: centered composer hero + tabbed discovery shelf.
  // Apps live only inside the shelf's "My apps" tab — there is no
  // separate "Your apps" section above the shelf.
  function renderDay1Home(scroll: HTMLElement, templates: TemplateEntry[]): void {
    scroll.classList.add('cd-day1-scroll');
    scroll.append(buildHomeHero());
    scroll.append(buildTabbedShelf(templates));
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

  // Right-pointing arrow — the shared icon set ships only ArrowLeft, so
  // the design's right-arrows are ArrowLeft rotated 180°.
  function arrowRight(size: number): string {
    return `<span style="display:inline-flex;transform:rotate(180deg)">${Icon.ArrowLeft({ size })}</span>`;
  }
  // Small chevron-down — ArrowLeft rotated -90°, matching Day1Composer.
  function chevronDown(size: number): string {
    return `<span style="display:inline-flex;transform:rotate(-90deg);opacity:0.6">${Icon.ArrowLeft(
      { size },
    )}</span>`;
  }
  // Microphone glyph — not in the shared icon set; inlined to match the
  // design's voice affordance.
  const MIC_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="9" y="2" width="6" height="11" rx="3"/>' +
    '<path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></svg>';

  function buildHomeHero(): HTMLElement {
    const wrap = el('div', { class: 'cd-hero' });

    // Personalized heading — no user-profile source exists in the
    // renderer, so we fall back to the un-named form rather than fake one.
    wrap.append(el('h1', {}, 'What should we build?'));

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
    wrap.append(composer);
    return wrap;
  }

  // A shelf tile — the same RefinedAppTile shape as renderAppCard but
  // driven by a plain spec, so templates (which aren't AppMetaResolved)
  // can share the exact card vocabulary.
  function buildShelfTile(spec: {
    name: string;
    desc: string;
    iconKey: string;
    color: string;
    status?: 'new' | 'draft' | 'template' | null;
    timestamp?: string;
    starred?: boolean;
    onClick: () => void;
    /** Optional right-click handler — wires the card's context menu. */
    onContextMenu?: (e: MouseEvent) => void;
    /** Optional hover-revealed `•••` action in the tile's bottom-right. */
    more?: { label: string; onOpen: (rect: DOMRect) => void };
  }): HTMLElement {
    const card = el('button', {
      class: 'cd-app-card cd-app-card--small',
      type: 'button',
      onClick: spec.onClick,
    });
    if (spec.onContextMenu) {
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        spec.onContextMenu?.(e as MouseEvent);
      });
    }

    const iconEl = el('div', {
      class: 'cd-app-card-icon',
      trustedHtml: Icon[spec.iconKey as IconNameType]
        ? Icon[spec.iconKey as IconNameType]({ size: 18, strokeWidth: 1.85 })
        : '',
    });
    const finish = window.CentraidTokens.tileFinish(spec.color as ColorHexType, prefs.tileVariant);
    iconEl.style.background = finish.background;
    iconEl.style.color = finish.glyphColor;
    if (finish.boxShadow) iconEl.style.boxShadow = finish.boxShadow;

    const top = el('div', { class: 'cd-app-card-top' }, [iconEl]);
    if (spec.status) {
      const dot = el('span', { class: 'cd-app-card-icon-dot', 'data-tone': spec.status });
      iconEl.style.position = 'relative';
      iconEl.append(dot);
    }
    card.append(top);

    card.append(el('div', { class: 'cd-app-card-name' }, spec.name));
    card.append(el('div', { class: 'cd-app-card-desc' }, spec.desc));

    const foot = el('div', { class: 'cd-app-card-foot' });
    if (spec.status === 'new') foot.append(statusPillEl('new', 'new'));
    else if (spec.status === 'draft') foot.append(statusPillEl('draft', 'draft'));
    else if (spec.status === 'template') foot.append(statusPillEl('live', 'template'));
    if (spec.status && spec.timestamp) {
      foot.append(el('span', { class: 'cd-app-card-foot-sep' }, '·'));
    }
    if (spec.timestamp) {
      foot.append(el('span', { class: 'cd-app-card-foot-time' }, spec.timestamp));
    }
    card.append(foot);

    const wrap = el('div', { class: 'cd-app-card-wrap' }, [card]);
    if (spec.more) {
      wrap.append(buildMoreButton(spec.more.label, spec.more.onOpen));
    }
    return wrap;
  }

  // §A1 — HomeShelf: pill-tabbed shelf — My apps · Starred · Templates —
  // each tab a count badge, "Browse all →" pushed right, a 6-col grid.
  function buildTabbedShelf(templates: TemplateEntry[]): HTMLElement {
    const section = el('section', { class: 'cd-shelf' });

    const all: AppMetaResolvedType[] = [...getApps(), ...drafts];
    const starredApps = all.filter((a) => isStarred(a.id));
    const palette = window.ICON_PALETTE as Record<string, string>;

    const appTiles = (list: AppMetaResolvedType[]): HTMLElement[] =>
      list.map((a) => renderAppCard(a, true));

    const tabs: ReadonlyArray<{
      id: string;
      label: string;
      count: number;
      render: () => HTMLElement[];
      empty: { icon: IconNameType; title: string; sub: string };
    }> = [
      {
        id: 'apps',
        label: 'My apps',
        count: all.length,
        render: () => appTiles(all),
        empty: {
          icon: 'Sparkle',
          title: 'No apps yet',
          sub: 'Describe an app in the box above — Centraid will build it for you.',
        },
      },
      {
        id: 'starred',
        label: 'Starred',
        count: starredApps.length,
        render: () => appTiles(starredApps),
        empty: {
          icon: 'Star',
          title: 'Nothing starred yet',
          sub: 'Hover an app tile and tap the star to pin it here.',
        },
      },
      {
        id: 'templates',
        label: 'Templates',
        count: templates.length,
        empty: {
          icon: 'Compass',
          title: 'No templates yet',
          sub: 'Starter templates will show up here once they’re available.',
        },
        render: () =>
          templates.map((t) =>
            buildShelfTile({
              name: t.name,
              desc: t.desc,
              iconKey: t.iconKey,
              color: palette[t.colorKey] ?? '#7C5BD9',
              status: 'template',
              onClick: () => openTemplatePreview(t),
            }),
          ),
      },
    ];

    const inner = el('div', { class: 'cd-shelf-inner' });
    const tabRow = el('div', { class: 'cd-shelf-tabrow' });
    const tabList = el('div', { class: 'cd-shelf-tabs', role: 'tablist' });
    const grid = el('div', { class: 'cd-shelf-grid' });

    const renderTab = (tabId: string): void => {
      const t = tabs.find((x) => x.id === tabId) ?? tabs[0]!;
      grid.innerHTML = '';
      const tiles = t.render();
      if (tiles.length === 0) {
        grid.append(
          el('div', { class: 'cd-shelf-empty' }, [
            el('div', {
              class: 'cd-shelf-empty-icon',
              trustedHtml: (Icon[t.empty.icon] ?? Icon.Sparkle)({ size: 20 }),
            }),
            el('div', { class: 'cd-shelf-empty-title' }, t.empty.title),
            el('div', { class: 'cd-shelf-empty-sub' }, t.empty.sub),
          ]),
        );
      } else {
        for (const tile of tiles) grid.append(tile);
      }
    };

    for (const t of tabs) {
      const btn = el(
        'button',
        {
          class: 'cd-shelf-tab',
          type: 'button',
          role: 'tab',
          'data-active': t.id === 'apps' ? 'true' : undefined,
          onClick: () => {
            for (const b of tabList.querySelectorAll<HTMLElement>('.cd-shelf-tab')) {
              delete b.dataset.active;
            }
            btn.dataset.active = 'true';
            renderTab(t.id);
          },
        },
        [
          el('span', {}, t.label),
          el('span', { class: 'cd-shelf-tab-count' }, String(t.count).padStart(2, '0')),
        ],
      );
      tabList.append(btn);
    }

    const browseAll = el(
      'button',
      { class: 'cd-shelf-browse', type: 'button', onClick: renderDiscover },
      [el('span', {}, 'Browse all'), el('span', { trustedHtml: arrowRight(13) })],
    );

    tabRow.append(tabList, el('span', { class: 'cd-shelf-spacer' }), browseAll);
    inner.append(tabRow, grid);
    section.append(inner);
    renderTab('apps');
    return section;
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

  function mountShellPage(page: SidebarPage, main: HTMLElement): void {
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
    root.append(shell);
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

  // ───────────────────────── Insights page ─────────────────────────
  // Usage analytics dashboard — token consumption, spend, per-model and
  // per-app breakdowns. The desktop shell has no usage-metering backend
  // yet, so the figures here are a representative synthetic snapshot;
  // the layout is the deliverable, ready to bind to real data later.

  // A tinted icon tile used in the By-app table and Recent-activity feed.
  function insAppTile(iconKey: IconNameType, color: ColorHexType, size: number): HTMLElement {
    const finish = window.CentraidTokens.tileFinish(color, 'gradient');
    const tile = el('span', {
      class: 'cd-ins-app-icon',
      trustedHtml: Icon[iconKey] ? Icon[iconKey]({ size, strokeWidth: 1.9 }) : '',
    });
    tile.style.background = finish.background;
    tile.style.color = finish.glyphColor;
    if (finish.boxShadow) tile.style.boxShadow = finish.boxShadow;
    return tile;
  }

  // Inline SVG line chart for the daily-consumption panel. `values` is a
  // per-day token series; the peak point is marked with a labelled node.
  function insLineChart(values: readonly number[]): HTMLElement {
    const W = 760;
    const H = 200;
    const PAD = 14;
    const n = values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const px = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * W);
    const py = (v: number): number => H - PAD - ((v - min) / span) * (H - PAD * 2);
    const pts = values.map((v, i) => [px(i), py(v)] as const);
    const line = pts
      .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
      .join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    const peakIdx = values.indexOf(max);
    const [peakX, peakY] = pts[peakIdx]!;
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cd-ins-chart-svg">
      <defs><linearGradient id="insArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#insArea)"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${peakX.toFixed(1)}" cy="${peakY.toFixed(1)}" r="4"
        fill="var(--bg-elev)" stroke="var(--accent)" stroke-width="2"/>
    </svg>`;
    const chart = el('div', { class: 'cd-ins-chart-plot' }, [
      el('div', { class: 'cd-ins-chart-svg-wrap', trustedHtml: svg }),
      el(
        'div',
        {
          class: 'cd-ins-chart-peak',
          style: { left: `${((peakX / W) * 100).toFixed(2)}%` },
        },
        `${insK(max)}`,
      ),
    ]);
    return chart;
  }

  // Compact 14-day sparkline (no fill, no markers) for the By-app table.
  function insSparkline(values: readonly number[]): HTMLElement {
    const W = 96;
    const H = 26;
    const n = values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => {
      const x = n <= 1 ? 0 : (i / (n - 1)) * W;
      const y = H - 3 - ((v - min) / span) * (H - 6);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    return el('span', {
      class: 'cd-ins-spark',
      trustedHtml: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <path d="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>`,
    });
  }

  // Format a raw token count as a compact k / M string.
  function insK(v: number): string {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
    return String(v);
  }

  function insStatCard(opts: {
    icon: string;
    label: string;
    value: string;
    foot?: HTMLElement | string;
  }): HTMLElement {
    return el('div', { class: 'cd-ins-kpi' }, [
      el('div', { class: 'cd-ins-kpi-label' }, [
        el('span', { class: 'cd-ins-kpi-icon', trustedHtml: opts.icon }),
        opts.label,
      ]),
      el('div', { class: 'cd-ins-kpi-value' }, opts.value),
      opts.foot ? el('div', { class: 'cd-ins-kpi-foot' }, [opts.foot]) : false,
    ]);
  }

  // A "+18%" style delta chip — tone drives the colour.
  function insDelta(text: string, tone: 'up' | 'down' | 'flat'): HTMLElement {
    return el('span', { class: 'cd-ins-delta', 'data-tone': tone }, text);
  }

  function insPanel(title: string, meta: string, body: HTMLElement): HTMLElement {
    return el('section', { class: 'cd-ins-panel' }, [
      el('header', { class: 'cd-ins-panel-head' }, [
        el('h2', {}, title),
        meta ? el('span', { class: 'cd-ins-panel-meta' }, meta) : false,
      ]),
      body,
    ]);
  }

  function renderInsights(): void {
    recordRoute({ kind: 'insights' });
    clear();
    const { main, scroll } = pageScroll('', '');
    // pageScroll seeds an empty cd-page-head; the Insights page owns its
    // own header treatment, so drop it.
    scroll.replaceChildren();

    const page = el('div', { class: 'cd-ins-page' });
    scroll.append(page);

    // ── Header — title + filter chips ────────────────────────────────
    const filterChip = (icon: string, label: string, caret: boolean): HTMLElement =>
      el('button', { class: 'cd-ins-filter', type: 'button', disabled: 'true' }, [
        el('span', { class: 'cd-ins-filter-icon', trustedHtml: icon }),
        el('span', {}, label),
        caret
          ? el('span', {
              class: 'cd-ins-filter-caret',
              trustedHtml: Icon.ChevronDown({ size: 12, strokeWidth: 2 }),
            })
          : false,
      ]);
    page.append(
      el('div', { class: 'cd-ins-head' }, [
        el('div', { class: 'cd-ins-title' }, [
          el('span', {
            class: 'cd-ins-title-icon',
            trustedHtml: Icon.Activity({ size: 18, strokeWidth: 2 }),
          }),
          el('h1', {}, 'Insights'),
        ]),
        el('div', { class: 'cd-ins-filters' }, [
          filterChip(Icon.Folder({ size: 13 }), 'All apps', true),
          filterChip(Icon.History({ size: 13 }), 'Last 30 days', true),
          filterChip(Icon.Sparkle({ size: 13 }), 'Tokens · USD', true),
          el('button', {
            class: 'cd-ins-filter cd-ins-filter-icononly',
            type: 'button',
            disabled: 'true',
            'aria-label': 'Export',
            trustedHtml: Icon.Share({ size: 14 }),
          }),
        ]),
      ]),
    );

    // ── KPI row ──────────────────────────────────────────────────────
    page.append(
      el('div', { class: 'cd-ins-kpis' }, [
        insStatCard({
          icon: Icon.Activity({ size: 12 }),
          label: 'Tokens · this month',
          value: '3.53M',
          foot: el('div', { class: 'cd-ins-meter' }, [
            el('div', { class: 'cd-ins-meter-row' }, [
              insDelta('+18%', 'up'),
              el('span', { class: 'cd-ins-kpi-sub' }, 'of 8M included'),
            ]),
            el('div', { class: 'cd-ins-bar' }, [
              el('div', { class: 'cd-ins-bar-fill', style: { width: '44%' } }),
            ]),
            el('div', { class: 'cd-ins-meter-foot' }, [
              el('span', {}, '3.53M of 8M included'),
              el('span', {}, '44%'),
            ]),
          ]),
        }),
        insStatCard({
          icon: Icon.Coin({ size: 12 }),
          label: 'Spent · USD',
          value: '$10.41',
          foot: el('div', { class: 'cd-ins-kpi-row' }, [
            insDelta('+18%', 'up'),
            el('span', { class: 'cd-ins-kpi-sub' }, 'May 1 – 30'),
          ]),
        }),
        insStatCard({
          icon: Icon.History({ size: 12 }),
          label: 'Forecast · USD',
          value: '$26.40',
          foot: el('span', { class: 'cd-ins-kpi-sub' }, 'end of month'),
        }),
        insStatCard({
          icon: Icon.Folder({ size: 12 }),
          label: 'Apps touched',
          value: '14',
          foot: el('div', { class: 'cd-ins-kpi-row' }, [
            insDelta('+27%', 'up'),
            el('span', { class: 'cd-ins-kpi-sub' }, 'this month'),
          ]),
        }),
        insStatCard({
          icon: Icon.Sparkle({ size: 12 }),
          label: 'Generations',
          value: '62',
          foot: el('div', { class: 'cd-ins-kpi-row' }, [
            insDelta('+11%', 'up'),
            el('span', { class: 'cd-ins-kpi-sub' }, '2 retries today'),
          ]),
        }),
      ]),
    );

    // ── Two-column grid ──────────────────────────────────────────────
    const grid = el('div', { class: 'cd-ins-grid' });
    page.append(grid);
    const colMain = el('div', { class: 'cd-ins-col' });
    const colSide = el('div', { class: 'cd-ins-col' });
    grid.append(colMain, colSide);

    // Daily consumption ------------------------------------------------
    const series = [
      62, 71, 58, 66, 54, 88, 79, 72, 95, 84, 91, 103, 88, 110, 124, 96, 108, 119, 102, 131, 115,
      142, 311, 168, 151, 139, 158, 171, 162, 175,
    ].map((k) => k * 1000);
    const chartBody = el('div', { class: 'cd-ins-chart' }, [
      el('div', { class: 'cd-ins-chart-stats' }, [
        insChartStat('Daily avg', '118k'),
        insChartStat('Peak', '311k', 'May 23'),
        insChartStat('Median', '108k'),
        insChartStat('Trend', '↑ 1.4% / day', undefined, true),
      ]),
      insLineChart(series),
      el('div', { class: 'cd-ins-chart-axis' }, [
        el('span', {}, '30d ago'),
        el('span', {}, '23d'),
        el('span', {}, '16d'),
        el('span', {}, '9d'),
        el('span', {}, '1d'),
      ]),
    ]);
    colMain.append(insPanel('Daily consumption', '30 days · tokens', chartBody));

    // By app -----------------------------------------------------------
    interface InsAppRow {
      name: string;
      iconKey: IconNameType;
      color: ColorHexType;
      spike?: boolean;
      tokens: number;
      usd: string;
      delta: string;
      tone: 'up' | 'down' | 'flat';
      mix: number;
      spark: number[];
      lastTouched: string;
      runs: number;
    }
    const appRows: InsAppRow[] = [
      {
        name: 'Habit tracker',
        iconKey: 'Habit',
        color: '#C8516B' as ColorHexType,
        tokens: 842_000,
        usd: '$2.58',
        delta: '+24%',
        tone: 'up',
        mix: 78,
        spark: [4, 6, 5, 7, 6, 8, 7, 9, 8, 7, 9, 8, 10, 9],
        lastTouched: '12m ago',
        runs: 9,
      },
      {
        name: 'Journal',
        iconKey: 'Journal',
        color: '#7C5BD9' as ColorHexType,
        tokens: 614_000,
        usd: '$1.87',
        delta: '+8%',
        tone: 'up',
        mix: 64,
        spark: [5, 5, 6, 5, 7, 6, 8, 7, 6, 8, 7, 9, 8, 9],
        lastTouched: '1h ago',
        runs: 7,
      },
      {
        name: 'Plant care',
        iconKey: 'Plant',
        color: '#5E7A52' as ColorHexType,
        spike: true,
        tokens: 587_000,
        usd: '$2.21',
        delta: '+312%',
        tone: 'up',
        mix: 58,
        spark: [2, 2, 3, 2, 3, 4, 3, 5, 6, 8, 7, 10, 12, 14],
        lastTouched: 'yesterday',
        runs: 4,
      },
      {
        name: 'Task tracker',
        iconKey: 'Todo',
        color: '#4F6BD9' as ColorHexType,
        tokens: 498_000,
        usd: '$1.52',
        delta: '−6%',
        tone: 'down',
        mix: 49,
        spark: [9, 8, 9, 7, 8, 6, 7, 6, 5, 6, 5, 6, 5, 5],
        lastTouched: '3h ago',
        runs: 6,
      },
      {
        name: 'Weekly planner',
        iconKey: 'Todo',
        color: '#3FA89A' as ColorHexType,
        tokens: 312_000,
        usd: '$0.96',
        delta: '+2%',
        tone: 'flat',
        mix: 31,
        spark: [4, 5, 4, 5, 5, 4, 5, 5, 6, 5, 5, 6, 5, 6],
        lastTouched: 'yesterday',
        runs: 3,
      },
      {
        name: 'Notes',
        iconKey: 'Journal',
        color: '#C8516B' as ColorHexType,
        tokens: 186_000,
        usd: '$0.57',
        delta: '−14%',
        tone: 'down',
        mix: 19,
        spark: [7, 6, 6, 5, 6, 4, 5, 4, 4, 3, 4, 3, 3, 2],
        lastTouched: '2d ago',
        runs: 2,
      },
    ];
    const table = el('div', { class: 'cd-ins-table' });
    table.append(
      el('div', { class: 'cd-ins-tr cd-ins-tr-head' }, [
        el('span', { class: 'cd-ins-th cd-ins-c-app' }, 'App'),
        el('span', { class: 'cd-ins-th cd-ins-c-num' }, 'Tokens'),
        el('span', { class: 'cd-ins-th cd-ins-c-num' }, 'USD'),
        el('span', { class: 'cd-ins-th cd-ins-c-num' }, 'Δ 30d'),
        el('span', { class: 'cd-ins-th cd-ins-c-mix' }, 'Mix'),
        el('span', { class: 'cd-ins-th cd-ins-c-spark' }, '14-day'),
        el('span', { class: 'cd-ins-th cd-ins-c-last' }, 'Last touched'),
        el('span', { class: 'cd-ins-th cd-ins-c-runs' }, 'Runs'),
      ]),
    );
    for (const r of appRows) {
      table.append(
        el('div', { class: 'cd-ins-tr' }, [
          el('span', { class: 'cd-ins-td cd-ins-c-app' }, [
            insAppTile(r.iconKey, r.color, 13),
            el('span', { class: 'cd-ins-app-name' }, r.name),
            r.spike ? el('span', { class: 'cd-ins-tag' }, 'spike') : false,
          ]),
          el('span', { class: 'cd-ins-td cd-ins-c-num cd-ins-mono' }, insK(r.tokens)),
          el('span', { class: 'cd-ins-td cd-ins-c-num cd-ins-mono' }, r.usd),
          el('span', { class: 'cd-ins-td cd-ins-c-num' }, [insDelta(r.delta, r.tone)]),
          el('span', { class: 'cd-ins-td cd-ins-c-mix' }, [
            el('span', { class: 'cd-ins-mixbar' }, [
              el('span', { class: 'cd-ins-mixbar-fill', style: { width: `${r.mix}%` } }),
            ]),
          ]),
          el('span', { class: 'cd-ins-td cd-ins-c-spark' }, [insSparkline(r.spark)]),
          el('span', { class: 'cd-ins-td cd-ins-c-last cd-ins-mono' }, r.lastTouched),
          el('span', { class: 'cd-ins-td cd-ins-c-runs cd-ins-mono' }, String(r.runs)),
        ]),
      );
    }
    colMain.append(insPanel('By app', `${appRows.length} apps · sorted by tokens`, table));

    // By model ---------------------------------------------------------
    interface InsModelRow {
      name: string;
      pct: number;
      tokens: string;
      usd: string;
    }
    const models: InsModelRow[] = [
      { name: 'Claude Sonnet 4.5', pct: 66, tokens: '2.87M', usd: '$8.61' },
      { name: 'Claude Haiku 4.5', pct: 27, tokens: '1.18M', usd: '$1.18' },
      { name: 'GPT-4o mini', pct: 6, tokens: '246k', usd: '$0.62' },
      { name: 'Local · Llama 3.1', pct: 1, tokens: '18k', usd: '$0.00' },
    ];
    const modelBody = el('div', { class: 'cd-ins-models' });
    for (const m of models) {
      modelBody.append(
        el('div', { class: 'cd-ins-model' }, [
          el('div', { class: 'cd-ins-model-name' }, m.name),
          el('div', { class: 'cd-ins-bar' }, [
            el('div', { class: 'cd-ins-bar-fill', style: { width: `${m.pct}%` } }),
          ]),
          el('div', { class: 'cd-ins-model-foot' }, [
            el('span', { class: 'cd-ins-mono' }, `${m.pct}%  ${m.tokens}`),
            el('span', { class: 'cd-ins-mono' }, m.usd),
          ]),
        ]),
      );
    }
    colSide.append(insPanel('By model', 'this month', modelBody));

    // Recent activity --------------------------------------------------
    interface InsActivityRow {
      app: string;
      iconKey: IconNameType;
      color: ColorHexType;
      note: string;
      ago: string;
      tokens: string;
      usd: string;
    }
    const activity: InsActivityRow[] = [
      {
        app: 'Habit tracker',
        iconKey: 'Habit',
        color: '#C8516B' as ColorHexType,
        note: 'Iterated — fixed streak rollover bug',
        ago: '12m ago',
        tokens: '24k',
        usd: '$0.07',
      },
      {
        app: 'Journal',
        iconKey: 'Journal',
        color: '#7C5BD9' as ColorHexType,
        note: 'Iterated — added weekly recap view',
        ago: '1h ago',
        tokens: '58k',
        usd: '$0.17',
      },
      {
        app: 'Journal',
        iconKey: 'Journal',
        color: '#7C5BD9' as ColorHexType,
        note: 'Published v3',
        ago: '3h ago',
        tokens: '4k',
        usd: '$0.01',
      },
      {
        app: 'Plant care',
        iconKey: 'Plant',
        color: '#5E7A52' as ColorHexType,
        note: 'Built — watering schedule generator',
        ago: 'yesterday',
        tokens: '142k',
        usd: '$0.43',
      },
    ];
    const actBody = el('div', { class: 'cd-ins-activity' });
    for (const a of activity) {
      actBody.append(
        el('div', { class: 'cd-ins-act' }, [
          el('span', { class: 'cd-ins-act-ago cd-ins-mono' }, a.ago),
          insAppTile(a.iconKey, a.color, 13),
          el('div', { class: 'cd-ins-act-body' }, [
            el('div', { class: 'cd-ins-act-app' }, a.app),
            el('div', { class: 'cd-ins-act-note' }, a.note),
          ]),
          el('div', { class: 'cd-ins-act-cost' }, [
            el('span', { class: 'cd-ins-mono' }, a.tokens),
            el('span', { class: 'cd-ins-mono cd-ins-act-usd' }, a.usd),
          ]),
        ]),
      );
    }
    colSide.append(insPanel('Recent activity', '62 generations', actBody));

    mountShellPage('insights', main);
  }

  // One labelled stat in the daily-consumption panel header strip.
  function insChartStat(label: string, value: string, sub?: string, accent?: boolean): HTMLElement {
    return el('div', { class: 'cd-ins-chart-stat' }, [
      el('div', { class: 'cd-ins-chart-stat-label' }, label),
      el(
        'div',
        {
          class: accent
            ? 'cd-ins-chart-stat-value cd-ins-chart-stat-accent'
            : 'cd-ins-chart-stat-value',
        },
        value,
      ),
      sub ? el('div', { class: 'cd-ins-chart-stat-sub' }, sub) : false,
    ]);
  }

  function renderDiscover(): void {
    void renderDiscoverAsync();
  }
  async function renderDiscoverAsync(): Promise<void> {
    recordRoute({ kind: 'discover' });
    clear();
    const availableTemplates = await loadAvailableTemplates();
    const { main, scroll } = pageScroll(
      'Discover',
      'Start from a template — clone it and make it yours.',
    );
    if (availableTemplates.length > 0) {
      const grid = el('div', { class: 'cd-tmpl-grid' });
      for (const tmpl of availableTemplates) grid.append(renderTemplateCard(tmpl));
      scroll.append(grid);
    } else {
      scroll.append(renderSimpleEmpty('No templates available yet.'));
    }
    mountShellPage('discover', main);
  }

  function renderStarred(): void {
    recordRoute({ kind: 'starred' });
    clear();
    const { main, scroll } = pageScroll('Starred', 'Apps you star show up here for quick access.');
    scroll.append(renderSimpleEmpty('Nothing starred yet. Hover an app tile and tap the star.'));
    mountShellPage('starred', main);
  }

  // One execution in the Automations "Runs" feed.
  interface AutomationFeedEntry {
    app: AppMetaResolvedType;
    projectId: string;
    automationName: string;
    run: CentraidAutomationRunRecord;
  }

  // App-grouped header for the top-level Automations page — a gradient
  // icon tile + name, clicking through to the app's own view.
  function renderAutomationsGroupHead(app: AppMetaResolvedType): HTMLElement {
    const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');
    const icon = el('span', {
      class: 'cd-automations-group-icon',
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 14, strokeWidth: 1.85 }) : '',
    });
    icon.style.background = finish.background;
    icon.style.color = finish.glyphColor;
    if (finish.boxShadow) icon.style.boxShadow = finish.boxShadow;
    return el(
      'button',
      {
        class: 'cd-automations-group-head',
        type: 'button',
        onClick: () => openApp(app.id),
      },
      [icon, el('span', { class: 'cd-automations-group-name' }, app.name)],
    );
  }

  // Apps whose automations are reachable — published apps via their
  // centraid project id, drafts via their tile id (id == project id).
  function resolveAutomationApps(): { app: AppMetaResolvedType; projectId: string }[] {
    return getAppsWithDrafts()
      .map((app) => {
        const ua = findUserApp(app.id);
        const projectId = ua?.centraidProjectId ?? (isDraft(app) ? app.id : undefined);
        return projectId ? { app, projectId } : null;
      })
      .filter((x): x is { app: AppMetaResolvedType; projectId: string } => x !== null);
  }

  function renderAutomations(): void {
    recordRoute({ kind: 'automations' });
    clear();
    // The Automations page owns a flex-column layout (rather than
    // pageScroll's single scroll column) so the executions master-detail
    // can fill the viewport with independently-scrolling panes.
    const main = el('div', { class: 'has-wall' });
    const topbar = el('div', { class: 'cd-automations-topbar' }, [
      el('div', { class: 'cd-page-head' }, [
        el('h1', {}, 'Automations'),
        el('p', {}, 'Scheduled triggers that run scripts across your apps.'),
      ]),
    ]);
    const tabRow = el('div', { class: 'cd-automations-tabswitch', role: 'tablist' });
    topbar.append(tabRow);
    const host = el('div', { class: 'cd-automations-host' });
    main.append(topbar, host);

    // Two views, n8n-style: the executions log (every run, with per-step
    // timing) and the standing-order definitions grouped by app.
    const tabs: ReadonlyArray<{
      id: string;
      label: string;
      render: (host: HTMLElement, isStale: () => boolean) => void;
    }> = [
      { id: 'runs', label: 'Executions', render: renderAutomationsRunsInto },
      { id: 'orders', label: 'Standing orders', render: renderAutomationsOrdersInto },
    ];
    const tabBtns = new Map<string, HTMLElement>();

    // Bumped on every tab switch so an in-flight async render that
    // resolves after the user moved away can detect it's stale.
    let renderSeq = 0;
    const select = (id: string): void => {
      const tab = tabs.find((t) => t.id === id) ?? tabs[0]!;
      for (const [tid, btn] of tabBtns) {
        if (tid === tab.id) btn.dataset.active = 'true';
        else delete btn.dataset.active;
      }
      const seq = ++renderSeq;
      host.replaceChildren(el('div', { class: 'cd-automations-loading' }, 'Loading…'));
      tab.render(host, () => seq !== renderSeq || !document.contains(host));
    };
    for (const t of tabs) {
      const btn = el('button', {
        class: 'cd-automations-tab',
        type: 'button',
        role: 'tab',
        onClick: () => select(t.id),
      });
      btn.textContent = t.label;
      tabBtns.set(t.id, btn);
      tabRow.append(btn);
    }

    mountShellPage('automations', main);
    select('runs');
  }

  function automationsEmpty(host: HTMLElement, title: string, sub: string): void {
    host.replaceChildren(
      el('div', { class: 'cd-automations-empty-wrap' }, [
        el('div', { class: 'cd-page-empty' }, [
          el('div', { class: 'cd-page-empty-icon', trustedHtml: Icon.Bolt({ size: 22 }) }),
          el('div', { class: 'cd-page-empty-text' }, [
            el('div', { class: 'cd-page-empty-title' }, title),
            el('div', {}, sub),
          ]),
        ]),
      ]),
    );
  }

  // "Standing orders" tab — the automation definitions, grouped by app.
  function renderAutomationsOrdersInto(host: HTMLElement, isStale: () => boolean): void {
    void (async () => {
      const groups = await Promise.all(
        resolveAutomationApps().map(async ({ app, projectId }) => {
          try {
            const rows = await window.CentraidApi.listAutomations({ appId: projectId });
            return { app, projectId, rows };
          } catch {
            return { app, projectId, rows: [] as CentraidAutomationRow[] };
          }
        }),
      );
      if (isStale()) return;

      const nonEmpty = groups.filter((g) => g.rows.length > 0);
      if (nonEmpty.length === 0) {
        automationsEmpty(
          host,
          'No automations yet',
          'Add one from an app’s settings → Automations.',
        );
        return;
      }
      const scroll = el('div', { class: 'cd-automations-orders' });
      const col = el('div', { class: 'cd-automations-orders-col' });
      for (const g of nonEmpty) {
        const group = el('div', { class: 'cd-automations-group' });
        group.append(renderAutomationsGroupHead(g.app));
        // `group` is the panel handed to renderStandingOrder so its
        // run/toggle re-renders scope `.cd-app-orders-list` to this app.
        group.append(renderAutomationsSection(g.rows, g.projectId, group));
        col.append(group);
      }
      scroll.append(col);
      host.replaceChildren(scroll);
    })();
  }

  // Fan out across every app's automations and collect their runs into
  // one flat list (newest-first sorting is the caller's job).
  async function collectAutomationRuns(): Promise<AutomationFeedEntry[]> {
    const perApp = await Promise.all(
      resolveAutomationApps().map(async ({ app, projectId }) => {
        try {
          const autos = await window.CentraidApi.listAutomations({ appId: projectId });
          return { app, projectId, autos };
        } catch {
          return { app, projectId, autos: [] as CentraidAutomationRow[] };
        }
      }),
    );
    const jobs: Promise<AutomationFeedEntry[]>[] = [];
    for (const { app, projectId, autos } of perApp) {
      for (const auto of autos) {
        jobs.push(
          (async () => {
            try {
              const runs = await window.CentraidApi.listAutomationRuns({
                appId: projectId,
                name: auto.name,
                limit: 25,
              });
              return runs.map((run) => ({ app, projectId, automationName: auto.name, run }));
            } catch {
              return [];
            }
          })(),
        );
      }
    }
    return (await Promise.all(jobs)).flat();
  }

  // "Executions" tab — n8n-style master/detail: a list of every run on
  // the left, the selected run's stats + per-step timeline on the right.
  function renderAutomationsRunsInto(host: HTMLElement, isStale: () => boolean): void {
    void (async () => {
      const entries = await collectAutomationRuns();
      if (isStale()) return;

      if (entries.length === 0) {
        automationsEmpty(
          host,
          'No executions yet',
          'Every time an automation fires — on schedule or run manually — it shows up here.',
        );
        return;
      }
      entries.sort((a, b) => b.run.startedAt - a.run.startedAt);

      const layout = el('div', { class: 'cd-exec' });
      const listCol = el('div', { class: 'cd-exec-list' });
      const detailCol = el('div', { class: 'cd-exec-detail' });
      layout.append(listCol, detailCol);

      listCol.append(
        el('div', { class: 'cd-exec-list-head' }, [
          el('span', { class: 'cd-exec-eyebrow' }, 'Executions'),
          el('span', { class: 'cd-exec-list-count' }, String(entries.length)),
        ]),
      );
      const listScroll = el('div', { class: 'cd-exec-list-scroll' });
      listCol.append(listScroll);

      const rows: HTMLElement[] = [];
      let selected = -1;
      const select = (idx: number): void => {
        if (selected === idx) return;
        if (selected >= 0) delete rows[selected]!.dataset.selected;
        selected = idx;
        rows[idx]!.dataset.selected = 'true';
        void renderExecutionDetail(detailCol, entries[idx]!);
      };
      entries.forEach((entry, idx) => {
        const row = renderExecutionRow(entry, () => select(idx));
        rows.push(row);
        listScroll.append(row);
      });

      host.replaceChildren(layout);
      select(0);
    })();
  }

  // One row in the executions list (left rail of the master/detail).
  function renderExecutionRow(entry: AutomationFeedEntry, onClick: () => void): HTMLElement {
    const { app, automationName, run } = entry;
    const row = el('button', {
      type: 'button',
      class: 'cd-exec-row',
      'data-ok': String(run.ok),
      onClick,
    });
    const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');
    const icon = el('span', {
      class: 'cd-exec-row-icon',
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 11, strokeWidth: 1.9 }) : '',
    });
    icon.style.background = finish.background;
    icon.style.color = finish.glyphColor;
    const duration =
      run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : 'running';
    row.append(
      el('span', { class: 'cd-exec-row-spine', 'aria-hidden': 'true' }),
      icon,
      el('span', { class: 'cd-exec-row-main' }, [
        el('span', { class: 'cd-exec-row-name' }, automationName),
        el(
          'span',
          { class: 'cd-exec-row-sub' },
          `${app.name} · ${relativeTime(new Date(run.startedAt).toISOString())}`,
        ),
      ]),
      el('span', { class: 'cd-exec-row-dur' }, duration),
    );
    return row;
  }

  // Bumped before each detail fetch so a slow listAutomationRunNodes
  // resolving after the user picked another row can detect it's stale.
  let execDetailToken = 0;

  async function renderExecutionDetail(
    detailCol: HTMLElement,
    entry: AutomationFeedEntry,
  ): Promise<void> {
    const token = String(++execDetailToken);
    detailCol.dataset.token = token;
    detailCol.replaceChildren(el('div', { class: 'cd-exec-detail-loading' }, 'Loading execution…'));
    let nodes: CentraidAutomationRunNode[] = [];
    try {
      nodes = await window.CentraidApi.listAutomationRunNodes({
        appId: entry.projectId,
        runId: entry.run.runId,
      });
    } catch {
      /* leave nodes empty — the detail still shows run-level stats */
    }
    if (detailCol.dataset.token !== token) return;
    detailCol.replaceChildren(buildExecutionDetail(entry, nodes));
  }

  function buildExecutionDetail(
    entry: AutomationFeedEntry,
    nodes: CentraidAutomationRunNode[],
  ): HTMLElement {
    const { app, run, automationName, projectId } = entry;
    const scroll = el('div', { class: 'cd-exec-detail-scroll' });

    // ── Header — app-icon lockup, status, trigger, Run again ──────────
    const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');
    const iconTile = el('span', {
      class: 'cd-exec-hd-icon',
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 17, strokeWidth: 1.85 }) : '',
    });
    iconTile.style.background = finish.background;
    iconTile.style.color = finish.glyphColor;
    if (finish.boxShadow) iconTile.style.boxShadow = finish.boxShadow;

    const runAgainBtn = el('button', {
      type: 'button',
      class: 'cd-exec-runagain',
      trustedHtml: `${Icon.Play({ size: 12 })}<span>Run again</span>`,
    }) as HTMLButtonElement;
    runAgainBtn.addEventListener('click', () => {
      runAgainBtn.disabled = true;
      runAgainBtn.querySelector('span')!.textContent = 'Running…';
      void (async () => {
        try {
          await window.CentraidApi.runAutomationNow({ appId: projectId, name: automationName });
        } catch (err) {
          showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        renderAutomations();
      })();
    });

    const header = el('div', { class: 'cd-exec-hd' }, [
      iconTile,
      el('div', { class: 'cd-exec-hd-text' }, [
        el('div', { class: 'cd-exec-hd-eyebrow' }, app.name),
        el('div', { class: 'cd-exec-hd-title' }, automationName),
      ]),
      el('div', { class: 'cd-exec-hd-actions' }, [
        el('span', { class: 'cd-exec-status', 'data-ok': String(run.ok) }, [
          el('span', { class: 'cd-exec-status-dot' }),
          run.ok ? 'Success' : 'Failed',
        ]),
        runAgainBtn,
      ]),
    ]);
    scroll.append(header);

    // ── Stat strip — n8n-style KPI tiles ──────────────────────────────
    const totalMs = run.endedAt !== undefined ? run.endedAt - run.startedAt : undefined;
    const tokens = nodes.reduce((sum, n) => sum + (n.inputTokens ?? 0) + (n.outputTokens ?? 0), 0);
    const statTile = (label: string, value: string, kind?: string): HTMLElement =>
      el('div', { class: 'cd-exec-stat', ...(kind ? { 'data-kind': kind } : {}) }, [
        el('div', { class: 'cd-exec-stat-label' }, label),
        el('div', { class: 'cd-exec-stat-value' }, value),
      ]);
    scroll.append(
      el('div', { class: 'cd-exec-stats' }, [
        statTile('Duration', totalMs !== undefined ? formatDuration(totalMs) : '—'),
        statTile('Steps', String(nodes.length)),
        statTile('Tokens', tokens > 0 ? tokens.toLocaleString() : '—'),
        statTile('Trigger', run.triggerKind.replace('_', ' ')),
        statTile('Started', new Date(run.startedAt).toLocaleString()),
      ]),
    );

    // ── Input / Output preview ────────────────────────────────────────
    const io = el('div', { class: 'cd-exec-io' }, [
      renderExecPreview('Input', run.inputJson),
      renderExecPreview('Output', run.outputJson, run.ok ? run.summary : run.error),
    ]);
    scroll.append(io);

    // ── Steps timeline ────────────────────────────────────────────────
    const stepsSection = el('div', { class: 'cd-exec-section' });
    stepsSection.append(
      el('div', { class: 'cd-exec-section-head' }, [
        el('span', { class: 'cd-exec-eyebrow' }, 'Steps'),
        el('span', { class: 'cd-exec-section-count' }, String(nodes.length)),
      ]),
    );
    if (nodes.length === 0) {
      stepsSection.append(
        el(
          'div',
          { class: 'cd-exec-steps-empty' },
          'No steps recorded — this run did not call any tools or agents.',
        ),
      );
    } else {
      stepsSection.append(renderExecSteps(projectId, nodes, 0));
    }
    scroll.append(stepsSection);

    return scroll;
  }

  // A labelled JSON/text preview block. `fallbackText` is shown as a
  // plain line when there's no JSON payload (e.g. a run summary).
  function renderExecPreview(label: string, json?: string, fallbackText?: string): HTMLElement {
    const block = el('div', { class: 'cd-exec-preview' });
    block.append(el('div', { class: 'cd-exec-preview-label' }, label));
    if (json) {
      block.append(el('pre', { class: 'cd-exec-preview-body' }, prettyJson(json)));
    } else if (fallbackText) {
      block.append(el('div', { class: 'cd-exec-preview-text' }, fallbackText));
    } else {
      block.append(el('div', { class: 'cd-exec-preview-empty' }, 'Not recorded'));
    }
    return block;
  }

  // Render a run's nodes as a timeline. Nodes sharing a `batchId` (a
  // Promise.all frontier) render side-by-side in a parallel lane; the
  // duration bar of every step is scaled to the slowest node so the
  // relative cost of each tool call reads at a glance.
  function renderExecSteps(
    appId: string,
    nodes: CentraidAutomationRunNode[],
    depth: number,
  ): HTMLElement {
    const wrap = el('div', { class: 'cd-exec-steps' });
    const maxMs = Math.max(1, ...nodes.map((n) => n.durationMs ?? 0));
    let i = 0;
    while (i < nodes.length) {
      const bid = nodes[i]!.batchId;
      if (bid !== undefined) {
        const group: CentraidAutomationRunNode[] = [];
        while (i < nodes.length && nodes[i]!.batchId === bid) group.push(nodes[i++]!);
        if (group.length > 1) {
          const lane = el('div', { class: 'cd-exec-lane' }, [
            el('div', { class: 'cd-exec-lane-label' }, `Parallel · ${group.length} steps`),
          ]);
          const laneSteps = el('div', { class: 'cd-exec-lane-steps' });
          for (const g of group) laneSteps.append(renderExecStep(appId, g, maxMs, depth));
          lane.append(laneSteps);
          wrap.append(lane);
          continue;
        }
        wrap.append(renderExecStep(appId, group[0]!, maxMs, depth));
        continue;
      }
      wrap.append(renderExecStep(appId, nodes[i]!, maxMs, depth));
      i++;
    }
    return wrap;
  }

  // One step (tool / agent / invoke call) — header carries the duration
  // bar; the body expands to args, output, token counts, and — for
  // ctx.invoke nodes — the nested child-run timeline.
  function renderExecStep(
    appId: string,
    node: CentraidAutomationRunNode,
    maxMs: number,
    depth: number,
  ): HTMLElement {
    const step = el('div', {
      class: 'cd-exec-step',
      'data-ok': String(node.ok),
      'data-kind': node.kind,
    });
    const pct = node.durationMs ? Math.max(3, (node.durationMs / maxMs) * 100) : 0;
    const barFill = el('span', { class: 'cd-exec-step-bar-fill' });
    barFill.style.width = `${pct}%`;

    const head = el('button', {
      type: 'button',
      class: 'cd-exec-step-head',
      'aria-expanded': 'false',
    }) as HTMLButtonElement;
    head.append(
      el('span', { class: 'cd-exec-step-ord' }, String(node.ordinal)),
      el('span', { class: 'cd-exec-step-kind', 'data-kind': node.kind }, node.kind),
      el('span', { class: 'cd-exec-step-name' }, node.name),
      el('span', { class: 'cd-exec-step-bar' }, [barFill]),
      el(
        'span',
        { class: 'cd-exec-step-dur' },
        node.durationMs !== undefined ? formatDuration(node.durationMs) : '—',
      ),
      el('span', { class: 'cd-exec-step-caret', trustedHtml: Icon.ArrowRight({ size: 13 }) }),
    );

    const body = el('div', { class: 'cd-exec-step-body', hidden: 'true' });
    let bodyBuilt = false;
    const buildBody = (): void => {
      if (bodyBuilt) return;
      bodyBuilt = true;
      if (node.error) {
        body.append(el('div', { class: 'cd-exec-step-error' }, node.error));
      }
      if (node.inputTokens !== undefined || node.outputTokens !== undefined) {
        body.append(
          el('div', { class: 'cd-exec-step-tokens' }, [
            el('span', {}, `${node.inputTokens ?? 0} in`),
            el('span', { class: 'cd-exec-step-tokens-sep' }, '·'),
            el('span', {}, `${node.outputTokens ?? 0} out`),
          ]),
        );
      }
      body.append(
        el('div', { class: 'cd-exec-step-io' }, [
          renderExecPreview('Args', node.argsJson),
          renderExecPreview('Output', node.outputJson),
        ]),
      );
      // ctx.invoke — nest the child run's own timeline. Cross-app
      // children (`appId/name`) live in another app's audit file.
      const childRunId = node.childRunId;
      if (node.kind === 'invoke' && childRunId) {
        if (node.name.includes('/')) {
          body.append(
            el(
              'div',
              { class: 'cd-exec-step-note' },
              'Cross-app sub-run — recorded in the target app.',
            ),
          );
        } else if (depth < 4) {
          const childHost = el('div', { class: 'cd-exec-step-child', hidden: 'true' });
          const childToggle = el('button', {
            type: 'button',
            class: 'cd-exec-step-childtoggle',
            'aria-expanded': 'false',
          }) as HTMLButtonElement;
          childToggle.textContent = 'Show sub-run steps';
          childToggle.addEventListener('click', () => {
            const open = childToggle.getAttribute('aria-expanded') === 'true';
            childToggle.setAttribute('aria-expanded', String(!open));
            childToggle.textContent = open ? 'Show sub-run steps' : 'Hide sub-run steps';
            childHost.hidden = open;
            if (!open && !childHost.dataset.loaded) {
              void loadExecChildSteps(appId, childRunId, childHost, depth);
            }
          });
          body.append(childToggle, childHost);
        }
      }
    };

    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!open));
      if (!open) buildBody();
      body.hidden = open;
    });

    step.append(head, body);
    return step;
  }

  async function loadExecChildSteps(
    appId: string,
    runId: string,
    host: HTMLElement,
    depth: number,
  ): Promise<void> {
    host.dataset.loaded = 'true';
    host.replaceChildren(el('div', { class: 'cd-exec-steps-empty' }, 'Loading sub-run…'));
    let nodes: CentraidAutomationRunNode[];
    try {
      nodes = await window.CentraidApi.listAutomationRunNodes({ appId, runId });
    } catch (err) {
      host.replaceChildren(
        el(
          'div',
          { class: 'cd-exec-steps-empty' },
          `Failed to load sub-run: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (nodes.length === 0) {
      host.replaceChildren(
        el('div', { class: 'cd-exec-steps-empty' }, 'Sub-run recorded no steps.'),
      );
      return;
    }
    host.replaceChildren(renderExecSteps(appId, nodes, depth + 1));
  }

  // ---------- ⌘K command palette (Refined Screens §F) ----------
  let paletteCleanup: (() => void) | null = null;

  function closeCommandPalette(): void {
    if (paletteCleanup) {
      paletteCleanup();
      paletteCleanup = null;
    }
  }

  interface PaletteRow {
    label: string;
    sub?: string;
    icon: string;
    tint?: string;
    /** Variant changes the leading visual: action chip, app tile, chat dot. */
    variant?: 'action' | 'app' | 'chat';
    /** App reference — drives the gradient icon tile for `variant: 'app'`. */
    app?: AppMetaResolvedType;
    /** Right-aligned meta — relative time or a kbd hint. */
    meta?: string;
    /** Right-aligned mono kbd chip (e.g. ↵). */
    kbd?: string;
    /** Accent treatment for the leading chip (the primary "Build" action). */
    accent?: boolean;
    run: () => void;
  }

  // §F — a 640px command card over a dimmed, blurred copy of the current
  // screen. Results group into Build / Apps / Chats / Settings with
  // up/down + Enter keyboard navigation and a footer hint bar.
  function openCommandPalette(): void {
    if (paletteCleanup) return;
    const backdrop = el('div', { class: 'cd-palette-backdrop' });
    const card = el('div', {
      class: 'cd-palette',
      role: 'dialog',
      'aria-label': 'Command palette',
    });

    // Input row — leading search glyph, the field, a trailing `esc` chip.
    const input = el('input', {
      class: 'cd-palette-input',
      type: 'text',
      autocomplete: 'off',
      placeholder: 'Search apps, chats, templates — or describe a new one…',
    }) as HTMLInputElement;
    const inputRow = el('div', { class: 'cd-palette-inputrow' }, [
      el('span', { class: 'cd-palette-search-icon', trustedHtml: Icon.Search({ size: 16 }) }),
      input,
      el('span', { class: 'cd-palette-esc' }, 'esc'),
    ]);
    const resultsEl = el('div', { class: 'cd-palette-results' });

    // Footer hint bar — navigate / open / open-in-new-window / esc close.
    const kbd = (k: string): HTMLElement => el('span', { class: 'cd-palette-kbd' }, k);
    const footer = el('div', { class: 'cd-palette-footer' }, [
      kbd('↑↓'),
      el('span', {}, 'navigate'),
      kbd('↵'),
      el('span', {}, 'open'),
      kbd('⌘↵'),
      el('span', {}, 'open in new window'),
      el('span', { class: 'cd-palette-footer-sp' }),
      kbd('esc'),
      el('span', {}, 'close'),
    ]);
    card.append(inputRow, resultsEl, footer);
    backdrop.append(card);
    document.body.append(backdrop);

    let templates: TemplateEntry[] = [];
    void loadAvailableTemplates().then((t) => {
      templates = t;
      render();
    });

    const settingsLabels = [
      'Appearance',
      'Layout',
      'Workspace',
      'AI providers',
      'Inference endpoint',
      'Where apps run',
      'Sync & backups',
    ];

    let rows: PaletteRow[] = [];
    let active = 0;

    const settingsSubs: Record<string, string> = {
      Appearance: 'Theme, accent, app tiles',
      Layout: 'Density, cards, sidebar',
      Workspace: 'Sidebar, chat model',
      'AI providers': 'Codex · Claude Code · custom endpoint',
      'Inference endpoint': 'Route Codex through any OpenAI endpoint',
      'Where apps run': 'Local or remote runtime',
      'Sync & backups': 'Cross-device sync and snapshots',
    };

    const collectGroups = (q: string): Array<{ group: string; items: PaletteRow[] }> => {
      const lc = q.toLowerCase();
      const groups: Array<{ group: string; items: PaletteRow[] }> = [];

      // ── Build — describe-a-new-app primary action + template browse.
      groups.push({
        group: 'Build',
        items: [
          {
            label: q ? `Build ${q}` : 'Build a new app',
            sub: q
              ? 'Start a new app with this prompt'
              : 'Describe an app and let the agent build it',
            icon: Icon.Sparkle({ size: 14 }),
            variant: 'action',
            accent: true,
            kbd: '↵',
            run: () => {
              closeCommandPalette();
              if (q) enterBuilder({ initialPrompt: q });
              else openNewAppSheet();
            },
          },
          {
            label: q
              ? `Browse templates · matching “${q}”`
              : 'Browse templates · habit, journal, counter',
            sub: templates.length
              ? `${templates.length} curated templates`
              : 'Curated starting points',
            icon: Icon.Compass({ size: 14 }),
            variant: 'action',
            run: () => {
              closeCommandPalette();
              renderDiscover();
            },
          },
        ],
      });

      // ── Apps — gradient app tiles. Matching apps, or recents pre-query.
      const allApps = [...getApps(), ...drafts];
      const recents = recentApps();
      const appMatches = (
        q
          ? allApps.filter((a) => a.name.toLowerCase().includes(lc))
          : recents.length
            ? recents
            : allApps
      ).slice(0, 6);
      if (appMatches.length > 0) {
        groups.push({
          group: `Apps · ${appMatches.length}`,
          items: appMatches.map((a) => {
            const ua = !isDraft(a) ? findUserApp(a.id) : undefined;
            return {
              label: a.name,
              sub: a.desc || 'No description yet.',
              icon: '',
              variant: 'app' as const,
              app: a,
              meta: isDraft(a) ? 'draft' : relativeTime(ua?.updatedAt),
              run: () => {
                closeCommandPalette();
                if (isDraft(a)) enterBuilder({ appContext: a });
                else openApp(a.id);
              },
            };
          }),
        });
      }

      // ── Chats — recent builder conversations, one per app. The shell has
      // no separate chat store, so each app's build conversation is the
      // chat; opening a row drops you back into that app's builder.
      const chatApps = (q ? appMatches : recents.length ? recents : allApps).slice(0, 3);
      if (chatApps.length > 0) {
        groups.push({
          group: `Chats · ${chatApps.length}`,
          items: chatApps.map((a) => {
            const ua = !isDraft(a) ? findUserApp(a.id) : undefined;
            return {
              label: `Continue building ${a.name}`,
              sub: `${a.name} · ${isDraft(a) ? 'draft' : relativeTime(ua?.updatedAt)}`,
              icon: Icon.Sparkle({ size: 13 }),
              variant: 'chat' as const,
              run: () => {
                closeCommandPalette();
                enterBuilder({ appContext: a });
              },
            };
          }),
        });
      }

      // ── Settings — the seven inner pages, each with a one-line blurb.
      const setMatches = settingsLabels.filter((s) => !q || s.toLowerCase().includes(lc));
      if (setMatches.length > 0) {
        groups.push({
          group: 'Settings',
          items: setMatches.map((s) => ({
            label: s,
            sub: settingsSubs[s] ?? 'Settings',
            icon: Icon.Settings({ size: 14 }),
            variant: 'action' as const,
            run: () => {
              closeCommandPalette();
              renderSettings();
            },
          })),
        });
      }
      return groups;
    };

    const highlight = (): void => {
      const rowEls = resultsEl.querySelectorAll<HTMLElement>('.cd-palette-row');
      let i = 0;
      for (const r of rowEls) {
        r.dataset.active = String(i === active);
        if (i === active) r.scrollIntoView({ block: 'nearest' });
        i += 1;
      }
    };

    const render = (): void => {
      const q = input.value.trim();
      rows = [];
      resultsEl.replaceChildren();
      for (const g of collectGroups(q)) {
        resultsEl.append(el('div', { class: 'cd-palette-group' }, g.group));
        for (const item of g.items) {
          rows.push(item);

          // Leading visual — gradient app tile, accent action chip, or a
          // plain bordered glyph chip (chat / non-accent action).
          let lead: HTMLElement;
          if (item.variant === 'app' && item.app) {
            lead = el('div', { class: 'cd-palette-row-tile' });
            const finish = window.CentraidTokens.tileFinish(item.app.color, 'gradient');
            lead.style.background = finish.background;
            lead.style.color = finish.glyphColor;
            if (finish.boxShadow) lead.style.boxShadow = finish.boxShadow;
            lead.innerHTML = Icon[item.app.iconKey]
              ? Icon[item.app.iconKey]({ size: 14, strokeWidth: 1.85 })
              : Icon.Sparkle({ size: 14 });
          } else {
            lead = el('span', {
              class: 'cd-palette-row-icon',
              'data-accent': item.accent ? 'true' : undefined,
              trustedHtml: item.icon,
            });
            if (item.tint && !item.accent) lead.style.color = item.tint;
          }

          const txt = el('div', { class: 'cd-palette-row-text' }, [
            el('div', { class: 'cd-palette-row-label' }, item.label),
          ]);
          if (item.sub) txt.append(el('div', { class: 'cd-palette-row-sub' }, item.sub));

          const rowChildren: HTMLElement[] = [lead, txt];
          if (item.kbd) {
            rowChildren.push(el('span', { class: 'cd-palette-row-kbd' }, item.kbd));
          } else if (item.meta) {
            rowChildren.push(el('span', { class: 'cd-palette-row-meta' }, item.meta));
          }

          resultsEl.append(
            el(
              'button',
              {
                class: 'cd-palette-row',
                'data-variant': item.variant ?? 'action',
                type: 'button',
                onClick: () => item.run(),
              },
              rowChildren,
            ),
          );
        }
      }
      if (active >= rows.length) active = Math.max(0, rows.length - 1);
      highlight();
    };

    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if (k.key === 'Escape') {
        k.preventDefault();
        closeCommandPalette();
      } else if (k.key === 'ArrowDown') {
        k.preventDefault();
        active = Math.min(rows.length - 1, active + 1);
        highlight();
      } else if (k.key === 'ArrowUp') {
        k.preventDefault();
        active = Math.max(0, active - 1);
        highlight();
      } else if (k.key === 'Enter') {
        // ⌘↵ is the "open in new window" affordance from the footer hint
        // bar; the shell is single-window today, so it runs the active row.
        k.preventDefault();
        rows[active]?.run();
      }
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeCommandPalette();
    });

    paletteCleanup = (): void => {
      backdrop.remove();
    };

    render();
    input.focus();
  }

  function statusPillEl(tone: 'new' | 'draft' | 'live', label: string): HTMLElement {
    return el('span', { class: 'cd-status', 'data-tone': tone }, [
      el('span', { class: 'cd-status-dot' }),
      label,
    ]);
  }

  // §A3 — RefinedAppTile: gradient icon tile with a status dot, a
  // hover-revealed star, a 2-line blurb, and a state-aware bottom strip
  // (NEW for <24h, DRAFT, else last-opened).
  function renderAppCard(app: AppMetaResolvedType, small = false): HTMLElement {
    const draft = isDraft(app);

    // Wrap is the grid item; the card is the clickable surface. The `•••`
    // action rides as a wrap sibling so we don't nest a button in a button.
    const wrap = el('div', { class: 'cd-app-card-wrap', 'data-app-id': app.id });
    const card = el('button', {
      class: small ? 'cd-app-card cd-app-card--small' : 'cd-app-card',
      type: 'button',
      onClick: () => (draft ? enterBuilder({ appContext: app }) : openApp(app.id)),
      onContextmenu: (e: Event) => {
        e.preventDefault();
        const me = e as MouseEvent;
        openContextMenu(app, { kind: 'point', x: me.clientX, y: me.clientY });
      },
    });

    const ua = !draft ? findUserApp(app.id) : undefined;
    const isNew = !draft && isRecentlyCreated(ua?.createdAt);
    const tone: 'new' | 'draft' | null = draft ? 'draft' : isNew ? 'new' : null;

    const iconEl = el('div', {
      class: 'cd-app-card-icon',
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 18, strokeWidth: 1.85 }) : '',
    });
    const finish = window.CentraidTokens.tileFinish(app.color, prefs.tileVariant);
    iconEl.style.background = finish.background;
    iconEl.style.color = finish.glyphColor;
    if (finish.boxShadow) iconEl.style.boxShadow = finish.boxShadow;
    if (tone) {
      iconEl.append(el('span', { class: 'cd-app-card-icon-dot', 'data-tone': tone }));
    }

    // Hover-revealed star — toggles starred state without opening the app.
    const star = el('button', {
      class: 'cd-app-card-star',
      type: 'button',
      'aria-label': isStarred(app.id) ? 'Unstar app' : 'Star app',
      'data-on': isStarred(app.id) ? 'true' : undefined,
      trustedHtml: Icon.Star ? Icon.Star({ size: 14 }) : '',
      onClick: (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        toggleStar(app.id);
        renderHome();
      },
    });

    card.append(el('div', { class: 'cd-app-card-top' }, [iconEl, star]));
    card.append(el('div', { class: 'cd-app-card-name' }, app.name));
    card.append(el('div', { class: 'cd-app-card-desc' }, app.desc || 'No description yet.'));

    // State-aware bottom strip — status label + "·" + timestamp.
    const foot = el('div', { class: 'cd-app-card-foot' });
    if (tone) foot.append(statusPillEl(tone, tone));
    const stamp = draft ? 'saved' : relativeTime(ua?.updatedAt);
    if (tone) foot.append(el('span', { class: 'cd-app-card-foot-sep' }, '·'));
    foot.append(el('span', { class: 'cd-app-card-foot-time' }, stamp));
    card.append(foot);
    wrap.append(card);

    wrap.append(
      buildMoreButton('App actions', (rect) => openContextMenu(app, { kind: 'rect', rect })),
    );
    return wrap;
  }

  // Discover-page template card. Shares the exact RefinedAppTile vocabulary
  // and uniform-height grid as the Home shelf — `buildShelfTile` is the one
  // card builder, so Discover and the shelf's Templates tab stay in lockstep.
  // Click opens a preview rather than cloning straight away — keeps a
  // single-tap from becoming a surprise side effect on disk; the "Use this
  // template" button in the preview commits the clone.
  function renderTemplateCard(tmpl: TemplateEntry): HTMLElement {
    const color = (window.ICON_PALETTE as Record<string, string>)[tmpl.colorKey] || '#7C5BD9';
    return buildShelfTile({
      name: tmpl.name,
      desc: tmpl.desc,
      iconKey: tmpl.iconKey,
      color,
      status: 'template',
      onClick: () => openTemplatePreview(tmpl),
      onContextMenu: (me) =>
        openTemplateContextMenu(tmpl, { kind: 'point', x: me.clientX, y: me.clientY }),
      more: {
        label: 'Template actions',
        onOpen: (rect) => openTemplateContextMenu(tmpl, { kind: 'rect', rect }),
      },
    });
  }

  // Hover-revealed `•••` action trigger. Sits as a sibling to the card so we
  // don't nest a button inside a button; CSS reveals it on hover/focus of
  // the parent wrap. Marks itself `data-open` while the menu is mounted so
  // the button stays visible even when the cursor wanders into the menu.
  function buildMoreButton(label: string, onOpen: (rect: DOMRect) => void): HTMLElement {
    const btn = el('button', {
      class: 'cd-card-more',
      type: 'button',
      'aria-label': label,
      'aria-haspopup': 'menu',
      trustedHtml: Icon.MoreHoriz({ size: 16 }),
      onClick: (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        target.dataset.open = 'true';
        onOpen(target.getBoundingClientRect());
      },
    });
    return btn;
  }

  // ---------- Context menu ----------
  let ctxBackdrop: HTMLElement | null = null;
  let ctxMenu: HTMLElement | null = null;
  // Element whose `data-open` flag we cleared on close — typically the
  // hover-revealed `•••` button. Tracked so the button can stay visible
  // while its menu is mounted and gracefully return to hover-only on close.
  let ctxTrigger: HTMLElement | null = null;

  function closeContextMenu(): void {
    if (ctxBackdrop) {
      ctxBackdrop.remove();
    }
    if (ctxMenu) {
      ctxMenu.remove();
    }
    if (ctxTrigger) {
      delete ctxTrigger.dataset.open;
    }
    ctxBackdrop = null;
    ctxMenu = null;
    ctxTrigger = null;
  }

  interface CtxItem {
    id: string;
    label: string;
    icon: IconNameType;
    danger?: boolean;
  }

  // `MenuAnchor` is defined globally in `types.d.ts` so both `app.ts` and
  // `chrome.ts` (separate IIFEs) can hand right-click events to the same
  // openMenu without dragging the type through a window bridge.

  function openMenu(
    items: ReadonlyArray<CtxItem | 'sep'>,
    anchor: MenuAnchor,
    onPick: (id: string) => void,
  ): void {
    closeContextMenu();
    ctxBackdrop = el('div', {
      class: 'ctx-backdrop',
      onClick: closeContextMenu,
      onContextmenu: (e: Event) => {
        e.preventDefault();
        closeContextMenu();
      },
    });
    document.body.append(ctxBackdrop);

    ctxMenu = el('div', { class: 'ctx-menu', role: 'menu' });
    for (const it of items) {
      if (it === 'sep') {
        ctxMenu.append(el('div', { class: 'ctx-sep' }));
        continue;
      }
      const btn = el('button', {
        class: 'ctx-item',
        role: 'menuitem',
        'data-danger': String(!!it.danger),
        onClick: () => {
          const id = it.id;
          closeContextMenu();
          onPick(id);
        },
      });
      btn.innerHTML = `${Icon[it.icon]({ size: 15 })}<span>${it.label}</span>`;
      ctxMenu.append(btn);
    }
    document.body.append(ctxMenu);

    const w = ctxMenu.offsetWidth;
    const h = ctxMenu.offsetHeight;
    let px: number;
    let py: number;
    if (anchor.kind === 'point') {
      px = Math.min(anchor.x, window.innerWidth - w - 8);
      py = Math.min(anchor.y, window.innerHeight - h - 8);
    } else {
      const r = anchor.rect;
      py = r.bottom + 4;
      px = r.left;
      // Flip horizontally if the menu would clip the right edge: align to
      // the trigger's right edge instead of its left.
      if (px + w > window.innerWidth - 8) px = r.right - w;
      // Flip vertically if it would clip the bottom: rise above the trigger.
      if (py + h > window.innerHeight - 8) py = r.top - h - 4;
    }
    ctxMenu.style.left = `${Math.max(8, px)}px`;
    ctxMenu.style.top = `${Math.max(8, py)}px`;
  }

  function openContextMenu(app: AppMetaResolvedType, anchor: MenuAnchor): void {
    captureTrigger();
    // Drafts have no published runtime, so "Open" and "Share" are hidden
    // — only Edit (back to builder) and Delete (rm the project dir) make
    // sense. Published apps additionally get Share.
    const items: (CtxItem | 'sep')[] = isDraft(app)
      ? [
          { icon: 'Sparkle', id: 'update', label: 'Continue editing' },
          { icon: 'Pencil', id: 'rename', label: 'Rename' },
          { icon: 'Folder', id: 'reveal', label: 'Reveal in Finder' },
          'sep',
          { danger: true, icon: 'Trash', id: 'delete', label: 'Delete draft' },
        ]
      : [
          { icon: 'Eye', id: 'open', label: 'Open' },
          { icon: 'Sparkle', id: 'update', label: 'Edit with Centraid' },
          { icon: 'Pencil', id: 'rename', label: 'Rename' },
          { icon: 'Share', id: 'share', label: 'Share' },
          { icon: 'Folder', id: 'reveal', label: 'Reveal in Finder' },
          'sep',
          { danger: true, icon: 'Trash', id: 'delete', label: 'Delete' },
        ];
    openMenu(items, anchor, (id) => handleAction(id, app));
  }

  function openTemplateContextMenu(tmpl: TemplateEntry, anchor: MenuAnchor): void {
    const items: (CtxItem | 'sep')[] = [
      { icon: 'Sparkle', id: 'use', label: 'Use this template' },
      { icon: 'Eye', id: 'preview', label: 'Preview' },
    ];
    openMenu(items, anchor, (id) => {
      if (id === 'use') void cloneTemplate(tmpl);
      else if (id === 'preview') openTemplatePreview(tmpl);
    });
  }

  // The `•••` trigger flips its own `data-open` before calling openMenu so
  // CSS keeps it visible while the menu is mounted (cursor can wander into
  // the menu without retracting the affordance). We pick up that flag here
  // so closeContextMenu can clear it on dismiss. For right-click — no
  // trigger to capture and ctxTrigger stays null; hover CSS still handles
  // visibility for that surface.
  function captureTrigger(): void {
    const btn = document.querySelector<HTMLElement>('.cd-card-more[data-open="true"]');
    if (btn) ctxTrigger = btn;
  }

  function handleAction(id: string, app: AppMetaResolvedType): void {
    if (id === 'open') {
      openApp(app.id);
    } else if (id === 'update') {
      enterBuilder({ appContext: app });
    } else if (id === 'delete') {
      void deleteApp(app);
    } else if (id === 'share') {
      openShareDialog(app);
    } else if (id === 'rename') {
      startInlineRename(app);
    } else if (id === 'reveal') {
      void revealApp(app);
    }
  }

  async function revealApp(app: AppMetaResolvedType): Promise<void> {
    try {
      await window.CentraidApi.openProjectFolder({ id: app.id });
    } catch (err) {
      showToast(`Could not reveal folder: ${String(err)}`);
    }
  }

  /**
   * Flip the app card's name into a contenteditable inline editor (Notion
   * style — no modal). Enter or blur commits via `updateProjectMeta`; Esc
   * cancels. Empty/identical names are treated as no-op cancels. On commit
   * the home re-renders so the meta timestamp and any title-derived state
   * (sidebar, drafts) stay consistent.
   */
  function startInlineRename(app: AppMetaResolvedType): void {
    const wrap = document.querySelector<HTMLElement>(`[data-app-id="${CSS.escape(app.id)}"]`);
    const nameEl = wrap?.querySelector<HTMLElement>('.cd-app-card-name');
    if (!nameEl) return;
    const original = app.name;
    nameEl.setAttribute('contenteditable', 'plaintext-only');
    nameEl.classList.add('cd-app-card-name-editing');

    let done = false;
    const finish = async (commit: boolean): Promise<void> => {
      if (done) return;
      done = true;
      nameEl.removeAttribute('contenteditable');
      nameEl.classList.remove('cd-app-card-name-editing');
      nameEl.removeEventListener('keydown', onKey);
      nameEl.removeEventListener('blur', onBlur);
      nameEl.removeEventListener('click', stop);
      nameEl.removeEventListener('mousedown', stop);
      const nextName = (nameEl.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (!commit || !nextName || nextName === original) {
        nameEl.textContent = original;
        return;
      }
      try {
        await window.CentraidApi.updateProjectMeta({ id: app.id, name: nextName });
        if (!isDraft(app)) {
          syncUserAppMeta({ projectId: app.id, name: nextName });
        }
        showToast(`Renamed to "${nextName}"`);
        renderHome();
      } catch (err) {
        nameEl.textContent = original;
        showToast(`Could not rename: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const onKey = (e: Event): void => {
      const ke = e as KeyboardEvent;
      e.stopPropagation();
      if (ke.key === 'Enter') {
        e.preventDefault();
        void finish(true);
      } else if (ke.key === 'Escape') {
        e.preventDefault();
        void finish(false);
      }
    };
    const onBlur = (): void => void finish(true);
    const stop = (e: Event): void => e.stopPropagation();

    nameEl.addEventListener('keydown', onKey);
    nameEl.addEventListener('blur', onBlur);
    nameEl.addEventListener('click', stop);
    nameEl.addEventListener('mousedown', stop);

    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /**
   * Notion-style template preview. The previous behaviour was to clone on
   * click of the tile, which made every accidental tap leave a draft on
   * disk. The preview shows what the template is and gates cloning behind
   * an explicit "Use this template" button.
   */
  function openTemplatePreview(tmpl: TemplateEntry): void {
    const color = (window.ICON_PALETTE as Record<string, string>)[tmpl.colorKey] || '#7C5BD9';
    const backdrop = el('div', { class: 'modal-backdrop' });
    const card = el('div', {
      class: 'modal-card cd-tmpl-preview',
      role: 'dialog',
      'aria-label': `Preview ${tmpl.name}`,
    });
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }
    const close = (): void => {
      backdrop.remove();
      card.remove();
      document.removeEventListener('keydown', onKey);
    };
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    const closeBtn = el('button', {
      'aria-label': 'Close',
      class: 'btn-icon modal-close',
      trustedHtml: Icon.X({ size: 16 }),
      onClick: close,
    });
    card.append(closeBtn);

    const head = el('div', { class: 'cd-tmpl-preview-head' });
    const iconEl = el('div', {
      class: 'cd-tmpl-preview-icon',
      style: { background: color },
      trustedHtml: Icon[tmpl.iconKey as IconNameType]
        ? Icon[tmpl.iconKey as IconNameType]({ size: 28, strokeWidth: 1.85 })
        : '',
    });
    head.append(iconEl);
    const headText = el('div', { style: { minWidth: '0' } });
    headText.append(el('div', { class: 'cd-tmpl-preview-eyebrow' }, `Template · v${tmpl.version}`));
    headText.append(el('h3', {}, tmpl.name));
    head.append(headText);
    card.append(head);

    card.append(el('p', {}, tmpl.desc));
    card.append(
      el(
        'div',
        { class: 'cd-tmpl-preview-note' },
        'Clones into your projects as a draft. Rename, edit, and publish from there — the original template stays in the catalog.',
      ),
    );

    const cancel = el('button', { class: 'btn btn-ghost', onClick: close }, 'Cancel');
    const useBtn = el('button', {
      class: 'btn btn-primary',
      onClick: () => {
        close();
        void cloneTemplate(tmpl);
      },
    });
    useBtn.innerHTML = Icon.Sparkle({ size: 13 }) + '<span>Use this template</span>';
    card.append(el('div', { class: 'sheet-actions' }, [cancel, useBtn]));

    document.body.append(backdrop);
    document.body.append(card);
    setTimeout(() => useBtn.focus(), 30);
  }

  async function deleteApp(app: AppMetaResolvedType): Promise<void> {
    const draft = isDraft(app);
    const ok = await openConfirm({
      confirmLabel: 'Delete',
      danger: true,
      message: draft
        ? `Delete the draft "${app.name}"? Its project files will be removed from disk.`
        : `Delete "${app.name}"? This removes it from the gateway and wipes its local project files. Data published to the gateway cannot be recovered.`,
      title: draft ? 'Delete draft?' : 'Delete app?',
    });
    if (!ok) return;

    if (draft) {
      try {
        await window.CentraidApi.deleteProject({ id: app.id });
        showToast(`Deleted draft "${app.name}"`);
      } catch (err) {
        showToast(`Could not delete draft: ${String(err)}`);
      }
      renderHome();
      return;
    }

    // Gateway is the source of truth — if deregister fails for anything other
    // than 404 (already gone), keep the tile so the user can retry rather than
    // silently leaking an orphan registration on the gateway.
    const ua = findUserApp(app.id);
    if (ua?.centraidProjectId) {
      try {
        await window.CentraidApi.deregisterApp({ id: ua.centraidProjectId });
      } catch (err) {
        const msg = String(err);
        if (!/404|not_found/i.test(msg)) {
          showToast(`Could not delete "${app.name}" from gateway: ${msg}`);
          return;
        }
      }
    }

    // Disk cleanup is best-effort — the gateway side is already consistent.
    let diskWarn: string | null = null;
    try {
      await window.CentraidApi.deleteProject({ id: app.id });
    } catch (err) {
      diskWarn = String(err);
    }

    userApps = userApps.filter((a) => a.id !== app.id);
    persist();
    renderHome();
    if (diskWarn) {
      showToast(`Removed "${app.name}" — local files may linger: ${diskWarn}`);
    } else {
      showToast(`Removed "${app.name}"`);
    }
  }

  function openConfirm(opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        card.remove();
        resolve(result);
      };

      const backdrop = el('div', { class: 'modal-backdrop', onClick: () => finish(false) });
      const card = el('div', {
        'aria-label': opts.title,
        class: 'modal-card',
        role: 'dialog',
      });
      const closeBtn = el('button', {
        'aria-label': 'Close',
        class: 'btn-icon modal-close',
        trustedHtml: Icon.X({ size: 16 }),
        onClick: () => finish(false),
      });
      const cancelBtn = el(
        'button',
        { class: 'btn btn-ghost', onClick: () => finish(false) },
        'Cancel',
      );
      const confirmBtn = el(
        'button',
        {
          class: opts.danger ? 'btn btn-danger' : 'btn btn-primary',
          onClick: () => finish(true),
        },
        opts.confirmLabel ?? 'Confirm',
      );

      card.append(closeBtn);
      card.append(el('h3', {}, opts.title));
      card.append(el('p', {}, opts.message));
      card.append(el('div', { class: 'sheet-actions' }, [cancelBtn, confirmBtn]));

      function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        }
      }
      document.addEventListener('keydown', onKey);

      document.body.append(backdrop);
      document.body.append(card);
      setTimeout(() => confirmBtn.focus(), 30);
    });
  }

  // ---------- New app flow ----------
  const STARTER_PROMPTS = [
    'A habit tracker',
    'A grocery list',
    'A daily journal',
    'A pomodoro timer',
    'A reading log',
    'A workout counter',
  ];

  function openNewAppSheet(): void {
    let text = '';
    const backdrop = el('div', { class: 'modal-backdrop' });
    const card = el('div', { class: 'modal-card', role: 'dialog', 'aria-label': 'New app' });

    const ta = el('textarea', {
      class: 'input',
      placeholder: 'A simple grocery list, sectioned by aisle…',
    }) as HTMLTextAreaElement;
    const generateBtn = el('button', {
      class: 'btn btn-primary',
      disabled: '',
      onClick: () => {
        if (text.trim()) {
          close();
          enterBuilder({ initialPrompt: text.trim() });
        }
      },
    });
    generateBtn.innerHTML = Icon.Sparkle({ size: 13 }) + '<span>Generate</span>';

    const updateState = (): void => {
      text = ta.value;
      if (text.trim()) {
        generateBtn.removeAttribute('disabled');
      } else {
        generateBtn.setAttribute('disabled', '');
      }
    };
    ta.addEventListener('input', updateState);
    ta.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if (k.key === 'Enter' && (k.metaKey || k.ctrlKey) && text.trim()) {
        k.preventDefault();
        close();
        enterBuilder({ initialPrompt: text.trim() });
      }
      if (k.key === 'Escape') {
        k.preventDefault();
        close();
      }
    });

    const chips = el('div', { class: 'sheet-chips' });
    for (const s of STARTER_PROMPTS) {
      chips.append(
        el(
          'button',
          {
            class: 'chip',
            onClick: () => {
              ta.value = s;
              updateState();
              ta.focus();
            },
          },
          s,
        ),
      );
    }

    const closeBtn = el('button', {
      'aria-label': 'Close',
      class: 'btn-icon modal-close',
      trustedHtml: Icon.X({ size: 16 }),
      onClick: () => close(),
    });
    const cancelBtn = el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancel');

    card.append(closeBtn);
    card.append(el('h3', {}, 'What should we build?'));
    card.append(el('p', {}, 'Describe your app in a sentence or two. You can iterate from there.'));
    card.append(ta);
    card.append(chips);
    card.append(el('div', { class: 'sheet-actions' }, [cancelBtn, generateBtn]));

    backdrop.addEventListener('click', () => {
      if (!ta.value.trim()) close();
    });
    document.body.append(backdrop);
    document.body.append(card);
    setTimeout(() => ta.focus(), 30);

    function close(): void {
      backdrop.remove();
      card.remove();
    }
  }

  // ---------- Templates (inline tiles) ----------
  // Renderer-side mirror of @centraid/app-templates' `TemplateMeta`. We don't
  // import the package here — the IPC layer carries plain JSON.
  interface TemplateEntry {
    id: string;
    name: string;
    desc: string;
    colorKey: string;
    iconKey: string;
    version: string;
  }

  /**
   * Returns the full template gallery. Templates behave like a catalog
   * (Notion-style): cloning never depletes the list, so a template the
   * user has already cloned still shows up and can be cloned again into
   * an independent app. Failures are swallowed — an offline or broken
   * templates IPC just hides the inline strip; the rest of the home keeps
   * rendering.
   */
  async function loadAvailableTemplates(): Promise<TemplateEntry[]> {
    try {
      return (await window.CentraidApi.listTemplates()) as TemplateEntry[];
    } catch {
      return [];
    }
  }

  // Clone a template to disk and drop the user straight into the builder.
  // The new project surfaces as a DRAFT tile on next home render; the user
  // explicitly clicks Publish to upload it to the gateway.
  async function cloneTemplate(tmpl: TemplateEntry): Promise<void> {
    const palette = window.CentraidTokens.palette as unknown as Record<string, ColorHexType>;
    const color: ColorHexType = palette[tmpl.colorKey] ?? ('#5847e0' as ColorHexType);
    try {
      const result = await window.CentraidApi.cloneTemplate({ templateId: tmpl.id });
      const draft: DraftAppMeta = {
        __draft: true,
        color,
        colorKey: tmpl.colorKey as DraftAppMeta['colorKey'],
        desc: result.project.description || tmpl.desc,
        hasIndex: true,
        iconKey: tmpl.iconKey as IconNameType,
        id: result.project.id,
        name: result.template.name,
      };
      enterBuilder({ appContext: draft, focusName: true });
    } catch (err) {
      showToast(`Clone failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function enterBuilder(
    opts: {
      initialPrompt?: string;
      appContext?: AppMetaResolvedType;
      /**
       * One-shot: focus + select the inline title on mount so the user lands
       * in rename mode. Used by the template-clone path; deliberately not
       * persisted into the route so back/forward replays don't re-focus.
       */
      focusName?: boolean;
    } = {},
  ): void {
    const { focusName, ...routeOpts } = opts;
    recordRoute({ kind: 'builder', ...routeOpts });
    clear();
    if (typeof window.openBuilder !== 'function') {
      console.error('Builder not loaded');
      return;
    }
    // If editing an existing user app that was published via centraid, pass the
    // project id so the builder reattaches to that project on disk + gateway.
    // Drafts are unpublished projects whose tile id == project id.
    let projectId: string | undefined;
    if (opts.appContext) {
      if (isDraft(opts.appContext)) {
        projectId = opts.appContext.id;
      } else {
        const ua = findUserApp(opts.appContext.id);
        projectId = ua?.centraidProjectId;
      }
    }
    // Sidebar drafts list — give the builder the same view of WIP projects
    // the home sidebar shows, so users can swap between drafts without
    // having to bounce through Home. `drafts` is the shell's module-level
    // cache (refreshed by `hydrateDrafts()` on home render). It can lag
    // behind reality in two cases worth covering:
    //   - cloneTemplate just minted a fresh DraftAppMeta and called us
    //     directly; the draft isn't in the cache yet.
    //   - cold start / deep-link before the first home render.
    // For (1) we splice in `opts.appContext` if it's a draft and missing
    // from the cache, so the freshly-cloned tile is immediately visible in
    // the builder sidebar without bouncing through Home. (2) still needs a
    // home visit to fully populate, which is acceptable for v1.
    const draftsForSidebar: DraftAppMeta[] =
      opts.appContext &&
      isDraft(opts.appContext) &&
      !drafts.some((d) => d.id === opts.appContext!.id)
        ? [opts.appContext, ...drafts]
        : drafts;
    const builderDrafts: ChromeSidebarApp[] = draftsForSidebar.map((d) => ({
      color: d.color,
      iconKey: d.iconKey,
      id: d.id,
      name: d.name,
      status: 'draft',
    }));
    currentCleanup =
      window.openBuilder({
        root,
        el,
        onExit: renderHome,
        ...routeOpts,
        ...(projectId ? { projectId } : {}),
        ...(focusName ? { focusName: true } : {}),
        ...chromeNav(),
        drafts: builderDrafts,
        onAddToHome: addUserApp,
        onMetaChange: syncUserAppMeta,
      }) ?? null;
  }

  // Mirror builder-side inline title/description edits into the home's
  // userApps store so a published tile reflects the new metadata
  // immediately on return. Drafts come back from disk via hydrateDrafts
  // (reads `app.json#{name,description}`), so we only need to touch
  // userApps here.
  function syncUserAppMeta(input: {
    projectId: string;
    name?: string;
    description?: string;
  }): void {
    const ua = userApps.find(
      (a) => a.centraidProjectId === input.projectId || a.id === input.projectId,
    );
    if (!ua) return;
    if (input.name !== undefined) ua.name = input.name;
    if (input.description !== undefined) ua.desc = input.description || 'Built with Centraid.';
    ua.updatedAt = new Date().toISOString();
    persist();
  }

  // ---------- Add to home ----------
  const ICON_KEYS_POOL: IconNameType[] = [
    'Todo',
    'Habit',
    'Journal',
    'Pomodoro',
    'Plant',
    'Water',
    'Gift',
    'Mood',
  ];

  function inferAppMeta(prompt: string): {
    iconKey: IconNameType;
    color: ColorHexType;
    name: string;
  } {
    const p = prompt.toLowerCase();
    const map: [IconNameType, RegExp][] = [
      ['Todo', /\b(todo|to-do|task|grocery|list|shopping)\b/],
      ['Habit', /\b(habit|streak|daily)\b/],
      ['Journal', /\b(journal|diary|note|writing|log|read|reading)\b/],
      ['Pomodoro', /\b(pomodoro|timer|focus|work\s*block)\b/],
      ['Plant', /\b(plant|water|garden)\b/],
      ['Water', /\b(hydrate|water|cup|drink)\b/],
      ['Gift', /\b(gift|present|idea|wish)\b/],
      ['Mood', /\b(mood|feel|emotion|check[- ]?in)\b/],
    ];
    let iconKey: IconNameType =
      ICON_KEYS_POOL[Math.floor(Math.random() * ICON_KEYS_POOL.length)] ?? 'Todo';
    for (const [k, re] of map) {
      if (re.test(p)) {
        iconKey = k;
        break;
      }
    }
    // Colour is derived from the icon, not random — matches the design's
    // fixture (Todos always indigo, Habits always rose, etc.). If no prompt
    // keywords hit, `iconKey` falls back to a random pool entry; that entry
    // still has a canonical colour via colorForIcon().
    const color = colorForIcon(iconKey);
    const cleaned = prompt.replace(/^\s*(a|an)\s+/i, '').trim();
    const words = cleaned.split(/\s+/).slice(0, 3).join(' ');
    const name = words.charAt(0).toUpperCase() + words.slice(1);
    return { color, iconKey, name: name || 'New app' };
  }

  function addUserApp(input: {
    prompt?: string;
    name?: string;
    projectId?: string;
    versionId?: string;
    color?: ColorHexType;
    iconKey?: IconNameType;
  }): UserAppMeta {
    const meta = inferAppMeta(input.prompt || '');
    // If the builder gave us a centraid project id, the home tile uses it as
    // the app id (so context-menu actions and openApp can address it directly).
    // Older flows without a centraid project still get the legacy `usr_` id.
    const id = input.projectId || 'usr_' + Math.random().toString(36).slice(2, 9);

    const existing = userApps.find((a) => a.id === id);
    if (existing) {
      // Republished — refresh metadata, keep tile in place.
      existing.name = input.name || existing.name;
      existing.desc = input.prompt && input.prompt.length <= 60 ? input.prompt : existing.desc;
      existing.centraidProjectId = input.projectId ?? existing.centraidProjectId;
      existing.updatedAt = new Date().toISOString();
      persist();
      renderHome();
      showToast(`Updated "${existing.name}"`);
      return existing;
    }

    const stampIso = new Date().toISOString();
    const newApp: UserAppMeta = {
      color: input.color || meta.color,
      colorKey: 'violet',
      createdAt: stampIso,
      desc: input.prompt && input.prompt.length <= 60 ? input.prompt : 'Built with Centraid.',
      iconKey: input.iconKey || meta.iconKey,
      id,
      name: input.name || meta.name,
      updatedAt: stampIso,
      ...(input.projectId ? { centraidProjectId: input.projectId } : {}),
    };
    userApps.push(newApp);
    persist();
    renderHome();
    showToast(`Added "${newApp.name}" to home`);
    return newApp;
  }

  // ---------- App view router ----------
  function openApp(id: string): void {
    const app = findApp(id);
    if (!app) {
      return;
    }
    recordRecent(id);
    // A draft with no built index.html has nothing to serve — route to the
    // builder so the click still does something. Drafts that *have* a build
    // mount in the app view just like published apps (their tile id is the
    // project id — see `enterBuilder`'s projectId note).
    if (isDraft(app) && !app.hasIndex) {
      enterBuilder({ appContext: app });
      return;
    }
    recordRoute({ id, kind: 'app' });
    // Published apps carry their project id on the UserAppMeta; drafts use
    // their tile id directly (tile id == project id for unpublished apps).
    const ua = findUserApp(id);
    const projectId = ua?.centraidProjectId ?? (isDraft(app) ? app.id : undefined);
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
      onClick: () => toggleAppSettings(app, gearBtn, view, projectId),
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
        onClick: () => enterBuilder({ appContext: app }),
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
      onNewChat: openNewAppSheet,
      onToggleSidebar: toggleSidebar,
      showNewChat: true,
      sidebar,
      sidebarOpen: prefs.sidebarOpen,
      titlebarLead: brandChip,
      titlebarRight,
    });
    currentSetSidebarOpen = setSidebarOpen;
    root.append(shell);

    try {
      mountUserApp(app, projectId, inner);
      // Per-app agentic chat: only wire it up for centraid-backed apps,
      // since the agent reads the app's data.sqlite via the gateway.
      if (projectId) {
        currentCleanup = window.AppChat.mount({
          view,
          app,
          appId: projectId,
          el,
        });
      } else {
        currentCleanup = null;
      }
    } catch (error) {
      console.error('App crashed:', error);
      inner.append(el('div', { class: 'empty' }, `Something went wrong loading ${app.name}.`));
    }
  }

  function mountUserApp(
    app: AppMetaResolvedType,
    projectId: string | undefined,
    container: HTMLElement,
  ): void {
    if (projectId) {
      // Real centraid app — host its iframe served by the openclaw plugin.
      // The frame fills the main pane edge-to-edge; the app supplies its
      // own header and chrome.
      container.classList.add('app-view-fullbleed');
      const frameWrap = el('div', { class: 'app-view-frame' });
      const frame = el('iframe', {
        src: 'about:blank',
        sandbox: 'allow-scripts allow-forms allow-same-origin',
        referrerpolicy: 'no-referrer',
      }) as HTMLIFrameElement;
      // Tag so applyPrefs() can find every running app iframe and
      // postMessage the latest theme on slider/toggle changes.
      frame.dataset.centraidApp = '1';
      frame.addEventListener('load', () => {
        try {
          frame.contentWindow?.postMessage(
            { type: 'centraid:theme', theme: prefs.theme, bgL: prefs.bgL },
            '*',
          );
        } catch {
          /* noop */
        }
      });
      frameWrap.append(frame);
      container.append(frameWrap);

      // Resolve the live URL and load it. We carry the global theme in
      // BOTH the query string (so the runtime's settings injection bakes
      // `data-theme` / `--bg-l` into the served `index.html` server-side)
      // AND the hash (read by the inline live-settings bridge before paint,
      // covering the builder-preview path that bypasses the runtime).
      // Theme is intentionally global — every mini app inherits the
      // Centraid shell theme so the workspace stays visually coherent.
      void window.CentraidApi.appLiveUrl({ id: projectId })
        .then((r) => {
          const qsep = r.url.includes('?') ? '&' : '?';
          const themeQs = `theme=${prefs.theme}&bgL=${prefs.bgL}`;
          frame.src = `${r.url}${qsep}${themeQs}#${themeQs}`;
        })
        .catch(() => {
          frameWrap.innerHTML =
            '<div class="empty">Could not reach the gateway. Check Settings.</div>';
        });
      return;
    }

    // Legacy `usr_` apps — no centraid backing yet, keep the placeholder.
    const stub = el('div', { style: { marginTop: '20px' } }, [
      el('div', { class: 'home-section-title', style: { margin: '0 0 12px' } }, 'Mock preview'),
      el('div', { class: 'card' }, [
        el('div', { style: { alignItems: 'center', display: 'flex', gap: '12px' } }, [
          el('div', {
            trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 18 }) : '',
            style: {
              background: app.color,
              borderRadius: '6px',
              color: 'white',
              display: 'grid',
              height: '32px',
              placeItems: 'center',
              width: '32px',
            },
          }),
          el('div', { class: 'flex-1' }, [
            el('div', { style: { fontSize: '14px', fontWeight: '500' } }, 'This is a mocked app'),
            el(
              'div',
              { style: { color: 'var(--ink-3)', fontSize: '12px', marginTop: '2px' } },
              'No centraid project linked. Open the builder to scaffold one.',
            ),
          ]),
        ]),
        el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px' } }, [
          el('button', {
            class: 'btn btn-primary',
            trustedHtml: Icon.Sparkle({ size: 13 }) + '<span>Edit with Centraid</span>',
            onClick: () => enterBuilder({ appContext: app }),
          }),
          el('button', {
            class: 'btn btn-ghost',
            trustedHtml: Icon.Trash({ size: 14 }) + '<span>Delete</span>',
            onClick: () => void deleteApp(app),
          }),
        ]),
      ]),
    ]);
    container.append(stub);
  }

  // ---------- Per-app settings popover ----------
  // Notion-style customization surface anchored to the gear button in the
  // app-view titlebar.
  //
  // Theme / accent / density stay GLOBAL — baked into the iframe URL so
  // every mini-app inherits the Centraid shell theme and the workspace
  // reads as one product. True per-app *aesthetics* (font, page width,
  // corner radius, etc.) live here. Each template declares its knobs in
  // `<template>/app-knobs.json` (see `packages/app-templates`); the
  // scaffolder copies that file into the cloned project; the runtime
  // serves it as a static file. We fetch the cloned copy at panel-open
  // so the controls match the app's CSS, not whatever the bundled
  // template might have evolved to since the clone.
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

  // SQLite single-quote escape. Values come from a closed set
  // (knob.value strings declared by the template) — we still escape
  // defensively so a template author can introduce arbitrary value
  // strings without rethinking the write path.
  function sqlString(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
  }

  async function ensureAppSettingsTable(appId: string): Promise<void> {
    await window.CentraidApi.appQuery({
      id: appId,
      sql: 'CREATE TABLE IF NOT EXISTS __centraid_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    });
  }

  async function fetchAppKnobValues(appId: string): Promise<Record<string, string>> {
    try {
      await ensureAppSettingsTable(appId);
      const result = await window.CentraidApi.appQuery({
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
    await window.CentraidApi.appQuery({ id: appId, sql });
  }

  // Settings key (camelCase, e.g. `appFont`) → kebab name shared by the
  // data-attr and CSS-var paths. Mirrors `camelTailToKebab` in
  // `runtime-core/src/settings-merge.ts` so the live update lands on the
  // same target the runtime will bake on next reload.
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

  async function fetchAppKnobsManifest(appId: string): Promise<AppKnobsManifest | null> {
    try {
      const live = await window.CentraidApi.appLiveUrl({ id: appId });
      // `appLiveUrl` returns `${gateway}/centraid/<id>/`. The manifest is a
      // static sibling of `index.html` inside the same project.
      const url = `${live.url.replace(/\/?$/, '/')}app-knobs.json`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const parsed = (await res.json()) as AppKnobsManifest;
      if (!parsed || !Array.isArray(parsed.knobs)) return null;
      return parsed;
    } catch {
      return null;
    }
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

    // §E1 — tabbed popover: Appearance · Automations · Manage. Each tab
    // does one job instead of one flat stack.
    type AppSettingsTab = 'appearance' | 'automations' | 'manage';
    const panes: Record<AppSettingsTab, HTMLElement> = {
      appearance: el('div', { class: 'cd-app-settings-pane' }),
      automations: el('div', { class: 'cd-app-settings-pane' }),
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
      manage:
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4l-5.6 5.6a2 2 0 1 0 2.8 2.8l5.6-5.6a4 4 0 0 1 5.4-5.4l-3 3-2.2-2.2 3-3z"/></svg>',
    };
    for (const [id, label] of [
      ['appearance', 'Appearance'],
      ['automations', 'Automations'],
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
      if (id === 'automations') {
        btn.append(el('span', { class: 'cd-app-settings-tab-badge', hidden: '' }, '0'));
      }
      tabButtons.set(id, btn);
      tabBar.append(btn);
    }
    panel.append(tabBarWrap);
    panel.append(panes.appearance, panes.automations, panes.manage);

    // Appearance — per-app knobs (font / width / corners / App color).
    // Only meaningful for centraid-backed apps; an empty host fills in
    // when the manifest + current values resolve.
    let prefsHost: HTMLElement | null = el('div', { class: 'cd-app-settings-section-host' });
    prefsHost.append(
      el('div', { class: 'cd-app-settings-note' }, 'No appearance options for this app.'),
    );
    panes.appearance.append(prefsHost);
    if (appId) {
      void Promise.all([fetchAppKnobsManifest(appId), fetchAppKnobValues(appId)]).then(
        ([manifest, stored]) => {
          if (!prefsHost || !document.contains(panel)) return;
          if (!manifest || manifest.knobs.length === 0) return;
          prefsHost.replaceChildren(renderKnobsSection(manifest.knobs, stored, view, appId, panel));
        },
      );
    }

    // Automations (issue #70) — end-user surface for cron-scheduled
    // actions the builder agent scaffolded. Same lazy pattern.
    const automationsHost = el('div', { class: 'cd-app-settings-section-host' });
    automationsHost.append(
      el('div', { class: 'cd-app-settings-note' }, 'No automations for this app yet.'),
    );
    panes.automations.append(automationsHost);
    if (appId) {
      void window.CentraidApi.listAutomations({ appId }).then((rows) => {
        if (!document.contains(panel)) return;
        if (rows.length === 0) return;
        const badge = tabButtons.get('automations')?.querySelector('.cd-app-settings-tab-badge');
        if (badge instanceof HTMLElement) {
          badge.textContent = String(rows.length);
          badge.hidden = false;
        }
        automationsHost.replaceChildren(renderAutomationsSection(rows, appId, panel));
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
            renderAutomations();
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
        openShareDialog(app);
      }),
      appSettingsMenuItem('Folder', 'Reveal in Finder', 'Open the project folder', () => {
        closeAppSettings();
        void revealApp(app);
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
        'Removes the project, its data, and its scheduled automations.',
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
      void deleteApp(app);
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

  // Per-automation run state, keyed by `${appId}:${name}`. Survives
  // multiple opens/closes of the popover so a user who closes during a
  // run sees the result chip on next open.
  const automationRunState = new Map<
    string,
    | { kind: 'running' }
    | { kind: 'done'; ok: boolean; durationMs: number; error?: string; finishedAt: number }
  >();
  const automationKey = (appId: string, name: string): string => `${appId}:${name}`;

  /**
   * Translate a 5-field cron expression into a small-caps display
   * string. Covers the patterns the builder agent actually emits
   * (`0 20 * * 0`, `0 17 * * 1-5`, `*[asterisk-slash]N * * * *`, …);
   * unrecognized expressions fall back to the raw text so the
   * end-user at least sees something stable.
   *
   * Time zone is the user's local — the cron expression runs in UTC
   * server-side, but for the in-app surface we show what they'll
   * actually feel.
   */
  function cronToHuman(expr: string): string {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return expr;
    const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];

    const fmtTime = (h: number, m: number): string => {
      const date = new Date();
      date.setHours(h, m, 0, 0);
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    };

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Every N minutes
    const stepMin = min.match(/^\*\/(\d+)$/);
    if (stepMin && hour === '*' && dom === '*' && month === '*' && dow === '*') {
      const n = Number(stepMin[1]);
      return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    }

    // Hourly on the dot
    if (min === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
      return 'Hourly';
    }

    const minNum = Number(min);
    const hourNum = Number(hour);
    const isExactTime = !Number.isNaN(minNum) && !Number.isNaN(hourNum);

    if (isExactTime && dom === '*' && month === '*') {
      const time = fmtTime(hourNum, minNum);
      if (dow === '*') return `Daily at ${time}`;
      if (dow === '1-5') return `Weekdays at ${time}`;
      if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
      const single = Number(dow);
      if (!Number.isNaN(single) && single >= 0 && single <= 6) {
        return `${dayNames[single]}s at ${time}`;
      }
    }

    return expr;
  }

  function renderAutomationsSection(
    rows: CentraidAutomationRow[],
    appId: string,
    panel: HTMLElement,
  ): HTMLElement {
    const section = el('div', { class: 'cd-app-settings-section cd-app-orders' });
    section.append(
      el('div', { class: 'cd-app-settings-section-label cd-app-orders-label' }, 'Standing orders'),
    );

    const list = el('div', { class: 'cd-app-orders-list' });
    for (const row of rows) {
      list.append(renderStandingOrder(row, appId, panel));
    }
    section.append(list);
    return section;
  }

  function renderStandingOrder(
    row: CentraidAutomationRow,
    appId: string,
    panel: HTMLElement,
  ): HTMLElement {
    const card = el('article', {
      class: 'cd-app-order',
      'data-enabled': String(row.enabled),
    });

    // Left rail — thin colored bar. Accent when on, neutral when off.
    // Decorative only; the toggle is the keyboard target.
    card.append(el('span', { class: 'cd-app-order-rail', 'aria-hidden': 'true' }));

    const body = el('div', { class: 'cd-app-order-body' });

    // Header line: schedule (display) · run-now affordance.
    const head = el('div', { class: 'cd-app-order-head' });
    const schedule = el('span', { class: 'cd-app-order-schedule' }, cronToHuman(row.cronExpr));
    head.append(schedule);

    const stateKey = automationKey(appId, row.name);
    const runBtn = el('button', {
      class: 'cd-app-order-run',
      type: 'button',
      onClick: () => void onRunStandingOrder(row, appId, panel),
    }) as HTMLButtonElement;
    const runState = automationRunState.get(stateKey);
    runBtn.disabled = runState?.kind === 'running';
    runBtn.textContent = runState?.kind === 'running' ? 'Running…' : 'Run now';
    head.append(runBtn);
    body.append(head);

    // The user's NL prompt, treated as a quoted instruction. No quote
    // marks — the left rule + italic carry the gesture.
    const promptEl = el('blockquote', { class: 'cd-app-order-prompt' });
    promptEl.textContent = row.prompt;
    body.append(promptEl);

    // Foot: handler reference + result chip when present.
    const foot = el('div', { class: 'cd-app-order-foot' });
    foot.append(el('span', { class: 'cd-app-order-handler' }, row.manifest.action));

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
        void loadRunsInto(appId, row.name, runsHost);
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
      void onToggleStandingOrder(row, appId, input, card, panel);
    });
    toggle.append(input);
    toggle.append(el('span', { class: 'cd-app-order-toggle-track', 'aria-hidden': 'true' }));
    card.append(toggle);

    return card;
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return secs ? `${mins}m ${secs}s` : `${mins}m`;
  }

  async function onToggleStandingOrder(
    row: CentraidAutomationRow,
    appId: string,
    input: HTMLInputElement,
    card: HTMLElement,
    panel: HTMLElement,
  ): Promise<void> {
    const next = input.checked;
    card.dataset.enabled = String(next);
    try {
      await window.CentraidApi.setAutomationEnabled({ appId, name: row.name, enabled: next });
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

  async function onRunStandingOrder(
    row: CentraidAutomationRow,
    appId: string,
    panel: HTMLElement,
  ): Promise<void> {
    const stateKey = automationKey(appId, row.name);
    automationRunState.set(stateKey, { kind: 'running' });
    // Repaint just this card so the rest of the panel doesn't blink.
    rerenderOrderCard(row, appId, panel);
    try {
      const result = await window.CentraidApi.runAutomationNow({ appId, name: row.name });
      automationRunState.set(stateKey, {
        kind: 'done',
        ok: result.ok,
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
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
    rerenderOrderCard(row, appId, panel);
  }

  // Issue #80 — render the per-automation runs panel inline below the
  // standing-order card. The host element is created hidden in
  // renderStandingOrder; this function lazy-loads on first open and
  // caches via the `data-loaded` flag so re-toggling doesn't refetch.
  async function loadRunsInto(appId: string, name: string, host: HTMLElement): Promise<void> {
    host.dataset.loaded = 'true';
    host.replaceChildren(el('div', { class: 'cd-app-runs-empty' }, 'Loading…'));
    let runs: CentraidAutomationRunRecord[];
    try {
      runs = await window.CentraidApi.listAutomationRuns({ appId, name });
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
    // When a run is pinned, surface a one-click "replay it" affordance —
    // the replayed fire serves recorded tool/agent output, no live calls.
    if (runs.some((r) => r.pinned)) {
      const bar = el('div', { class: 'cd-app-runs-bar' });
      const replayBtn = el('button', {
        type: 'button',
        class: 'cd-app-runs-replay',
      }) as HTMLButtonElement;
      replayBtn.textContent = 'Replay pinned run';
      replayBtn.title = `Re-run "${name}" against the pinned run's recorded outputs (no live tool calls)`;
      replayBtn.addEventListener('click', () => void onReplayPinned(appId, name, host, replayBtn));
      bar.append(
        el('span', { class: 'cd-app-runs-bar-note' }, 'A run is pinned as a replay fixture.'),
        replayBtn,
      );
      wrap.append(bar);
    }
    const list = el('div', { class: 'cd-app-runs-list' });
    for (const run of runs) list.append(renderRunRow(appId, name, run, host));
    wrap.append(list);
    host.replaceChildren(wrap);
  }

  async function onReplayPinned(
    appId: string,
    name: string,
    host: HTMLElement,
    btn: HTMLButtonElement,
  ): Promise<void> {
    btn.disabled = true;
    btn.textContent = 'Replaying…';
    try {
      const result = await window.CentraidApi.runAutomationNow({ appId, name, replay: true });
      if (!result.ok) showToast(`Replay finished with an error: ${result.error ?? 'unknown'}`);
    } catch (err) {
      showToast(`Replay failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    delete host.dataset.loaded;
    void loadRunsInto(appId, name, host);
  }

  async function onTogglePin(
    appId: string,
    name: string,
    run: CentraidAutomationRunRecord,
    host: HTMLElement,
  ): Promise<void> {
    try {
      await window.CentraidApi.pinAutomationRun({ appId, runId: run.runId, pinned: !run.pinned });
    } catch (err) {
      showToast(`Could not update pin: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    delete host.dataset.loaded;
    void loadRunsInto(appId, name, host);
  }

  function renderRunRow(
    appId: string,
    name: string,
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
        void loadNodesInto(appId, run.runId, nodesHost);
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
      : 'Pin this run as a replay fixture for builder iteration';
    pinBtn.addEventListener('click', () => void onTogglePin(appId, name, run, host));
    actions.append(pinBtn);
    card.append(head, actions, nodesHost);
    return card;
  }

  async function loadNodesInto(appId: string, runId: string, host: HTMLElement): Promise<void> {
    host.dataset.loaded = 'true';
    host.replaceChildren(el('div', { class: 'cd-app-runs-empty' }, 'Loading nodes…'));
    let nodes: CentraidAutomationRunNode[];
    try {
      nodes = await window.CentraidApi.listAutomationRunNodes({ appId, runId });
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
    host.replaceChildren(renderNodeTimeline(appId, nodes, 0));
  }

  // Issue #80 follow-up — render the run as a DAG rather than a flat
  // list: nodes that share a `batchId` (a `Promise.all` frontier) sit in
  // one parallel lane; `ctx.invoke` nodes expand to their child run's
  // own nested timeline.
  function renderNodeTimeline(
    appId: string,
    nodes: CentraidAutomationRunNode[],
    depth: number,
  ): HTMLElement {
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
          for (const g of group) laneNodes.append(renderNodeCard(appId, g, depth));
          lane.append(laneNodes);
          wrap.append(lane);
          continue;
        }
        wrap.append(renderNodeCard(appId, group[0]!, depth));
        continue;
      }
      wrap.append(renderNodeCard(appId, node, depth));
      i++;
    }
    return wrap;
  }

  function renderNodeCard(
    appId: string,
    node: CentraidAutomationRunNode,
    depth: number,
  ): HTMLElement {
    const wrap = el('div', {
      class: 'cd-app-run-node',
      'data-ok': String(node.ok),
      'data-kind': node.kind,
    });
    const head = el('div', { class: 'cd-app-run-node-head' }, [
      el('span', { class: 'cd-app-run-node-pos' }, `#${node.ordinal}`),
      el('span', { class: 'cd-app-run-node-kind' }, node.kind),
      el('span', { class: 'cd-app-run-node-name' }, node.name),
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
    // ctx.invoke node — nest the child run's own timeline. Cross-app
    // children (`appId/name`) live in another app's audit file, so we
    // can't reach them from here; show a note instead of a dead toggle.
    const childRunId = node.childRunId;
    if (node.kind === 'invoke' && childRunId) {
      if (node.name.includes('/')) {
        wrap.append(
          el(
            'div',
            { class: 'cd-app-run-node-note' },
            'cross-app invoke — child run recorded in the target app',
          ),
        );
      } else if (depth < 4) {
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
            void loadChildNodes(appId, childRunId, childHost, depth);
          }
        });
        wrap.append(toggle, childHost);
      }
    }
    return wrap;
  }

  async function loadChildNodes(
    appId: string,
    runId: string,
    host: HTMLElement,
    depth: number,
  ): Promise<void> {
    host.dataset.loaded = 'true';
    host.replaceChildren(el('div', { class: 'cd-app-runs-empty' }, 'Loading child run…'));
    let nodes: CentraidAutomationRunNode[];
    try {
      nodes = await window.CentraidApi.listAutomationRunNodes({ appId, runId });
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
    host.replaceChildren(renderNodeTimeline(appId, nodes, depth + 1));
  }

  function prettyJson(raw: string): string {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  function rerenderOrderCard(row: CentraidAutomationRow, appId: string, panel: HTMLElement): void {
    if (!document.contains(panel)) return;
    const list = panel.querySelector('.cd-app-orders-list');
    if (!list) return;
    const cards = list.querySelectorAll<HTMLElement>('.cd-app-order');
    // The order matches the listAutomations response — find by name
    // via the run-now button's disabled-state proxy and the handler
    // span. Simpler: replace whichever card carries this name in its
    // aria-label-bearing toggle.
    for (const card of cards) {
      const toggle = card.querySelector<HTMLElement>('.cd-app-order-toggle');
      if (toggle?.getAttribute('aria-label')?.endsWith(row.name)) {
        const next = renderStandingOrder(row, appId, panel);
        card.replaceWith(next);
        return;
      }
    }
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
  // app-knobs.json may want `{ value: "sans", label: "Sans" }` etc.
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
      await window.CentraidApi.updateProjectMeta({ id: app.id, name: next });
      const ua = findUserApp(app.id);
      if (ua) {
        ua.name = next;
        ua.updatedAt = new Date().toISOString();
        Store.set('home.userApps', userApps);
      }
      showToast(`Renamed to "${next}"`);
      openApp(app.id);
    } catch (err) {
      showToast(`Rename failed: ${String(err)}`);
    }
  }

  // ---------- Settings page ----------
  // Rendered as a top-level page in the main panel (sibling of Home /
  // App view / Builder), not a drawer. Four groups:
  //  - Theme / Layout / App tiles: renderer prefs, apply live.
  //  - Gateway: openclaw URL / token / projects dir (main-process prefs,
  //    needs explicit Save).
  function renderSettings(): void {
    void renderSettingsAsync();
  }

  async function renderSettingsAsync(): Promise<void> {
    recordRoute({ kind: 'settings' });
    clear();

    const current = await window.CentraidApi.getSettings().catch(() => ({
      gatewayUrl: 'http://127.0.0.1:18789',
      gatewayToken: '',
      projectsDir: '~/centraid-projects',
      runtimeMode: 'local' as const,
      remoteGatewayUrl: 'http://127.0.0.1:18789',
      remoteGatewayToken: '',
      chatModel: undefined as string | undefined,
    }));

    const main = el('div', { class: 'cd-settings-main' });

    // §C1 — break the Settings monolith into discrete inner-sidebar
    // pages. Each `drawerGroup` appends into its page host instead of
    // one continuous scroll; an inner sidebar (built at the end) swaps
    // which host is visible.
    type SettingsPageId =
      | 'appearance'
      | 'layout'
      | 'workspace'
      | 'providers'
      | 'inference'
      | 'runtime'
      | 'sync';
    const pageHosts: Record<SettingsPageId, HTMLElement> = {
      appearance: el('div', { class: 'cd-settings-page' }),
      layout: el('div', { class: 'cd-settings-page' }),
      workspace: el('div', { class: 'cd-settings-page' }),
      providers: el('div', { class: 'cd-settings-page' }),
      inference: el('div', { class: 'cd-settings-page' }),
      runtime: el('div', { class: 'cd-settings-page' }),
      sync: el('div', { class: 'cd-settings-page' }),
    };

    // ---- Theme group ----
    // The proposal's Mode control offers Auto / Light / Dark. The shell
    // only persists a concrete light|dark theme, so "Auto" is a one-shot
    // that resolves the OS `prefers-color-scheme` and applies it — no new
    // persisted state, persistence semantics stay intact.
    const themeSeg = makeSegmentedLabeled(
      ['auto', 'light', 'dark'],
      { auto: 'Auto', light: 'Light', dark: 'Dark' },
      prefs.theme,
      (v) => {
        const resolved: ThemeName =
          v === 'auto'
            ? window.matchMedia('(prefers-color-scheme: light)').matches
              ? 'light'
              : 'dark'
            : (v as ThemeName);
        setPrefs({ theme: resolved });
      },
    );
    const coolCastSwitch = makeSwitch(prefs.coolBlueCast, (v) => setPrefs({ coolBlueCast: v }));
    const accentSwatches = makeSwatches(prefs.accent, (v) => setPrefs({ accent: v }));

    // ---- Layout group ----
    const densitySeg = makeSegmented<Density>(['compact', 'regular', 'comfy'], prefs.density, (v) =>
      setPrefs({ density: v }),
    );
    const cardsSeg = makeSegmented<CardVariant>(
      ['flat', 'outlined', 'elevated'],
      prefs.cardVariant,
      (v) => setPrefs({ cardVariant: v }),
    );
    const sidebarSwitch = makeSwitch(prefs.sidebarOpen, (v) => {
      setPrefs({ sidebarOpen: v });
      if (currentSetSidebarOpen) currentSetSidebarOpen(v);
    });

    // ---- App tiles group ----
    const tileSeg = makeSegmented<TileVariant>(
      ['solid', 'gradient', 'glassy', 'flat'],
      prefs.tileVariant,
      (v) => {
        setPrefs({ tileVariant: v });
      },
    );

    // §C2 — live-preview tile. A 4-up grid of representative app tiles
    // (icon + name) that re-renders on every appearance change so the
    // user sees the theme / accent / tile-variant land on real tiles.
    const previewHost = el('div', { class: 'ap-preview-host' });
    const renderAppearancePreview = (): void => {
      const seeds: ReadonlyArray<{ color: string; icon: IconNameType; name: string }> = [
        { color: '#4E68DD', icon: 'Todo', name: 'Tasks' },
        { color: '#7C5BD9', icon: 'Journal', name: 'Journal' },
        { color: '#E55772', icon: 'Pencil', name: 'Notes' },
        { color: '#2EA098', icon: 'Habit', name: 'Weekly' },
      ];
      const tiles = seeds.map((s) => {
        const finish = window.CentraidTokens.tileFinish(s.color, prefs.tileVariant);
        const icon = el('div', {
          class: 'ap-preview-tile-icon',
          trustedHtml: Icon[s.icon]
            ? Icon[s.icon]({ size: 18, strokeWidth: 1.85 })
            : Icon.Folder({ size: 18 }),
        });
        icon.style.background = finish.background;
        icon.style.color = finish.glyphColor;
        if (finish.boxShadow) icon.style.boxShadow = finish.boxShadow;
        return el('div', { class: 'ap-preview-tile' }, [
          icon,
          el('span', { class: 'ap-preview-tile-name' }, s.name),
        ]);
      });
      previewHost.replaceChildren(el('div', { class: 'ap-preview' }, tiles));
    };
    renderAppearancePreview();
    onAppearanceApplied = renderAppearancePreview;
    registerCleanup(() => {
      onAppearanceApplied = null;
    });

    pageHosts.appearance.append(
      drawerGroup('Theme', [
        drawerRowH('Mode', 'Light theme follows the system at night when set to Auto.', themeSeg),
        drawerRowH(
          'Cool blue cast',
          'Tint dark surfaces toward blue. Off = neutral graphite.',
          coolCastSwitch,
        ),
      ]),
      drawerGroup('Accent', [
        drawerRowH(
          'Color',
          'Used for the build button, sparkle, focus rings, and version badges.',
          accentSwatches,
        ),
      ]),
      drawerGroup('App tiles', [
        drawerRowH('Treatment', 'How icon tiles on the home grid look.', tileSeg),
        drawerRowH(
          'Preview',
          'How the home grid looks with your current choices.',
          previewHost,
          true,
        ),
      ]),
    );
    pageHosts.layout.append(
      drawerGroup('Density', [
        drawerRowH(
          'Spacing',
          'Affects row height, type sizes, and spacing across all apps.',
          densitySeg,
        ),
      ]),
      drawerGroup('Cards', [
        drawerRowH(
          'Surface',
          'Affects every card-shaped surface — app tiles, message rows, settings groups.',
          cardsSeg,
        ),
      ]),
      drawerGroup('Sidebar', [
        drawerRowH('Show sidebar', 'Toggle the apps + chats panel.', sidebarSwitch),
      ]),
    );

    // ---- Runtime group ----
    let runtimeMode: 'local' | 'remote' = current.runtimeMode ?? 'local';

    const remoteUrl = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'http://127.0.0.1:18789',
      value: current.remoteGatewayUrl ?? '',
    }) as HTMLInputElement;
    const remoteToken = el('input', {
      class: 'input',
      type: 'password',
      placeholder: 'paste your gateway.auth.token (leave empty for loopback no-auth)',
      value: current.remoteGatewayToken ?? '',
    }) as HTMLInputElement;
    const projectsDir = el('input', {
      class: 'input',
      type: 'text',
      placeholder: '~/centraid-projects',
      value: current.projectsDir,
    }) as HTMLInputElement;

    const labeled = (label: string, hint: string, input: HTMLElement): HTMLElement =>
      el('div', { class: 'drawer-row' }, [
        el('span', { class: 'drawer-row-label' }, label),
        input,
        el('div', { class: 'settings-hint' }, hint),
      ]);

    // ---- Chat group ----
    const chatModelSelect = el('select', { class: 'input' }) as HTMLSelectElement;
    chatModelSelect.append(el('option', { value: '' }, 'Gateway default') as HTMLOptionElement);
    let chatModelInitial = current.chatModel ?? '';
    if (chatModelInitial) {
      // Pre-seed with the persisted choice so the dropdown shows the current
      // model even before the async list resolves.
      const seed = el(
        'option',
        { value: chatModelInitial, selected: '' },
        chatModelInitial,
      ) as HTMLOptionElement;
      chatModelSelect.append(seed);
    }
    async function loadChatModels(): Promise<void> {
      const models = await window.CentraidApi.listChatModels().catch(() => []);
      // Replace existing options but keep the leading "Gateway default" entry.
      while (chatModelSelect.children.length > 1) {
        chatModelSelect.lastChild?.remove();
      }
      for (const m of models) {
        const opt = el('option', { value: m.id }, `${m.name} · ${m.provider}`) as HTMLOptionElement;
        if (m.id === chatModelInitial) opt.selected = true;
        chatModelSelect.append(opt);
      }
    }
    void loadChatModels();
    chatModelSelect.addEventListener('change', () => {
      chatModelInitial = chatModelSelect.value;
      void window.CentraidApi.saveSettings({ chatModel: chatModelSelect.value || undefined });
    });

    // Refresh button — re-hits `models.list` on the gateway. Useful when the
    // user adds a provider profile in openclaw and wants the list to update
    // without restarting the desktop app.
    const refreshModelsBtn = el('button', {
      class: 'btn btn-soft app-chat-models-refresh',
      type: 'button',
      title: 'Refresh model list',
      'aria-label': 'Refresh model list',
      onClick: async () => {
        refreshModelsBtn.setAttribute('disabled', '');
        try {
          await loadChatModels();
          showToast('Model list refreshed');
        } finally {
          refreshModelsBtn.removeAttribute('disabled');
        }
      },
    });
    refreshModelsBtn.innerHTML = Icon.Reset({ size: 13 }) + '<span>Refresh</span>';

    const modelRow = el('div', { style: { alignItems: 'center', display: 'flex', gap: '8px' } }, [
      chatModelSelect,
      refreshModelsBtn,
    ]);

    pageHosts.workspace.append(
      drawerGroup('Chat', [
        el(
          'div',
          { class: 'settings-note' },
          'Model used by the in-app chat. The chat is sandboxed to one app at a time and only issues read-only SELECTs.',
        ),
        labeled(
          'Model',
          'Pick any model exposed by `openclaw infer model list`. "Gateway default" lets openclaw choose.',
          modelRow,
        ),
      ]),
    );

    // ---- AI providers (Claude Code / Codex credential status) ----
    // Centraid's coding agent runs the user's installed CLIs in place:
    // codex app-server reads `~/.codex/auth.json` (set up by `codex login`)
    // and the Claude Agent SDK reads `ANTHROPIC_API_KEY`. This panel just
    // probes the on-machine state and shows which backends are ready.
    const authStatusHost = el('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '8px' },
    });

    type AuthStatusSnapshot = Awaited<ReturnType<Window['CentraidApi']['authStatus']>>;
    const renderAuthStatus = (status: AuthStatusSnapshot | null): void => {
      authStatusHost.replaceChildren();
      if (!status) {
        authStatusHost.append(el('div', { class: 'settings-note' }, 'Reading credential status…'));
        return;
      }
      // §C3 — each provider row carries a state badge (Connected /
      // Standby / Not found) so the at-a-glance status doesn't rely on
      // reading the subtitle prose.
      const providerRow = (params: {
        title: string;
        subtitle: string;
        connected: boolean;
        accent: string;
        badge: { label: string; tone: 'on' | 'standby' | 'off' };
      }): HTMLElement => {
        const dotColor = params.connected ? params.accent : 'var(--ink-4, var(--ink-3))';
        return el(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 10px',
              border: '0.5px solid var(--line)',
              borderRadius: '8px',
              background: 'var(--bg-elev)',
            },
          },
          [
            el('span', {
              style: {
                width: '8px',
                height: '8px',
                borderRadius: '999px',
                background: dotColor,
                flexShrink: '0',
              },
            }),
            el(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1px',
                  flex: '1',
                  minWidth: '0',
                },
              },
              [
                el('span', { style: { fontSize: '13px', fontWeight: '500' } }, params.title),
                el(
                  'span',
                  { style: { fontSize: '11.5px', color: 'var(--ink-3)' } },
                  params.subtitle,
                ),
              ],
            ),
            el(
              'span',
              { class: 'provider-badge', 'data-tone': params.badge.tone },
              params.badge.label,
            ),
          ],
        );
      };

      // Codex row first — preferred when both subscriptions are present.
      // The runtime reads `~/.codex/auth.json` in place, so "available" IS
      // "connected" for our purposes; there's no separate import step.
      authStatusHost.append(
        providerRow({
          title: 'Codex (ChatGPT Plus/Pro) — preferred',
          subtitle: status.codexAvailable
            ? 'connected via ~/.codex/auth.json'
            : 'not found — run `codex login`',
          connected: status.codexAvailable,
          accent: '#10b981',
          badge: status.codexAvailable
            ? { label: 'Preferred', tone: 'on' }
            : { label: 'Not found', tone: 'off' },
        }),
      );

      const claudeSubtitle = status.claudeAvailable
        ? status.codexAvailable
          ? 'connected — held back because Codex is preferred'
          : 'connected via macOS keychain'
        : 'not found in keychain';
      authStatusHost.append(
        providerRow({
          title: 'Claude Code (Pro/Max)',
          subtitle: claudeSubtitle,
          connected: status.claudeAvailable,
          accent: '#a855f7',
          badge: !status.claudeAvailable
            ? { label: 'Not found', tone: 'off' }
            : status.codexAvailable
              ? { label: 'Standby', tone: 'standby' }
              : { label: 'Connected', tone: 'on' },
        }),
      );
    };

    const resyncBtn = el('button', {
      class: 'btn btn-soft',
      type: 'button',
    }) as HTMLButtonElement;
    resyncBtn.innerHTML = Icon.Reset({ size: 13 }) + '<span>Re-sync</span>';
    resyncBtn.addEventListener('click', async () => {
      resyncBtn.setAttribute('disabled', '');
      try {
        const result = await window.CentraidApi.authResync();
        renderAuthStatus(result.status);
        const parts: string[] = [];
        if (result.importedCodex) parts.push('Codex');
        if (result.importedClaude) parts.push('Claude Code');
        showToast(parts.length ? `Imported ${parts.join(' + ')}` : 'No new creds to import');
      } catch (err) {
        showToast(`Re-sync failed: ${String(err)}`);
      } finally {
        resyncBtn.removeAttribute('disabled');
      }
    });

    pageHosts.providers.append(
      drawerGroup('Connected', [authStatusHost]),
      el('div', { class: 'sheet-actions' }, [resyncBtn]),
    );

    // Initial status load — populates the rows after the page mounts.
    renderAuthStatus(null);
    void window.CentraidApi.authStatus()
      .then(renderAuthStatus)
      .catch(() =>
        renderAuthStatus({
          codexAvailable: false,
          claudeAvailable: false,
        }),
      );

    // ---- Custom inference endpoint (OpenAI-compatible providers) ----
    // Codex can route through any OpenAI-compatible /v1/chat/completions
    // endpoint (Ollama, vLLM, Groq, Together, LM Studio). The renderer
    // writes provider config to user_prefs under `agent.runner.provider.*`;
    // the API key is held by main's safeStorage (never round-tripped to the
    // renderer). On every spawn the main process materializes a scoped
    // CODEX_HOME so the user's ~/.codex/config.toml is left untouched.
    type ProviderPreset = {
      id: string;
      name: string;
      baseUrl: string;
      envKey: string;
      wireApi: 'chat' | 'responses';
    };
    const PROVIDER_PRESETS: Record<string, ProviderPreset | null> = {
      '': null, // Custom
      ollama: {
        id: 'ollama',
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        envKey: '',
        wireApi: 'chat',
      },
      groq: {
        id: 'groq',
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        envKey: 'GROQ_API_KEY',
        wireApi: 'chat',
      },
      together: {
        id: 'together',
        name: 'Together',
        baseUrl: 'https://api.together.xyz/v1',
        envKey: 'TOGETHER_API_KEY',
        wireApi: 'chat',
      },
      vllm: {
        id: 'vllm',
        name: 'vLLM (local)',
        baseUrl: 'http://localhost:8000/v1',
        envKey: '',
        wireApi: 'chat',
      },
    };

    const userPrefsSnapshot = await window.CentraidApi.getUserPrefs().catch(
      () => ({}) as Record<string, unknown>,
    );
    const readPref = (k: string): string =>
      typeof userPrefsSnapshot[k] === 'string' ? (userPrefsSnapshot[k] as string) : '';
    const initialWire = readPref('agent.runner.provider.wireApi');
    const wireApiInitial: 'chat' | 'responses' = initialWire === 'responses' ? 'responses' : 'chat';

    const presetSelect = el('select', { class: 'input' }) as HTMLSelectElement;
    presetSelect.append(el('option', { value: '' }, 'Custom') as HTMLOptionElement);
    for (const [key, p] of Object.entries(PROVIDER_PRESETS)) {
      if (!p) continue;
      presetSelect.append(el('option', { value: key }, p.name) as HTMLOptionElement);
    }

    const providerIdInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'groq',
      value: readPref('agent.runner.provider.id'),
    }) as HTMLInputElement;
    const providerNameInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Groq',
      value: readPref('agent.runner.provider.name'),
    }) as HTMLInputElement;
    const baseUrlInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'https://api.example.com/v1',
      value: readPref('agent.runner.provider.baseUrl'),
    }) as HTMLInputElement;
    const envKeyInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'GROQ_API_KEY (leave empty for keyless local endpoints)',
      value: readPref('agent.runner.provider.envKey'),
    }) as HTMLInputElement;
    const wireApiSelect = el('select', { class: 'input' }) as HTMLSelectElement;
    wireApiSelect.append(
      el('option', { value: 'chat' }, 'Chat completions (default)') as HTMLOptionElement,
    );
    wireApiSelect.append(
      el('option', { value: 'responses' }, 'Responses API') as HTMLOptionElement,
    );
    wireApiSelect.value = wireApiInitial;
    const apiKeyInput = el('input', {
      class: 'input',
      type: 'password',
      placeholder: 'paste new key to update; leave empty to keep existing',
    }) as HTMLInputElement;
    const apiKeyStatusEl = el(
      'span',
      { style: { fontSize: '11.5px', color: 'var(--ink-3)' } },
      'checking…',
    );
    const providerStatusEl = el('div', { class: 'settings-note' }, '');

    const refreshKeyStatus = async (): Promise<void> => {
      try {
        const r = await window.CentraidApi.hasProviderApiKey();
        apiKeyStatusEl.textContent = r.present
          ? 'A key is stored (encrypted in OS keychain). Paste a new one to replace.'
          : 'No key configured.';
      } catch {
        apiKeyStatusEl.textContent = 'Could not read key status.';
      }
    };
    const refreshProviderStatus = async (): Promise<void> => {
      providerStatusEl.textContent = 'Probing endpoint…';
      try {
        const status = await window.CentraidApi.getRunnerStatus();
        if (!status.provider) {
          providerStatusEl.textContent = providerIdInput.value
            ? 'Saved a config but no probe yet — click Test connection.'
            : 'No custom endpoint configured — codex uses its built-in models.';
          return;
        }
        const p = status.provider;
        if (p.ok) {
          providerStatusEl.textContent = `Connected${
            p.modelCount !== undefined ? ` · ${p.modelCount} models available` : ''
          } · ${p.baseUrl}`;
        } else {
          providerStatusEl.textContent = `Endpoint unreachable — ${p.reason ?? 'unknown error'}`;
        }
      } catch (err) {
        providerStatusEl.textContent = `Probe failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

    presetSelect.addEventListener('change', () => {
      const p = PROVIDER_PRESETS[presetSelect.value];
      if (!p) return;
      providerIdInput.value = p.id;
      providerNameInput.value = p.name;
      baseUrlInput.value = p.baseUrl;
      envKeyInput.value = p.envKey;
      wireApiSelect.value = p.wireApi;
    });

    const saveProviderBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      onClick: async () => {
        saveProviderBtn.setAttribute('disabled', '');
        try {
          // null deletes the key — keeps `user_prefs` clean when the user
          // clears a field (matches the gateway's merge semantics).
          const trim = (s: string): string | null => (s.trim() ? s.trim() : null);
          // OpenAI-compatible endpoints only work through the Codex runner —
          // the Claude Agent SDK speaks Anthropic wire format and ignores
          // `RunnerPrefs.provider`. If the user is on a different runner, flip
          // them to Codex so saving doesn't silently no-op.
          const livePrefs = await window.CentraidApi.getUserPrefs().catch(
            () => ({}) as Record<string, unknown>,
          );
          const currentKind = livePrefs['agent.runner.kind'];
          const switchingKind = currentKind !== 'codex';
          await window.CentraidApi.saveUserPrefs({
            'agent.runner.provider.id': trim(providerIdInput.value),
            'agent.runner.provider.name': trim(providerNameInput.value),
            'agent.runner.provider.baseUrl': trim(baseUrlInput.value),
            'agent.runner.provider.envKey': trim(envKeyInput.value),
            // Skip writing the wire format when it equals the default 'chat' —
            // keeps `user_prefs` tidy and lets the engine's default kick in
            // naturally if we ever change it.
            'agent.runner.provider.wireApi':
              wireApiSelect.value === 'responses' ? 'responses' : null,
            ...(switchingKind ? { 'agent.runner.kind': 'codex' } : {}),
          });
          if (apiKeyInput.value) {
            await window.CentraidApi.setProviderApiKey({ apiKey: apiKeyInput.value });
            apiKeyInput.value = '';
          }
          showToast(
            switchingKind
              ? 'Provider saved · runner switched to Codex (only OpenAI-compatible API is supported here; Claude Code is Anthropic-wire-format only)'
              : 'Provider saved',
          );
          await Promise.all([refreshKeyStatus(), refreshProviderStatus()]);
        } catch (err) {
          showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          saveProviderBtn.removeAttribute('disabled');
        }
      },
    }) as HTMLButtonElement;
    saveProviderBtn.innerHTML = Icon.Save({ size: 13 }) + '<span>Save provider</span>';

    const testProviderBtn = el('button', {
      class: 'btn btn-soft',
      type: 'button',
      onClick: async () => {
        testProviderBtn.setAttribute('disabled', '');
        try {
          await refreshProviderStatus();
        } finally {
          testProviderBtn.removeAttribute('disabled');
        }
      },
    }) as HTMLButtonElement;
    testProviderBtn.innerHTML = Icon.Reset({ size: 13 }) + '<span>Test connection</span>';

    const clearProviderBtn = el('button', {
      class: 'btn btn-soft',
      type: 'button',
      onClick: async () => {
        clearProviderBtn.setAttribute('disabled', '');
        try {
          await window.CentraidApi.saveUserPrefs({
            'agent.runner.provider.id': null,
            'agent.runner.provider.name': null,
            'agent.runner.provider.baseUrl': null,
            'agent.runner.provider.envKey': null,
            'agent.runner.provider.wireApi': null,
          });
          await window.CentraidApi.clearProviderApiKey();
          providerIdInput.value = '';
          providerNameInput.value = '';
          baseUrlInput.value = '';
          envKeyInput.value = '';
          wireApiSelect.value = 'chat';
          apiKeyInput.value = '';
          presetSelect.value = '';
          showToast('Custom endpoint cleared — codex will use its built-in models');
          await Promise.all([refreshKeyStatus(), refreshProviderStatus()]);
        } finally {
          clearProviderBtn.removeAttribute('disabled');
        }
      },
    }) as HTMLButtonElement;
    clearProviderBtn.innerHTML = Icon.Reset({ size: 13 }) + '<span>Disable</span>';

    pageHosts.inference.append(
      drawerGroup('Provider', [
        labeled('Preset', 'Quick-fills the fields below from a known provider.', presetSelect),
        labeled(
          'Provider id',
          'Used as the [model_providers.<id>] key in codex config.',
          providerIdInput,
        ),
        labeled('Display name', 'Shown in codex logs.', providerNameInput),
      ]),
      drawerGroup('Connection', [
        labeled(
          'Base URL',
          'Must include /v1 (or whatever path precedes /chat/completions).',
          baseUrlInput,
        ),
        labeled(
          'API key env var',
          'Codex reads the bearer token from this env var. Empty = no auth.',
          envKeyInput,
        ),
        labeled(
          'Wire format',
          'Default is Chat completions; only flip if your provider supports /responses.',
          wireApiSelect,
        ),
      ]),
      drawerGroup('Credentials', [
        labeled(
          'API key',
          'Stored encrypted via OS keychain. Never written to disk in plaintext.',
          apiKeyInput,
        ),
        el('div', { class: 'drawer-row drawer-row-grid' }, [
          el('div', { class: 'drawer-row-head' }, [
            el('span', { class: 'drawer-row-label' }, 'Key status'),
          ]),
          el('div', { class: 'drawer-row-control' }, [apiKeyStatusEl]),
        ]),
        providerStatusEl,
      ]),
      el('div', { class: 'sheet-actions' }, [saveProviderBtn, testProviderBtn, clearProviderBtn]),
    );

    void refreshKeyStatus();
    void refreshProviderStatus();

    const remoteRowsHost = el('div');
    const renderRemoteRows = (): void => {
      remoteRowsHost.replaceChildren();
      if (runtimeMode === 'remote') {
        remoteRowsHost.append(
          labeled(
            'Gateway URL',
            'Base URL of the remote openclaw gateway (typically loopback).',
            remoteUrl,
          ),
          labeled(
            'Gateway token',
            'From ~/.openclaw/openclaw.json → gateway.auth.token. Leave empty if the gateway runs in mode "none".',
            remoteToken,
          ),
        );
      } else {
        remoteRowsHost.append(
          el(
            'div',
            { class: 'settings-note' },
            'Local mode: apps run inside this Electron process. No external gateway required.',
          ),
        );
      }
    };

    const modeSeg = makeSegmented<'local' | 'remote'>(['local', 'remote'], runtimeMode, (v) => {
      runtimeMode = v;
      renderRemoteRows();
    });

    renderRemoteRows();

    const saveBtn = el('button', {
      class: 'btn btn-primary',
      onClick: async () => {
        try {
          const next = await window.CentraidApi.saveSettings({
            projectsDir: projectsDir.value.trim(),
            runtimeMode,
            remoteGatewayUrl: remoteUrl.value.trim(),
            remoteGatewayToken: remoteToken.value,
          });
          currentRuntimeMode = next.runtimeMode;
          renderSettings();
          showToast('Settings saved');
        } catch (err) {
          showToast(`Save failed: ${String(err)}`);
        }
      },
    });
    saveBtn.innerHTML = Icon.Save({ size: 13 }) + '<span>Save</span>';

    const testBtn = el('button', {
      class: 'btn btn-soft',
      onClick: async () => {
        try {
          const next = await window.CentraidApi.saveSettings({
            projectsDir: projectsDir.value.trim(),
            runtimeMode,
            remoteGatewayUrl: remoteUrl.value.trim(),
            remoteGatewayToken: remoteToken.value,
          });
          currentRuntimeMode = next.runtimeMode;
          const base = (next.gatewayUrl ?? '').replace(/\/+$/, '');
          const health = await fetch(`${base}/health`).catch(() => null);
          showToast(health?.ok ? 'Runtime reachable' : 'Settings saved. Health check unavailable.');
        } catch (err) {
          showToast(`Runtime check failed: ${String(err)}`);
        }
      },
    });
    testBtn.innerHTML = Icon.Eye({ size: 13 }) + '<span>Test connection</span>';

    pageHosts.runtime.append(
      drawerGroup('Mode', [
        drawerRowH('Runtime', 'Changes apply when you save.', modeSeg),
        remoteRowsHost,
        labeled(
          'Projects directory',
          'Where each app project is scaffolded. Tilde is expanded to your home directory.',
          projectsDir,
        ),
      ]),
      el('div', { class: 'sheet-actions' }, [testBtn, saveBtn]),
    );
    pageHosts.sync.append(
      drawerGroup('Sync', [
        el('div', { class: 'settings-note' }, 'Project sync and backup settings will live here.'),
      ]),
    );

    // §C1 — inner-sidebar shell modelled on RefinedSettingsV2. A grouped
    // category nav (Workspace / Models / Runtime) — each entry an icon +
    // label + optional mono hint — sits beside a scrolling content pane
    // that shows exactly one page (a PageHead + its controls) at a time.
    interface SettingsPageDef {
      id: SettingsPageId;
      label: string;
      section: string;
      icon: IconNameType;
      hint?: string;
      subtitle: string;
    }
    const settingsPages: ReadonlyArray<SettingsPageDef> = [
      {
        id: 'appearance',
        label: 'Appearance',
        section: 'Workspace',
        icon: 'Mood',
        subtitle: 'Visual treatment for Centraid chrome and the app tiles on your home screen.',
      },
      {
        id: 'layout',
        label: 'Layout',
        section: 'Workspace',
        icon: 'Code',
        subtitle: 'Density and surface treatment across every Centraid screen.',
      },
      {
        id: 'workspace',
        label: 'Workspace',
        section: 'Workspace',
        icon: 'Folder',
        subtitle: 'Sidebar, navigation, and the in-app chat model.',
      },
      {
        id: 'providers',
        label: 'AI providers',
        section: 'Models',
        icon: 'Sparkle',
        subtitle:
          'Centraid auto-imports your Claude Code and Codex credentials on first launch so the coding agent rides on your existing subscription.',
      },
      {
        id: 'inference',
        label: 'Inference endpoint',
        section: 'Models',
        icon: 'Bolt',
        hint: 'Custom',
        subtitle:
          'Route Codex through any OpenAI-compatible endpoint (Ollama, vLLM, Groq, Together, LM Studio). Your ~/.codex/auth.json and config.toml are not touched.',
      },
      {
        id: 'runtime',
        label: 'Where apps run',
        section: 'Runtime',
        icon: 'Monitor',
        subtitle:
          'Local mode runs apps inside this Electron process. Remote mode delegates to the Centraid gateway so they’re reachable from any device.',
      },
      {
        id: 'sync',
        label: 'Sync & backups',
        section: 'Runtime',
        icon: 'History',
        subtitle:
          'Keep apps, drafts, and chats in sync across your devices and back up automatically.',
      },
    ];

    const innerNav = el('aside', { class: 'cd-settings-nav' });
    const contentArea = el('section', { class: 'cd-settings-content' });
    innerNav.append(
      el('div', { class: 'cd-settings-nav-head' }, [
        el('div', { class: 'cd-settings-nav-eyebrow' }, 'Settings'),
        el('div', { class: 'cd-settings-nav-title' }, 'Personal'),
      ]),
    );

    // §C4 — pages whose controls persist on change carry an "Auto-saved"
    // marker; the credential pages (inference, runtime) keep their
    // explicit Save/Test buttons and so get no marker.
    const autoSavePages = new Set<SettingsPageId>(['appearance', 'layout', 'workspace']);

    const navButtons = new Map<SettingsPageId, HTMLElement>();
    const showSettingsPage = (id: SettingsPageId): void => {
      const def = settingsPages.find((p) => p.id === id);
      for (const [pid, btn] of navButtons) {
        btn.dataset.active = String(pid === id);
      }
      const titleRow = el('div', { class: 'cd-settings-page-titlerow' }, [
        el('h1', { class: 'cd-settings-page-title' }, def ? def.label : 'Settings'),
        ...(autoSavePages.has(id)
          ? [
              el('span', {
                class: 'cd-settings-autosaved',
                trustedHtml: `${Icon.Check({ size: 10, strokeWidth: 2.5 })}<span>Auto-saved</span>`,
              }),
            ]
          : []),
      ]);
      const head = el('header', { class: 'cd-settings-page-head' }, [
        titleRow,
        ...(def ? [el('p', { class: 'cd-settings-page-sub' }, def.subtitle)] : []),
      ]);
      contentArea.replaceChildren(head, pageHosts[id]);
      contentArea.scrollTop = 0;
    };
    let lastSection = '';
    for (const p of settingsPages) {
      if (p.section !== lastSection) {
        innerNav.append(el('div', { class: 'cd-settings-nav-section' }, p.section));
        lastSection = p.section;
      }
      const btnChildren: HTMLElement[] = [
        el('span', {
          class: 'cd-settings-nav-icon',
          trustedHtml: Icon[p.icon] ? Icon[p.icon]({ size: 14 }) : Icon.Folder({ size: 14 }),
        }),
        el('span', { class: 'cd-settings-nav-label' }, p.label),
      ];
      if (p.hint) btnChildren.push(el('span', { class: 'cd-settings-nav-hint' }, p.hint));
      const btn = el(
        'button',
        { class: 'cd-settings-nav-item', type: 'button', onClick: () => showSettingsPage(p.id) },
        btnChildren,
      );
      navButtons.set(p.id, btn);
      innerNav.append(btn);
    }
    innerNav.append(
      el('div', { class: 'cd-settings-nav-foot' }, [
        el('span', { class: 'cd-settings-nav-ver' }, 'v0.5.2'),
      ]),
    );

    const settingsShell = el('div', { class: 'cd-settings-shell' }, [innerNav, contentArea]);
    main.append(settingsShell);
    showSettingsPage('appearance');

    const sidebar = buildHomeSidebar({ page: 'settings' });
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
    root.append(shell);
  }

  // §C — RefinedSettingsV2 `Sec`: a titled section — a plain bold heading
  // above a body of rows that sits under a hairline rule.
  function drawerGroup(label: string, rows: HTMLElement[]): HTMLElement {
    return el('div', { class: 'drawer-group' }, [
      el('div', { class: 'drawer-group-label' }, label),
      el('div', { class: 'drawer-group-body' }, rows),
    ]);
  }
  // §C — RefinedSettingsV2 `Row`: a two-column grid — a label + hint
  // stack on the left, the control on the right. `full` stacks the
  // control below the label across the whole row width.
  function drawerRowH(
    label: string,
    hint: string,
    control: HTMLElement,
    full = false,
  ): HTMLElement {
    return el(
      'div',
      { class: full ? 'drawer-row drawer-row-full' : 'drawer-row drawer-row-grid' },
      [
        el('div', { class: 'drawer-row-head' }, [
          el('span', { class: 'drawer-row-label' }, label),
          el('span', { class: 'drawer-row-hint' }, hint),
        ]),
        el('div', { class: 'drawer-row-control' }, [control]),
      ],
    );
  }
  function makeSwitch(initial: boolean, onChange: (next: boolean) => void): HTMLElement {
    let on = initial;
    const btn = el('button', {
      'aria-checked': String(on),
      class: 'cd-switch',
      'data-on': String(on),
      role: 'switch',
      type: 'button',
    });
    btn.append(el('span', { class: 'cd-switch-thumb' }));
    btn.addEventListener('click', () => {
      on = !on;
      btn.dataset.on = String(on);
      btn.setAttribute('aria-checked', String(on));
      onChange(on);
    });
    return btn;
  }
  // §C — RefinedSettingsV2 accent picker: a labelled swatch card per
  // accent (a color bar + a name caption); the active card wears an ink
  // border. Names match the proposal copy (Electric / Violet / …).
  function makeSwatches(selected: AccentKey, onSelect: (value: AccentKey) => void): HTMLElement {
    const order: ReadonlyArray<{ key: AccentKey; name: string }> = [
      { key: 'blue', name: 'Electric' },
      { key: 'violet', name: 'Violet' },
      { key: 'teal', name: 'Teal' },
      { key: 'ochre', name: 'Ochre' },
      { key: 'rose', name: 'Rose' },
    ];
    const wrap = el('div', { class: 'cd-swatches', role: 'radiogroup', 'aria-label': 'Accent' });
    for (const { key, name } of order) {
      const swatch = ACCENT_PALETTE[key];
      const btn = el(
        'button',
        {
          'aria-checked': String(key === selected),
          'aria-label': name,
          class: 'cd-swatch',
          'data-active': String(key === selected),
          role: 'radio',
          type: 'button',
        },
        [
          el('span', { class: 'cd-swatch-chip', style: { background: swatch.accent } }),
          el('span', { class: 'cd-swatch-name' }, name),
        ],
      );
      btn.addEventListener('click', () => {
        for (const child of wrap.children) {
          (child as HTMLElement).dataset.active = 'false';
          child.setAttribute('aria-checked', 'false');
        }
        btn.dataset.active = 'true';
        btn.setAttribute('aria-checked', 'true');
        onSelect(key);
      });
      wrap.append(btn);
    }
    return wrap;
  }
  function makeSegmented<T extends string>(
    options: readonly T[],
    selected: T,
    onSelect: (value: T) => void,
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
        opt,
      );
      wrap.append(btn);
    }
    return wrap;
  }

  // ---------- Share dialog ----------
  // Centered modal with a read-only share link + access radios. Link is a
  // local fake (centraid.app/s/...) — wire to real share URLs once the
  // gateway exposes a share endpoint.
  function openShareDialog(app: AppMetaResolvedType): void {
    const slug = app.name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    const link = `centraid.app/s/${app.id}-${slug}`;
    let access: 'private' | 'link' | 'public' = 'link';
    // ^ also declared as `Access` below; the union keeps both call sites narrow.

    const backdrop = el('div', { class: 'modal-backdrop' });
    const card = el('div', {
      class: 'share-card',
      role: 'dialog',
      'aria-label': `Share ${app.name}`,
    });
    const close = (): void => {
      backdrop.remove();
      card.remove();
    };
    backdrop.addEventListener('click', close);

    const closeBtn = el('button', {
      'aria-label': 'Close',
      class: 'btn-icon',
      trustedHtml: Icon.X({ size: 16 }),
      onClick: close,
    });

    card.append(
      el('div', { class: 'flex between' }, [
        el('div', {}, [
          el('h3', {}, `Share ${app.name}`),
          el('p', { class: 'share-sub' }, 'Anyone with the link can open a read-only copy.'),
        ]),
        closeBtn,
      ]),
    );

    const linkInput = el('input', {
      class: 'share-link-input',
      readonly: '',
      value: link,
    }) as HTMLInputElement;
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    const copyBtn = el(
      'button',
      {
        class: 'btn btn-primary',
        onClick: () => {
          void navigator.clipboard
            .writeText(link)
            .then(() => {
              copyBtn.textContent = 'Copied';
              if (copyTimer) clearTimeout(copyTimer);
              copyTimer = setTimeout(() => {
                copyBtn.textContent = 'Copy';
              }, 1400);
            })
            .catch(() => showToast('Could not copy to clipboard'));
        },
        style: { minWidth: '80px' },
      },
      'Copy',
    );
    card.append(el('div', { class: 'share-link-row' }, [linkInput, copyBtn]));

    type Access = 'private' | 'link' | 'public';
    const options: { id: Access; label: string; hint: string }[] = [
      { hint: 'App is private. No one else can open it.', id: 'private', label: 'Only me' },
      {
        hint: 'Read-only. They can fork it into their own Centraid.',
        id: 'link',
        label: 'Anyone with the link',
      },
      { hint: 'Listed in Centraid Discover.', id: 'public', label: 'Public' },
    ];
    const accessWrap = el('div', { class: 'share-access' });
    const rows: HTMLElement[] = [];
    for (const o of options) {
      const radio = el('input', {
        type: 'radio',
        name: 'share-access',
        checked: o.id === access ? '' : null,
      }) as HTMLInputElement;
      const row = el(
        'label',
        {
          class: 'share-access-row',
          'data-active': String(o.id === access),
          onClick: () => {
            access = o.id;
            for (const r of rows) r.dataset.active = 'false';
            row.dataset.active = 'true';
            radio.checked = true;
          },
        },
        [
          radio,
          el('span', {}, [
            el('div', { class: 'label' }, o.label),
            el('div', { class: 'hint' }, o.hint),
          ]),
        ],
      );
      rows.push(row);
      accessWrap.append(row);
    }
    card.append(accessWrap);

    const doneBtn = el('button', { class: 'btn btn-soft', onClick: close }, 'Done');
    card.append(el('div', { class: 'share-actions' }, [doneBtn]));

    document.body.append(backdrop);
    document.body.append(card);
    setTimeout(() => linkInput.select(), 30);
  }

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
    if (e.key === 'Escape' && ctxMenu) {
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
    }
  });

  // Prime the sidebar's Local/Remote badge BEFORE the first renderHome
  // so the badge is present on cold-boot Home. Racing renderHome()
  // against a later applyRoute() rebuild produced two concurrent
  // renderHomeAsync() calls — both cleared root, both appended, and the
  // window ended up showing a stacked duplicate of the entire UI. The
  // settings IPC is a local file read, so awaiting it doesn't make the
  // first paint noticeably slower.
  void (async (): Promise<void> => {
    await refreshRuntimeMode();
    renderHome();
  })();
})();
