// Centraid shell — renders the home screen and routes to apps.
// Built-in apps register on window.CentraidApps with { mount(container) }.
// User-built apps live in localStorage and render via a generic mock view.

(function () {
  const root = document.querySelector('#root') as HTMLElement;

  // Built-in app catalog comes from @centraid/design-tokens via preload —
  // shared with mobile so both home grids stay in sync.
  const BUILTIN_APPS: AppMetaResolvedType[] = window.CentraidTokens?.apps ?? [];

  // Persistent state: which built-ins the user removed, and user-built apps.
  const deletedBuiltins = new Set<string>(Store.get<string[]>('home.deletedBuiltins', []));
  let userApps = Store.get<UserAppMeta[]>('home.userApps', []);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function persist(): void {
    Store.set('home.deletedBuiltins', [...deletedBuiltins]);
    Store.set('home.userApps', userApps);
  }

  // Drafts: projects that exist on disk under <projectsDir>/<id>/ but were
  // never "Add to home"-d. Hydrated from listProjects() on each home render
  // so newly scaffolded projects show up without a manual refresh.
  let drafts: DraftAppMeta[] = [];

  function getApps(): AppMetaResolvedType[] {
    return BUILTIN_APPS.filter((a) => !deletedBuiltins.has(a.id)).concat(userApps);
  }
  function getAppsWithDrafts(): AppMetaResolvedType[] {
    return [...getApps(), ...drafts];
  }
  function isDraftApp(id: string): boolean {
    return drafts.some((d) => d.id === id);
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
            desc: 'Draft — not yet published',
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
      class: 'btn-icon titlebar-action',
      trustedHtml: Icon.Settings({ size: 16 }),
      onClick: () => void openSettingsSheet(),
    });

    const titlebar = el('div', { class: 'titlebar' }, [
      el('span', { class: 'wordmark' }, 'M'),
      el('span', { class: 'crumb' }, 'Centraid'),
      el('div', { class: 'spacer' }),
      settingsBtn,
    ]);

    const hero = el('div', { class: 'home-hero' }, [
      el('div', { class: 'wordmark' }, 'M'),
      el('div', {}, [
        el('h1', {}, 'Your tiny apps.'),
        el(
          'p',
          {},
          'A small home screen of personal apps for the things you do every day. Right-click any tile for options.',
        ),
      ]),
    ]);

    const grid = el('div', { class: 'home-grid' });
    for (const app of getApps()) {
      grid.append(renderTile(app));
    }

    // Refresh drafts from disk and append after the published apps so the
    // user sees in-progress projects without losing them when they back out
    // of the builder before publishing.
    await hydrateDrafts();
    for (const d of drafts) {
      grid.append(renderTile(d));
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
        el('div', { class: 'app-tile-desc' }, 'Describe what you want.'),
      ],
    );
    grid.append(newTile);

    const home = el('div', { class: 'home' }, [
      hero,
      el('div', { class: 'home-section-title' }, 'Apps'),
      grid,
    ]);

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
        el('div', {
          class: 'app-icon',
          trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 28, strokeWidth: 1.75 }) : '',
          style: { background: app.color },
        }),
        el('div', { class: 'app-tile-name' }, app.name),
        el('div', { class: 'app-tile-desc' }, app.desc),
        (() => {
          const btn = el('span', {
            'aria-label': 'More',
            class: 'tile-more-btn',
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
    id: 'open' | 'update' | 'delete';
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

    // Drafts have no published runtime, so "Open" is hidden — only Edit
    // (back to builder) and Delete (rm the project dir) make sense.
    const items: (CtxItem | 'sep')[] = isDraft(app)
      ? [
          { icon: 'Sparkle', id: 'update', label: 'Continue editing' },
          'sep',
          { danger: true, icon: 'Trash', id: 'delete', label: 'Delete draft' },
        ]
      : [
          { icon: 'Eye', id: 'open', label: 'Open' },
          { icon: 'Sparkle', id: 'update', label: 'Edit with Centraid' },
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
      deleteApp(app);
    }
  }

  function deleteApp(app: AppMetaResolvedType): void {
    if (isDraft(app)) {
      // Drafts only live on disk. Wipe the project directory; on success,
      // re-render so the tile disappears.
      void window.CentraidApi.deleteProject({ id: app.id })
        .then(() => {
          showToast(`Deleted draft "${app.name}"`);
          renderHome();
        })
        .catch((err) => showToast(`Could not delete draft: ${String(err)}`));
      return;
    }
    if (isUserApp(app.id)) {
      // Best-effort: tell the gateway to forget the app too.
      const ua = findUserApp(app.id);
      if (ua?.centraidProjectId) {
        void window.CentraidApi.deregisterApp({ id: ua.centraidProjectId }).catch(() => undefined);
      }
      // Also remove the project files on disk so a freshly-deleted user
      // app doesn't reappear as a draft on the next render.
      void window.CentraidApi.deleteProject({ id: app.id }).catch(() => undefined);
      userApps = userApps.filter((a) => a.id !== app.id);
    } else {
      deletedBuiltins.add(app.id);
    }
    persist();
    showToast(`Removed "${app.name}"`);
    renderHome();
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
    const card = el('div', { class: 'modal-card' });

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

    const cancelBtn = el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancel');

    card.append(el('h3', {}, 'What should we build?'));
    card.append(el('p', {}, 'Describe your app in a sentence or two. You can iterate from there.'));
    card.append(ta);
    card.append(chips);
    card.append(el('div', { class: 'sheet-actions' }, [cancelBtn, generateBtn]));

    backdrop.addEventListener('click', () => close());
    document.body.append(backdrop);
    document.body.append(card);
    setTimeout(() => ta.focus(), 30);

    function close(): void {
      backdrop.remove();
      card.remove();
    }
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
      }) ?? null;
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
      existing.desc =
        input.prompt && input.prompt.length <= 60 ? input.prompt : existing.desc;
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
    const ua = isUserApp(id) ? findUserApp(id) : undefined;
    const def = isUserApp(id)
      ? { mount: (c: HTMLElement) => mountUserApp(app, ua, c) }
      : window.CentraidApps?.[id];
    if (!def) {
      console.error('No implementation for app:', id);
      return;
    }
    clear();

    const titlebar = el('div', { class: 'titlebar' }, [
      el('span', { class: 'wordmark', onClick: renderHome, style: { cursor: 'pointer' } }, 'M'),
      el('span', { class: 'crumb', onClick: renderHome, style: { cursor: 'pointer' } }, 'Centraid'),
      el('span', { class: 'crumb-sep' }, '/'),
      el('span', {}, app.name),
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
      currentCleanup = (def.mount(inner, { app, el }) as (() => void) | void) ?? null;
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
        sandbox: 'allow-scripts allow-forms',
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
            onClick: () => deleteApp(app),
          }),
        ]),
      ]),
    ]);
    container.append(stub);
  }

  // ---------- Settings sheet ----------
  async function openSettingsSheet(): Promise<void> {
    const current = await window.CentraidApi.getSettings().catch(() => ({
      gatewayUrl: 'http://127.0.0.1:7575',
      gatewayToken: '',
      projectsDir: '~/centraid-projects',
    }));

    const backdrop = el('div', { class: 'modal-backdrop' });
    const card = el('div', { class: 'modal-card' });

    const gatewayUrl = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'http://127.0.0.1:7575',
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

    const close = (): void => {
      backdrop.remove();
      card.remove();
    };

    const saveBtn = el('button', {
      class: 'btn btn-primary',
      onClick: async () => {
        try {
          await window.CentraidApi.saveSettings({
            gatewayUrl: gatewayUrl.value.trim(),
            gatewayToken: gatewayToken.value,
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

    const cancelBtn = el('button', { class: 'btn btn-ghost', onClick: close }, 'Cancel');

    const labeled = (label: string, hint: string, input: HTMLElement): HTMLElement =>
      el('div', { class: 'settings-field' }, [
        el('label', { class: 'settings-label' }, label),
        input,
        el('div', { class: 'settings-hint' }, hint),
      ]);

    card.append(el('h3', {}, 'Settings'));
    card.append(
      el(
        'p',
        {},
        'Where centraid stores your projects on disk and how to reach the openclaw gateway that hosts published apps.',
      ),
    );
    card.append(
      labeled('Gateway URL', 'Base URL of the openclaw gateway (typically loopback).', gatewayUrl),
    );
    card.append(
      labeled(
        'Gateway token',
        'From ~/.openclaw/openclaw.json → gateway.auth.token. Leave empty if the gateway runs in mode "none".',
        gatewayToken,
      ),
    );
    card.append(
      labeled(
        'Projects directory',
        'Where each app project is scaffolded. Tilde is expanded to your home directory.',
        projectsDir,
      ),
    );
    card.append(el('div', { class: 'sheet-actions' }, [cancelBtn, saveBtn]));

    backdrop.addEventListener('click', close);
    document.body.append(backdrop);
    document.body.append(card);
    setTimeout(() => gatewayUrl.focus(), 30);
  }

  // Expose helpers to other modules.
  window.Centraid = {
    el,
    openApp,
    openBuilder: openNewAppSheet,
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
