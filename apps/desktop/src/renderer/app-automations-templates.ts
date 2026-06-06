// Automation templates gallery — the browsable catalog of automation
// blueprints, each previewable and one-tap adoptable into the conversational
// builder. Split out of app-automations.ts. Self-contained: it reaches the
// shell through ShellContext primitives and routes adoption through
// ctx.shell.{enterAutomationBuilder,createAndOpenAutomationBuilder}.
import { cloneTemplate as gwCloneTemplate, listTemplates } from './gateway-client.js';
import { isAutomationTemplate } from './app-format.js';
import { INTEGRATION_HUES } from './app-automations-ui.js';
import type { ShellContext, TemplateEntry } from './app-shell-context.js';

export interface TemplatesGalleryModule {
  renderAutomationTemplates(): void;
  openAutomationTemplatePreview(template: TemplateEntry): void;
  loadAutomationTemplates(): Promise<TemplateEntry[]>;
}

export function createTemplatesGallery(ctx: ShellContext): TemplatesGalleryModule {
  const { el, clear, showToast, recordRoute, pageScroll, mountShellPage } = ctx;

  // The automation slice of the unified template catalog (Discover reuses this
  // loader via the module's exposed binding).
  async function loadAutomationTemplates(): Promise<TemplateEntry[]> {
    try {
      const all = (await listTemplates()) as TemplateEntry[];
      return all.filter(isAutomationTemplate);
    } catch {
      return [];
    }
  }

  // A row of integration chips — colored dot + name.
  function renderIntegrationChips(integrations: readonly string[]): HTMLElement {
    const wrap = el('div', { class: 'cd-au-chips' });
    for (const name of integrations) {
      const hue = INTEGRATION_HUES[name] ?? 'slate';
      const dot = el('i', { class: 'cd-au-chip-dot', 'aria-hidden': 'true' });
      dot.style.background = `var(--c-${hue})`;
      wrap.append(el('span', { class: 'cd-au-chip' }, [dot, name]));
    }
    return wrap;
  }

  function renderAutomationTemplateCard(
    template: TemplateEntry,
    onOpen: (t: TemplateEntry) => void = openAutomationTemplatePreview,
  ): HTMLElement {
    const card = el('button', {
      class: 'cd-au-tpl-card',
      type: 'button',
      onClick: () => onOpen(template),
    });
    const trigIcon =
      template.triggerKind === 'webhook' ? Icon.Webhook({ size: 13 }) : Icon.Clock({ size: 13 });
    card.append(
      el('span', {
        class: 'cd-au-tpl-use',
        trustedHtml: `<span>Use template</span>${Icon.ArrowRight({ size: 13 })}`,
      }),
      el('span', { class: 'cd-au-tpl-top' }, [
        el('span', { class: 'cd-au-tpl-emoji' }, template.emoji ?? '⚙️'),
        el('span', { class: 'cd-au-tpl-name' }, template.name),
      ]),
      el('span', { class: 'cd-au-tpl-desc' }, template.desc),
      el('span', { class: 'cd-au-tpl-foot' }, [
        el('span', { class: 'cd-au-tpl-trig' }, [
          el('span', {
            class: 'cd-au-tpl-trig-icon',
            'aria-hidden': 'true',
            trustedHtml: trigIcon,
          }),
          template.triggerLabel ?? '',
        ]),
        renderIntegrationChips(template.integrations ?? []),
      ]),
    );
    return card;
  }

  // Preview drawer — a right-side panel describing an automation template
  // before adopting it. "Use template" routes into the conversational builder
  // pre-seeded. (Distinct from the home shelf's centered app-template modal,
  // `openTemplatePreview`.)
  function openAutomationTemplatePreview(template: TemplateEntry): void {
    const integrations = template.integrations ?? [];
    const trigIcon =
      template.triggerKind === 'webhook' ? Icon.Webhook({ size: 14 }) : Icon.Clock({ size: 14 });
    const backdrop = el('div', { class: 'cd-au-drawer-backdrop' });
    const panel = el('div', {
      class: 'cd-au-drawer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `${template.name} template`,
    });
    const close = (): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    const stepsList = el('ul', { class: 'cd-au-drawer-steps' });
    for (const line of [
      `Fires ${template.triggerLabel ?? 'on a trigger'}.`,
      template.desc,
      integrations.length > 0
        ? `Works through ${integrations.join(', ')}.`
        : 'Runs with the workspace default tools.',
    ]) {
      stepsList.append(el('li', {}, line));
    }

    const useBtn = el('button', {
      class: 'cd-au-btn cd-au-btn-primary',
      type: 'button',
      trustedHtml: `<span>Use template</span>${Icon.ArrowRight({ size: 14 })}`,
      onClick: () => {
        close();
        void adoptTemplate(template);
      },
    });

    panel.append(
      el('div', { class: 'cd-au-drawer-head' }, [
        el('span', { class: 'cd-au-drawer-emoji' }, template.emoji ?? '⚙️'),
        el('div', {}, [
          el('div', { class: 'cd-au-drawer-name' }, template.name),
          el('div', { class: 'cd-au-drawer-trig' }, [
            el('span', { 'aria-hidden': 'true', trustedHtml: trigIcon }),
            template.triggerLabel ?? 'Manual',
          ]),
        ]),
        el('button', {
          class: 'cd-au-drawer-close',
          type: 'button',
          'aria-label': 'Close',
          trustedHtml: Icon.X({ size: 16 }),
          onClick: close,
        }),
      ]),
      el('div', { class: 'cd-au-drawer-body' }, [
        el('div', { class: 'cd-au-drawer-sec-l' }, 'What it does'),
        stepsList,
        ...(integrations.length > 0
          ? [
              el('div', { class: 'cd-au-drawer-sec-l' }, 'Connects'),
              renderIntegrationChips([...integrations]),
            ]
          : []),
      ]),
      el('div', { class: 'cd-au-drawer-foot' }, [useBtn]),
    );
    backdrop.append(panel);
    document.body.append(backdrop);
  }

  // Renders the Automations → "Browse templates" gallery: a live-search +
  // trigger segmented filter + integration filter chips over the
  // category-grouped card grid. Cards open a preview drawer; "Use template"
  // routes through `cloneTemplate` (the same IPC the home shelf uses).
  function renderAutomationTemplates(): void {
    recordRoute({ kind: 'templates' });
    clear();
    const { main, scroll } = pageScroll(
      'Templates',
      'Proven automations, pre-wired with triggers and integrations. Adopt one and tune it to your workflow.',
    );
    scroll.append(el('div', { class: 'cd-au-loading' }, 'Loading templates…'));
    mountShellPage('automations', main);
    void loadAutomationTemplates().then((tmpls) => {
      scroll.replaceChildren(buildTemplatesGallery(tmpls));
    });
  }

  function buildTemplatesGallery(tmpls: readonly TemplateEntry[]): HTMLElement {
    const wrap = el('div', { class: 'cd-au-tpl-wrap' });

    // Filter state.
    let query = '';
    let trig: 'all' | 'cron' | 'webhook' = 'all';
    const activeIntegrations = new Set<string>();

    // All integrations referenced across the catalog → filter chips.
    const allIntegrations: string[] = [];
    for (const t of tmpls) {
      for (const i of t.integrations ?? [])
        if (!allIntegrations.includes(i)) allIntegrations.push(i);
    }

    const matches = (t: TemplateEntry): boolean => {
      if (trig !== 'all' && (t.triggerKind ?? 'cron') !== trig) return false;
      if (activeIntegrations.size > 0) {
        const ints = t.integrations ?? [];
        for (const want of activeIntegrations) if (!ints.includes(want)) return false;
      }
      if (query) {
        const hay =
          `${t.name} ${t.desc} ${t.category ?? ''} ${(t.integrations ?? []).join(' ')}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    };

    const results = el('div', { class: 'cd-au-tpl-cats' });
    const paint = (): void => {
      const shown = tmpls.filter(matches);
      if (shown.length === 0) {
        results.replaceChildren(
          el('div', { class: 'cd-au-tpl-empty' }, [
            el('div', {
              class: 'cd-au-tpl-empty-icon',
              'aria-hidden': 'true',
              trustedHtml: Icon.Filter({ size: 22 }),
            }),
            el('div', { class: 'cd-au-tpl-empty-title' }, 'No templates match'),
            el(
              'div',
              { class: 'cd-au-tpl-empty-text' },
              'Try a different search or clear the filters.',
            ),
            el('div', { class: 'cd-au-tpl-empty-actions' }, [
              el('button', {
                class: 'cd-au-btn cd-au-btn-ghost',
                type: 'button',
                trustedHtml: `${Icon.X({ size: 14 })}<span>Clear filters</span>`,
                onClick: () => {
                  query = '';
                  trig = 'all';
                  activeIntegrations.clear();
                  searchInput.value = '';
                  syncControls();
                  paint();
                },
              }),
              el('button', {
                class: 'cd-au-btn cd-au-btn-primary',
                type: 'button',
                trustedHtml: `${Icon.Sparkle({ size: 14 })}<span>Start from scratch</span>`,
                onClick: () => void ctx.shell.createAndOpenAutomationBuilder(),
              }),
            ]),
          ]),
        );
        return;
      }
      const cats: string[] = [];
      for (const t of shown) {
        const c = t.category ?? 'Other';
        if (!cats.includes(c)) cats.push(c);
      }
      const sections: HTMLElement[] = [];
      for (const cat of cats) {
        const grid = el('div', { class: 'cd-au-tpl-grid' });
        for (const t of shown) {
          if ((t.category ?? 'Other') === cat)
            grid.append(renderAutomationTemplateCard(t, openAutomationTemplatePreview));
        }
        sections.push(
          el('section', { class: 'cd-au-tpl-cat' }, [
            el('div', { class: 'cd-au-tpl-cat-label' }, cat),
            grid,
          ]),
        );
      }
      results.replaceChildren(...sections);
    };

    // Search.
    const searchInput = el('input', {
      class: 'cd-au-tpl-search-in',
      type: 'search',
      placeholder: 'Search templates…',
      'aria-label': 'Search templates',
    }) as HTMLInputElement;
    searchInput.addEventListener('input', () => {
      query = searchInput.value.trim().toLowerCase();
      paint();
    });
    const search = el('div', { class: 'cd-au-tpl-search' }, [
      el('span', {
        class: 'cd-au-tpl-search-ic',
        'aria-hidden': 'true',
        trustedHtml: Icon.Search({ size: 14 }),
      }),
      searchInput,
    ]);

    // Trigger segmented filter (All / Cron / Webhook).
    const seg = el('div', {
      class: 'cd-au-tpl-seg',
      role: 'tablist',
      'aria-label': 'Filter by trigger',
    });
    const segBtns: HTMLElement[] = [];
    for (const opt of [
      { k: 'all', label: 'All' },
      { k: 'cron', label: 'Cron' },
      { k: 'webhook', label: 'Webhook' },
    ] as const) {
      const b = el(
        'button',
        {
          class: 'cd-au-tpl-seg-b',
          type: 'button',
          role: 'tab',
          'data-k': opt.k,
          onClick: () => {
            trig = opt.k;
            syncControls();
            paint();
          },
        },
        opt.label,
      );
      segBtns.push(b);
      seg.append(b);
    }

    // Integration filter chips.
    const chips = el('div', { class: 'cd-au-tpl-fltr-chips' });
    const chipEls = new Map<string, HTMLElement>();
    for (const name of allIntegrations) {
      const hue = INTEGRATION_HUES[name] ?? 'slate';
      const dot = el('i', { class: 'cd-au-chip-dot', 'aria-hidden': 'true' });
      dot.style.background = `var(--c-${hue})`;
      const chip = el(
        'button',
        {
          class: 'cd-au-tpl-fltr-chip',
          type: 'button',
          'aria-pressed': 'false',
          onClick: () => {
            if (activeIntegrations.has(name)) activeIntegrations.delete(name);
            else activeIntegrations.add(name);
            syncControls();
            paint();
          },
        },
        [dot, name],
      );
      chipEls.set(name, chip);
      chips.append(chip);
    }

    const syncControls = (): void => {
      for (const b of segBtns) {
        if (b.dataset.k === trig) b.dataset.active = 'true';
        else delete b.dataset.active;
      }
      for (const [name, chip] of chipEls) {
        const on = activeIntegrations.has(name);
        chip.dataset.active = on ? 'true' : '';
        if (!on) delete chip.dataset.active;
        chip.setAttribute('aria-pressed', String(on));
      }
    };

    const toolbar = el('div', { class: 'cd-au-tpl-toolbar' }, [search, seg]);
    wrap.append(toolbar);
    if (allIntegrations.length > 0) wrap.append(chips);
    wrap.append(results);
    syncControls();
    paint();
    return wrap;
  }

  // Adopting an automation template goes through the same `cloneTemplate`
  // IPC as the home-shelf "Use template" button — one code path for both
  // kinds. The IPC handles suffix-aware id+name picking, copies the
  // template's `<slug>/automations/<slug>/{automation.json,handler.js}`
  // into the user's appsDir as `<slug>-N/`, and mints any pending
  // webhook secrets. The user then lands in the automation builder where
  // the agent will tune the handler from the manifest's `prompt`.
  async function adoptTemplate(template: TemplateEntry): Promise<void> {
    try {
      const result = await gwCloneTemplate({ templateId: template.id });
      // Webhook secrets are returned exactly once. v1 surfaces a toast;
      // a follow-up can show a proper "copy this URL + secret" sheet.
      for (const w of result.webhooks ?? []) {
        showToast(`Webhook URL: ${w.url} (secret shown once in console)`);
        // eslint-disable-next-line no-console
        console.info(`[clone] webhook secret for ${w.ownerApp}/${w.automationId}:`, w.secret);
      }
      ctx.shell.enterAutomationBuilder({ automationId: result.app.id });
    } catch (err) {
      showToast(`Could not adopt template: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { renderAutomationTemplates, openAutomationTemplatePreview, loadAutomationTemplates };
}
