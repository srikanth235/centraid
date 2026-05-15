// Centraid Bold · Atmospheric chrome — Codex-style window shell.
// Builds the `.cd-window` grid (sidebar column + main column) with
// synthetic traffic lights, sidebar toggle, back/forward arrows, and an
// optional "New app" pencil that surfaces when the sidebar is collapsed.
// Pure builder — Home, App view, and Builder each compose their own page
// by passing a sidebar element and a main element. State (sidebarOpen)
// is owned by the caller; this file exposes a setter that flips the
// data-attribute so the grid animates without a full rebuild.

(function () {
  // The renderer's `el` helper is co-located in app.ts; we re-implement a
  // tiny copy here so chrome.ts can run before app.ts loads.
  function el(tag: string, attrs: ElAttrs = {}, children: ElChild | ElChild[] = []): HTMLElement {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class' && typeof v === 'string') {
        node.className = v;
      } else if (k === 'style' && typeof v === 'object' && v !== null) {
        Object.assign(node.style, v as Partial<CSSStyleDeclaration>);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'trustedHtml' && typeof v === 'string') {
        node.innerHTML = v;
      } else if (v != null && typeof v !== 'function') {
        node.setAttribute(k, String(v));
      }
    }
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c == null || c === false) continue;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ── Inline icons used by chrome that aren't in @centraid/design-tokens
  // (sidebar glyph, project folder, plug icon, etc.). One source of truth so
  // they paint at the same stroke weight as the tokenised set.
  function svg(path: string, size = 15, strokeWidth = 1.7): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }
  const Glyph = {
    sidebarOpen: (size = 15): string =>
      svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>', size),
    sidebarClosed: (size = 15): string =>
      svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>', size),
    // Chat-pane toggle — panel with a chevron pointing the collapse
    // direction. Distinct from sidebarOpen/Closed (which carry only a
    // vertical divider) so the two adjacent toggles read as siblings, not
    // duplicates. Chevron points LEFT when open (click to collapse left),
    // RIGHT when collapsed (click to expand from left).
    chatPanelOpen: (size = 15): string =>
      svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M13 9l-3 3 3 3"/>', size),
    chatPanelClosed: (size = 15): string =>
      svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M10 9l3 3-3 3"/>', size),
    arrowLeft: (size = 15): string => svg('<path d="M19 12H5M12 19l-7-7 7-7"/>', size),
    arrowRight: (size = 15): string => svg('<path d="M5 12h14M12 5l7 7-7 7"/>', size),
    pencil: (size = 15): string =>
      svg('<path d="M14 4l6 6L9 21H3v-6z"/><path d="M14 4l3-3 6 6-3 3"/>', size),
    chevronDown: (size = 11): string => svg('<path d="M6 9l6 6 6-6"/>', size),
    folder: (size = 14): string =>
      svg(
        '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        size,
      ),
    plug: (size = 15): string =>
      svg('<path d="M9 7V4M15 7V4M7 7h10v6a4 4 0 1 1-10 0z"/><path d="M12 17v3"/>', size),
    history: (size = 15): string =>
      svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>', size),
    settings: (size = 15): string =>
      svg(
        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
        size,
      ),
    search: (size = 15): string =>
      svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', size),
    plus: (size = 15): string => svg('<path d="M12 5v14M5 12h14"/>', size),
    home: (size = 15): string => svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>', size),
    star: (size = 15): string =>
      svg(
        '<path d="M12 3l2.6 5.3L20 9.3l-4 3.9.9 5.5L12 16.1 7.1 18.7 8 13.2 4 9.3l5.4-1z"/>',
        size,
      ),
    sparkle: (size = 15): string =>
      svg(
        '<path d="M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3z"/><path d="M19 15l.6 1.6L21 17l-1.4.4L19 19l-.6-1.6L17 17l1.4-.4z"/>',
        size,
        1.5,
      ),
  };

  // The Electron window uses `titleBarStyle: 'hiddenInset'` (see
  // main.ts), which keeps the real macOS traffic lights at (16, 16).
  // We don't paint synthetic ones — that would stack a second set on
  // top. Instead, `.cd-tl-side` / `.cd-tl-main` reserve padding-left so
  // the OS controls have a clean home. A no-op spacer keeps the layout
  // identical whether or not the lights are present.
  function trafficLightsSpacer(): HTMLElement {
    return el('span', {
      class: 'cd-traffic-lights-spacer',
      'aria-hidden': 'true',
    });
  }

  // Reusable titlebar icon button with tooltip + ⌘-shortcut chip.
  function tbBtn(opts: {
    icon: string;
    title?: string;
    shortcut?: string;
    onClick?: () => void;
    disabled?: boolean;
    ariaLabel?: string;
  }): HTMLElement {
    const wrap = el('span', { class: 'cd-tb-btn-wrap' });
    const btn = el('button', {
      class: 'cd-tb-btn',
      type: 'button',
      'aria-label': opts.ariaLabel || opts.title,
      onClick: opts.onClick,
      trustedHtml: opts.icon,
    });
    if (opts.disabled) btn.setAttribute('disabled', '');
    wrap.append(btn);
    if (opts.title) {
      const tip = el('span', { class: 'cd-tooltip' }, opts.title);
      if (opts.shortcut) tip.append(el('span', { class: 'cd-kbd' }, opts.shortcut));
      wrap.append(tip);
    }
    return wrap;
  }

  interface WindowOpts {
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    sidebar: HTMLElement;
    main: HTMLElement;
    /** Right-edge chrome cluster — project identity, Publish, brand chip, etc. */
    titlebarRight?: HTMLElement | null;
    /** Center chrome cluster — view-context controls (mode tabs, device pill).
     *  Sits between the back/forward nav and the trailing flex spacer, so it
     *  reads as "what's the main canvas showing" rather than identity. */
    titlebarCenter?: HTMLElement | null;
    showNewChat?: boolean;
    onNewChat?: () => void;
    canGoBack?: boolean;
    canGoForward?: boolean;
    onBack?: () => void;
    onForward?: () => void;
    /** When true, a chat-pane toggle is rendered at the trailing edge of
     *  `.cd-tl-nav` — i.e. the chat-pane/canvas boundary. Builder only. */
    showChatToggle?: boolean;
    chatPaneOpen?: boolean;
    onToggleChat?: () => void;
  }

  // Builds the full `.cd-window` shell. Returns the root element plus a
  // setter that flips data-sidebar so the grid animates without a rebuild.
  function buildWindow(opts: WindowOpts): {
    root: HTMLElement;
    setSidebarOpen: (open: boolean) => void;
    setChatPaneOpen: (open: boolean) => void;
  } {
    const sidebarToggle = (open: boolean): HTMLElement =>
      tbBtn({
        icon: open ? Glyph.sidebarOpen() : Glyph.sidebarClosed(),
        title: open ? 'Hide sidebar' : 'Show sidebar',
        shortcut: '⌘B',
        ariaLabel: open ? 'Hide sidebar' : 'Show sidebar',
        onClick: opts.onToggleSidebar,
      });

    const sidebarToggleLeft = sidebarToggle(true);
    // The closed-state toggle is now built on-demand inside
    // `buildTlMainContent`, so we don't need a captured reference here.
    const backButton = (): HTMLElement =>
      tbBtn({
        icon: Glyph.arrowLeft(),
        title: 'Back',
        shortcut: '⌘[',
        ariaLabel: 'Back',
        disabled: !opts.canGoBack,
        onClick: opts.onBack,
      });
    const forwardButton = (): HTMLElement =>
      tbBtn({
        icon: Glyph.arrowRight(),
        title: 'Forward',
        shortcut: '⌘]',
        ariaLabel: 'Forward',
        disabled: !opts.canGoForward,
        onClick: opts.onForward,
      });
    const chatToggle = (open: boolean): HTMLElement => {
      const node = tbBtn({
        icon: open ? Glyph.chatPanelOpen() : Glyph.chatPanelClosed(),
        title: open ? 'Hide chat pane' : 'Show chat pane',
        shortcut: '⌘\\',
        ariaLabel: open ? 'Hide chat pane' : 'Show chat pane',
        onClick: opts.onToggleChat,
      });
      node.classList.add('chat-toggle-wrap');
      return node;
    };

    const tlSide = el('div', { class: 'cd-tl-side' }, [
      trafficLightsSpacer(),
      el('span', { style: { flex: '1' } }),
      sidebarToggleLeft,
    ]);

    // tlMain layout. When `titlebarCenter` is passed, the row uses a
    // 2-cell grid (`.cd-tl-nav` + `.cd-tl-context`) whose column tracks
    // mirror `.builder-body` — that aligns the center cluster's left edge
    // with the right pane's left edge, and lets us push the trailing
    // cluster (e.g. device pill) to the chrome row's extreme right. When
    // no center is set, the row stays a flat flex container as before.
    function buildTlMainContent(open: boolean): HTMLElement[] {
      const navChildren: (HTMLElement | null)[] = [
        trafficLightsSpacer(),
        open ? null : sidebarToggle(false),
        backButton(),
        forwardButton(),
      ];
      if (!open && opts.showNewChat) {
        navChildren.push(
          tbBtn({
            icon: Glyph.pencil(),
            title: 'New app',
            shortcut: '⌘N',
            ariaLabel: 'New app',
            onClick: opts.onNewChat,
          }),
        );
      }
      // Chat-pane toggle pinned to the trailing edge of cd-tl-nav (via
      // `.chat-toggle-wrap { margin-left: auto }` — see styles.css). Sits at
      // the chat-pane/canvas boundary, matching the panel-it-controls edge.
      if (opts.showChatToggle) {
        navChildren.push(chatToggle(opts.chatPaneOpen !== false));
      }
      const nav = navChildren.filter((c): c is HTMLElement => !!c);
      if (opts.titlebarCenter) {
        const contextChildren: HTMLElement[] = [opts.titlebarCenter];
        if (opts.titlebarRight) {
          contextChildren.push(el('span', { style: { flex: '1' } }));
          contextChildren.push(opts.titlebarRight);
        }
        return [
          el('div', { class: 'cd-tl-nav' }, nav),
          el('div', { class: 'cd-tl-context' }, contextChildren),
        ];
      }
      const flat: HTMLElement[] = [...nav, el('span', { style: { flex: '1' } })];
      if (opts.titlebarRight) flat.push(opts.titlebarRight);
      return flat;
    }
    const tlMain = el(
      'div',
      {
        class: 'cd-tl-main',
        'data-layout': opts.titlebarCenter ? 'grid' : 'flat',
      },
      buildTlMainContent(opts.sidebarOpen),
    );

    // Codex-style chrome: tlSide / tlMain are no longer separate window-
    // grid rows — they live INSIDE the sidebar column and main element as
    // each pane's first row. The cd-window collapses to a single grid row,
    // reclaiming ~44px at the top of the canvas (see styles.css).
    const sidebarColumn = el('aside', { class: 'cd-sidebar' }, [
      tlSide,
      el('div', { class: 'cd-sidebar-inner' }, opts.sidebar),
    ]);
    opts.main.classList.add('cd-main');
    opts.main.prepend(tlMain);

    const root = el(
      'div',
      { class: 'cd-window', 'data-sidebar': opts.sidebarOpen ? 'open' : 'closed' },
      [sidebarColumn, opts.main],
    );

    function rebuildTlMain(open: boolean): void {
      const main = root.querySelector('.cd-tl-main');
      if (!main) return;
      main.innerHTML = '';
      for (const c of buildTlMainContent(open)) main.append(c);
    }
    return {
      root,
      setSidebarOpen(open: boolean): void {
        root.dataset.sidebar = open ? 'open' : 'closed';
        rebuildTlMain(open);
      },
      setChatPaneOpen(open: boolean): void {
        // Mutate the captured opt so the next rebuildTlMain picks the right
        // chevron direction. cd-tl-main is rebuilt against the CURRENT sidebar
        // state so the new-app / sidebar-toggle cluster stays consistent.
        opts.chatPaneOpen = open;
        rebuildTlMain(root.dataset.sidebar !== 'closed');
      },
    };
  }

  // ── Sidebar ────────────────────────────────────────────────────────
  // Hybrid contents: live workspace switcher · live New app / Search /
  // Settings · disabled placeholders for Plugins / Automations / Chats ·
  // a live Apps section listing user apps and drafts with status dots.

  interface SidebarApp {
    id: string;
    name: string;
    iconKey: IconNameType;
    color: string;
    status?: 'new' | 'draft' | 'live' | null;
  }

  interface SidebarOpts {
    activeId?: string;
    apps: SidebarApp[];
    drafts: SidebarApp[];
    onHome: () => void;
    onNewApp: () => void;
    onSearch?: () => void;
    onAppClick: (id: string) => void;
    onSettings: () => void;
    onAppContext?: (id: string, anchor: MenuAnchor) => void;
  }

  // Hover-revealed `•••` + right-click on a sidebar row, both routing
  // through `onAppContext` (same handler the home grid uses).
  function appRow(item: HTMLElement, id: string, cb: SidebarOpts['onAppContext']): HTMLElement {
    if (!cb) return item;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const m = e as MouseEvent;
      cb(id, { kind: 'point', x: m.clientX, y: m.clientY });
    });
    const more = el('button', {
      class: 'cd-card-more cd-sb-more',
      type: 'button',
      'aria-label': 'App actions',
      'aria-haspopup': 'menu',
      trustedHtml: window.Icon.MoreHoriz({ size: 14 }),
      onClick: (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const t = e.currentTarget as HTMLElement;
        t.dataset.open = 'true';
        cb(id, { kind: 'rect', rect: t.getBoundingClientRect() });
      },
    });
    return el('div', { class: 'cd-sb-app-row' }, [item, more]);
  }

  function sbItem(opts: {
    icon: string;
    label: string;
    meta?: string;
    active?: boolean;
    disabled?: boolean;
    onClick?: () => void;
    dotColor?: string;
    iconNode?: HTMLElement;
  }): HTMLElement {
    const item = el('button', {
      class: 'cd-sb-item',
      type: 'button',
      'data-active': opts.active ? 'true' : undefined,
      'data-disabled': opts.disabled ? 'true' : undefined,
      onClick: opts.onClick,
    });
    if (opts.iconNode) {
      item.append(opts.iconNode);
    } else {
      item.append(el('span', { class: 'cd-sb-icon', trustedHtml: opts.icon }));
    }
    item.append(el('span', { class: 'cd-sb-label' }, opts.label));
    if (opts.meta) item.append(el('span', { class: 'cd-sb-meta' }, opts.meta));
    if (opts.dotColor)
      item.append(el('span', { class: 'cd-sb-dot', style: { background: opts.dotColor } }));
    return item;
  }

  function statusDotColor(status?: string | null): string {
    if (status === 'new') return 'var(--accent-light)';
    if (status === 'draft') return 'var(--icon-amber)';
    if (status === 'live') return 'var(--success)';
    return 'transparent';
  }

  function buildSidebar(opts: SidebarOpts): HTMLElement {
    const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });

    // Top nav
    wrap.append(
      sbItem({
        icon: Glyph.plus(),
        label: 'New app',
        meta: '⌘N',
        onClick: opts.onNewApp,
      }),
    );
    wrap.append(
      sbItem({
        icon: Glyph.search(),
        label: 'Search',
        meta: '⌘K',
        onClick: opts.onSearch,
        disabled: !opts.onSearch,
      }),
    );
    wrap.append(sbItem({ icon: Glyph.plug(), label: 'Plugins', disabled: true }));
    wrap.append(sbItem({ icon: Glyph.history(), label: 'Automations', disabled: true }));

    // Pages
    wrap.append(el('div', { class: 'cd-sb-section' }, 'Pages'));
    wrap.append(
      sbItem({
        icon: Glyph.home(),
        label: 'Home',
        active: opts.activeId === 'home',
        onClick: opts.onHome,
      }),
    );
    wrap.append(sbItem({ icon: Glyph.star(), label: 'Starred', disabled: true }));

    // Apps section
    if (opts.apps.length > 0) {
      wrap.append(el('div', { class: 'cd-sb-section' }, 'Apps'));
      for (const a of opts.apps) {
        const iconNode = el('span', {
          class: 'cd-sb-app-icon',
          style: { background: a.color },
          trustedHtml: window.Icon[a.iconKey]
            ? window.Icon[a.iconKey]({ size: 11, strokeWidth: 1.85 })
            : '',
        });
        const item = sbItem({
          iconNode,
          icon: '',
          label: a.name,
          active: opts.activeId === a.id,
          onClick: () => opts.onAppClick(a.id),
          dotColor: a.status ? statusDotColor(a.status) : undefined,
        });
        wrap.append(appRow(item, a.id, opts.onAppContext));
      }
    }

    // Drafts
    if (opts.drafts.length > 0) {
      wrap.append(el('div', { class: 'cd-sb-section' }, 'Drafts'));
      for (const d of opts.drafts) {
        const iconNode = el('span', {
          class: 'cd-sb-app-icon',
          style: { background: d.color },
          trustedHtml: window.Icon[d.iconKey]
            ? window.Icon[d.iconKey]({ size: 11, strokeWidth: 1.85 })
            : window.Icon.Sparkle({ size: 11 }),
        });
        const item = sbItem({
          iconNode,
          icon: '',
          label: d.name,
          active: opts.activeId === d.id,
          onClick: () => opts.onAppClick(d.id),
          dotColor: 'var(--c-amber)',
        });
        wrap.append(appRow(item, d.id, opts.onAppContext));
      }
    }

    // Placeholder: Chats — visible to preserve the design's information
    // architecture for future wiring, but disabled today.
    wrap.append(el('div', { class: 'cd-sb-section' }, 'Chats'));
    wrap.append(sbItem({ icon: Glyph.sparkle(), label: 'No saved chats yet', disabled: true }));

    // Spacer pushes Settings to the bottom
    wrap.append(el('span', { style: { flex: '1', minHeight: '12px' } }));
    wrap.append(
      sbItem({
        icon: Glyph.settings(),
        label: 'Settings',
        active: opts.activeId === 'settings',
        onClick: opts.onSettings,
      }),
    );

    return wrap;
  }

  // Expose for app.ts + builder.ts.
  window.Chrome = {
    buildWindow,
    buildSidebar,
    tbBtn,
    glyphs: Glyph,
  };
})();
