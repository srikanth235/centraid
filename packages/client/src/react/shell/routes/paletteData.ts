import type { AppearancePrefs, ShellRoute } from '../../../app-shell-context.js';
import type { PaletteGroupDTO, PaletteRowDTO } from '../../screen-contracts.js';
import { iconSvg } from '../iconSvg.js';

// The ⌘K command palette's data driver — the React successor to the vanilla
// app-palette.ts `buildGroups`. Given the current query it returns grouped
// rows (apps, navigation targets, a "build a new app" create row), each with a
// `run` closure the palette invokes on Enter/click. Kept pure + deps-injected
// so it is unit-testable without a live shell.

const NAV_ACTIONS: { label: string; icon: string; route: ShellRoute }[] = [
  { label: 'Home', icon: 'Home', route: { kind: 'home' } },
  { label: 'Assistant', icon: 'Sparkle', route: { kind: 'assistant' } },
  { label: 'Insights', icon: 'Gauge', route: { kind: 'insights' } },
  { label: 'Discover', icon: 'Compass', route: { kind: 'discover' } },
  { label: 'Automations', icon: 'Bolt', route: { kind: 'automations' } },
  { label: 'Gateway', icon: 'Cellular', route: { kind: 'gateway' } },
  { label: 'Settings', icon: 'Settings', route: { kind: 'settings' } },
];

export interface PaletteDeps {
  userApps: readonly UserAppMeta[];
  drafts: readonly DraftAppMeta[];
  tileVariant: AppearancePrefs['tileVariant'];
  navigate: (route: ShellRoute) => void;
  enterBuilder: (initialPrompt?: string) => void;
  onClose: () => void;
}

/** Recompute the palette's grouped rows for `query` (case-insensitive substring). */
export function buildPaletteGroups(query: string, deps: PaletteDeps): PaletteGroupDTO[] {
  const q = query.trim().toLowerCase();
  const groups: PaletteGroupDTO[] = [];

  const allApps: AppMetaResolvedType[] = [...deps.userApps, ...deps.drafts];
  const appMatches = allApps.filter((a) => !q || a.name.toLowerCase().includes(q));
  if (appMatches.length > 0) {
    groups.push({
      group: 'Apps',
      items: appMatches.slice(0, 8).map((a): PaletteRowDTO => {
        const finish = window.CentraidTokens.tileFinish(a.color, deps.tileVariant);
        return {
          variant: 'app',
          label: a.name,
          ...(a.desc ? { sub: a.desc } : {}),
          iconHtml: iconSvg(a.iconKey || 'Sparkle'),
          tile: {
            background: finish.background,
            glyphColor: finish.glyphColor,
            boxShadow: finish.boxShadow,
          },
          run: () => {
            deps.onClose();
            deps.navigate({ kind: 'app', id: a.id });
          },
        };
      }),
    });
  }

  const navMatches = NAV_ACTIONS.filter((n) => !q || n.label.toLowerCase().includes(q));
  if (navMatches.length > 0) {
    groups.push({
      group: 'Go to',
      items: navMatches.map(
        (n): PaletteRowDTO => ({
          variant: 'action',
          label: n.label,
          iconHtml: iconSvg(n.icon),
          run: () => {
            deps.onClose();
            deps.navigate(n.route);
          },
        }),
      ),
    });
  }

  const trimmed = query.trim();
  groups.push({
    group: 'Create',
    items: [
      {
        variant: 'action',
        accent: true,
        label: trimmed ? `Build “${trimmed}”` : 'Build a new app…',
        iconHtml: iconSvg('Plus'),
        run: () => {
          deps.onClose();
          deps.enterBuilder(trimmed || undefined);
        },
      },
    ],
  });

  return groups;
}
