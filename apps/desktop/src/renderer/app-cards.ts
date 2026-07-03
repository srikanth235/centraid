// governance: allow-repo-hygiene file-size-limit route-module split out of app.ts (#227)
// App tiles + the surfaces that mint, open, rename, delete, and share them:
// the home/app card, the right-click context menu, inline rename, the
// new-app sheet, the template clone path, and the conversational-builder entry
// (enterBuilder). Extracted from app.ts.
//
// Context-menu DOM state (ctxBackdrop/ctxMenu/ctxTrigger) and appSettings-free
// helpers are module-local. The home userApps store is reached through the
// ctx accessors (getUserApps/setUserApps/persist); cross-surface navigation
// (openApp, renderHome) goes through `ctx.shell.*`.
import {
  cloneTemplate as gwCloneTemplate,
  deleteApp,
  deregisterApp,
  listApps,
  listTemplates,
  updateAppMeta,
} from './gateway-client.js';
import { inferAppVisual, isAutomationTemplate, relativeTime } from './app-format.js';
import { APP_BADGE_SVG } from './app-glyphs.js';
import type { ShellContext, TemplateEntry } from './app-shell-context.js';

// True when an app was created within the last 24h (drives the "new" pill).
function isRecentlyCreated(iso?: string): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && Date.now() - t < 24 * 60 * 60 * 1000;
}

export interface CardsModule {
  renderAppCard(app: AppMetaResolvedType, small?: boolean): HTMLElement;
  statusPillEl(tone: 'new' | 'draft' | 'live', label: string): HTMLElement;
  /** Footer kind badge (APP / AUTOMATION) — shared with the Home automation card. */
  kindBadgeEl(kind: 'app' | 'automation'): HTMLElement;
  closeContextMenu(): void;
  isContextMenuOpen(): boolean;
  openContextMenu(app: AppMetaResolvedType, anchor: MenuAnchor): void;
  /** Generic popover menu — reused by the Home automation cards' overflow. */
  openMenu(
    items: ReadonlyArray<
      { id: string; label: string; icon: IconNameType; danger?: boolean } | 'sep'
    >,
    anchor: MenuAnchor,
    onPick: (id: string) => void,
  ): void;
  openTemplateContextMenu(tmpl: TemplateEntry, anchor: MenuAnchor): void;
  openTemplatePreview(tmpl: TemplateEntry): void;
  openNewAppSheet(): void;
  enterBuilder(opts?: {
    initialPrompt?: string;
    appContext?: AppMetaResolvedType;
    focusName?: boolean;
  }): void;
  openConfirm(opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }): Promise<boolean>;
  loadAvailableTemplates(): Promise<TemplateEntry[]>;
  handleDeleteApp(app: AppMetaResolvedType): Promise<void>;
  revealApp(app: AppMetaResolvedType): Promise<void>;
  addUserApp(input: {
    prompt?: string;
    name?: string;
    appId: string;
    versionId?: string;
    color?: ColorHexType;
    colorKey?: ColorKeyType;
    iconKey?: IconNameType;
  }): UserAppMeta;
  syncUserAppMeta(input: { appId: string; name?: string; description?: string }): void;
  inferAppMeta(prompt: string): { name: string; iconKey: IconNameType; color: ColorHexType };
}

export function createCardsModule(ctx: ShellContext): CardsModule {
  const {
    el,
    clear,
    showToast,
    recordRoute,
    chromeNav,
    root,
    getDrafts,
    findUserApp,
    isDraft,
    isStarred,
    toggleStar,
    getPrefs,
    getUserApps,
    setUserApps,
    persist,
  } = ctx;

  function statusPillEl(tone: 'new' | 'draft' | 'live', label: string): HTMLElement {
    return el('span', { class: 'cd-status', 'data-tone': tone }, [
      el('span', { class: 'cd-status-dot' }),
      label,
    ]);
  }

  // Card footer kind badge (APP / AUTOMATION) — reuses the Discover badge
  // styling so apps and automations read consistently across both surfaces.
  // Exposed on the module so the Home automation card (in app.ts) reuses it.
  function kindBadgeEl(kind: 'app' | 'automation'): HTMLElement {
    return el('span', { class: 'cd-disc-badge', 'data-kind': kind }, [
      el('span', {
        'aria-hidden': 'true',
        trustedHtml: kind === 'app' ? APP_BADGE_SVG : Icon.Bolt({ size: 12 }),
      }),
      el('span', {}, kind === 'app' ? 'App' : 'Automation'),
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
      // Stable hook for e2e — the clickable tile surface. Decouples tests from
      // the styling class so a card restyle can't break tile-open flows.
      'data-testid': 'app-tile',
      onClick: () => (draft ? enterBuilder({ appContext: app }) : ctx.shell.openApp(app.id)),
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
      // Home tiles render the glyph large + prominent (24px in a ~52px tile)
      // to match the app-gallery spec; CSS pins the final svg box per variant.
      trustedHtml: Icon[app.iconKey] ? Icon[app.iconKey]({ size: 24, strokeWidth: 1.9 }) : '',
    });
    const finish = window.CentraidTokens.tileFinish(app.color, getPrefs().tileVariant);
    iconEl.style.background = finish.background;
    iconEl.style.color = finish.glyphColor;
    if (finish.boxShadow) iconEl.style.boxShadow = finish.boxShadow;
    if (tone) {
      iconEl.append(el('span', { class: 'cd-app-card-icon-dot', 'data-tone': tone }));
    }

    // Horizontal header — large glyph plate on the left, name (+ inline NEW/
    // DRAFT pill) over blurb on the right (matches the apps-gallery spec).
    card.dataset.kind = 'app';
    card.append(
      el('div', { class: 'cd-app-card-head' }, [
        iconEl,
        el('div', { class: 'cd-app-card-head-text' }, [
          el('div', { class: 'cd-app-card-name-row' }, [
            el('div', { class: 'cd-app-card-name' }, app.name),
            ...(tone ? [statusPillEl(tone, tone)] : []),
          ]),
          el('div', { class: 'cd-app-card-desc' }, app.desc || 'No description yet.'),
        ]),
      ]),
    );

    // Divider + state strip: APP kind badge on the left, timestamp on the
    // right. The hover-revealed action toolbar floats over the top-right (a
    // wrap sibling so we don't nest buttons inside the card button).
    const foot = el('div', { class: 'cd-app-card-foot' });
    foot.append(kindBadgeEl('app'));
    const stamp = draft ? 'saved' : relativeTime(ua?.updatedAt);
    foot.append(el('span', { class: 'cd-app-card-foot-time' }, stamp));
    card.append(foot);
    const starred = isStarred(app.id);
    wrap.dataset.starred = String(starred);
    wrap.append(card);

    // Single overflow ⋯ affordance — Edit / Star / Open / Rename / … all live in
    // the menu (openContextMenu) so the card stays clean (no multi-button hover
    // toolbar). A persistent gold star flag marks starred apps when idle;
    // hovering swaps in the ⋯.
    wrap.append(
      el('div', { class: 'cd-card-actions' }, [
        buildMoreButton('App actions', (rect) => openContextMenu(app, { kind: 'rect', rect })),
      ]),
    );
    if (starred)
      wrap.append(
        el('span', {
          class: 'cd-card-star-flag',
          'aria-hidden': 'true',
          trustedHtml: Icon.Star ? Icon.Star({ size: 14 }) : '',
        }),
      );
    return wrap;
  }

  // Overflow `⋯` trigger for the inline toolbar. Marks itself `data-open`
  // while the menu is mounted so CSS keeps the toolbar visible even when the
  // cursor wanders off the card into the menu (captureTrigger reads the flag).
  function buildMoreButton(label: string, onOpen: (rect: DOMRect) => void): HTMLElement {
    const btn = el('button', {
      class: 'cd-card-act cd-card-act-more',
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
    // — only Edit (back to builder) and Delete (rm the app dir) make
    // sense. Published apps additionally get Share.
    const starItem: CtxItem = {
      icon: 'Star',
      id: 'star',
      label: isStarred(app.id) ? 'Unstar' : 'Star',
    };
    const items: (CtxItem | 'sep')[] = isDraft(app)
      ? [
          { icon: 'Sparkle', id: 'update', label: 'Continue editing' },
          { icon: 'Pencil', id: 'rename', label: 'Rename' },
          { icon: 'Folder', id: 'reveal', label: 'Reveal in Finder' },
          starItem,
          'sep',
          { danger: true, icon: 'Trash', id: 'delete', label: 'Delete draft' },
        ]
      : [
          { icon: 'Eye', id: 'open', label: 'Open' },
          { icon: 'Sparkle', id: 'update', label: 'Edit with Centraid' },
          { icon: 'Pencil', id: 'rename', label: 'Rename' },
          { icon: 'Share', id: 'share', label: 'Share' },
          { icon: 'Folder', id: 'reveal', label: 'Reveal in Finder' },
          starItem,
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
    const btn = document.querySelector<HTMLElement>(
      '.cd-card-more[data-open="true"], .cd-card-act[data-open="true"]',
    );
    if (btn) ctxTrigger = btn;
  }

  function handleAction(id: string, app: AppMetaResolvedType): void {
    if (id === 'open') {
      ctx.shell.openApp(app.id);
    } else if (id === 'update') {
      enterBuilder({ appContext: app });
    } else if (id === 'delete') {
      void handleDeleteApp(app);
    } else if (id === 'share') {
      ctx.shell.openShareDialog(app);
    } else if (id === 'rename') {
      startInlineRename(app);
    } else if (id === 'reveal') {
      void revealApp(app);
    } else if (id === 'star') {
      toggleStar(app.id);
      ctx.shell.renderHome();
    }
  }

  async function revealApp(app: AppMetaResolvedType): Promise<void> {
    try {
      await window.CentraidApi.openAppFolder({ id: app.id });
    } catch (err) {
      showToast(`Could not reveal folder: ${String(err)}`);
    }
  }

  /**
   * Flip the app card's name into a contenteditable inline editor (Notion
   * style — no modal). Enter or blur commits via `updateAppMeta`; Esc
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
        await updateAppMeta({ id: app.id, name: nextName });
        if (!isDraft(app)) {
          syncUserAppMeta({ appId: app.id, name: nextName });
        }
        showToast(`Renamed to "${nextName}"`);
        ctx.shell.renderHome();
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
        'Clones into your apps as a draft. Rename, edit, and publish from there — the original template stays in the catalog.',
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

  // Does the store still list this app id? Used by delete to distinguish a
  // transient gateway failure (keep the tile, let the user retry) from an app
  // that's already gone (drop the pin so it can't strand as a ghost tile).
  // A lookup failure is treated as "gone" so a broken gateway never blocks
  // removing a pin.
  async function appStillOnGateway(id: string): Promise<boolean> {
    try {
      return (await listApps()).some((p) => p.id === id);
    } catch {
      return false;
    }
  }

  async function handleDeleteApp(app: AppMetaResolvedType): Promise<void> {
    const draft = isDraft(app);
    const ok = await openConfirm({
      confirmLabel: 'Delete',
      danger: true,
      message: draft
        ? `Delete the draft "${app.name}"? Its app files will be removed from disk.`
        : `Delete "${app.name}"? This removes it from the gateway and wipes its local app files. Data published to the gateway cannot be recovered.`,
      title: draft ? 'Delete draft?' : 'Delete app?',
    });
    if (!ok) return;

    if (draft) {
      try {
        await deleteApp({ id: app.id });
        showToast(`Deleted draft "${app.name}"`);
      } catch (err) {
        showToast(`Could not delete draft: ${String(err)}`);
      }
      ctx.shell.renderHome();
      return;
    }

    // Gateway is the source of truth — if deregister fails for anything other
    // than 404 (already gone), keep the tile so the user can retry rather than
    // silently leaking an orphan registration on the gateway. But only keep it
    // if the app is GENUINELY still there: a wiped/rebuilt code store makes the
    // delete error with a non-404 while the app is already gone, and bailing
    // there would strand the local pin as an unremovable ghost tile. So on a
    // non-404 error we re-check the store and only abort when it confirms the
    // app still exists.
    const ua = findUserApp(app.id);
    const gatewayId = ua?.centraidAppId ?? app.id;
    if (ua?.centraidAppId) {
      try {
        await deregisterApp({ id: ua.centraidAppId });
      } catch (err) {
        const msg = String(err);
        if (!/404|not_found/i.test(msg) && (await appStillOnGateway(gatewayId))) {
          showToast(`Could not delete "${app.name}" from gateway: ${msg}`);
          return;
        }
      }
    }

    // Disk cleanup is best-effort — the gateway side is already consistent.
    let diskWarn: string | null = null;
    try {
      await deleteApp({ id: app.id });
    } catch (err) {
      diskWarn = String(err);
    }

    setUserApps(getUserApps().filter((a) => a.id !== app.id));
    persist();
    ctx.shell.renderHome();
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
  // TemplateEntry lives in app-shell-context.ts; isAutomationTemplate in
  // app-format.ts; loadAutomationTemplates in app-automations.ts (bound below).

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
      const all = (await listTemplates()) as TemplateEntry[];
      // Home Templates tab + Discover gallery surface app templates only.
      // Automation templates have their own surface (renderAutomationTemplates)
      // because they need the richer card layout (emoji, category, trigger
      // label, integration chips).
      return all.filter((t) => !isAutomationTemplate(t));
    } catch {
      return [];
    }
  }

  // Clone a template to disk and drop the user straight into the builder.
  // The new app surfaces as a DRAFT tile on next home render; the user
  // explicitly clicks Publish to upload it to the gateway.
  async function cloneTemplate(tmpl: TemplateEntry): Promise<void> {
    const palette = window.CentraidTokens.palette as unknown as Record<string, ColorHexType>;
    const color: ColorHexType = palette[tmpl.colorKey] ?? ('#5847e0' as ColorHexType);
    try {
      const result = await gwCloneTemplate({ templateId: tmpl.id });
      const draft: DraftAppMeta = {
        __draft: true,
        color,
        colorKey: tmpl.colorKey as DraftAppMeta['colorKey'],
        desc: result.app.description || tmpl.desc,
        hasIndex: true,
        iconKey: tmpl.iconKey as IconNameType,
        id: result.app.id,
        // The IPC's `suggestCloneIdentity` picks a unique suffixed name
        // (e.g. "Hydrate 2") and writes it to `app.json#name` — read that
        // back via `app.name` so the home tile shows the same string
        // the builder topbar will. Fall back to the template's bare name
        // only when app.name wasn't populated (older app shapes).
        name: result.app.name ?? result.template.name,
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
    // app id so the builder reattaches to that app on disk + gateway.
    // Drafts are unpublished apps whose tile id == app id.
    let appId: string | undefined;
    if (opts.appContext) {
      if (isDraft(opts.appContext)) {
        appId = opts.appContext.id;
      } else {
        const ua = findUserApp(opts.appContext.id);
        appId = ua?.centraidAppId;
      }
    }
    // Sidebar drafts list — give the builder the same view of WIP apps
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
      !getDrafts().some((d) => d.id === opts.appContext!.id)
        ? [opts.appContext, ...getDrafts()]
        : getDrafts();
    const builderDrafts: ChromeSidebarApp[] = draftsForSidebar.map((d) => ({
      color: d.color,
      iconKey: d.iconKey,
      id: d.id,
      name: d.name,
      status: 'draft',
    }));
    ctx.setCurrentCleanup(
      window.openBuilder({
        root,
        el,
        onExit: ctx.shell.renderHome,
        ...routeOpts,
        ...(appId ? { appId } : {}),
        ...(focusName ? { focusName: true } : {}),
        ...chromeNav(),
        drafts: builderDrafts,
        onAddToHome: addUserApp,
        onMetaChange: syncUserAppMeta,
      }) ?? null,
    );
  }

  // Mirror builder-side inline title/description edits into the home's
  // userApps store so a published tile reflects the new metadata
  // immediately on return. Drafts come back from disk via hydrateDrafts
  // (reads `app.json#{name,description}`), so we only need to touch
  // userApps here.
  function syncUserAppMeta(input: { appId: string; name?: string; description?: string }): void {
    const ua = getUserApps().find((a) => a.centraidAppId === input.appId || a.id === input.appId);
    if (!ua) return;
    if (input.name !== undefined) ua.name = input.name;
    if (input.description !== undefined) ua.desc = input.description || 'Built with Centraid.';
    ua.updatedAt = new Date().toISOString();
    persist();
  }

  // ---------- Add to home ----------

  // Prompt inference moved to app-format.ts (issue #263) so the builder's
  // create flow stamps the same identity into the scaffolded app.json —
  // this wrapper keeps the CardsModule surface stable.
  function inferAppMeta(prompt: string): {
    iconKey: IconNameType;
    color: ColorHexType;
    name: string;
  } {
    const { iconKey, color, name } = inferAppVisual(prompt);
    return { iconKey, color, name };
  }

  function addUserApp(input: {
    prompt?: string;
    name?: string;
    /** Centraid app id — required. The builder only fires
     *  `onAddToHome` after a successful publish, at which point the
     *  app id is always defined. The home tile's id is this id, so
     *  context-menu actions and `openApp` can address it directly. */
    appId: string;
    versionId?: string;
    color?: ColorHexType;
    colorKey?: ColorKeyType;
    iconKey?: IconNameType;
  }): UserAppMeta {
    const meta = inferAppVisual(input.prompt || '');
    const id = input.appId;

    const existing = getUserApps().find((a) => a.id === id);
    if (existing) {
      // Republished — refresh metadata, keep tile in place.
      existing.name = input.name || existing.name;
      existing.desc = input.prompt && input.prompt.length <= 60 ? input.prompt : existing.desc;
      existing.centraidAppId = input.appId ?? existing.centraidAppId;
      existing.updatedAt = new Date().toISOString();
      persist();
      ctx.shell.renderHome();
      showToast(`Updated "${existing.name}"`);
      return existing;
    }

    const stampIso = new Date().toISOString();
    const newApp: UserAppMeta = {
      color: input.color || meta.color,
      // The inferred (or caller-provided) hue key — was hardcoded 'violet'
      // pre-#263, which desynced the stored key from the rendered color.
      colorKey: input.colorKey || meta.colorKey,
      createdAt: stampIso,
      desc: input.prompt && input.prompt.length <= 60 ? input.prompt : 'Built with Centraid.',
      iconKey: input.iconKey || meta.iconKey,
      id,
      name: input.name || meta.name,
      updatedAt: stampIso,
      centraidAppId: input.appId,
    };
    getUserApps().push(newApp);
    persist();
    ctx.shell.renderHome();
    showToast(`Added "${newApp.name}" to home`);
    return newApp;
  }

  return {
    renderAppCard,
    statusPillEl,
    kindBadgeEl,
    closeContextMenu,
    isContextMenuOpen: () => ctxMenu !== null,
    openContextMenu,
    openMenu,
    openTemplateContextMenu,
    openTemplatePreview,
    openNewAppSheet,
    enterBuilder,
    openConfirm,
    loadAvailableTemplates,
    handleDeleteApp,
    revealApp,
    addUserApp,
    syncUserAppMeta,
    inferAppMeta,
  };
}
