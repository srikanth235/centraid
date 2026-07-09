// Command palette (⌘K) — a 640px command card over a dimmed, blurred copy of
// the current screen. Results group into Build / Apps / Chats / Settings with
// up/down + Enter keyboard navigation and a footer hint bar (Refined Screens
// §F). Extracted from app.ts.
//
// `paletteCleanup` is module-local — nothing outside the palette touches it.
// Cross-surface actions (build/open/discover/settings) are invoked lazily
// through `ctx.shell.*` because that registry is populated after this factory
// runs; plain shell helpers are destructured up front.
//
// The React `PaletteScreen` owns the overlay + search + keyboard nav (via the
// `window.CentraidReact.mountPalette` bridge). This module owns the data: the
// group-building (`collectGroups`) and the DTO mapping (`toDTOGroups`) that
// feed it.
import { relativeTime } from './app-format.js';
import { requireReactBridge, type PaletteGroupDTO } from './react/bridge.js';
import type { ShellContext, TemplateEntry } from './app-shell-context.js';

export interface PaletteModule {
  openCommandPalette(): void;
  closeCommandPalette(): void;
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

const SETTINGS_LABELS = ['Appearance', 'Layout', 'Workspace', 'Agents'];
const SETTINGS_SUBS: Record<string, string> = {
  Appearance: 'Theme, accent, app tiles',
  Layout: 'Density, cards, sidebar',
  Workspace: 'Sidebar, chat model',
  Agents: 'Codex · Claude Code',
};

export function createPaletteModule(ctx: ShellContext): PaletteModule {
  const { el, getApps, getDrafts, recentApps, isDraft, findUserApp, loadAvailableTemplates } = ctx;

  let paletteCleanup: (() => void) | null = null;

  function closeCommandPalette(): void {
    if (paletteCleanup) {
      paletteCleanup();
      paletteCleanup = null;
    }
  }

  // The grouped results for a query, fed to the React PaletteScreen. `run`
  // closures call `closeCommandPalette` + the shell.
  function collectGroups(
    q: string,
    templates: readonly TemplateEntry[],
  ): Array<{
    group: string;
    items: PaletteRow[];
  }> {
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

    // ── Chats — recent builder conversations, one per app.
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
    const setMatches = SETTINGS_LABELS.filter((s) => !q || s.toLowerCase().includes(lc));
    if (setMatches.length > 0) {
      groups.push({
        group: 'Settings',
        items: setMatches.map((s) => ({
          label: s,
          sub: SETTINGS_SUBS[s] ?? 'Settings',
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
  }

  // Map a vanilla PaletteRow to the bridge DTO — pre-render the icon SVG and
  // resolve the gradient tile paint so the React screen stays decoupled.
  function toDTOGroups(groups: Array<{ group: string; items: PaletteRow[] }>): PaletteGroupDTO[] {
    return groups.map((g) => ({
      group: g.group,
      items: g.items.map((r) => {
        const appTile =
          r.variant === 'app' && r.app
            ? window.CentraidTokens.tileFinish(r.app.color, 'gradient')
            : undefined;
        const iconHtml =
          r.variant === 'app' && r.app
            ? (Icon[r.app.iconKey]?.({ size: 14, strokeWidth: 1.85 }) ?? Icon.Sparkle({ size: 14 }))
            : r.icon;
        return {
          label: r.label,
          sub: r.sub,
          iconHtml,
          variant: r.variant ?? 'action',
          tile: appTile
            ? {
                background: appTile.background,
                glyphColor: appTile.glyphColor,
                boxShadow: appTile.boxShadow,
              }
            : undefined,
          meta: r.meta,
          kbd: r.kbd,
          accent: r.accent,
          run: r.run,
        };
      }),
    }));
  }

  function openCommandPalette(): void {
    if (paletteCleanup) return;
    const host = el('div', { class: 'cd-palette-react-host' });
    document.body.append(host);
    let templates: TemplateEntry[] = [];
    let refresh: (() => void) | null = null;
    let dispose: (() => void) | null = null;
    const close = (): void => {
      dispose?.();
      host.remove();
    };
    dispose = requireReactBridge().mountPalette(host, {
      buildGroups: (query) => toDTOGroups(collectGroups(query, templates)),
      onClose: () => closeCommandPalette(),
      onReady: (r) => {
        refresh = r;
      },
    });
    paletteCleanup = close;
    // Templates load async — refresh the open palette when they arrive so the
    // "N curated templates" count fills in.
    void loadAvailableTemplates().then((t) => {
      templates = t;
      refresh?.();
    });
  }

  return { openCommandPalette, closeCommandPalette };
}
