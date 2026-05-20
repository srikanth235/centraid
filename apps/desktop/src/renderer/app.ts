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
  }

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
    | { id: string; kind: 'app' }
    | { appContext?: AppMetaResolvedType; initialPrompt?: string; kind: 'builder' };

  const navStack: ShellRoute[] = [];
  let navIndex = -1;
  let applyingNav = false;

  function routeKey(route: ShellRoute): string {
    if (route.kind === 'home') return 'home';
    if (route.kind === 'settings') return 'settings';
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
  function buildHomeSidebar(activeId?: string): HTMLElement {
    const all = getAppsWithDrafts();
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
    void all;
    return window.Chrome.buildSidebar({
      activeId,
      apps,
      drafts: draftEntries,
      onAppClick: (id) => {
        const app = findApp(id);
        if (!app) return;
        if (isDraft(app)) enterBuilder({ appContext: app });
        else openApp(id);
      },
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
      onSettings: renderSettings,
      runtimeMode: currentRuntimeMode,
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
  /**
   * Legacy `usr_` ids stay treated as user apps for backwards-compat with
   * stored localStorage entries. New centraid-backed apps use plain
   * `<slug>-<rand>` ids and are detected by membership in `userApps`.
   */
  function isUserApp(id: string): boolean {
    if (id.startsWith('usr_')) return true;
    return !!findUserApp(id);
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

  function renderHome(): void {
    void renderHomeAsync();
  }

  async function renderHomeAsync(): Promise<void> {
    recordRoute({ kind: 'home' });
    clear();
    await hydrateDrafts();
    const availableTemplates = await loadAvailableTemplates();

    // ─ Main column: glass hero + "Your apps" grid + Templates strip ─
    // `has-wall` paints the device-wall crosshatch behind everything —
    // matches the Bold home screenshot. (UPDATES.md §5 said don't promote
    // device-wall to a system token; the rendered design HTML uses it on
    // Home anyway, so it lives here as a product choice, not a DS token.)
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);

    scroll.append(buildHomeHero());

    // Your apps section — always rendered so the home page keeps a stable
    // shape. When the workspace is empty an inline empty-state card stands
    // in for the grid, pointing users at the Templates strip below as the
    // fastest way to get their first app on screen.
    const apps = getApps();
    const totalApps = apps.length;
    const totalDrafts = drafts.length;
    {
      const section = el('section', { class: 'cd-section' });
      const head = el('div', { class: 'cd-section-head' }, [el('h2', {}, 'Your apps')]);
      section.append(head);
      if (totalApps + totalDrafts > 0) {
        const grid = el('div', { class: 'cd-apps-grid' });
        for (const app of apps) grid.append(renderAppCard(app));
        for (const d of drafts) grid.append(renderAppCard(d));
        section.append(grid);
      } else {
        section.append(renderHomeAppsEmptyState());
      }
      scroll.append(section);
    }

    // Templates strip
    if (availableTemplates.length > 0) {
      const section = el('section', { class: 'cd-section' });
      section.append(el('div', { class: 'cd-eyebrow' }, 'Templates · curated'));
      const grid = el('div', { class: 'cd-tmpl-grid' });
      for (const tmpl of availableTemplates) grid.append(renderTemplateCard(tmpl));
      section.append(grid);
      scroll.append(section);
    }

    const sidebar = buildHomeSidebar('home');
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

  function buildHomeHero(): HTMLElement {
    const wrap = el('div', { class: 'cd-hero' });
    wrap.append(el('h1', {}, 'What should we build?'));

    const prompt = el('div', { class: 'cd-hero-prompt' });
    const ta = el('textarea', {
      placeholder: 'A habit tracker, a journal, a tiny calculator…',
      rows: '2',
    }) as HTMLTextAreaElement;
    const buildBtn = el('button', { class: 'cd-hero-build-btn', disabled: '' });
    buildBtn.innerHTML = `<span>Build</span>${Icon.Send({ size: 13 })}`;

    const submit = (): void => {
      const v = ta.value.trim();
      if (!v) return;
      enterBuilder({ initialPrompt: v });
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

    const row = el('div', { class: 'cd-hero-prompt-row' });
    row.append(el('span', { style: { flex: '1' } }));
    row.append(buildBtn);
    prompt.append(ta);
    prompt.append(row);
    wrap.append(prompt);

    const suggestions = [
      { icon: 'Habit', label: 'Habit tracker' } as const,
      { icon: 'Journal', label: 'Daily journal' } as const,
      { icon: 'Pomodoro', label: 'Pomodoro timer' } as const,
      { icon: 'Water', label: 'Hydration' } as const,
    ];
    const sugRow = el('div', { class: 'cd-hero-suggestions' });
    for (const s of suggestions) {
      const chip = el('button', {
        class: 'cd-chip',
        onClick: () => {
          ta.value = s.label;
          ta.dispatchEvent(new Event('input'));
          ta.focus();
        },
      });
      chip.innerHTML = `${Icon[s.icon]({ size: 12 })}<span>${s.label}</span>`;
      sugRow.append(chip);
    }
    wrap.append(sugRow);
    return wrap;
  }

  // Empty-state card shown under "Your apps" when the workspace is fresh.
  // Carries the same visual weight as a populated grid row so the page
  // silhouette stays steady when the first app lands. Points the user at
  // the two ways forward — the hero prompt above, the templates below.
  function renderHomeAppsEmptyState(): HTMLElement {
    const card = el('div', { class: 'cd-apps-empty' });
    card.append(el('div', { class: 'cd-apps-empty-halo' }));

    const icon = el('div', {
      class: 'cd-apps-empty-icon',
      trustedHtml: Icon.Sparkle({ size: 22 }),
    });
    card.append(icon);

    card.append(
      el('div', { class: 'cd-apps-empty-text' }, [
        el('div', { class: 'cd-apps-empty-title' }, 'Your workspace is a blank canvas'),
        el(
          'div',
          { class: 'cd-apps-empty-hint' },
          'Clone a template or describe what you want — we’ll build it.',
        ),
      ]),
    );

    const cues = el('div', { class: 'cd-apps-empty-cues' });
    const cueUp = el('div', { class: 'cd-apps-empty-cue' });
    cueUp.innerHTML = `${Icon.ArrowLeft({ size: 12 })}<span>Describe above</span>`;
    cueUp.querySelector('svg')?.setAttribute('style', 'transform: rotate(90deg)');
    const cueDown = el('div', { class: 'cd-apps-empty-cue' });
    cueDown.innerHTML = `<span>Pick a template</span>${Icon.ArrowLeft({ size: 12 })}`;
    cueDown.querySelector('svg')?.setAttribute('style', 'transform: rotate(-90deg)');
    cues.append(cueUp, cueDown);
    card.append(cues);

    return card;
  }

  function renderAppCard(app: AppMetaResolvedType): HTMLElement {
    const draft = isDraft(app);
    const status: 'new' | 'draft' | null = draft ? 'draft' : isUserApp(app.id) ? 'new' : null;

    // Wrap is the grid item; card is the clickable surface. The wrap also
    // hosts the hover-revealed `•••` action button as a sibling so we don't
    // nest a button inside a button.
    const wrap = el('div', { class: 'cd-app-card-wrap', 'data-app-id': app.id });
    const card = el('button', {
      class: 'cd-app-card',
      type: 'button',
      onClick: () => (draft ? enterBuilder({ appContext: app }) : openApp(app.id)),
      onContextmenu: (e: Event) => {
        e.preventDefault();
        const me = e as MouseEvent;
        openContextMenu(app, { kind: 'point', x: me.clientX, y: me.clientY });
      },
    });

    // Top row mirrors the template card layout — small icon on the
    // left, name + description stacked to its right. Keeps app +
    // template tiles visually related so the home page reads as one
    // consistent grid family.
    const row = el('div', { class: 'cd-app-card-row' });
    const iconEl = el('div', {
      class: 'cd-app-card-icon',
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 16, strokeWidth: 1.85 }) : '',
    });
    const finish = window.CentraidTokens.tileFinish(app.color, prefs.tileVariant);
    iconEl.style.background = finish.background;
    iconEl.style.color = finish.glyphColor;
    if (finish.boxShadow) iconEl.style.boxShadow = finish.boxShadow;
    row.append(iconEl);
    const text = el('div', { class: 'cd-app-card-text' });
    text.append(el('div', { class: 'cd-app-card-name' }, app.name));
    if (app.desc) text.append(el('div', { class: 'cd-app-card-desc' }, app.desc));
    row.append(text);
    card.append(row);

    // Foot — edited time on the left, status pill pushed to the right.
    // What separates an app tile from a template tile: templates show
    // a description; apps show their lifecycle (last touched + state).
    const ua = !draft ? findUserApp(app.id) : undefined;
    const metaLabel = draft ? 'Continue editing' : relativeTime(ua?.updatedAt);
    const foot = el('div', { class: 'cd-app-card-foot' });
    foot.append(el('span', { class: 'cd-app-card-foot-time' }, metaLabel));
    if (status) {
      const pill = el('span', { class: 'cd-status', 'data-tone': status });
      pill.append(el('span', { class: 'cd-status-dot' }));
      pill.append(document.createTextNode(status));
      foot.append(pill);
    }
    card.append(foot);

    wrap.append(card);
    wrap.append(
      buildMoreButton('App actions', (rect) => openContextMenu(app, { kind: 'rect', rect })),
    );
    return wrap;
  }

  function renderTemplateCard(tmpl: TemplateEntry): HTMLElement {
    const color = (window.ICON_PALETTE as Record<string, string>)[tmpl.colorKey] || '#7C5BD9';
    const wrap = el('div', { class: 'cd-tmpl-card-wrap' });
    const card = el(
      'button',
      {
        class: 'cd-tmpl-card',
        type: 'button',
        // Click opens a preview rather than cloning straight away — keeps a
        // single-tap from becoming a surprise side effect on disk. The
        // "Use this template" button in the preview commits the clone.
        onClick: () => openTemplatePreview(tmpl),
        onContextmenu: (e: Event) => {
          e.preventDefault();
          const me = e as MouseEvent;
          openTemplateContextMenu(tmpl, { kind: 'point', x: me.clientX, y: me.clientY });
        },
      },
      [],
    );
    const iconEl = el('div', {
      class: 'cd-tmpl-card-icon',
      style: { background: color },
      trustedHtml: Icon[tmpl.iconKey as IconNameType]
        ? Icon[tmpl.iconKey as IconNameType]({ size: 16, strokeWidth: 1.85 })
        : '',
    });
    card.append(iconEl);
    const text = el('div', { style: { minWidth: '0', flex: '1' } });
    text.append(el('div', { class: 'cd-tmpl-card-name' }, tmpl.name));
    text.append(el('div', { class: 'cd-tmpl-card-desc' }, tmpl.desc));
    card.append(text);
    wrap.append(card);
    wrap.append(
      buildMoreButton('Template actions', (rect) =>
        openTemplateContextMenu(tmpl, { kind: 'rect', rect }),
      ),
    );
    return wrap;
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

    const newApp: UserAppMeta = {
      color: input.color || meta.color,
      colorKey: 'violet',
      desc: input.prompt && input.prompt.length <= 60 ? input.prompt : 'Built with Centraid.',
      iconKey: input.iconKey || meta.iconKey,
      id,
      name: input.name || meta.name,
      updatedAt: new Date().toISOString(),
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
    // Drafts can't be "opened" — they don't have a runnable build yet.
    // Route to the builder so the click is meaningful even when openApp
    // is called by surfaces (like the builder's own sidebar) that don't
    // pre-branch on draft status.
    if (isDraft(app)) {
      enterBuilder({ appContext: app });
      return;
    }
    recordRoute({ id, kind: 'app' });
    // Every app on the grid is a user app now (built-ins were retired in
    // favour of templates), so we always mount via the iframe-backed path.
    const ua = findUserApp(id);
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

    // Titlebar right cluster: brand chip with app icon + name, gear button
    // for per-app settings, then the floating Edit pill that returns to the
    // builder.
    const brandChip = el('span', { class: 'cd-brand-chip' });
    brandChip.append(
      el('span', {
        class: 'cd-app-strip-icon',
        style: { background: app.color, width: '18px', height: '18px', borderRadius: '4px' },
        trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 11, strokeWidth: 2 }) : '',
      }),
    );
    brandChip.append(el('span', { class: 'cd-brand-chip-name' }, app.name));

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
      onClick: () => toggleAppSettings(app, gearBtn, view, ua?.centraidProjectId),
    });
    gearWrap.append(gearBtn);
    gearWrap.append(el('span', { class: 'cd-tooltip' }, 'App settings'));

    const editPill = el('button', {
      class: 'cd-edit-pill',
      type: 'button',
      onClick: () => enterBuilder({ appContext: app }),
    });
    editPill.innerHTML = `${Icon.Sparkle({ size: 11 })}<span>Edit</span>`;
    const titlebarRight = el('span', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
    });
    titlebarRight.append(brandChip);
    titlebarRight.append(gearWrap);
    titlebarRight.append(editPill);

    const sidebar = buildHomeSidebar(app.id);
    const { root: shell, setSidebarOpen } = window.Chrome.buildWindow({
      ...chromeNav(),
      main,
      onNewChat: openNewAppSheet,
      onToggleSidebar: toggleSidebar,
      showNewChat: true,
      sidebar,
      sidebarOpen: prefs.sidebarOpen,
      titlebarRight,
    });
    currentSetSidebarOpen = setSidebarOpen;
    root.append(shell);

    try {
      mountUserApp(app, ua, inner);
      // Per-app agentic chat: only wire it up for centraid-backed apps,
      // since the agent reads the app's data.sqlite via the gateway.
      if (ua?.centraidProjectId) {
        currentCleanup = window.AppChat.mount({
          view,
          app,
          appId: ua.centraidProjectId,
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
    ua: UserAppMeta | undefined,
    container: HTMLElement,
  ): void {
    if (ua?.centraidProjectId) {
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
      void window.CentraidApi.appLiveUrl({ id: ua.centraidProjectId })
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

    // Header
    const header = el('div', { class: 'cd-app-settings-header' });
    const iconTile = el('span', {
      class: 'cd-app-settings-icon',
      style: { background: app.color },
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 13, strokeWidth: 1.85 }) : '',
    });
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

    // Preferences (knobs) — only meaningful for centraid-backed apps.
    // We render an empty host section synchronously and fill it in when
    // the manifest + current values resolve, so the panel pops in
    // immediately without waiting for HTTP/SQL.
    let prefsHost: HTMLElement | null = null;
    if (appId) {
      prefsHost = el('div', { class: 'cd-app-settings-section-host' });
      panel.append(prefsHost);
      void Promise.all([fetchAppKnobsManifest(appId), fetchAppKnobValues(appId)]).then(
        ([manifest, stored]) => {
          if (!prefsHost || !document.contains(panel)) return;
          if (!manifest || manifest.knobs.length === 0) return;
          prefsHost.replaceChildren(renderKnobsSection(manifest.knobs, stored, view, appId, panel));
        },
      );
    }

    // Automations (issue #70) — end-user surface for cron-scheduled
    // actions the builder agent scaffolded. Same lazy pattern as
    // Preferences: empty host first, replace once the mirror responds.
    // End-user controls only — on/off toggle, Run now, and a
    // human-readable schedule. Operator concerns (delete, schedule
    // editing) live in the builder's Cloud → Automations rail item.
    let automationsHost: HTMLElement | null = null;
    if (appId) {
      automationsHost = el('div', { class: 'cd-app-settings-section-host' });
      panel.append(automationsHost);
      void window.CentraidApi.listAutomations({ appId }).then((rows) => {
        if (!automationsHost || !document.contains(panel)) return;
        if (rows.length === 0) return;
        automationsHost.replaceChildren(renderAutomationsSection(rows, appId, panel));
      });
    }

    // Manage
    const manage = el('div', { class: 'cd-app-settings-manage' });
    manage.append(
      appSettingsMenuItem('Pencil', 'Rename', () => {
        closeAppSettings();
        void renameAppFromSettings(app);
      }),
      appSettingsMenuItem('Share', 'Share', () => {
        closeAppSettings();
        openShareDialog(app);
      }),
      appSettingsMenuItem('Folder', 'Reveal in Finder', () => {
        closeAppSettings();
        void revealApp(app);
      }),
      appSettingsMenuItem(
        'Trash',
        'Delete app',
        () => {
          closeAppSettings();
          void deleteApp(app);
        },
        { destructive: true },
      ),
    );
    panel.append(manage);

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
    const list = el('div', { class: 'cd-app-runs-list' });
    for (const run of runs) list.append(renderRunRow(appId, run));
    host.replaceChildren(list);
  }

  function renderRunRow(appId: string, run: CentraidAutomationRunRecord): HTMLElement {
    const card = el('div', { class: 'cd-app-run', 'data-ok': String(run.ok) });
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
    card.append(head, nodesHost);
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
    const list = el('div', { class: 'cd-app-run-node-list' });
    for (const node of nodes) list.append(renderNodeRow(node));
    host.replaceChildren(list);
  }

  function renderNodeRow(node: CentraidAutomationRunNode): HTMLElement {
    const wrap = el('div', { class: 'cd-app-run-node', 'data-ok': String(node.ok) });
    const head = el('div', { class: 'cd-app-run-node-head' }, [
      el('span', { class: 'cd-app-run-node-pos' }, `#${node.ordinal}`),
      el('span', { class: 'cd-app-run-node-kind' }, node.kind),
      el('span', { class: 'cd-app-run-node-name' }, node.name),
      ...(node.batchId !== undefined
        ? [el('span', { class: 'cd-app-run-node-batch' }, `batch ${node.batchId}`)]
        : []),
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
    return wrap;
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
    onClick: () => void,
    opts: { destructive?: boolean } = {},
  ): HTMLElement {
    const btn = el('button', {
      class: 'cd-app-settings-menu-item',
      type: 'button',
      'data-danger': opts.destructive ? 'true' : undefined,
      onClick,
    });
    btn.innerHTML = `${Icon[iconKey]({ size: 13 })}<span>${label}</span>`;
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

    const main = el('div');
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);

    // Constrain the form to a readable width inside the wider main panel;
    // the drawer-* classes were authored for a ~360px column so giving them
    // a similar max-width here preserves their visual rhythm.
    const page = el('div', {
      style: {
        margin: '0 auto',
        maxWidth: '720px',
        padding: '28px 32px 48px',
        width: '100%',
      },
    });

    page.append(
      el(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            marginBottom: '20px',
          },
        },
        [
          el('h1', { style: { fontSize: '24px', fontWeight: '600', margin: '0' } }, 'Settings'),
          el(
            'div',
            { class: 'settings-hint', style: { margin: '0' } },
            'Appearance and gateway preferences for Centraid.',
          ),
        ],
      ),
    );

    // ---- Tweaks — Theme group ----
    const themeSeg = makeSegmented<ThemeName>(['dark', 'light'], prefs.theme, (v) => {
      setPrefs({ theme: v });
    });
    const coolCastSwitch = makeSwitch(prefs.coolBlueCast, (v) => setPrefs({ coolBlueCast: v }));
    const accentSwatches = makeSwatches(prefs.accent, (v) => setPrefs({ accent: v }));

    // ---- Tweaks — Layout group ----
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

    page.append(
      drawerGroup('Theme', [
        el('div', { class: 'settings-note' }, 'Changes are saved automatically.'),
        drawerRow('Mode', themeSeg),
        drawerRowInline('Cool blue cast', coolCastSwitch),
        drawerRow('Accent', accentSwatches),
      ]),
      drawerGroup('Layout', [
        drawerRow('Density', densitySeg),
        drawerRow('Cards', cardsSeg),
        drawerRowInline('Sidebar visible', sidebarSwitch),
      ]),
      drawerGroup('App tiles', [drawerRow('Treatment', tileSeg)]),
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

    page.append(
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
      const providerRow = (params: {
        title: string;
        subtitle: string;
        connected: boolean;
        accent: string;
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

    page.append(
      drawerGroup('AI providers', [
        el(
          'div',
          { class: 'settings-note' },
          'Centraid auto-imports your Claude Code and Codex credentials on first launch so the coding agent rides on your existing subscription. Codex is preferred when both are present.',
        ),
        authStatusHost,
        el('div', { class: 'sheet-actions' }, [resyncBtn]),
      ]),
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

    page.append(
      drawerGroup('Custom inference endpoint', [
        el(
          'div',
          { class: 'settings-note' },
          'Route Codex through any OpenAI-compatible endpoint (Ollama, vLLM, Groq, Together, LM Studio). Your ~/.codex/auth.json and config.toml are not touched — Centraid materializes a scoped CODEX_HOME for the spawned process.',
        ),
        labeled('Preset', 'Fill the fields below from a known provider.', presetSelect),
        labeled(
          'Provider id',
          'Used as the [model_providers.<id>] key in codex config.',
          providerIdInput,
        ),
        labeled('Display name', 'Shown in codex logs.', providerNameInput),
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
        labeled(
          'API key',
          'Stored encrypted via OS keychain. Never written to disk in plaintext.',
          apiKeyInput,
        ),
        el('div', { class: 'drawer-row' }, [
          el('span', { class: 'drawer-row-label' }, 'Key status'),
          apiKeyStatusEl,
        ]),
        providerStatusEl,
        el('div', { class: 'sheet-actions' }, [saveProviderBtn, testProviderBtn, clearProviderBtn]),
      ]),
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

    page.append(
      drawerGroup('Runtime', [
        el(
          'div',
          { class: 'settings-note' },
          'Where centraid runs your apps. Changes apply when you save.',
        ),
        drawerRow('Mode', modeSeg),
        remoteRowsHost,
        labeled(
          'Projects directory',
          'Where each app project is scaffolded. Tilde is expanded to your home directory.',
          projectsDir,
        ),
        el('div', { class: 'sheet-actions' }, [testBtn, saveBtn]),
      ]),
    );

    scroll.append(page);

    const sidebar = buildHomeSidebar('settings');
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

  function drawerGroup(label: string, rows: HTMLElement[]): HTMLElement {
    return el('div', { class: 'drawer-group' }, [
      el('div', { class: 'drawer-group-label' }, label),
      ...rows,
    ]);
  }
  function drawerRow(label: string, control: HTMLElement): HTMLElement {
    return el('div', { class: 'drawer-row' }, [
      el('span', { class: 'drawer-row-label' }, label),
      control,
    ]);
  }
  // Inline variant — label on the left, control on the right (used by the
  // Tweaks switches "Cool blue cast" and "Sidebar visible").
  function drawerRowInline(label: string, control: HTMLElement): HTMLElement {
    return el('div', { class: 'drawer-row drawer-row-inline' }, [
      el('span', { class: 'drawer-row-label' }, label),
      control,
    ]);
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
  function makeSwatches(selected: AccentKey, onSelect: (value: AccentKey) => void): HTMLElement {
    const order: AccentKey[] = ['blue', 'violet', 'teal', 'ochre', 'rose'];
    const wrap = el('div', { class: 'cd-swatches', role: 'radiogroup', 'aria-label': 'Accent' });
    for (const key of order) {
      const swatch = ACCENT_PALETTE[key];
      const btn = el('button', {
        'aria-checked': String(key === selected),
        'aria-label': key,
        class: 'cd-swatch',
        'data-active': String(key === selected),
        role: 'radio',
        style: { background: swatch.accent },
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
    renderHome,
    getRuntimeMode: () => currentRuntimeMode,
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctxMenu) {
      closeContextMenu();
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
