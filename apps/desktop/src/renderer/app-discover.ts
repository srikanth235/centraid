// Discover route — the unified template gallery (app + automation templates,
// filtered by a kind segmented control) and the Starred placeholder. Extracted
// from app.ts. Template previews / context menus live in app-cards.ts and
// app-automations.ts; discover reaches them lazily through `ctx.shell.*`.
import { isAutomationTemplate } from './app-format.js';
import { APP_BADGE_SVG, buildLayoutToggle } from './app-glyphs.js';
import type { ShellContext, TemplateEntry } from './app-shell-context.js';

export interface DiscoverModule {
  renderDiscover(): void;
  renderStarred(): void;
}

export function createDiscoverModule(ctx: ShellContext): DiscoverModule {
  const {
    el,
    clear,
    teardownCurrent,
    recordRoute,
    mountShellPage,
    pageScroll,
    renderSimpleEmpty,
    getRenderSeq,
    getPrefs,
    loadAvailableTemplates,
    loadAutomationTemplates,
    integrationDots,
  } = ctx;

  function renderDiscover(): void {
    void renderDiscoverAsync();
  }
  async function renderDiscoverAsync(): Promise<void> {
    recordRoute({ kind: 'discover' });
    // Keep the current view on screen while the templates IPC is in flight;
    // clear() here would blank the window until it resolves (flicker). The
    // built shell is swapped in atomically by mountShellPage below.
    teardownCurrent();
    const seq = getRenderSeq();
    // Discover now lists BOTH app and automation templates so the kind
    // segmented filter (All / Apps / Automations) is meaningful. The two
    // loaders split the one catalog on `kind`; concatenating keeps apps
    // first so the "All" view leads with them.
    const [appTemplates, automationTemplates] = await Promise.all([
      loadAvailableTemplates(),
      loadAutomationTemplates(),
    ]);
    const all = [...appTemplates, ...automationTemplates];

    const main = el('div', { class: 'has-wall' });
    // cd-disc-scroll drops the cd-main-scroll padding so the width envelope is
    // owned entirely by .cd-disc-wrap below — mirroring Home, whose day1 scroll
    // is padding-free and lets .cd-hsec own the envelope. Without this Discover
    // double-pads (scroll + wrap) and its grid ends up 112px narrower than Home.
    const scroll = el('div', { class: 'cd-main-scroll cd-disc-scroll' });
    main.append(scroll);

    // Kind filter state — drives which slice paints below.
    let kind: 'all' | 'app' | 'automation' = 'all';
    // Tiles (grid) vs Rows (full-width strips). Session-only, mirrors Home.
    let layout: 'tiles' | 'rows' = 'tiles';

    const results = el('div', { class: 'cd-disc-cats' });
    const paint = (): void => {
      const shown = kind === 'all' ? all : kind === 'app' ? appTemplates : automationTemplates;
      if (shown.length === 0) {
        results.replaceChildren(renderSimpleEmpty('No templates available yet.'));
        return;
      }
      // Group by category. Automations carry one; apps don't, so they bucket
      // under a single "Apps" heading (first-seen order preserves apps-first).
      const order: string[] = [];
      const groups = new Map<string, TemplateEntry[]>();
      for (const t of shown) {
        const cat = t.category ?? (isAutomationTemplate(t) ? 'Automations' : 'Apps');
        let bucket = groups.get(cat);
        if (!bucket) {
          bucket = [];
          groups.set(cat, bucket);
          order.push(cat);
        }
        bucket.push(t);
      }
      results.replaceChildren(
        ...order.map((cat) => {
          const bucket = groups.get(cat) ?? [];
          return el('section', { class: 'cd-disc-cat' }, [
            el('div', { class: 'cd-disc-cat-head' }, [
              el('span', { class: 'cd-disc-cat-label' }, cat),
              el('span', { class: 'cd-disc-cat-count' }, String(bucket.length).padStart(2, '0')),
            ]),
            el(
              'div',
              { class: 'cd-disc-grid', 'data-layout': layout },
              bucket.map(renderDiscoverTemplateCard),
            ),
          ]);
        }),
      );
    };

    // Segmented kind filter — pill control, top-right of the header.
    const seg = el('div', {
      class: 'cd-disc-seg',
      role: 'tablist',
      'aria-label': 'Filter templates by kind',
    });
    const sync = (): void => {
      for (const b of seg.querySelectorAll<HTMLElement>('.cd-disc-seg-b'))
        b.dataset.active = String(b.dataset.k === kind);
    };
    const segDefs = [
      { k: 'all', label: 'All', count: all.length, icon: null },
      { k: 'app', label: 'Apps', count: appTemplates.length, icon: 'Home' },
      { k: 'automation', label: 'Automations', count: automationTemplates.length, icon: 'Bolt' },
    ] as const;
    for (const d of segDefs) {
      seg.append(
        el(
          'button',
          {
            class: 'cd-disc-seg-b',
            type: 'button',
            role: 'tab',
            'data-k': d.k,
            onClick: () => {
              kind = d.k;
              sync();
              paint();
            },
          },
          [
            ...(d.icon
              ? [
                  el('span', {
                    class: 'cd-disc-seg-ic',
                    'aria-hidden': 'true',
                    trustedHtml: Icon[d.icon]({ size: 13 }),
                  }),
                ]
              : []),
            el('span', {}, d.label),
            el('span', { class: 'cd-disc-seg-n' }, `· ${d.count}`),
          ],
        ),
      );
    }

    // Layout toggle — Tiles | Rows, far right of the filter toolbar. Flips the
    // grids' data-layout (read by paint); session-only. Shared with Home.
    const layoutToggle = buildLayoutToggle(
      el,
      () => layout,
      (mode) => {
        layout = mode;
        paint();
      },
    );

    // Width envelope matches the Home library shelf (.cd-hsec): capped + padded
    // so the tile grid resolves to the same column width as Home rather than
    // spanning the full main pane.
    scroll.append(
      el('div', { class: 'cd-disc-wrap' }, [
        el('div', { class: 'cd-disc-head' }, [
          el('div', { class: 'cd-disc-head-text' }, [
            el('div', { class: 'cd-eyebrow' }, 'Discover'),
            el('h1', {}, 'Templates'),
            el(
              'p',
              {},
              'Start from a blueprint — an app you open or an automation that runs for you. Clone it, then describe your tweaks in the builder.',
            ),
          ]),
        ]),
        el('div', { class: 'cd-disc-toolbar' }, [
          seg,
          el('span', { class: 'cd-hsec-spacer' }),
          layoutToggle,
        ]),
        results,
      ]),
    );
    sync();
    paint();
    mountShellPage('discover', main, seq);
  }

  // Unified Discover template card — one wide card for both apps and
  // automations (the kind badge + trigger metadata distinguish them).
  // Click opens the matching preview; right-click opens the template menu.
  function renderDiscoverTemplateCard(t: TemplateEntry): HTMLElement {
    const isAuto = isAutomationTemplate(t);
    const card = el('button', {
      class: 'cd-disc-card',
      type: 'button',
      'data-kind': isAuto ? 'automation' : 'app',
      onClick: () =>
        isAuto ? ctx.shell.openAutomationTemplatePreview(t) : ctx.shell.openTemplatePreview(t),
      onContextmenu: (e: Event) => {
        e.preventDefault();
        const me = e as MouseEvent;
        ctx.shell.openTemplateContextMenu(t, { kind: 'point', x: me.clientX, y: me.clientY });
      },
    });

    const color = (window.ICON_PALETTE as Record<string, string>)[t.colorKey] || '#7C5BD9';
    const iconEl = el('div', {
      class: 'cd-disc-card-icon',
      trustedHtml: Icon[t.iconKey as IconNameType]
        ? Icon[t.iconKey as IconNameType]({ size: 21, strokeWidth: 1.85 })
        : '',
    });
    const finish = window.CentraidTokens.tileFinish(color as ColorHexType, getPrefs().tileVariant);
    iconEl.style.background = finish.background;
    iconEl.style.color = finish.glyphColor;
    if (finish.boxShadow) iconEl.style.boxShadow = finish.boxShadow;

    card.append(
      el('div', { class: 'cd-disc-card-top' }, [
        iconEl,
        el('div', { class: 'cd-disc-card-head' }, [
          el('div', { class: 'cd-disc-card-name' }, t.name),
          el('div', { class: 'cd-disc-card-desc' }, t.desc),
        ]),
      ]),
    );

    // Foot: kind badge, then (automations only) trigger badge + integration
    // dots pushed to the right.
    const foot = el('div', { class: 'cd-disc-card-foot' }, [
      el('span', { class: 'cd-disc-badge', 'data-kind': isAuto ? 'automation' : 'app' }, [
        el('span', {
          'aria-hidden': 'true',
          trustedHtml: isAuto ? Icon.Bolt({ size: 12 }) : APP_BADGE_SVG,
        }),
        el('span', {}, isAuto ? 'Automation' : 'App'),
      ]),
    ]);
    if (isAuto) {
      foot.append(
        el('span', { class: 'cd-disc-trig' }, [
          el('span', {
            'aria-hidden': 'true',
            trustedHtml: (t.triggerKind === 'webhook' ? Icon.Webhook : Icon.Clock)({ size: 12 }),
          }),
          el('span', {}, t.triggerKind === 'webhook' ? 'Webhook' : 'Cron'),
        ]),
      );
      // Always append the dots container (empty for no integrations) so the
      // rows-layout tail reserves the slot and the trigger/badge columns stay
      // aligned whether or not a row carries integrations.
      foot.append(integrationDots([...(t.integrations ?? [])]));
    }
    card.append(foot);
    return card;
  }

  function renderStarred(): void {
    recordRoute({ kind: 'starred' });
    clear();
    const { main, scroll } = pageScroll('Starred', 'Apps you star show up here for quick access.');
    scroll.append(renderSimpleEmpty('Nothing starred yet. Hover an app tile and tap the star.'));
    mountShellPage('starred', main);
  }

  return { renderDiscover, renderStarred };
}
