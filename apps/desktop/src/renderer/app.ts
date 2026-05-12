// Centraid shell — renders the home screen and routes to apps.
// Every app the user sees is centraid-backed: cloned from a template or
// authored in the builder, published to the gateway, rendered through a
// sandboxed iframe. The home grid also shows uninstalled templates inline
// so they're one tap away from being cloned & deployed.
// governance: allow-repo-hygiene file-size-limit shell-entry-point pending split into route modules

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" style="display:block;width:100%;height:100%"><path d="M 52.82 52.82 A 95 95 0 0 1 187.18 52.82 L 161.01 78.99 A 58 58 0 0 0 78.99 78.99 Z" fill="#8B5CF6"/><path d="M 52.82 187.18 A 95 95 0 0 1 52.82 52.82 L 78.99 78.99 A 58 58 0 0 0 78.99 161.01 Z" fill="#F59E0B"/><path d="M 187.18 187.18 A 95 95 0 0 1 52.82 187.18 L 78.99 161.01 A 58 58 0 0 0 161.01 161.01 Z" fill="#06B6D4"/><circle cx="120" cy="120" r="12" fill="#E11D48"/></svg>`;

(function () {
  const root = document.querySelector('#root') as HTMLElement;

  // Apps the user has installed (cloned from a template or built themselves).
  // The home grid renders these plus uninstalled templates inline.
  let userApps = Store.get<UserAppMeta[]>('home.userApps', []);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Renderer prefs — appearance settings live here (vs gateway settings,
  // which live in the main process via window.CentraidApi.getSettings).
  type ThemeName = 'light' | 'dark';
  type Density = 'compact' | 'regular' | 'comfy';
  type TileVariant = 'solid' | 'gradient' | 'glassy' | 'flat';
  interface AppearancePrefs {
    theme: ThemeName;
    density: Density;
    tileVariant: TileVariant;
  }
  const DEFAULT_PREFS: AppearancePrefs = {
    density: 'regular',
    theme: 'light',
    tileVariant: 'solid',
  };
  let prefs: AppearancePrefs = {
    ...DEFAULT_PREFS,
    ...Store.get<Partial<AppearancePrefs>>('appearance', {}),
  };

  function applyPrefs(): void {
    const html = document.documentElement;
    html.dataset.theme = prefs.theme;
    html.dataset.density = prefs.density;
  }
  applyPrefs();

  function setPrefs(patch: Partial<AppearancePrefs>): void {
    prefs = { ...prefs, ...patch };
    Store.set('appearance', prefs);
    applyPrefs();
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
      const draftPalette = (Object.values(window.ICON_PALETTE ?? {}) as ColorHexType[]) || [];
      drafts = projs
        .filter((p) => !knownIds.has(p.id))
        .map((p) => {
          // Stable color/icon per id so a draft tile doesn't reshuffle on
          // every re-render.
          const seed = hashString(p.id);
          const color =
            (draftPalette[seed % Math.max(1, draftPalette.length)] as ColorHexType) ??
            ('#5847e0' as ColorHexType);
          return {
            __draft: true,
            color,
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

  function hashString(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function renderHome(): void {
    void renderHomeAsync();
  }

  async function renderHomeAsync(): Promise<void> {
    clear();

    const settingsBtn = el('button', {
      'aria-label': 'Settings',
      title: 'Settings',
      class: 'btn-icon btn-settings titlebar-action',
      trustedHtml: `${Icon.Settings({ size: 15 })}<span class="btn-settings-label">Settings</span>`,
      onClick: () => void openSettingsSheet(),
    });

    const titlebar = el('div', { class: 'titlebar' }, [
      el('div', { class: 'titlebar-side' }),
      el('div', { class: 'titlebar-brand' }, [
        el('span', { class: 'wordmark', trustedHtml: LOGO_SVG }),
        el('span', { class: 'crumb' }, 'Centraid'),
      ]),
      el('div', { class: 'titlebar-side is-end' }, [settingsBtn]),
    ]);

    const hero = el('div', { class: 'home-hero' }, [
      el('div', { class: 'wordmark', trustedHtml: LOGO_SVG }),
      el('div', { class: 'home-hero-copy' }, [
        el('h1', {}, 'Your tiny apps.'),
        el('p', {}, 'Build, continue, and open personal apps for the things you do every day.'),
      ]),
    ]);

    // Apps section: installed user apps + on-disk drafts + the "New app"
    // tile (the entry point for authoring from scratch). Always rendered —
    // on a clean install it just contains the "New app" tile.
    const appsGrid = el('div', { class: 'home-grid' });
    for (const app of getApps()) {
      appsGrid.append(renderTile(app));
    }
    await hydrateDrafts();
    for (const d of drafts) {
      appsGrid.append(renderTile(d));
    }
    const newTile = el(
      'button',
      {
        class: 'app-tile app-tile-add',
        onClick: openNewAppSheet,
      },
      [
        el('div', {
          class: 'app-icon app-icon-add',
          trustedHtml: Icon.Plus({ size: 28, strokeWidth: 1.75 }),
        }),
        el('div', { class: 'app-tile-name' }, 'New app'),
        el('div', { class: 'app-tile-desc' }, 'Start from a prompt.'),
      ],
    );
    appsGrid.append(newTile);

    // Templates section: pre-built apps available to clone. Hidden once the
    // user has installed everything; reappears when they delete a clone.
    const availableTemplates = await loadAvailableTemplates();
    const homeChildren: (Node | null)[] = [
      hero,
      el('div', { class: 'home-section-title' }, 'Apps'),
      appsGrid,
    ];
    if (availableTemplates.length > 0) {
      const templatesGrid = el('div', { class: 'home-grid' });
      for (const tmpl of availableTemplates) {
        templatesGrid.append(renderTemplateTile(tmpl));
      }
      homeChildren.push(el('div', { class: 'home-section-title' }, 'Templates'), templatesGrid);
    }

    const home = el(
      'div',
      { class: 'home' },
      homeChildren.filter((c): c is Node => c != null),
    );

    root.append(titlebar);
    root.append(home);
  }

  function renderTile(app: AppMetaResolvedType): HTMLElement {
    const draft = isDraft(app);
    const badgeLabel = draft ? 'DRAFT' : isUserApp(app.id) ? 'NEW' : null;
    const tile = el(
      'button',
      {
        class: 'app-tile',
        'data-draft': String(draft),
        // Drafts can't be "opened" — they have no published runtime. Send
        // the user back into the builder instead.
        onClick: () => (draft ? enterBuilder({ appContext: app }) : openApp(app.id)),
        onContextmenu: (e: Event) => {
          e.preventDefault();
          const me = e as MouseEvent;
          openContextMenu(app, me.clientX, me.clientY);
        },
      },
      [
        (() => {
          // Compute the tile's visual treatment in TS (single source of
          // truth, shared with mobile) and apply directly as inline style —
          // no per-variant CSS rules in styles.css, no `--tile-color` plumbing.
          const finish = window.CentraidTokens.tileFinish(app.color, prefs.tileVariant);
          const iconEl = el('div', {
            class: 'app-icon',
            trustedHtml: Icon[app.iconKey]
              ? Icon[app.iconKey]({ size: 28, strokeWidth: 1.75 })
              : '',
          });
          iconEl.style.background = finish.background;
          iconEl.style.color = finish.glyphColor;
          if (finish.boxShadow) iconEl.style.boxShadow = finish.boxShadow;
          if (finish.backdropFilter) {
            iconEl.style.backdropFilter = finish.backdropFilter;
            iconEl.style.setProperty('-webkit-backdrop-filter', finish.backdropFilter);
          }
          return iconEl;
        })(),
        el('div', { class: 'app-tile-name' }, app.name),
        el('div', { class: 'app-tile-desc' }, app.desc),
        el('span', { class: 'tile-action-label' }, draft ? 'Continue editing' : 'Open app'),
        (() => {
          const btn = el('button', {
            'aria-label': 'More',
            class: 'tile-more-btn',
            type: 'button',
            onClick: (e: Event) => {
              e.stopPropagation();
              e.preventDefault();
              const r = (btn as HTMLElement).getBoundingClientRect();
              openContextMenu(app, r.right, r.bottom + 4);
            },
          });
          btn.innerHTML = Icon.MoreHoriz({ size: 14 });
          return btn;
        })(),
        badgeLabel
          ? el('span', { class: 'tile-badge', 'data-kind': draft ? 'draft' : 'new' }, badgeLabel)
          : null,
      ],
    );
    return tile;
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

  function renderTemplateTile(tmpl: TemplateEntry): HTMLElement {
    const palette = window.CentraidTokens.palette as unknown as Record<string, ColorHexType>;
    const color: ColorHexType = palette[tmpl.colorKey] ?? ('#5847e0' as ColorHexType);
    const finish = window.CentraidTokens.tileFinish(color, prefs.tileVariant);

    const iconRenderer = (Icon as unknown as Record<string, IconRenderer>)[tmpl.iconKey];
    const iconEl = el('div', {
      class: 'app-icon',
      trustedHtml: iconRenderer ? iconRenderer({ size: 28, strokeWidth: 1.75 }) : '',
    });
    iconEl.style.background = finish.background;
    iconEl.style.color = finish.glyphColor;
    if (finish.boxShadow) iconEl.style.boxShadow = finish.boxShadow;
    if (finish.backdropFilter) {
      iconEl.style.backdropFilter = finish.backdropFilter;
      iconEl.style.setProperty('-webkit-backdrop-filter', finish.backdropFilter);
    }

    // The "Templates" section title carries the "this is a template" cue,
    // so no per-tile badge — keeps the tile visually identical to a real
    // app, which is honest about what happens on tap.
    const tile = el(
      'button',
      {
        class: 'app-tile app-tile-template',
        'data-template-id': tmpl.id,
      },
      [
        iconEl,
        el('div', { class: 'app-tile-name' }, tmpl.name),
        el('div', { class: 'app-tile-desc' }, tmpl.desc),
        el('span', { class: 'tile-action-label' }, 'Clone template'),
      ],
    );

    tile.addEventListener('click', () => {
      if (tile.dataset.installing === 'true') return;
      tile.dataset.installing = 'true';
      tile.classList.add('app-tile-installing');
      void (async () => {
        try {
          const result = await window.CentraidApi.cloneTemplate({ templateId: tmpl.id });
          // Clone only lays the project down on disk. Drop the user straight
          // into the builder so they can edit/preview; on exit, the new
          // project surfaces as a DRAFT tile (hydrateDrafts picks it up) and
          // the user explicitly clicks Publish to upload to the gateway.
          const draft: DraftAppMeta = {
            __draft: true,
            color,
            colorKey: tmpl.colorKey as DraftAppMeta['colorKey'],
            // Surface the real template description in the builder topbar;
            // cloneTemplate has already persisted it to `app.json` so
            // hydrateDrafts will pick it up on subsequent renders too.
            desc: result.project.description || tmpl.desc,
            hasIndex: true,
            iconKey: tmpl.iconKey as IconNameType,
            id: result.project.id,
            name: result.template.name,
          };
          enterBuilder({ appContext: draft });
        } catch (err) {
          tile.dataset.installing = 'false';
          tile.classList.remove('app-tile-installing');
          showToast(`Clone failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    });

    return tile;
  }

  function enterBuilder(
    opts: { initialPrompt?: string; appContext?: AppMetaResolvedType } = {},
  ): void {
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
  const COLOR_POOL: ColorHexType[] = Object.values(ICON_PALETTE) as ColorHexType[];

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
    const color = COLOR_POOL[Math.floor(Math.random() * COLOR_POOL.length)] ?? COLOR_POOL[0]!;
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
    // Every app on the grid is a user app now (built-ins were retired in
    // favour of templates), so we always mount via the iframe-backed path.
    const ua = findUserApp(id);
    clear();

    const titlebar = el('div', { class: 'titlebar' }, [
      el('div', { class: 'titlebar-side' }),
      el('div', { class: 'titlebar-brand' }, [
        el('span', {
          class: 'wordmark',
          onClick: renderHome,
          style: { cursor: 'pointer' },
          trustedHtml: LOGO_SVG,
        }),
        el(
          'span',
          { class: 'crumb', onClick: renderHome, style: { cursor: 'pointer' } },
          'Centraid',
        ),
        el('span', { class: 'crumb-sep' }, '/'),
        el('span', {}, app.name),
      ]),
      el('div', { class: 'titlebar-side is-end' }),
    ]);

    const topbar = el('div', { class: 'app-topbar' }, [
      el('button', {
        'aria-label': 'Back',
        class: 'btn-icon',
        trustedHtml: Icon.ArrowLeft({ size: 18 }),
        onClick: renderHome,
      }),
      el('div', {
        class: 'app-topbar-icon',
        trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 16, strokeWidth: 2 }) : '',
        style: { background: app.color },
      }),
      el('div', { class: 'app-topbar-name' }, app.name),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-soft',
        trustedHtml: Icon.Sparkle({ size: 13 }) + '<span>Edit</span>',
        onClick: () => enterBuilder({ appContext: app }),
      }),
    ]);

    const view = el('div', { class: 'app-view' });
    const body = el('div', { class: 'app-body' });
    const inner = el('div', { class: 'app-body-inner' });
    body.append(inner);
    view.append(topbar);
    view.append(body);

    inner.style.setProperty('--accent-color', app.color);

    root.append(titlebar);
    root.append(view);

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
    const header = el('div', { class: 'app-header' }, [
      el('div', {}, [
        el('h1', { class: 'app-title' }, app.name),
        el('p', { class: 'app-subtitle' }, 'Built with Centraid'),
      ]),
    ]);
    container.append(header);

    if (ua?.centraidProjectId) {
      // Real centraid app — host its iframe served by the openclaw plugin.
      const frameWrap = el('div', {
        style: {
          background: 'var(--surface, #fff)',
          border: '0.5px solid var(--line, rgba(0,0,0,.08))',
          borderRadius: '14px',
          height: 'calc(100vh - 220px)',
          marginTop: '20px',
          minHeight: '480px',
          overflow: 'hidden',
        },
      });
      const frame = el('iframe', {
        src: 'about:blank',
        style: { border: '0', height: '100%', width: '100%' },
        sandbox: 'allow-scripts allow-forms allow-same-origin',
        referrerpolicy: 'no-referrer',
      }) as HTMLIFrameElement;
      frameWrap.append(frame);
      container.append(frameWrap);

      // Resolve the live URL and load it.
      void window.CentraidApi.appLiveUrl({ id: ua.centraidProjectId })
        .then((r) => {
          frame.src = r.url;
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

  // ---------- Settings drawer ----------
  // Right-side panel per the design system. Two groups:
  //  - Appearance: theme / density / tile treatment (renderer prefs).
  //  - Gateway: openclaw URL / token / projects dir (main-process prefs).
  // Appearance changes apply on click (no save needed); gateway needs a save.
  async function openSettingsSheet(): Promise<void> {
    const current = await window.CentraidApi.getSettings().catch(() => ({
      gatewayUrl: 'http://127.0.0.1:18789',
      gatewayToken: '',
      projectsDir: '~/centraid-projects',
    }));

    const backdrop = el('div', { class: 'drawer-backdrop' });
    const panel = el('div', { class: 'drawer-panel', role: 'dialog', 'aria-label': 'Settings' });

    const close = (): void => {
      backdrop.remove();
      panel.remove();
    };
    backdrop.addEventListener('click', close);

    // Header
    const closeBtn = el('button', {
      'aria-label': 'Close settings',
      class: 'btn-icon',
      trustedHtml: Icon.X({ size: 16 }),
      onClick: close,
    });
    panel.append(el('div', { class: 'drawer-head' }, [el('h3', {}, 'Settings'), closeBtn]));

    const body = el('div', { class: 'drawer-body' });

    // ---- Appearance group ----
    const themeSeg = makeSegmented<ThemeName>(['light', 'dark'], prefs.theme, (v) => {
      setPrefs({ theme: v });
    });
    const densitySeg = makeSegmented<Density>(['compact', 'regular', 'comfy'], prefs.density, (v) =>
      setPrefs({ density: v }),
    );
    const tileSeg = makeSegmented<TileVariant>(
      ['solid', 'gradient', 'glassy', 'flat'],
      prefs.tileVariant,
      (v) => {
        setPrefs({ tileVariant: v });
        if (root.querySelector('.home')) renderHome();
      },
    );

    body.append(
      drawerGroup('Appearance', [
        el('div', { class: 'settings-note' }, 'Appearance changes are saved automatically.'),
        drawerRow('Theme', themeSeg),
        drawerRow('Density', densitySeg),
      ]),
      drawerGroup('App tiles', [drawerRow('Treatment', tileSeg)]),
    );

    // ---- Gateway group ----
    const gatewayUrl = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'http://127.0.0.1:18789',
      value: current.gatewayUrl,
    }) as HTMLInputElement;
    const gatewayToken = el('input', {
      class: 'input',
      type: 'password',
      placeholder: 'paste your gateway.auth.token (leave empty for loopback no-auth)',
      value: current.gatewayToken ?? '',
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

    const saveBtn = el('button', {
      class: 'btn btn-primary',
      onClick: async () => {
        try {
          await window.CentraidApi.saveSettings({
            gatewayToken: gatewayToken.value,
            gatewayUrl: gatewayUrl.value.trim(),
            projectsDir: projectsDir.value.trim(),
          });
          close();
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
          await window.CentraidApi.saveSettings({
            gatewayToken: gatewayToken.value,
            gatewayUrl: gatewayUrl.value.trim(),
            projectsDir: projectsDir.value.trim(),
          });
          const base = gatewayUrl.value.trim().replace(/\/+$/, '');
          const health = await fetch(`${base}/health`).catch(() => null);
          showToast(
            health?.ok ? 'Gateway connection works' : 'Gateway saved. Health check unavailable.',
          );
        } catch (err) {
          showToast(`Gateway check failed: ${String(err)}`);
        }
      },
    });
    testBtn.innerHTML = Icon.Eye({ size: 13 }) + '<span>Test connection</span>';

    body.append(
      drawerGroup('Gateway', [
        el('div', { class: 'settings-note' }, 'Gateway changes are applied when you save.'),
        labeled(
          'Gateway URL',
          'Base URL of the openclaw gateway (typically loopback).',
          gatewayUrl,
        ),
        labeled(
          'Gateway token',
          'From ~/.openclaw/openclaw.json → gateway.auth.token. Leave empty if the gateway runs in mode "none".',
          gatewayToken,
        ),
        labeled(
          'Projects directory',
          'Where each app project is scaffolded. Tilde is expanded to your home directory.',
          projectsDir,
        ),
        el('div', { class: 'sheet-actions' }, [testBtn, saveBtn]),
      ]),
    );

    panel.append(body);
    panel.append(el('div', { class: 'drawer-foot' }, 'Centraid'));

    document.body.append(backdrop);
    document.body.append(panel);
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
    openSettings: openSettingsSheet,
    renderHome,
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctxMenu) {
      closeContextMenu();
    }
  });

  renderHome();
})();
