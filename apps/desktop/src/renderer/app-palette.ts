// Command palette (⌘K) — a 640px command card over a dimmed, blurred copy of
// the current screen. Results group into Build / Apps / Chats / Settings with
// up/down + Enter keyboard navigation and a footer hint bar (Refined Screens
// §F). Extracted from app.ts.
//
// `paletteCleanup` is module-local — nothing outside the palette touches it.
// Cross-surface actions (build/open/discover/settings) are invoked lazily
// through `ctx.shell.*` because that registry is populated after this factory
// runs; plain shell helpers are destructured up front.
import { relativeTime } from './app-format.js';
import type { ShellContext, TemplateEntry } from './app-shell-context.js';

export interface PaletteModule {
  openCommandPalette(): void;
  closeCommandPalette(): void;
}

export function createPaletteModule(ctx: ShellContext): PaletteModule {
  const { el, getApps, getDrafts, recentApps, isDraft, findUserApp, loadAvailableTemplates } = ctx;

  let paletteCleanup: (() => void) | null = null;

  function closeCommandPalette(): void {
    if (paletteCleanup) {
      paletteCleanup();
      paletteCleanup = null;
    }
  }

  interface PaletteRow {
    label: string;
    sub?: string;
    icon: string;
    tint?: string;
    /** Variant changes the leading visual: action chip, app tile, chat dot. */
    variant?: 'action' | 'app' | 'chat';
    /** App reference — drives the gradient icon tile for `variant: 'app'`. */
    app?: AppMetaResolvedType;
    /** Right-aligned meta — relative time or a kbd hint. */
    meta?: string;
    /** Right-aligned mono kbd chip (e.g. ↵). */
    kbd?: string;
    /** Accent treatment for the leading chip (the primary "Build" action). */
    accent?: boolean;
    run: () => void;
  }

  // §F — a 640px command card over a dimmed, blurred copy of the current
  // screen. Results group into Build / Apps / Chats / Settings with
  // up/down + Enter keyboard navigation and a footer hint bar.
  function openCommandPalette(): void {
    if (paletteCleanup) return;
    const backdrop = el('div', { class: 'cd-palette-backdrop' });
    const card = el('div', {
      class: 'cd-palette',
      role: 'dialog',
      'aria-label': 'Command palette',
    });

    // Input row — leading search glyph, the field, a trailing `esc` chip.
    const input = el('input', {
      class: 'cd-palette-input',
      type: 'text',
      autocomplete: 'off',
      placeholder: 'Search apps, chats, templates — or describe a new one…',
    }) as HTMLInputElement;
    const inputRow = el('div', { class: 'cd-palette-inputrow' }, [
      el('span', { class: 'cd-palette-search-icon', trustedHtml: Icon.Search({ size: 16 }) }),
      input,
      el('span', { class: 'cd-palette-esc' }, 'esc'),
    ]);
    const resultsEl = el('div', { class: 'cd-palette-results' });

    // Footer hint bar — navigate / open / open-in-new-window / esc close.
    const kbd = (k: string): HTMLElement => el('span', { class: 'cd-palette-kbd' }, k);
    const footer = el('div', { class: 'cd-palette-footer' }, [
      kbd('↑↓'),
      el('span', {}, 'navigate'),
      kbd('↵'),
      el('span', {}, 'open'),
      kbd('⌘↵'),
      el('span', {}, 'open in new window'),
      el('span', { class: 'cd-palette-footer-sp' }),
      kbd('esc'),
      el('span', {}, 'close'),
    ]);
    card.append(inputRow, resultsEl, footer);
    backdrop.append(card);
    document.body.append(backdrop);

    let templates: TemplateEntry[] = [];
    void loadAvailableTemplates().then((t) => {
      templates = t;
      render();
    });

    const settingsLabels = ['Appearance', 'Layout', 'Workspace', 'Agents'];

    let rows: PaletteRow[] = [];
    let active = 0;

    const settingsSubs: Record<string, string> = {
      Appearance: 'Theme, accent, app tiles',
      Layout: 'Density, cards, sidebar',
      Workspace: 'Sidebar, chat model',
      Agents: 'Codex · Claude Code',
    };

    const collectGroups = (q: string): Array<{ group: string; items: PaletteRow[] }> => {
      const lc = q.toLowerCase();
      const groups: Array<{ group: string; items: PaletteRow[] }> = [];

      // ── Build — describe-a-new-app primary action + template browse.
      groups.push({
        group: 'Build',
        items: [
          {
            label: q ? `Build ${q}` : 'Build a new app',
            sub: q
              ? 'Start a new app with this prompt'
              : 'Describe an app and let the agent build it',
            icon: Icon.Sparkle({ size: 14 }),
            variant: 'action',
            accent: true,
            kbd: '↵',
            run: () => {
              closeCommandPalette();
              if (q) ctx.shell.enterBuilder({ initialPrompt: q });
              else ctx.shell.openNewAppSheet();
            },
          },
          {
            label: q
              ? `Browse templates · matching “${q}”`
              : 'Browse templates · habit, journal, counter',
            sub: templates.length
              ? `${templates.length} curated templates`
              : 'Curated starting points',
            icon: Icon.Compass({ size: 14 }),
            variant: 'action',
            run: () => {
              closeCommandPalette();
              ctx.shell.renderDiscover();
            },
          },
        ],
      });

      // ── Apps — gradient app tiles. Matching apps, or recents pre-query.
      const allApps = [...getApps(), ...getDrafts()];
      const recents = recentApps();
      const appMatches = (
        q
          ? allApps.filter((a) => a.name.toLowerCase().includes(lc))
          : recents.length
            ? recents
            : allApps
      ).slice(0, 6);
      if (appMatches.length > 0) {
        groups.push({
          group: `Apps · ${appMatches.length}`,
          items: appMatches.map((a) => {
            const ua = !isDraft(a) ? findUserApp(a.id) : undefined;
            return {
              label: a.name,
              sub: a.desc || 'No description yet.',
              icon: '',
              variant: 'app' as const,
              app: a,
              meta: isDraft(a) ? 'draft' : relativeTime(ua?.updatedAt),
              run: () => {
                closeCommandPalette();
                if (isDraft(a)) ctx.shell.enterBuilder({ appContext: a });
                else ctx.shell.openApp(a.id);
              },
            };
          }),
        });
      }

      // ── Chats — recent builder conversations, one per app. The shell has
      // no separate chat store, so each app's build conversation is the
      // chat; opening a row drops you back into that app's builder.
      const chatApps = (q ? appMatches : recents.length ? recents : allApps).slice(0, 3);
      if (chatApps.length > 0) {
        groups.push({
          group: `Chats · ${chatApps.length}`,
          items: chatApps.map((a) => {
            const ua = !isDraft(a) ? findUserApp(a.id) : undefined;
            return {
              label: `Continue building ${a.name}`,
              sub: `${a.name} · ${isDraft(a) ? 'draft' : relativeTime(ua?.updatedAt)}`,
              icon: Icon.Sparkle({ size: 13 }),
              variant: 'chat' as const,
              run: () => {
                closeCommandPalette();
                ctx.shell.enterBuilder({ appContext: a });
              },
            };
          }),
        });
      }

      // ── Settings — the inner pages, each with a one-line blurb.
      const setMatches = settingsLabels.filter((s) => !q || s.toLowerCase().includes(lc));
      if (setMatches.length > 0) {
        groups.push({
          group: 'Settings',
          items: setMatches.map((s) => ({
            label: s,
            sub: settingsSubs[s] ?? 'Settings',
            icon: Icon.Settings({ size: 14 }),
            variant: 'action' as const,
            run: () => {
              closeCommandPalette();
              ctx.shell.renderSettings();
            },
          })),
        });
      }
      return groups;
    };

    const highlight = (): void => {
      const rowEls = resultsEl.querySelectorAll<HTMLElement>('.cd-palette-row');
      let i = 0;
      for (const r of rowEls) {
        r.dataset.active = String(i === active);
        if (i === active) r.scrollIntoView({ block: 'nearest' });
        i += 1;
      }
    };

    const render = (): void => {
      const q = input.value.trim();
      rows = [];
      resultsEl.replaceChildren();
      for (const g of collectGroups(q)) {
        resultsEl.append(el('div', { class: 'cd-palette-group' }, g.group));
        for (const item of g.items) {
          rows.push(item);

          // Leading visual — gradient app tile, accent action chip, or a
          // plain bordered glyph chip (chat / non-accent action).
          let lead: HTMLElement;
          if (item.variant === 'app' && item.app) {
            lead = el('div', { class: 'cd-palette-row-tile' });
            const finish = window.CentraidTokens.tileFinish(item.app.color, 'gradient');
            lead.style.background = finish.background;
            lead.style.color = finish.glyphColor;
            if (finish.boxShadow) lead.style.boxShadow = finish.boxShadow;
            lead.innerHTML = Icon[item.app.iconKey]
              ? Icon[item.app.iconKey]({ size: 14, strokeWidth: 1.85 })
              : Icon.Sparkle({ size: 14 });
          } else {
            lead = el('span', {
              class: 'cd-palette-row-icon',
              'data-accent': item.accent ? 'true' : undefined,
              trustedHtml: item.icon,
            });
            if (item.tint && !item.accent) lead.style.color = item.tint;
          }

          const txt = el('div', { class: 'cd-palette-row-text' }, [
            el('div', { class: 'cd-palette-row-label' }, item.label),
          ]);
          if (item.sub) txt.append(el('div', { class: 'cd-palette-row-sub' }, item.sub));

          const rowChildren: HTMLElement[] = [lead, txt];
          if (item.kbd) {
            rowChildren.push(el('span', { class: 'cd-palette-row-kbd' }, item.kbd));
          } else if (item.meta) {
            rowChildren.push(el('span', { class: 'cd-palette-row-meta' }, item.meta));
          }

          resultsEl.append(
            el(
              'button',
              {
                class: 'cd-palette-row',
                'data-variant': item.variant ?? 'action',
                type: 'button',
                onClick: () => item.run(),
              },
              rowChildren,
            ),
          );
        }
      }
      if (active >= rows.length) active = Math.max(0, rows.length - 1);
      highlight();
    };

    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if (k.key === 'Escape') {
        k.preventDefault();
        closeCommandPalette();
      } else if (k.key === 'ArrowDown') {
        k.preventDefault();
        active = Math.min(rows.length - 1, active + 1);
        highlight();
      } else if (k.key === 'ArrowUp') {
        k.preventDefault();
        active = Math.max(0, active - 1);
        highlight();
      } else if (k.key === 'Enter') {
        // ⌘↵ is the "open in new window" affordance from the footer hint
        // bar; the shell is single-window today, so it runs the active row.
        k.preventDefault();
        rows[active]?.run();
      }
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeCommandPalette();
    });

    paletteCleanup = (): void => {
      backdrop.remove();
    };

    render();
    input.focus();
  }

  return { openCommandPalette, closeCommandPalette };
}
