// governance: allow-repo-hygiene file-size-limit profile-switcher-presentation-layer pending split into switcher / modal / manage-page modules
// profiles.ts — profile ("space") switcher presentation layer.
//
// A profile is a separate space with its own home grid of apps. Since #280
// a profile IS a VAULT: name maps to `core_vault.display_name`, and
// color/icon/blurb live in the vault's own settings (`core_vault.
// settings_json`) — nothing is persisted client-side anymore, so a space's
// identity travels with a vault export. Gateways demoted to *connections*;
// the dropdown lists the other connections below the vault list.
//
// This module owns *presentation* only — the avatar, the sidebar-head
// switcher, its dropdown, the add/edit modal, the delete dialog, the toast,
// and the Settings "Spaces" manage body. All data + HTTP wiring lives in
// app.ts, which feeds plain `ProfileView` records in and receives callbacks
// out.

(function () {
  const Icon = window.Icon;
  const tokens = window.CentraidTokens;

  // Palette hexes, in the design's reference order. Mirrors
  // packages/design-tokens/palette.ts. Used for the color picker swatches.
  const PROFILE_COLORS: readonly string[] = [
    '#4E68DD', // indigo
    '#E55772', // rose
    '#7C5BD9', // violet
    '#2EA098', // teal
    '#5C8A4E', // forest
    '#E89A3C', // amber
    '#B47B3F', // ochre
    '#5C677D', // slate
  ];
  // Icon-picker options. Every name resolves through @centraid/design-tokens.
  const PROFILE_ICONS: readonly IconNameType[] = [
    'Home',
    'Bolt',
    'Sparkle',
    'Compass',
    'Book',
    'Music',
    'Gym',
    'Plant',
    'Calendar',
    'Camera',
    'Mood',
    'Gift',
  ];

  const DEFAULT_ICON: IconNameType = 'Sparkle';

  // ── el — local DOM helper (each renderer IIFE re-implements its own). ──
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

  const glyph = (name: IconNameType, opts?: { size?: number; strokeWidth?: number }): string =>
    (Icon[name] ?? Icon[DEFAULT_ICON])(opts);

  // ── Avatar — reuses the gradient app-tile finish so a profile reads as
  // a first-class member of the same visual family as the app icons. ─────
  function avatar(profile: { icon: IconNameType; color: string }, size = 28): HTMLElement {
    const finish = tokens.tileFinish(profile.color, 'gradient');
    return el('span', {
      'aria-hidden': 'true',
      style: {
        width: `${size}px`,
        height: `${size}px`,
        flexShrink: '0',
        borderRadius: `${Math.max(6, Math.round(size * 0.28))}px`,
        display: 'grid',
        placeItems: 'center',
        background: finish.background,
        color: finish.glyphColor,
        ...(finish.boxShadow ? { boxShadow: finish.boxShadow } : {}),
      },
      trustedHtml: glyph(profile.icon, { size: Math.round(size * 0.52), strokeWidth: 1.9 }),
    });
  }

  function kindLabel(kind: 'local' | 'remote'): string {
    return kind === 'remote' ? 'Remote' : 'Local';
  }
  /** Normalize a backend icon string into a renderable icon name. */
  function safeIcon(name: string | undefined): IconNameType {
    return name && Icon[name as IconNameType] ? (name as IconNameType) : DEFAULT_ICON;
  }
  function secondaryLine(p: ProfileView): string {
    const lead = p.blurb.trim() || kindLabel(p.kind);
    return typeof p.appsCount === 'number'
      ? `${lead} · ${p.appsCount} app${p.appsCount === 1 ? '' : 's'}`
      : lead;
  }

  // ── Focus trap + Esc — shared by the dropdown, modal, and dialog. ─────
  function focusables(root: HTMLElement): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((n) => n.offsetParent !== null || n === document.activeElement);
  }
  function trapFocus(panel: HTMLElement, onClose: () => void): () => void {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(panel);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }

  // ───────────────────────────────────────────────────────────────────
  // Sidebar-head switcher button. `[avatar] Name / N apps  ⇅`
  // Built fresh on every sidebar render; the dropdown is opened on click.
  // ───────────────────────────────────────────────────────────────────
  function buildSwitcherHeader(opts: {
    active: ProfileView;
    open?: boolean;
    onToggle: (anchor: DOMRect) => void;
  }): HTMLElement {
    const { active } = opts;
    const name = el('span', {
      class: 'cd-prof-head-name',
      title: active.name,
    });
    name.textContent = active.name;
    const sub = el('span', { class: 'cd-prof-head-sub' });
    sub.textContent =
      typeof active.appsCount === 'number'
        ? `${active.appsCount} app${active.appsCount === 1 ? '' : 's'}`
        : kindLabel(active.kind);

    const btn = el('button', {
      class: 'cd-prof-head',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': opts.open ? 'true' : 'false',
      'data-open': opts.open ? 'true' : 'false',
      'aria-label': `Active profile: ${active.name}. Click to switch.`,
      onClick: (e: Event) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        opts.onToggle(r);
      },
    });
    btn.append(
      avatar(active, 30),
      el('span', { class: 'cd-prof-head-text' }, [name, sub]),
      el('span', { class: 'cd-prof-head-chev', trustedHtml: glyph('SwitchVert', { size: 14 }) }),
    );
    return btn;
  }

  // ───────────────────────────────────────────────────────────────────
  // Dropdown — list of profiles + Add / Manage actions. Anchored to the
  // head row via position:fixed so it escapes the sidebar's overflow.
  // ───────────────────────────────────────────────────────────────────
  interface DropdownOpts {
    anchor: DOMRect;
    profiles: ProfileView[];
    activeId: string;
    onSwitch: (id: string) => void;
    onEdit: (p: ProfileView) => void;
    onAdd: () => void;
    onManage: () => void;
    /** Other gateway endpoints ("connections", #280) — switching one swaps the whole vault registry. */
    connections?: Array<{ id: string; name: string; active: boolean; kind: 'local' | 'remote' }>;
    onSwitchConnection?: (id: string) => void;
  }
  function openDropdown(opts: DropdownOpts): { close: () => void } {
    document.querySelectorAll('.cd-prof-pop, .cd-prof-pop-scrim').forEach((n) => n.remove());

    let released = false;
    let releaseTrap = (): void => {};
    const scrim = el('div', { class: 'cd-prof-pop-scrim', onClick: () => close() });
    const pop = el('div', { class: 'cd-prof-pop', role: 'menu' });

    function close(): void {
      if (released) return;
      released = true;
      releaseTrap();
      scrim.remove();
      pop.remove();
    }

    pop.append(
      el('div', { class: 'cd-eyebrow cd-prof-pop-eyebrow' }, `Profiles · ${opts.profiles.length}`),
    );
    const list = el('div', { class: 'cd-prof-pop-list' });
    for (const p of opts.profiles) {
      const isActive = p.id === opts.activeId;
      const row = el('div', {
        class: 'cd-prof-pop-row',
        role: 'menuitem',
        tabindex: '0',
        'data-active': isActive ? 'true' : 'false',
        onClick: () => {
          close();
          opts.onSwitch(p.id);
        },
        onKeydown: (e: Event) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' || ke.key === ' ') {
            ke.preventDefault();
            close();
            opts.onSwitch(p.id);
          }
        },
      });
      const text = el('span', { class: 'cd-prof-pop-text' });
      const nm = el('span', { class: 'cd-prof-pop-name' });
      nm.textContent = p.name;
      const sb = el('span', { class: 'cd-prof-pop-sub' });
      sb.textContent = secondaryLine(p);
      text.append(nm, sb);

      const editBtn = el('button', {
        class: 'cd-prof-pop-edit',
        type: 'button',
        title: 'Edit profile',
        'aria-label': `Edit ${p.name}`,
        trustedHtml: glyph('Pencil', { size: 12 }),
        onClick: (e: Event) => {
          e.stopPropagation();
          close();
          opts.onEdit(p);
        },
      });
      const trailing = isActive
        ? el('span', {
            class: 'cd-prof-pop-check',
            trustedHtml: glyph('Check', { size: 15, strokeWidth: 2.4 }),
          })
        : el('span', { class: 'cd-prof-pop-spacer' });

      row.append(avatar(p, 26), text, editBtn, trailing);
      list.append(row);
    }
    pop.append(list);
    pop.append(el('div', { class: 'cd-prof-pop-divider', 'aria-hidden': 'true' }));
    pop.append(
      menuAction('Plus', 'Add profile', () => {
        close();
        opts.onAdd();
      }),
    );
    pop.append(
      menuAction(
        'Users',
        'Manage spaces',
        () => {
          close();
          opts.onManage();
        },
        true,
      ),
    );

    // Connections (#280): gateways are plumbing now — list the OTHER
    // endpoints so switching machine/account stays one click, without
    // conflating them with spaces.
    const conns = opts.connections ?? [];
    if (conns.length > 1 && opts.onSwitchConnection) {
      pop.append(el('div', { class: 'cd-prof-pop-divider', 'aria-hidden': 'true' }));
      pop.append(el('div', { class: 'cd-eyebrow cd-prof-pop-eyebrow' }, 'Connections'));
      for (const c of conns) {
        pop.append(
          menuAction(
            c.kind === 'remote' ? 'Compass' : 'Home',
            c.active ? `${c.name} · connected` : c.name,
            () => {
              if (c.active) return;
              close();
              opts.onSwitchConnection?.(c.id);
            },
            c.active,
          ),
        );
      }
    }

    document.body.append(scrim, pop);

    // Anchor below the head row, flipping above if it would overflow.
    const a = opts.anchor;
    pop.style.left = `${Math.max(8, a.left)}px`;
    let top = a.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, a.top - pop.offsetHeight - 6);
    }
    pop.style.top = `${top}px`;
    const overflowRight = a.left + pop.offsetWidth - window.innerWidth + 8;
    if (overflowRight > 0) pop.style.left = `${Math.max(8, a.left - overflowRight)}px`;

    releaseTrap = trapFocus(pop, close);
    (
      pop.querySelector<HTMLElement>('.cd-prof-pop-row[data-active="true"]') ??
      pop.querySelector<HTMLElement>('.cd-prof-pop-row')
    )?.focus();

    return { close };
  }

  function menuAction(
    icon: IconNameType,
    label: string,
    onClick: () => void,
    muted = false,
  ): HTMLElement {
    return el(
      'button',
      {
        class: `cd-prof-pop-action${muted ? ' cd-prof-pop-action--muted' : ''}`,
        type: 'button',
        onClick,
      },
      [
        el('span', { class: 'cd-prof-pop-action-icon', trustedHtml: glyph(icon, { size: 14 }) }),
        el('span', {}, label),
      ],
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Add / edit modal.
  // ───────────────────────────────────────────────────────────────────
  interface ModalOpts {
    mode: 'add' | 'edit';
    initial: { name?: string; icon?: IconNameType; color?: string; blurb?: string };
    onCommit: (data: { name: string; icon: IconNameType; color: string; blurb: string }) => void;
    onCancel: () => void;
    onDelete?: (() => void) | null;
  }
  function openModal(opts: ModalOpts): { close: () => void } {
    let name = opts.initial.name ?? '';
    let icon: IconNameType =
      opts.initial.icon && Icon[opts.initial.icon] ? opts.initial.icon : DEFAULT_ICON;
    let color = opts.initial.color ?? PROFILE_COLORS[0]!;
    let blurb = opts.initial.blurb ?? '';

    let released = false;
    let releaseTrap = (): void => {};
    function close(): void {
      if (released) return;
      released = true;
      releaseTrap();
      wrap.remove();
    }

    const scrim = el('div', { class: 'cd-prof-scrim', onClick: () => opts.onCancel() });

    // Live preview, updated in place as fields change.
    const previewAvatar = el('span', { class: 'cd-prof-modal-preview-avatar' }, [
      avatar({ icon, color }, 46),
    ]);
    const previewName = el('div', { class: 'cd-prof-modal-preview-name' });
    const previewSub = el('div', { class: 'cd-prof-modal-preview-sub' });
    const refreshPreview = (): void => {
      previewAvatar.replaceChildren(avatar({ icon, color }, 46));
      previewName.textContent = name.trim() || 'Untitled';
      previewSub.textContent = blurb.trim() || 'How this profile appears in the switcher.';
    };

    const saveBtn = el('button', {
      class: 'cd-prof-modal-save',
      type: 'button',
      onClick: () => {
        if (!name.trim()) return;
        opts.onCommit({ name: name.trim(), icon, color, blurb: blurb.trim() });
      },
    });
    saveBtn.textContent = opts.mode === 'add' ? 'Create profile' : 'Save changes';
    const syncSave = (): void => {
      const ok = name.trim().length > 0;
      saveBtn.toggleAttribute('disabled', !ok);
      saveBtn.dataset.enabled = ok ? 'true' : 'false';
    };

    const nameInput = el('input', {
      class: 'cd-prof-field-input',
      type: 'text',
      placeholder: 'e.g. Work',
      value: name,
      onInput: (e: Event) => {
        name = (e.target as HTMLInputElement).value;
        refreshPreview();
        syncSave();
      },
    }) as HTMLInputElement;

    const iconGrid = el('div', { class: 'cd-prof-icon-grid' });
    const iconBtns = new Map<IconNameType, HTMLElement>();
    for (const ic of PROFILE_ICONS) {
      const b = el('button', {
        class: 'cd-prof-icon-btn',
        type: 'button',
        title: ic,
        'aria-label': ic,
        'data-selected': ic === icon ? 'true' : 'false',
        trustedHtml: glyph(ic, { size: 16 }),
        onClick: () => {
          icon = ic;
          for (const [k, node] of iconBtns) node.dataset.selected = k === ic ? 'true' : 'false';
          refreshPreview();
        },
      });
      iconBtns.set(ic, b);
      iconGrid.append(b);
    }

    const colorRow = el('div', { class: 'cd-prof-color-row' });
    const colorBtns = new Map<string, HTMLElement>();
    for (const c of PROFILE_COLORS) {
      const b = el('button', {
        class: 'cd-prof-color-btn',
        type: 'button',
        title: c,
        'aria-label': `Color ${c}`,
        'data-selected': c === color ? 'true' : 'false',
        style: { background: c },
        onClick: () => {
          color = c;
          for (const [k, node] of colorBtns) node.dataset.selected = k === c ? 'true' : 'false';
          refreshPreview();
        },
      });
      colorBtns.set(c, b);
      colorRow.append(b);
    }

    const blurbInput = el('input', {
      class: 'cd-prof-field-input',
      type: 'text',
      placeholder: 'A short note — e.g. Focus & planning',
      value: blurb,
      onInput: (e: Event) => {
        blurb = (e.target as HTMLInputElement).value;
        refreshPreview();
      },
    }) as HTMLInputElement;

    const footerLeft: ElChild[] = [];
    if (opts.onDelete) {
      footerLeft.push(
        el(
          'button',
          {
            class: 'cd-chip cd-prof-modal-delete',
            type: 'button',
            onClick: () => opts.onDelete?.(),
          },
          [el('span', { trustedHtml: glyph('Trash', { size: 12 }) }), 'Delete'],
        ),
      );
    }

    const panel = el('div', { class: 'cd-prof-modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'cd-prof-modal-head' }, [
        el('span', { class: 'cd-prof-modal-head-icon', trustedHtml: glyph('Users', { size: 14 }) }),
        el(
          'h2',
          { class: 'cd-prof-modal-title' },
          opts.mode === 'add' ? 'New profile' : 'Edit profile',
        ),
        el('button', {
          class: 'cd-icon-btn cd-prof-modal-close',
          type: 'button',
          title: 'Close',
          'aria-label': 'Close',
          trustedHtml: glyph('X', { size: 14 }),
          onClick: () => opts.onCancel(),
        }),
      ]),
      el('div', { class: 'cd-prof-modal-body' }, [
        el('div', { class: 'cd-prof-modal-preview' }, [
          previewAvatar,
          el('div', { class: 'cd-prof-modal-preview-text' }, [previewName, previewSub]),
        ]),
        field('Name', false, nameInput),
        field('Icon', false, iconGrid),
        field('Color', false, colorRow),
        field('Description', true, blurbInput),
      ]),
      el('div', { class: 'cd-prof-modal-foot' }, [
        ...footerLeft,
        el('span', { style: { flex: '1' } }),
        el(
          'button',
          { class: 'cd-chip', type: 'button', onClick: () => opts.onCancel() },
          'Cancel',
        ),
        saveBtn,
      ]),
    ]);

    const wrap = el('div', { class: 'cd-prof-overlay' }, [scrim, panel]);
    document.body.append(wrap);
    refreshPreview();
    syncSave();
    releaseTrap = trapFocus(panel, () => opts.onCancel());
    nameInput.focus();
    nameInput.select();

    return { close };
  }

  function field(label: string, optional: boolean, control: HTMLElement): HTMLElement {
    const lab = el('span', { class: 'cd-prof-field-label' }, label);
    if (optional) lab.append(el('span', { class: 'cd-prof-field-optional' }, 'optional'));
    return el('label', { class: 'cd-prof-field' }, [lab, control]);
  }

  // ───────────────────────────────────────────────────────────────────
  // Delete confirmation dialog.
  // ───────────────────────────────────────────────────────────────────
  function openDeleteDialog(opts: {
    profile: ProfileView;
    onConfirm: () => void;
    onCancel: () => void;
  }): { close: () => void } {
    let released = false;
    let releaseTrap = (): void => {};
    function close(): void {
      if (released) return;
      released = true;
      releaseTrap();
      wrap.remove();
    }

    const n = opts.profile.appsCount;
    const body = el('p', { class: 'cd-prof-dialog-body' });
    if (typeof n === 'number' && n > 0) {
      body.append(
        document.createTextNode('Its '),
        el('b', {}, `${n} app${n === 1 ? '' : 's'}`),
        document.createTextNode(
          ' and chats will be removed from this device. This can’t be undone.',
        ),
      );
    } else {
      body.textContent = 'Removing this profile can’t be undone.';
    }

    const title = el('h2', { class: 'cd-prof-dialog-title' });
    title.textContent = `Delete “${opts.profile.name}”?`;

    const panel = el(
      'div',
      { class: 'cd-prof-dialog', role: 'alertdialog', 'aria-modal': 'true' },
      [
        el('div', { class: 'cd-prof-dialog-head' }, [
          el('span', { class: 'cd-prof-dialog-icon', trustedHtml: glyph('Trash', { size: 17 }) }),
          title,
        ]),
        body,
        el('div', { class: 'cd-prof-dialog-actions' }, [
          el(
            'button',
            { class: 'cd-chip', type: 'button', onClick: () => opts.onCancel() },
            'Cancel',
          ),
          el(
            'button',
            { class: 'cd-prof-dialog-confirm', type: 'button', onClick: () => opts.onConfirm() },
            [el('span', { trustedHtml: glyph('Trash', { size: 12 }) }), 'Delete profile'],
          ),
        ]),
      ],
    );

    const wrap = el('div', { class: 'cd-prof-overlay' }, [
      el('div', { class: 'cd-prof-scrim', onClick: () => opts.onCancel() }),
      panel,
    ]);
    document.body.append(wrap);
    releaseTrap = trapFocus(panel, () => opts.onCancel());
    panel.querySelector<HTMLElement>('.cd-prof-dialog-confirm')?.focus();
    return { close };
  }

  // ───────────────────────────────────────────────────────────────────
  // Toast — pill, bottom-center, auto-dismiss.
  // ───────────────────────────────────────────────────────────────────
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(opts: { msg: string; kind?: 'ok' | 'del' }): void {
    document.querySelectorAll('.cd-prof-toast').forEach((n) => n.remove());
    if (toastTimer) clearTimeout(toastTimer);
    const ok = opts.kind !== 'del';
    const node = el(
      'div',
      { class: 'cd-prof-toast', 'data-kind': ok ? 'ok' : 'del', role: 'status' },
      [
        el('span', {
          class: 'cd-prof-toast-icon',
          trustedHtml: ok
            ? glyph('Check', { size: 11, strokeWidth: 2.6 })
            : glyph('Trash', { size: 10 }),
        }),
        el('span', {}, opts.msg),
      ],
    );
    document.body.append(node);
    toastTimer = setTimeout(() => node.remove(), 2600);
  }

  // ───────────────────────────────────────────────────────────────────
  // Manage body — list of profile cards. Used in Settings → Profiles.
  // ───────────────────────────────────────────────────────────────────
  interface ManageOpts {
    profiles: ProfileView[];
    activeId: string;
    onSwitch: (id: string) => void;
    onEdit: (p: ProfileView) => void;
    onDelete: (p: ProfileView) => void;
    onAdd: () => void;
  }
  function buildManageBody(opts: ManageOpts): HTMLElement {
    const wrap = el('div', { class: 'cd-prof-manage' });
    const listEl = el('div', { class: 'cd-prof-manage-list' });
    for (const p of opts.profiles) {
      listEl.append(manageRow(p, p.id === opts.activeId, opts));
    }
    wrap.append(listEl);
    wrap.append(
      el('button', { class: 'cd-prof-manage-add', type: 'button', onClick: () => opts.onAdd() }, [
        el('span', { trustedHtml: glyph('Plus', { size: 14 }) }),
        'Add profile',
      ]),
    );
    return wrap;
  }

  function manageRow(p: ProfileView, active: boolean, opts: ManageOpts): HTMLElement {
    const name = el('span', { class: 'cd-prof-row-name' });
    name.textContent = p.name;
    const titleRow = el('div', { class: 'cd-prof-row-titlerow' }, [name]);
    if (active) titleRow.append(el('span', { class: 'cd-prof-row-badge' }, 'Active'));
    const sub = el('div', { class: 'cd-prof-row-sub' });
    sub.textContent = secondaryLine(p);

    const actions = el('div', { class: 'cd-prof-row-actions' });
    if (!active) {
      actions.append(
        el(
          'button',
          {
            class: 'cd-chip cd-prof-row-switch',
            type: 'button',
            onClick: () => opts.onSwitch(p.id),
          },
          'Switch',
        ),
      );
    }
    actions.append(
      el('button', {
        class: 'cd-icon-btn',
        type: 'button',
        title: 'Edit',
        'aria-label': `Edit ${p.name}`,
        trustedHtml: glyph('Pencil', { size: 13 }),
        onClick: () => opts.onEdit(p),
      }),
    );
    if (!p.primordial) {
      actions.append(
        el('button', {
          class: 'cd-icon-btn cd-prof-row-del',
          type: 'button',
          title: 'Delete',
          'aria-label': `Delete ${p.name}`,
          trustedHtml: glyph('Trash', { size: 13 }),
          onClick: () => opts.onDelete(p),
        }),
      );
    }

    return el('div', { class: 'cd-prof-row', 'data-active': active ? 'true' : 'false' }, [
      avatar(p, 40),
      el('div', { class: 'cd-prof-row-text' }, [titleRow, sub]),
      actions,
    ]);
  }

  window.Profiles = {
    PROFILE_COLORS,
    PROFILE_ICONS,
    DEFAULT_ICON,
    safeIcon,
    avatar,
    buildSwitcherHeader,
    openDropdown,
    openModal,
    openDeleteDialog,
    toast,
    buildManageBody,
  };
})();
