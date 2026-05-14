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
    // (packages/app-templates/*/index.html) listens for this and flips
    // [data-theme] + --bg-l on its own <html>.
    broadcastThemeToFrames();
  }

  function broadcastThemeToFrames(): void {
    const payload = { type: 'centraid:theme', theme: prefs.theme, bgL: prefs.bgL };
    const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-centraid-app]');
    frames.forEach((f) => {
      try {
        f.contentWindow?.postMessage(payload, '*');
      } catch {
        // cross-origin postMessage cannot throw, but contentWindow access can
      }
    });
  }
  applyPrefs();

  function setPrefs(patch: Partial<AppearancePrefs>): void {
    prefs = { ...prefs, ...patch };
    Store.set('appearance', prefs);
    applyPrefs();
  }

  // Track the current cd-window setter so the sidebar toggle can flip the
  // animated grid without rebuilding the page. Reset on every clear().
  let currentSetSidebarOpen: ((open: boolean) => void) | null = null;

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
      onHome: renderHome,
      onNewApp: openNewAppSheet,
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

    // Your apps section
    const totalApps = getApps().length;
    const totalDrafts = drafts.length;
    if (totalApps + totalDrafts > 0) {
      const section = el('section', { class: 'cd-section' });
      const head = el('div', { class: 'cd-section-head' }, [
        el('h2', {}, 'Your apps'),
        el(
          'span',
          { class: 'cd-section-meta' },
          `${totalApps} ${totalApps === 1 ? 'app' : 'apps'}${totalDrafts > 0 ? ` · ${totalDrafts} draft${totalDrafts === 1 ? '' : 's'}` : ''}`,
        ),
      ]);
      const grid = el('div', { class: 'cd-apps-grid' });
      for (const app of getApps()) grid.append(renderAppCard(app));
      for (const d of drafts) grid.append(renderAppCard(d));
      section.append(head);
      section.append(grid);
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

  function renderAppCard(app: AppMetaResolvedType): HTMLElement {
    const draft = isDraft(app);
    const status: 'new' | 'draft' | null = draft ? 'draft' : isUserApp(app.id) ? 'new' : null;
    const card = el('button', {
      class: 'cd-app-card',
      type: 'button',
      onClick: () => (draft ? enterBuilder({ appContext: app }) : openApp(app.id)),
      onContextmenu: (e: Event) => {
        e.preventDefault();
        const me = e as MouseEvent;
        openContextMenu(app, me.clientX, me.clientY);
      },
    });

    // Halo glow tinted by app color — bg.jsx uses `${color}33` (20% alpha)
    // and no CSS opacity layer. Larger radius than the design (180×180 vs
    // 140×140) compensates for the desktop renderer's darker default base
    // background and pushes the glow under the icon a little further.
    const halo = el('span', { class: 'cd-app-card-halo' });
    halo.style.background = `radial-gradient(circle, ${app.color}66 0%, ${app.color}22 35%, transparent 70%)`;
    card.append(halo);

    // Head row: tile icon + status pill
    const head = el('div', { class: 'cd-app-card-head' });
    const iconEl = el('div', {
      class: 'cd-app-card-icon',
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 24, strokeWidth: 1.85 }) : '',
    });
    const finish = window.CentraidTokens.tileFinish(app.color, prefs.tileVariant);
    iconEl.style.background = finish.background;
    iconEl.style.color = finish.glyphColor;
    if (finish.boxShadow) iconEl.style.boxShadow = finish.boxShadow;
    head.append(iconEl);
    card.append(head);

    // Status pill — pinned to the card's top-right corner (independent of
    // the icon row's vertical extent). z-index keeps it above the halo.
    if (status) {
      const pill = el('span', { class: 'cd-status cd-status-corner', 'data-tone': status });
      pill.append(el('span', { class: 'cd-status-dot' }));
      pill.append(document.createTextNode(status));
      card.append(pill);
    }

    // Body
    const body = el('div', {});
    body.append(el('div', { class: 'cd-app-card-name' }, app.name));
    body.append(el('div', { class: 'cd-app-card-desc' }, app.desc));
    card.append(body);

    // Meta line — "Edited X ago" for published apps (timestamp comes from
    // userApps[*].updatedAt, backfilled by the v3 migration). Drafts have
    // no published lineage yet, so they get a verb-cued "Continue editing"
    // instead of a timestamp.
    const meta = el('div', { class: 'cd-app-card-meta' });
    const ua = !draft ? findUserApp(app.id) : undefined;
    const metaLabel = draft ? 'Continue editing' : `Edited ${relativeTime(ua?.updatedAt)}`;
    meta.innerHTML = `${Icon.Pencil({ size: 11 })}<span>${metaLabel}</span>`;
    card.append(meta);
    return card;
  }

  function renderTemplateCard(tmpl: TemplateEntry): HTMLElement {
    const color = (window.ICON_PALETTE as Record<string, string>)[tmpl.colorKey] || '#7C5BD9';
    const card = el(
      'button',
      {
        class: 'cd-tmpl-card',
        type: 'button',
        onClick: () => void cloneTemplate(tmpl),
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
    return card;
  }

  // ---------- Context menu ----------
  let ctxBackdrop: HTMLElement | null = null;
  let ctxMenu: HTMLElement | null = null;

  function closeContextMenu(): void {
    if (ctxBackdrop) {
      ctxBackdrop.remove();
    }
    if (ctxMenu) {
      ctxMenu.remove();
    }
    ctxBackdrop = null;
    ctxMenu = null;
  }

  interface CtxItem {
    id: 'open' | 'update' | 'delete' | 'share';
    label: string;
    icon: IconNameType;
    danger?: boolean;
  }

  function openContextMenu(app: AppMetaResolvedType, x: number, y: number): void {
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

    // Drafts have no published runtime, so "Open" and "Share" are hidden
    // — only Edit (back to builder) and Delete (rm the project dir) make
    // sense. Published apps additionally get Share.
    const items: (CtxItem | 'sep')[] = isDraft(app)
      ? [
          { icon: 'Sparkle', id: 'update', label: 'Continue editing' },
          'sep',
          { danger: true, icon: 'Trash', id: 'delete', label: 'Delete draft' },
        ]
      : [
          { icon: 'Eye', id: 'open', label: 'Open' },
          { icon: 'Sparkle', id: 'update', label: 'Edit with Centraid' },
          { icon: 'Share', id: 'share', label: 'Share' },
          'sep',
          { danger: true, icon: 'Trash', id: 'delete', label: 'Delete' },
        ];

    ctxMenu = el('div', { class: 'ctx-menu' });
    for (const it of items) {
      if (it === 'sep') {
        ctxMenu.append(el('div', { class: 'ctx-sep' }));
        continue;
      }
      const btn = el('button', {
        class: 'ctx-item',
        'data-danger': String(!!it.danger),
        onClick: () => {
          closeContextMenu();
          handleAction(it.id, app);
        },
      });
      btn.innerHTML = `${Icon[it.icon]({ size: 15 })}<span>${it.label}</span>`;
      ctxMenu.append(btn);
    }
    document.body.append(ctxMenu);

    const w = ctxMenu.offsetWidth;
    const h = ctxMenu.offsetHeight;
    const px = Math.min(x, window.innerWidth - w - 8);
    const py = Math.min(y, window.innerHeight - h - 8);
    ctxMenu.style.left = `${px}px`;
    ctxMenu.style.top = `${py}px`;
  }

  function handleAction(id: CtxItem['id'], app: AppMetaResolvedType): void {
    if (id === 'open') {
      openApp(app.id);
    } else if (id === 'update') {
      enterBuilder({ appContext: app });
    } else if (id === 'delete') {
      void deleteApp(app);
    } else if (id === 'share') {
      openShareDialog(app);
    }
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
   * Returns the bundled templates that aren't already installed (by exact id
   * match against `userApps`). Failures are swallowed — an offline or broken
   * templates IPC just hides the inline strip; the rest of the home keeps
   * rendering.
   */
  async function loadAvailableTemplates(): Promise<TemplateEntry[]> {
    try {
      const all = (await window.CentraidApi.listTemplates()) as TemplateEntry[];
      const installedIds = new Set(userApps.map((u) => u.id));
      return all.filter((t) => !installedIds.has(t.id));
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
      enterBuilder({ appContext: draft });
    } catch (err) {
      showToast(`Clone failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function enterBuilder(
    opts: { initialPrompt?: string; appContext?: AppMetaResolvedType } = {},
  ): void {
    recordRoute({ kind: 'builder', ...opts });
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
    currentCleanup =
      window.openBuilder({
        root,
        el,
        onExit: renderHome,
        ...opts,
        ...(projectId ? { projectId } : {}),
        ...chromeNav(),
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
    recordRoute({ id, kind: 'app' });
    // Every app on the grid is a user app now (built-ins were retired in
    // favour of templates), so we always mount via the iframe-backed path.
    const ua = findUserApp(id);
    clear();

    // Titlebar right cluster: brand chip with app icon + name, then the
    // floating Edit pill that returns to the builder.
    const brandChip = el('span', { class: 'cd-brand-chip' });
    brandChip.append(
      el('span', {
        class: 'cd-app-strip-icon',
        style: { background: app.color, width: '18px', height: '18px', borderRadius: '4px' },
        trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 11, strokeWidth: 2 }) : '',
      }),
    );
    brandChip.append(el('span', { class: 'cd-brand-chip-name' }, app.name));
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
    titlebarRight.append(editPill);

    // Main area: the running app fills the canvas inside a scrollable column.
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
      currentCleanup = null;
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

      // Resolve the live URL and load it. The hash carries the initial
      // theme so the app paints in the correct mode on first load — without
      // the hash there's a brief flash of light theme before postMessage
      // arrives.
      void window.CentraidApi.appLiveUrl({ id: ua.centraidProjectId })
        .then((r) => {
          const sep = r.url.includes('#') ? '&' : '#';
          frame.src = `${r.url}${sep}theme=${prefs.theme}&bgL=${prefs.bgL}`;
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
    // Dark shade is locked at 5 — slider is presentational only.
    const shadeRow = makeSliderRow(prefs.bgL, 0, 35, 1, () => {}, { disabled: true });
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
        shadeRow.row,
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
          await window.CentraidApi.saveSettings({
            projectsDir: projectsDir.value.trim(),
            runtimeMode,
            remoteGatewayUrl: remoteUrl.value.trim(),
            remoteGatewayToken: remoteToken.value,
          });
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
  function makeSliderRow(
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (next: number) => void,
    opts: { disabled?: boolean } = {},
  ): { row: HTMLElement; readout: HTMLElement } {
    const readout = el('span', { class: 'cd-slider-readout' }, String(value));
    const inputAttrs: ElAttrs = {
      class: 'cd-slider',
      max: String(max),
      min: String(min),
      step: String(step),
      type: 'range',
      value: String(value),
      onInput: (e: Event) => {
        const next = Number((e.target as HTMLInputElement).value);
        readout.textContent = String(next);
        onChange(next);
      },
    };
    if (opts.disabled) inputAttrs.disabled = '';
    const input = el('input', inputAttrs) as HTMLInputElement;
    const row = el('div', { class: 'drawer-row' }, [
      el('div', { class: 'cd-slider-head' }, [
        el('span', { class: 'drawer-row-label' }, 'Dark shade'),
        readout,
      ]),
      input,
    ]);
    if (opts.disabled) row.dataset.disabled = 'true';
    return { readout, row };
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
      btn.innerHTML = Icon.Check({ size: 14 });
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
    openBuilder: openNewAppSheet,
    openShare: openShareDialog,
    openSettings: renderSettings,
    renderHome,
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

  renderHome();
})();
