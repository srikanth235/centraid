import type {
  AppearancePrefs,
  ShellRoute,
} from "../../../app-shell-context.js";
import type { PaletteGroupDTO, PaletteRowDTO } from "../../screen-contracts.js";
import { iconSvg } from "../iconSvg.js";
import type { PaletteConversationSearch } from "./paletteConversationSearch.js";
import type { PaletteEntitySearch } from "./paletteEntitySearch.js";

// The ⌘K command palette's data driver — the React successor to the vanilla
// app-palette.ts `buildGroups`. Given the current query it returns grouped
// rows (apps, navigation targets, a "build a new app" create row), each with a
// `run` closure the palette invokes on Enter/click. Kept pure + deps-injected
// so it is unit-testable without a live shell.

// Labels here must match the sidebar's (navModel.ts) — the palette is the
// keyboard route to the same destinations, and a member who reads "Devices"
// in the rail will type "devices" here (#667). Destinations the sidebar
// dropped (Discover, Gateway, Storage) stay listed: the palette is the
// complete index, which is exactly what lets the rail stay short.
const NAV_ACTIONS: { label: string; icon: string; route: ShellRoute }[] = [
  { label: "Home", icon: "Home", route: { kind: "home" } },
  { label: "Assistant", icon: "Sparkle", route: { kind: "assistant" } },
  { label: "Notifications", icon: "Bell", route: { kind: "approvals" } },
  { label: "Automations", icon: "Bolt", route: { kind: "automations" } },
  { label: "Connectors", icon: "Plug", route: { kind: "connectors" } },
  { label: "Devices", icon: "Monitor", route: { kind: "household" } },
  { label: "Data", icon: "Folder", route: { kind: "atlas" } },
  { label: "Analytics", icon: "Activity", route: { kind: "insights" } },
  { label: "Discover", icon: "Compass", route: { kind: "discover" } },
  { label: "Gateway", icon: "Cellular", route: { kind: "gateway" } },
  { label: "Storage", icon: "Save", route: { kind: "storage" } },
  { label: "Settings", icon: "Settings", route: { kind: "settings" } },
];

export interface PaletteDeps {
  userApps: readonly UserAppMeta[];
  drafts: readonly DraftAppMeta[];
  /** Dev flag (issue #434, Phase 3) — the "Build a new app…" create row is a
   *  builder entry point, so it only appears when the builder is enabled. */
  builderEnabled: boolean;
  tileVariant: AppearancePrefs["tileVariant"];
  navigate: (route: ShellRoute) => void;
  enterBuilder: (initialPrompt?: string) => void;
  onClose: () => void;
  /**
   * Async conversation FTS source (issue #420). `buildPaletteGroups` reads its
   * synchronous cache and schedules a debounced fetch; when results land the
   * source calls the palette's `refresh()`, re-running this builder. Optional
   * so callers (and older tests) without a search source still work.
   */
  conversationSearch?: PaletteConversationSearch;
  /** FTS5 results across the eight bundled blueprint entity types. */
  entitySearch?: PaletteEntitySearch;
}

/** Flatten an FTS `snippet()` string to plain palette-sub text (drop `⟦`/`⟧`). */
function snippetToText(snippet: string): string {
  return snippet
    .replace(/[⟦⟧]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Recompute the palette's grouped rows for `query` (case-insensitive substring). */
export function buildPaletteGroups(
  query: string,
  deps: PaletteDeps
): PaletteGroupDTO[] {
  const q = query.trim().toLowerCase();
  const groups: PaletteGroupDTO[] = [];

  const allApps: AppMetaResolvedType[] = [...deps.userApps, ...deps.drafts];
  const appMatches = allApps.filter(
    (a) => !q || a.name.toLowerCase().includes(q)
  );
  if (appMatches.length > 0) {
    groups.push({
      group: "Apps",
      items: appMatches.slice(0, 8).map((a): PaletteRowDTO => {
        const finish = window.CentraidTokens.tileFinish(
          a.color,
          deps.tileVariant
        );
        return {
          variant: "app",
          label: a.name,
          ...(a.desc ? { sub: a.desc } : {}),
          iconHtml: iconSvg(a.iconKey || "Sparkle"),
          tile: {
            background: finish.background,
            glyphColor: finish.glyphColor,
            boxShadow: finish.boxShadow,
          },
          run: () => {
            deps.onClose();
            deps.navigate({ kind: "app", id: a.id });
          },
        };
      }),
    });
  }

  // Conversations (issue #420): FTS over titles + message text. The source
  // fetches asynchronously and re-runs this builder when hits arrive, so the
  // group fills in a beat after typing. Only shown when there's a query.
  if (q && deps.conversationSearch) {
    deps.conversationSearch.ensure(query);
    const hits = deps.conversationSearch.results(query);
    if (hits.length > 0) {
      groups.push({
        group: "Conversations",
        items: hits.slice(0, 6).map(
          (h): PaletteRowDTO => ({
            variant: "chat",
            label: h.title || "New conversation",
            ...(h.snippet ? { sub: snippetToText(h.snippet) } : {}),
            iconHtml: iconSvg("Sparkle"),
            run: () => {
              deps.onClose();
              deps.navigate({ kind: "assistant", conversationId: h.id });
            },
          })
        ),
      });
    }
  }

  if (q && deps.entitySearch) {
    deps.entitySearch.ensure(query);
    const hits = deps.entitySearch.results(query);
    const byApp = new Map<string, typeof hits>();
    for (const hit of hits) {
      const rows = byApp.get(hit.appLabel) ?? [];
      rows.push(hit);
      byApp.set(hit.appLabel, rows);
    }
    for (const [appLabel, rows] of byApp) {
      groups.push({
        group: appLabel,
        items: rows.slice(0, 6).map(
          (hit): PaletteRowDTO => ({
            variant: "action",
            label: hit.label,
            sub: hit.snippet || hit.entity,
            meta: hit.appLabel,
            iconHtml: iconSvg("Search"),
            run: () => {
              deps.onClose();
              deps.navigate({ kind: "app", id: hit.appId });
            },
          })
        ),
      });
    }
  }

  const navMatches = NAV_ACTIONS.filter(
    (n) => !q || n.label.toLowerCase().includes(q)
  );
  if (navMatches.length > 0) {
    groups.push({
      group: "Go to",
      items: navMatches.map(
        (n): PaletteRowDTO => ({
          variant: "action",
          label: n.label,
          iconHtml: iconSvg(n.icon),
          run: () => {
            deps.onClose();
            deps.navigate(n.route);
          },
        })
      ),
    });
  }

  // The "Build a new app…" create row is a builder entry point (issue #434,
  // Phase 3) — omitted entirely when the builder is hidden.
  if (deps.builderEnabled) {
    const trimmed = query.trim();
    groups.push({
      group: "Create",
      items: [
        {
          variant: "action",
          accent: true,
          label: trimmed ? `Build “${trimmed}”` : "Build a new app…",
          iconHtml: iconSvg("Plus"),
          run: () => {
            deps.onClose();
            deps.enterBuilder(trimmed || undefined);
          },
        },
      ],
    });
  }

  return groups;
}
