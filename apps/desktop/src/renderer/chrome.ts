// governance: allow-repo-hygiene file-size-limit chrome-window-and-sidebar pending split into separate window-builder / sidebar-builder modules
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
    // Geometric kind marks for the gateway switcher. Filled square ▣
    // for local (a definite, embedded thing on the user's machine);
    // hollow square ▢ for remote (a connected, external surface). The
    // pair reads as a paired vocabulary the way `sidebarOpen`/`Closed`
    // do — same hull, different interior — so the eye registers the
    // change without re-parsing the icon.
    gatewayLocal: (size = 11): string =>
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>`,
    gatewayRemote: (size = 11): string =>
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1.5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>`,
    trash: (size = 13): string =>
      svg(
        '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14"/>',
        size,
      ),
    // Key — used by the "Rotate token" action on remote profile rows.
    // Pairs visually with the existing token field's password style; not
    // in @centraid/design-tokens so kept inline alongside `trash` / `pencil`.
    key: (size = 13): string =>
      svg(
        '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M17 6l3 3M14 9l3 3"/>',
        size,
      ),
    // Palette — used by the "Change color" action. A small artist's-palette
    // shape so it reads as "swap the swatch" rather than "any visual edit".
    palette: (size = 13): string =>
      svg(
        '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2.5-1 2.5-2.5 0-1-.5-1.5-.5-2.5s.7-2 2-2H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z"/><circle cx="7.5" cy="11" r="1" fill="currentColor"/><circle cx="9" cy="7" r="1" fill="currentColor"/><circle cx="14" cy="7" r="1" fill="currentColor"/><circle cx="17" cy="11" r="1" fill="currentColor"/>',
        size,
      ),
    check: (size = 13): string => svg('<path d="M5 12l5 5L20 7"/>', size, 2),
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
    /** Lead chrome element — placed in `.cd-tl-nav` immediately after the
     *  forward button, so it hugs the back/forward arrows. Used by the
     *  Builder titlebar for the app-identity lockup. */
    titlebarLead?: HTMLElement | null;
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
      // Lead element — app-identity lockup, hugging the back/forward
      // arrows (Builder titlebar). Sits before the chat-pane toggle.
      if (opts.titlebarLead) {
        navChildren.push(opts.titlebarLead);
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
  // Refined Screens §G3: Build new + Search at the top, a Pages
  // section (Home / Discover / Starred / Automations), the live Apps
  // list (the active app row is highlighted — App/Cloud destinations now
  // live in the top bar's Use/Build switch, not as sidebar children),
  // and Settings pinned to the bottom with a `live` status pill.

  interface SidebarApp {
    id: string;
    name: string;
    iconKey: IconNameType;
    color: string;
    status?: 'new' | 'draft' | 'live' | null;
  }

  type SidebarPage = 'home' | 'insights' | 'discover' | 'starred' | 'automations' | 'settings';

  interface SidebarOpts {
    /** App id of the app/builder currently in focus — highlights its row. */
    activeId?: string;
    /** Which top-level page is current — drives the active highlight. */
    activePage?: SidebarPage;
    apps: SidebarApp[];
    drafts: SidebarApp[];
    /** Active gateway summary — renders the sidebar-head switcher row. */
    gateway?: {
      activeId: string;
      activeKind: 'local' | 'remote';
      activeLabel: string;
      /** Friendly name for the active profile (issue #113). */
      activeDisplayName: string;
      /** Avatar color (`#RRGGBB`) for the active profile (issue #113). */
      activeAvatarColor: string;
    };
    onOpenGatewaySwitcher?: (anchor: MenuAnchor) => void;
    onHome: () => void;
    onNewApp: () => void;
    /** New-chat action wired to the Chats section `+`. Falls back to
     *  `onNewApp` when there is no dedicated chat-creation entry point. */
    onNewChat?: () => void;
    onSearch?: () => void;
    onInsights?: () => void;
    onDiscover?: () => void;
    onStarred?: () => void;
    onAutomations?: () => void;
    onAppClick: (id: string) => void;
    onAppContext?: (id: string, anchor: MenuAnchor) => void;
    onSettings: () => void;
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
      trustedHtml: window.Icon.MoreVert({ size: 14 }),
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
    accent?: boolean;
    onClick?: () => void;
    dotColor?: string;
    iconNode?: HTMLElement;
    trailing?: HTMLElement;
  }): HTMLElement {
    const item = el('button', {
      class: 'cd-sb-item',
      type: 'button',
      'data-active': opts.active ? 'true' : undefined,
      'data-disabled': opts.disabled ? 'true' : undefined,
      'data-accent': opts.accent ? 'true' : undefined,
      onClick: opts.onClick,
    });
    if (opts.iconNode) {
      item.append(opts.iconNode);
    } else {
      item.append(el('span', { class: 'cd-sb-icon', trustedHtml: opts.icon }));
    }
    item.append(el('span', { class: 'cd-sb-label' }, opts.label));
    if (opts.meta) item.append(el('span', { class: 'cd-sb-meta' }, opts.meta));
    if (opts.trailing) item.append(opts.trailing);
    if (opts.dotColor)
      item.append(el('span', { class: 'cd-sb-dot', style: { background: opts.dotColor } }));
    return item;
  }

  // Small mono-caps status pill — see DS v0.5 `.cd-status`.
  function statusPill(tone: 'new' | 'draft' | 'live', label: string): HTMLElement {
    return el('span', { class: 'cd-status', 'data-tone': tone }, [
      el('span', { class: 'cd-status-dot' }),
      label,
    ]);
  }

  // Inline tinted app-icon tile used in sidebar app rows.
  function appIconNode(a: SidebarApp): HTMLElement {
    return el('span', {
      class: 'cd-sb-app-icon',
      style: { background: a.color },
      trustedHtml: window.Icon[a.iconKey]
        ? window.Icon[a.iconKey]({ size: 11, strokeWidth: 1.85 })
        : window.Icon.Sparkle({ size: 11 }),
    });
  }

  // Profile avatar disc — colored circle with 1–2 initials. Used by the
  // sidebar-head row and the switcher popover rows (issue #113).
  function profileInitials(name: string): string {
    const parts = name
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (parts.length === 0) return '?';
    if (parts.length === 1) {
      const w = parts[0] ?? '';
      return (w.charAt(0) + (w.charAt(1) || '')).toUpperCase();
    }
    return ((parts[0]?.charAt(0) ?? '') + (parts[1]?.charAt(0) ?? '')).toUpperCase();
  }
  function profileAvatar(displayName: string, avatarColor: string, size = 20): HTMLElement {
    return el(
      'span',
      {
        class: 'cd-gw-avatar',
        style: {
          background: avatarColor,
          width: `${size}px`,
          height: `${size}px`,
        },
        'aria-hidden': 'true',
      },
      profileInitials(displayName),
    );
  }

  // Section header — uppercase mono-caps label, format "Apps · N" with an
  // optional hover-revealed `+` action button (§G3 / RefinedSidebar).
  function sbSection(label: string, onAction?: () => void): HTMLElement {
    const section = el('div', { class: 'cd-sb-section' }, [el('span', {}, label)]);
    if (onAction) {
      section.append(
        el('span', { class: 'cd-sb-section-actions' }, [
          el('button', {
            class: 'cd-sb-section-btn',
            type: 'button',
            'aria-label': 'Add',
            trustedHtml: Glyph.plus(),
            onClick: onAction,
          }),
        ]),
      );
    }
    return section;
  }

  function buildSidebar(opts: SidebarOpts): HTMLElement {
    const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });

    // Sidebar-head gateway switcher. Renders ABOVE "Build new" because
    // the gateway is the meta-context every other entry operates
    // under (apps, automations, settings — all gateway-scoped). A
    // hairline divider below separates the gateway-scope row from
    // page-scope actions so the hierarchy reads at a glance.
    if (opts.gateway && opts.onOpenGatewaySwitcher) {
      const gw = opts.gateway;
      const openCb = opts.onOpenGatewaySwitcher;
      // Notion/Linear pattern: the head row is just `[avatar] Name ▾`.
      // The kind (local/remote) lives one level down — surfaced inside
      // the popover's secondary line per profile — so the head row
      // stays a clean identity affordance instead of a status billboard.
      // Drop the mono-caps LOCAL/REMOTE pill (and the geometric kind
      // mark next to it) we used in v1; one signal in the chrome, not
      // two competing ones.
      const avatar = profileAvatar(gw.activeDisplayName, gw.activeAvatarColor, 20);
      const row = el('button', {
        class: 'cd-sb-item cd-sb-gw-row',
        type: 'button',
        'aria-haspopup': 'menu',
        'data-gateway-kind': gw.activeKind,
        'aria-label': `Active profile: ${gw.activeDisplayName}. Click to switch.`,
        onClick: (e: Event) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openCb({ kind: 'rect', rect: r });
        },
      });
      row.append(avatar);
      row.append(el('span', { class: 'cd-sb-label' }, gw.activeDisplayName));
      row.append(el('span', { class: 'cd-sb-meta', trustedHtml: Glyph.chevronDown(11) }));
      wrap.append(row);
      wrap.append(el('div', { class: 'cd-sb-divider', 'aria-hidden': 'true' }));
    }

    // Top — Build new (accent) + Search (opens the ⌘K palette).
    wrap.append(
      sbItem({
        icon: Glyph.plus(),
        label: 'Build new',
        meta: '⌘N',
        accent: true,
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

    // Pages — Home / Discover / Starred (RefinedSidebar §G3).
    wrap.append(sbSection('Pages'));
    wrap.append(
      sbItem({
        icon: Glyph.home(),
        label: 'Home',
        active: opts.activePage === 'home',
        onClick: opts.onHome,
      }),
    );
    wrap.append(
      sbItem({
        icon: window.Icon.Activity({ size: 15 }),
        label: 'Insights',
        active: opts.activePage === 'insights',
        disabled: !opts.onInsights,
        onClick: opts.onInsights,
      }),
    );
    wrap.append(
      sbItem({
        icon: window.Icon.Compass({ size: 15 }),
        label: 'Discover',
        active: opts.activePage === 'discover',
        disabled: !opts.onDiscover,
        onClick: opts.onDiscover,
      }),
    );
    wrap.append(
      sbItem({
        icon: Glyph.star(),
        label: 'Starred',
        active: opts.activePage === 'starred',
        disabled: !opts.onStarred,
        onClick: opts.onStarred,
      }),
    );
    wrap.append(
      sbItem({
        icon: window.Icon.Bolt({ size: 15 }),
        label: 'Automations',
        active: opts.activePage === 'automations',
        disabled: !opts.onAutomations,
        onClick: opts.onAutomations,
      }),
    );

    // Apps section — the design folds drafts into the Apps list rather
    // than carrying a separate Drafts header. Count appended to the
    // header label; a hover-revealed `+` opens the new-app flow. The app
    // matching `activeId` is highlighted; App/Cloud destinations live in
    // the top bar's Use/Build switch, not as sidebar children.
    const appList = [...opts.apps, ...opts.drafts];
    wrap.append(sbSection(`Apps · ${appList.length}`, opts.onNewApp));
    if (appList.length > 0) {
      for (const a of appList) {
        const item = sbItem({
          iconNode: appIconNode(a),
          icon: '',
          label: a.name,
          active: a.id === opts.activeId,
          onClick: () => opts.onAppClick(a.id),
        });
        wrap.append(appRow(item, a.id, opts.onAppContext));
      }
    } else {
      wrap.append(sbItem({ icon: Glyph.sparkle(), label: 'No apps yet', disabled: true }));
    }

    // Placeholder: Chats — visible to preserve the design's information
    // architecture for future wiring, but disabled today. The header's
    // `+` reuses the new-app flow (the chat surface has no dedicated
    // creation entry point yet — RefinedSidebar §G3).
    wrap.append(sbSection('Chats · 0', opts.onNewChat ?? opts.onNewApp));
    wrap.append(sbItem({ icon: Glyph.sparkle(), label: 'No saved chats yet', disabled: true }));

    // Spacer pushes Settings to the bottom. Refined Screens §G3 swaps the
    // old Local/Remote tag for a `live` status pill.
    wrap.append(el('span', { style: { flex: '1', minHeight: '12px' } }));
    wrap.append(
      sbItem({
        icon: Glyph.settings(),
        label: 'Settings',
        active: opts.activePage === 'settings',
        onClick: opts.onSettings,
        trailing: statusPill('live', 'live'),
      }),
    );

    return wrap;
  }

  // ── Gateway switcher popover ───────────────────────────────────────
  // Notion / Linear-inspired refresh. v1 grouped profiles under LOCAL /
  // REMOTE section headers with hover-revealed pencil + trash icons and
  // two separate `+` buttons. v2 collapses that into:
  //
  //   • a single flat profile list (local first, then remote, matching
  //     gateway-store's sort) — kind moves to a muted secondary line
  //     under the displayName, not a competing top-line pill;
  //   • a leading check-mark column for the active row (Notion-style)
  //     instead of a trailing ACTIVE pill, freeing horizontal space and
  //     letting the scan read top-to-bottom;
  //   • a per-row `⋯` menu trigger (Rename · Change color · Rotate token
  //     for remote · Remove) instead of hover-only icons — more
  //     discoverable on keyboard / touch and stops the icons competing
  //     with the row label;
  //   • a single footer "+ Add profile" CTA opening a kind chooser
  //     (Local | Remote) → form, so the list above stays stable instead
  //     of being pushed down by an inline form per kind;
  //   • a filter input at the top when there are ≥ 4 profiles, so the
  //     switcher scales when a power user accumulates many gateways.
  //
  // Keyboard inside the popover: `↑/↓` moves focus through rows, Enter
  // activates the focused row, `/` jumps to filter (when shown), Esc
  // closes, ⌘1…⌘9 from outside jumps directly to the Nth profile
  // (wired in app.ts via the global keydown).
  type SwitcherOpts = {
    anchor: MenuAnchor;
    profiles: Array<{
      id: string;
      kind: 'local' | 'remote';
      label: string;
      /** Friendly name (issue #113). Always populated. */
      displayName: string;
      /** `#RRGGBB` avatar color (issue #113). Always populated. */
      avatarColor: string;
      url?: string;
    }>;
    activeId: string;
    primordialLocalId: string;
    onActivate: (id: string) => Promise<void> | void;
    onRename: (id: string, nextLabel: string) => Promise<void> | void;
    onRemove: (id: string) => Promise<void> | void;
    onChangeColor: (id: string, color: string) => Promise<void> | void;
    onRotateToken: (id: string, token: string) => Promise<void> | void;
    onAddLocal: (input: {
      label: string;
      displayName?: string;
      avatarColor?: string;
    }) => Promise<void> | void;
    onAddRemote: (input: {
      label: string;
      url: string;
      token: string;
      displayName?: string;
      avatarColor?: string;
    }) => Promise<void> | void;
  };

  /** Filter threshold — show search input only when the user has
   *  accumulated enough profiles that scanning becomes the bottleneck. */
  const SWITCHER_FILTER_MIN = 4;

  function openGatewaySwitcher(opts: SwitcherOpts): { close: () => void } {
    // Single-instance: a previous switcher always closes before the new
    // one mounts, even if the caller forgot to dismiss the old one.
    document.querySelectorAll('.cd-gw-pop, .cd-gw-pop-backdrop').forEach((n) => n.remove());

    // 8-swatch palette matching gateway-store's AVATAR_PALETTE so a
    // color picked here round-trips through `updateProfileMetadata`.
    const AVATAR_PALETTE = [
      '#5B8DEF',
      '#7C5CFF',
      '#E36AD2',
      '#E5734A',
      '#E0B53D',
      '#4FB077',
      '#3FB5C7',
      '#B07A4A',
    ];

    type View =
      | { mode: 'list'; filter: string; expanded?: string }
      | { mode: 'chooseKind' }
      | { mode: 'addLocal' }
      | { mode: 'addRemote' }
      | { mode: 'rotateToken'; profileId: string };

    let view: View = { mode: 'list', filter: '' };

    const close = (): void => {
      backdrop.remove();
      popover.remove();
      document.removeEventListener('keydown', onKey);
    };

    // Top-level keydown — Escape collapses any open sub-view first,
    // then closes the popover. Esc on a focused input is preempted
    // by the input's own keydown handler (so cancel-edit doesn't
    // close the whole switcher).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (view.mode !== 'list') {
          render({ mode: 'list', filter: '' });
        } else if ((view as { expanded?: string }).expanded) {
          render({ mode: 'list', filter: view.filter });
        } else {
          close();
        }
      }
    };

    const backdrop = el('div', {
      class: 'cd-gw-pop-backdrop',
      onClick: close,
      onContextmenu: (e: Event) => {
        e.preventDefault();
        close();
      },
    });
    document.body.append(backdrop);

    const popover = el('div', { class: 'cd-gw-pop', role: 'menu' });

    // ── Reusable color picker (shared across add-forms and the
    // per-row "Change color" expansion). Returns the row + a getter
    // for the picked value. `onPick` fires immediately on swatch
    // click — the per-row variant uses it to commit-on-pick, while
    // the add-forms ignore it and read via `get()` on submit.
    const buildColorPicker = (
      initial: string,
      onPick?: (c: string) => void,
    ): { node: HTMLElement; get: () => string } => {
      let selected = initial;
      const row = el('div', { class: 'cd-gw-pop-colors' });
      const swatches: HTMLElement[] = [];
      const apply = (): void => {
        for (const sw of swatches) {
          sw.dataset.selected = sw.dataset.color === selected ? 'true' : 'false';
        }
      };
      for (const c of AVATAR_PALETTE) {
        const sw = el('button', {
          class: 'cd-gw-pop-swatch',
          type: 'button',
          'aria-label': `Color ${c}`,
          'data-color': c,
          style: { background: c },
          onClick: (e: Event) => {
            e.preventDefault();
            selected = c;
            apply();
            if (onPick) onPick(c);
          },
        });
        swatches.push(sw);
        row.append(sw);
      }
      apply();
      return { node: row, get: () => selected };
    };

    // ── Header: title + back button when inside a sub-view ──────────
    const renderHeader = (title: string, onBack: (() => void) | null): HTMLElement => {
      const head = el('div', { class: 'cd-gw-pop-head' });
      if (onBack) {
        head.append(
          el('button', {
            class: 'cd-gw-pop-back',
            type: 'button',
            'aria-label': 'Back',
            trustedHtml: Glyph.arrowLeft(14),
            onClick: onBack,
          }),
        );
      }
      head.append(el('span', { class: 'cd-gw-pop-title' }, title));
      return head;
    };

    // ── List view ───────────────────────────────────────────────────
    const renderList = (state: { filter: string; expanded?: string }): void => {
      popover.dataset.view = 'list';

      // Optional filter — only shown when the user has accumulated
      // enough profiles that scanning is noticeably slower than typing.
      // Hidden by default keeps the popover quiet for the common
      // 1–3 profile case.
      let filterInput: HTMLInputElement | null = null;
      if (opts.profiles.length >= SWITCHER_FILTER_MIN) {
        filterInput = el('input', {
          class: 'input cd-gw-pop-filter',
          type: 'text',
          placeholder: 'Filter profiles…',
          value: state.filter,
          'aria-label': 'Filter profiles',
        }) as HTMLInputElement;
        filterInput.addEventListener('input', () => {
          renderList({
            filter: filterInput!.value,
            ...(state.expanded ? { expanded: state.expanded } : {}),
          });
          // Re-focus the input after re-render — preserve caret position.
          const re = popover.querySelector<HTMLInputElement>('.cd-gw-pop-filter');
          if (re) {
            re.focus();
            re.setSelectionRange(re.value.length, re.value.length);
          }
        });
        filterInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            const first = popover.querySelector<HTMLElement>('.cd-gw-pop-row');
            first?.focus();
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            if (filterInput!.value) {
              filterInput!.value = '';
              renderList({ filter: '' });
            } else {
              close();
            }
          }
        });
      }

      const needle = state.filter.trim().toLowerCase();
      const filtered = opts.profiles.filter((p) => {
        if (!needle) return true;
        return (
          p.displayName.toLowerCase().includes(needle) ||
          p.label.toLowerCase().includes(needle) ||
          (p.url ?? '').toLowerCase().includes(needle)
        );
      });

      // Build the row list. `data-index` lets ⌘1..⌘9 / arrow-nav land
      // on the right element without re-scanning the DOM.
      const list = el('div', { class: 'cd-gw-pop-list', role: 'listbox' });
      filtered.forEach((p, i) => {
        list.append(renderProfileRow(p, i, state));
      });
      if (filtered.length === 0) {
        list.append(el('div', { class: 'cd-gw-pop-empty' }, ['No profiles match.']));
      }

      popover.replaceChildren();
      if (filterInput) popover.append(filterInput);
      popover.append(list);
      popover.append(el('div', { class: 'cd-gw-pop-divider', 'aria-hidden': 'true' }));
      popover.append(renderFooterAddCta());

      // Focus the first row by default so ↑/↓ + Enter work immediately
      // (Notion-style keyboard-first switcher). The filter input, when
      // shown, claims focus instead so typing flows naturally.
      queueMicrotask(() => {
        if (filterInput) {
          filterInput.focus();
        } else {
          popover.querySelector<HTMLElement>('.cd-gw-pop-row')?.focus();
        }
      });
    };

    const kindMeta = (p: SwitcherOpts['profiles'][number]): string => {
      if (p.kind === 'local') {
        return p.id === opts.primordialLocalId ? 'Local · Default workspace' : 'Local workspace';
      }
      // Remote rows show the host (no scheme/path) — same trick Notion
      // uses for its workspace URLs. Falls back to "Remote gateway" if
      // the URL can't be parsed (shouldn't happen post-add validation).
      try {
        const u = new URL(p.url ?? '');
        return `Remote · ${u.host}`;
      } catch {
        return 'Remote gateway';
      }
    };

    const renderProfileRow = (
      p: SwitcherOpts['profiles'][number],
      index: number,
      state: { filter: string; expanded?: string },
    ): HTMLElement => {
      const isActive = p.id === opts.activeId;
      const isPrimordial = p.id === opts.primordialLocalId;
      const isExpanded = state.expanded === p.id;

      // Outer wrapper holds both the row and (when expanded) the
      // per-row action strip / inline sub-form. Keeps the row's
      // border-radius clean when actions appear below it.
      const wrap = el('div', { class: 'cd-gw-pop-rowwrap' });

      const row = el('button', {
        class: 'cd-gw-pop-row',
        type: 'button',
        role: 'option',
        'data-active': isActive ? 'true' : undefined,
        'data-primordial': isPrimordial ? 'true' : undefined,
        'data-expanded': isExpanded ? 'true' : undefined,
        'data-index': String(index),
        'aria-selected': isActive ? 'true' : 'false',
      });

      // Active state lives on the avatar itself: a 2px accent-colored
      // ring with a tight 1px gutter so it doesn't clash with the
      // avatar's own background. This integrates two signals (identity
      // + selection) into one column instead of a leading check + a
      // 22px gutter that read as orphaned whenever the row's right side
      // (number hint, ⋯) hadn't filled out yet. Bolder name + a faint
      // accent-tinted row background complete the cue.
      const avatarWrap = el(
        'span',
        {
          class: 'cd-gw-pop-avatar-wrap',
          'data-active': isActive ? 'true' : undefined,
        },
        [profileAvatar(p.displayName, p.avatarColor, 24)],
      );

      const text = el('span', { class: 'cd-gw-pop-text' }, [
        el('span', { class: 'cd-gw-pop-name' }, p.displayName),
        el('span', { class: 'cd-gw-pop-sub' }, kindMeta(p)),
      ]);

      // Number hint chip — ⌘1..⌘9. Only shown for the first nine
      // profiles in the unfiltered order so the hint stays meaningful.
      // Hidden during filter to avoid suggesting indices that won't
      // match the visible list (filtered rows still activate via
      // click / Enter, just not via the shortcut).
      const numberHint =
        !state.filter && index < 9
          ? el('span', { class: 'cd-gw-pop-numhint' }, `⌘${index + 1}`)
          : null;

      const more = el('button', {
        class: 'cd-gw-pop-more',
        type: 'button',
        'aria-label': 'Profile actions',
        'aria-haspopup': 'menu',
        'aria-expanded': isExpanded ? 'true' : 'false',
        trustedHtml: window.Icon.MoreVert({ size: 14 }),
        onClick: (e: Event) => {
          e.stopPropagation();
          renderList({
            filter: state.filter,
            ...(isExpanded ? {} : { expanded: p.id }),
          });
        },
      });

      row.append(avatarWrap, text);
      if (numberHint) row.append(numberHint);
      row.append(more);

      row.addEventListener('click', () => {
        if (isActive) {
          close();
          return;
        }
        close();
        void opts.onActivate(p.id);
      });

      // Per-row keyboard nav. Up/Down within the rendered list,
      // Enter activates, "/" jumps to filter input (when present).
      row.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'ArrowDown' || ke.key === 'ArrowUp') {
          ke.preventDefault();
          const rows = Array.from(popover.querySelectorAll<HTMLElement>('.cd-gw-pop-row'));
          const i = rows.indexOf(row);
          const next = ke.key === 'ArrowDown' ? i + 1 : i - 1;
          if (next >= 0 && next < rows.length) rows[next]?.focus();
          else if (ke.key === 'ArrowUp') {
            popover.querySelector<HTMLElement>('.cd-gw-pop-filter')?.focus();
          }
        } else if (ke.key === '/') {
          const f = popover.querySelector<HTMLElement>('.cd-gw-pop-filter');
          if (f) {
            ke.preventDefault();
            f.focus();
          }
        }
      });

      wrap.append(row);

      // Expanded sub-strip — Rename / Change color / Rotate token
      // (remote only) / Remove. Notion / Linear surface these behind
      // a `⋯` button per row; we render the resulting menu inline
      // below the row to avoid a second floating popover stacked on
      // top of this one. Click ⋯ again to collapse.
      if (isExpanded) {
        wrap.append(renderRowActions(p, isPrimordial, state));
      }

      return wrap;
    };

    const renderRowActions = (
      p: SwitcherOpts['profiles'][number],
      isPrimordial: boolean,
      state: { filter: string; expanded?: string },
    ): HTMLElement => {
      // Vertical menu list — what Notion's workspace `⋯` actually
      // renders. The v2 horizontal chip strip looked orphaned for
      // primordial-local rows (just `[Rename]` + `[Color]` with empty
      // space to the right) and competed with the row's own visual
      // weight. A stacked menu fills the popover width predictably,
      // keeps the icon column lined up with the row's avatar so the
      // expansion reads as a continuation of the row, and lets Remove
      // sit below a hairline separator so destructive actions don't
      // visually mingle with the everyday ones.
      const menu = el('div', { class: 'cd-gw-pop-actionmenu', role: 'menu' });

      // Sub-form box for inline rename / color picker. Sits BELOW the
      // menu items (still indented under the avatar column) so the
      // user picks an action, then immediately sees the edit affordance
      // appear in-place — no popover-takeover for these light edits.
      const subbox = el('div', { class: 'cd-gw-pop-subbox' });

      const setSub = (next: 'rename' | 'color' | null): void => {
        subbox.replaceChildren();
        // Update which menu item reads as "currently expanded" so the
        // user has a clear cue about what they clicked.
        menu.querySelectorAll<HTMLElement>('.cd-gw-pop-menuitem').forEach((mi) => {
          mi.dataset.subActive = mi.dataset.sub === next ? 'true' : 'false';
        });
        if (next === 'rename') {
          const input = el('input', {
            class: 'input cd-gw-pop-input cd-gw-pop-rename',
            type: 'text',
            value: p.displayName,
            'aria-label': 'New name',
          }) as HTMLInputElement;
          const commit = async (save: boolean): Promise<void> => {
            const trimmed = input.value.trim();
            if (save && trimmed && trimmed !== p.displayName) {
              await opts.onRename(p.id, trimmed);
              close();
            } else {
              setSub(null);
            }
          };
          input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              void commit(true);
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              setSub(null);
            }
          });
          subbox.append(input);
          queueMicrotask(() => {
            input.focus();
            input.select();
          });
        } else if (next === 'color') {
          // Commit-on-pick: clicking a swatch updates immediately.
          // Matches Linear's accent picker. Popover closes after; the
          // sidebar re-renders on the gateway-changed broadcast.
          const picker = buildColorPicker(p.avatarColor, (c) => {
            void Promise.resolve(opts.onChangeColor(p.id, c)).then(close);
          });
          subbox.append(picker.node);
        }
      };

      const menuItem = (opts: {
        label: string;
        icon: string;
        onClick: () => void;
        danger?: boolean;
        sub?: 'rename' | 'color';
      }): HTMLElement =>
        el(
          'button',
          {
            class: `cd-gw-pop-menuitem${opts.danger ? ' cd-gw-pop-menuitem--danger' : ''}`,
            type: 'button',
            role: 'menuitem',
            'data-sub': opts.sub,
            'data-sub-active': 'false',
            onClick: opts.onClick,
          },
          [
            el('span', { class: 'cd-gw-pop-menuitem-icon', trustedHtml: opts.icon }),
            el('span', { class: 'cd-gw-pop-menuitem-label' }, opts.label),
          ],
        );

      menu.append(
        menuItem({
          label: 'Rename',
          icon: Glyph.pencil(14),
          sub: 'rename',
          onClick: () => {
            const item = menu.querySelector<HTMLElement>('[data-sub="rename"]');
            setSub(item?.dataset.subActive === 'true' ? null : 'rename');
          },
        }),
      );
      menu.append(
        menuItem({
          label: 'Change color',
          icon: Glyph.palette(14),
          sub: 'color',
          onClick: () => {
            const item = menu.querySelector<HTMLElement>('[data-sub="color"]');
            setSub(item?.dataset.subActive === 'true' ? null : 'color');
          },
        }),
      );
      if (p.kind === 'remote') {
        menu.append(
          menuItem({
            label: 'Rotate token',
            icon: Glyph.key(14),
            onClick: () => render({ mode: 'rotateToken', profileId: p.id }),
          }),
        );
      }
      if (!isPrimordial) {
        // Hairline rule before destructive — visual breath so a
        // misaimed click doesn't land on Remove. Borrowed from
        // macOS context-menu conventions.
        menu.append(el('div', { class: 'cd-gw-pop-actionmenu-rule', 'aria-hidden': 'true' }));
        menu.append(
          menuItem({
            label: 'Remove profile',
            icon: Glyph.trash(14),
            danger: true,
            onClick: () => {
              const msg =
                p.kind === 'local'
                  ? `Remove profile "${p.displayName}"? Its apps and history will be deleted.`
                  : `Remove profile "${p.displayName}"? Its workspace will be deleted.`;
              if (!confirm(msg)) return;
              void Promise.resolve(opts.onRemove(p.id)).then(close);
            },
          }),
        );
      }

      void state; // menu rebuilt on every render; no state needed here.
      return el('div', { class: 'cd-gw-pop-actionblock' }, [menu, subbox]);
    };

    // ── Footer "+ Add profile" CTA ──────────────────────────────────
    const renderFooterAddCta = (): HTMLElement => {
      return el(
        'button',
        {
          class: 'cd-gw-pop-add-cta',
          type: 'button',
          onClick: () => render({ mode: 'chooseKind' }),
        },
        [
          el('span', { class: 'cd-gw-pop-add-icon', trustedHtml: Glyph.plus(13) }),
          el('span', {}, 'Add profile'),
        ],
      );
    };

    // ── Kind chooser (footer CTA → this view) ───────────────────────
    const renderChooseKind = (): void => {
      popover.dataset.view = 'chooseKind';
      popover.replaceChildren();
      popover.append(renderHeader('Add profile', () => render({ mode: 'list', filter: '' })));
      const tile = (title: string, sub: string, icon: string, onClick: () => void): HTMLElement =>
        el('button', { class: 'cd-gw-pop-kindtile', type: 'button', onClick }, [
          el('span', { class: 'cd-gw-pop-kindtile-icon', trustedHtml: icon }),
          el('span', { class: 'cd-gw-pop-kindtile-text' }, [
            el('span', { class: 'cd-gw-pop-kindtile-title' }, title),
            el('span', { class: 'cd-gw-pop-kindtile-sub' }, sub),
          ]),
        ]);
      popover.append(
        el('div', { class: 'cd-gw-pop-kindgrid' }, [
          tile(
            'Local workspace',
            'A new in-process workspace on this machine',
            Glyph.folder(18),
            () => render({ mode: 'addLocal' }),
          ),
          tile('Remote gateway', 'Connect to a hosted Centraid gateway', Glyph.plug(18), () =>
            render({ mode: 'addRemote' }),
          ),
        ]),
      );
    };

    // ── Add-local form ──────────────────────────────────────────────
    const renderAddLocal = (): void => {
      popover.dataset.view = 'addLocal';
      popover.replaceChildren();
      popover.append(renderHeader('New local workspace', () => render({ mode: 'chooseKind' })));
      const name = el('input', {
        class: 'input cd-gw-pop-input',
        type: 'text',
        placeholder: 'Profile name',
        'aria-label': 'Profile name',
      }) as HTMLInputElement;
      const initialColor =
        AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)] ?? AVATAR_PALETTE[0]!;
      const picker = buildColorPicker(initialColor);
      const submit = async (): Promise<void> => {
        const label = name.value.trim();
        if (!label) {
          name.focus();
          return;
        }
        await opts.onAddLocal({ label, avatarColor: picker.get() });
        close();
      };
      name.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          void submit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          render({ mode: 'chooseKind' });
        }
      });
      popover.append(
        el('div', { class: 'cd-gw-pop-form' }, [
          name,
          el('label', { class: 'cd-gw-pop-form-label' }, 'Avatar color'),
          picker.node,
          el('div', { class: 'cd-gw-pop-form-actions' }, [
            el(
              'button',
              {
                class: 'btn btn-soft',
                type: 'button',
                onClick: () => render({ mode: 'chooseKind' }),
              },
              'Cancel',
            ),
            el(
              'button',
              { class: 'btn btn-primary', type: 'button', onClick: () => void submit() },
              'Create',
            ),
          ]),
        ]),
      );
      queueMicrotask(() => name.focus());
    };

    // ── Add-remote form ─────────────────────────────────────────────
    const renderAddRemote = (): void => {
      popover.dataset.view = 'addRemote';
      popover.replaceChildren();
      popover.append(renderHeader('Connect remote gateway', () => render({ mode: 'chooseKind' })));
      const label = el('input', {
        class: 'input cd-gw-pop-input',
        type: 'text',
        placeholder: 'Profile name (e.g. Centraid Cloud)',
        'aria-label': 'Profile name',
      }) as HTMLInputElement;
      const url = el('input', {
        class: 'input cd-gw-pop-input',
        type: 'text',
        placeholder: 'https://gateway.example.com',
        'aria-label': 'Gateway URL',
      }) as HTMLInputElement;
      const token = el('input', {
        class: 'input cd-gw-pop-input',
        type: 'password',
        placeholder: 'Bearer token (optional)',
        'aria-label': 'Bearer token',
      }) as HTMLInputElement;
      const initialColor =
        AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)] ?? AVATAR_PALETTE[0]!;
      const picker = buildColorPicker(initialColor);
      const submit = async (): Promise<void> => {
        const l = label.value.trim();
        const u = url.value.trim();
        if (!l || !u) {
          (!l ? label : url).focus();
          return;
        }
        await opts.onAddRemote({
          label: l,
          url: u,
          token: token.value,
          avatarColor: picker.get(),
        });
        close();
      };
      const onKeyForm = (ev: KeyboardEvent): void => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          void submit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          render({ mode: 'chooseKind' });
        }
      };
      label.addEventListener('keydown', onKeyForm);
      url.addEventListener('keydown', onKeyForm);
      token.addEventListener('keydown', onKeyForm);
      popover.append(
        el('div', { class: 'cd-gw-pop-form' }, [
          label,
          url,
          token,
          el('label', { class: 'cd-gw-pop-form-label' }, 'Avatar color'),
          picker.node,
          el('div', { class: 'cd-gw-pop-form-actions' }, [
            el(
              'button',
              {
                class: 'btn btn-soft',
                type: 'button',
                onClick: () => render({ mode: 'chooseKind' }),
              },
              'Cancel',
            ),
            el(
              'button',
              { class: 'btn btn-primary', type: 'button', onClick: () => void submit() },
              'Add',
            ),
          ]),
        ]),
      );
      queueMicrotask(() => label.focus());
    };

    // ── Rotate-token form (remote only) ─────────────────────────────
    // Security-sensitive: takes over the popover instead of inlining
    // below the row so the user's attention isn't competing with
    // other profile rows while they're pasting a bearer token.
    const renderRotateToken = (profileId: string): void => {
      const profile = opts.profiles.find((p) => p.id === profileId);
      popover.dataset.view = 'rotateToken';
      popover.replaceChildren();
      popover.append(
        renderHeader(`Rotate token · ${profile?.displayName ?? profileId}`, () =>
          render({ mode: 'list', filter: '' }),
        ),
      );
      const token = el('input', {
        class: 'input cd-gw-pop-input',
        type: 'password',
        placeholder: 'New bearer token',
        autocomplete: 'new-password',
        'aria-label': 'New bearer token',
      }) as HTMLInputElement;
      const submit = async (): Promise<void> => {
        // Empty token is allowed — clears the keychain entry, used
        // when the user wants to unauthenticate a previously-bound
        // remote. Confirm via the placeholder + soft button copy
        // rather than a dialog.
        await opts.onRotateToken(profileId, token.value);
        close();
      };
      token.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          void submit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          render({ mode: 'list', filter: '' });
        }
      });
      popover.append(
        el('div', { class: 'cd-gw-pop-form' }, [
          el(
            'div',
            { class: 'cd-gw-pop-form-help' },
            'The plaintext crosses the bridge once and is stored in the OS keychain. Leave empty to clear.',
          ),
          token,
          el('div', { class: 'cd-gw-pop-form-actions' }, [
            el(
              'button',
              {
                class: 'btn btn-soft',
                type: 'button',
                onClick: () => render({ mode: 'list', filter: '' }),
              },
              'Cancel',
            ),
            el(
              'button',
              { class: 'btn btn-primary', type: 'button', onClick: () => void submit() },
              'Save',
            ),
          ]),
        ]),
      );
      queueMicrotask(() => token.focus());
    };

    // ── Render dispatcher ───────────────────────────────────────────
    const render = (next: View): void => {
      view = next;
      if (next.mode === 'list') {
        renderList({
          filter: next.filter,
          ...(next.expanded ? { expanded: next.expanded } : {}),
        });
      } else if (next.mode === 'chooseKind') {
        renderChooseKind();
      } else if (next.mode === 'addLocal') {
        renderAddLocal();
      } else if (next.mode === 'addRemote') {
        renderAddRemote();
      } else if (next.mode === 'rotateToken') {
        renderRotateToken(next.profileId);
      }
    };

    render({ mode: 'list', filter: '' });
    document.body.append(popover);

    // Position the popover. Width pinned to a Notion-style 320px so the
    // secondary line and the row buttons all fit comfortably without
    // wrapping at common displayName lengths.
    const w = 320;
    popover.style.width = `${w}px`;
    let px: number;
    let py: number;
    if (opts.anchor.kind === 'point') {
      px = Math.min(opts.anchor.x, window.innerWidth - w - 8);
      py = Math.min(opts.anchor.y, window.innerHeight - popover.offsetHeight - 8);
    } else {
      const r = opts.anchor.rect;
      px = r.left;
      py = r.bottom + 4;
      if (px + w > window.innerWidth - 8) px = r.right - w;
      if (py + popover.offsetHeight > window.innerHeight - 8) {
        py = r.top - popover.offsetHeight - 4;
      }
    }
    popover.style.left = `${Math.max(8, px)}px`;
    popover.style.top = `${Math.max(8, py)}px`;

    document.addEventListener('keydown', onKey);
    return { close };
  }

  // Expose for app.ts + builder.ts.
  window.Chrome = {
    buildWindow,
    buildSidebar,
    openGatewaySwitcher,
    tbBtn,
    glyphs: Glyph,
  };
})();
