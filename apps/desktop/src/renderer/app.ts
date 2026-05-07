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
  let userApps = Store.get<AppMetaResolvedType[]>('home.userApps', []);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function persist(): void {
    Store.set('home.deletedBuiltins', [...deletedBuiltins]);
    Store.set('home.userApps', userApps);
  }

  function getApps(): AppMetaResolvedType[] {
    return BUILTIN_APPS.filter((a) => !deletedBuiltins.has(a.id)).concat(userApps);
  }
  function findApp(id: string): AppMetaResolvedType | undefined {
    return getApps().find((a) => a.id === id);
  }
  function isUserApp(id: string): boolean {
    return id.startsWith('usr_');
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

  function renderHome(): void {
    clear();

    const titlebar = el('div', { class: 'titlebar' }, [
      el('span', { class: 'wordmark' }, 'M'),
      el('span', { class: 'crumb' }, 'Centraid'),
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
    const tile = el(
      'button',
      {
        class: 'app-tile',
        onClick: () => openApp(app.id),
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
        isUserApp(app.id) ? el('span', { class: 'tile-badge' }, 'NEW') : null,
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

    const items: (CtxItem | 'sep')[] = [
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
    if (isUserApp(app.id)) {
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
    currentCleanup =
      window.openBuilder({
        root,
        el,
        onExit: renderHome,
        ...opts,
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
    color?: ColorHexType;
    iconKey?: IconNameType;
  }): AppMetaResolvedType {
    const meta = inferAppMeta(input.prompt || '');
    const newApp: AppMetaResolvedType = {
      color: input.color || meta.color,
      colorKey: 'violet',
      desc: input.prompt && input.prompt.length <= 60 ? input.prompt : 'Built with Centraid.',
      iconKey: input.iconKey || meta.iconKey,
      id: 'usr_' + Math.random().toString(36).slice(2, 9),
      name: input.name || meta.name,
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
    const def = isUserApp(id)
      ? { mount: (c: HTMLElement) => mountUserApp(app, c) }
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

  function mountUserApp(app: AppMetaResolvedType, container: HTMLElement): void {
    const header = el('div', { class: 'app-header' }, [
      el('div', {}, [
        el('h1', { class: 'app-title' }, app.name),
        el('p', { class: 'app-subtitle' }, 'Built with Centraid'),
      ]),
    ]);
    container.append(header);

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
              "The Builder hasn't generated real code yet — open it again to keep iterating on the design.",
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

  // Expose helpers to other modules.
  window.Centraid = { el, openApp, openBuilder: openNewAppSheet, renderHome };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctxMenu) {
      closeContextMenu();
    }
  });

  renderHome();
})();
