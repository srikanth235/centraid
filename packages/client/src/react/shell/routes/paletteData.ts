import { apps as APP_CATALOG } from "@centraid/design";

import type {
  AppearancePrefs,
  ShellRoute,
} from "../../../app-shell-context.js";
import type {
  PaletteGroupDTO,
  PaletteGroupIconDTO,
  PaletteRowDTO,
} from "../../screen-contracts.js";
import { CAPABILITIES_ON } from "../capabilities.js";
import type { ShellCapabilities } from "../capabilities.js";
import { iconSvg } from "../iconSvg.js";
import {
  LAUNCHER_DESTINATIONS,
  visibleDestinations,
} from "../launcherModel.js";
import type { PaletteConversationSearch } from "./paletteConversationSearch.js";
import type {
  PaletteEntityHit,
  PaletteEntitySearch,
} from "./paletteEntitySearch.js";
import type { PaletteRecents } from "./paletteRecents.js";

// The ⌘K palette's data driver. Keep it pure and deps-injected so it is
// testable without a live shell. Destinations ARE the launcher's, read from the
// one model and never restated here (#707); gated ones leave the index with it
// (C1), or Enter lands on a page that cannot load.
function navActions(
  capabilities: ShellCapabilities
): { label: string; icon: string; route: ShellRoute }[] {
  return visibleDestinations(capabilities).map((destination) => ({
    icon: destination.icon,
    label: destination.label,
    route: destination.route,
  }));
}

export interface PaletteDeps {
  userApps: readonly UserAppMeta[];
  capabilities?: ShellCapabilities;
  tileVariant: AppearancePrefs["tileVariant"];
  navigate: (route: ShellRoute) => void;
  onClose: () => void;
  /** Read synchronously; landing results call `refresh()` to re-run the
   *  builder. */
  conversationSearch?: PaletteConversationSearch;
  entitySearch?: PaletteEntitySearch;
  recents?: PaletteRecents;
}

function appGroupIcon(appId: string): PaletteGroupIconDTO | undefined {
  const app = APP_CATALOG.find((a) => a.id === appId);
  if (!app) return undefined;
  return { html: iconSvg(app.iconKey), hue: `var(--c-${app.colorKey})` };
}

function assistantGroupIcon(): PaletteGroupIconDTO | undefined {
  const assistant = LAUNCHER_DESTINATIONS.find((d) => d.id === "assistant");
  if (!assistant) return undefined;
  /* No `hue`: the frame spends no colour (invariant 3). */
  return { html: iconSvg(assistant.icon) };
}

/**
 * KNOWN SEAM: `run` opens the owning app, not the object. Nothing hands a
 * record id into a running blueprint app yet, and faking a deeper deep-link
 * would misrepresent what the click does.
 */
function entityRow(hit: PaletteEntityHit, deps: PaletteDeps): PaletteRowDTO {
  return {
    variant: "action",
    label: hit.label,
    ...(hit.snippet ? { sub: hit.snippet } : {}),
    kind: hit.kind,
    ...(hit.meta ? { meta: hit.meta } : {}),
    iconHtml: iconSvg("Search"),
    run: () => {
      deps.onClose();
      deps.navigate({ kind: "app", id: hit.appId });
    },
  };
}

function snippetToText(snippet: string): string {
  return snippet
    .replace(/[⟦⟧]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function buildPaletteGroups(
  query: string,
  deps: PaletteDeps
): PaletteGroupDTO[] {
  const q = query.trim().toLowerCase();
  const groups: PaletteGroupDTO[] = [];

  if (!q && deps.recents) {
    deps.recents.ensure();
    const hits = deps.recents.items();
    if (hits.length > 0) {
      groups.push({
        group: "Recents",
        icon: { html: iconSvg("Clock") },
        items: hits.slice(0, 8).map((hit) => entityRow(hit, deps)),
      });
    }
  }

  const appMatches = deps.userApps.filter(
    (a) => !q || a.name.toLowerCase().includes(q)
  );
  if (appMatches.length > 0) {
    groups.push({
      group: "Apps",
      items: appMatches.slice(0, 8).map((a): PaletteRowDTO => {
        return {
          variant: "app",
          label: a.name,
          ...(a.desc ? { sub: a.desc } : {}),
          appMark: { colorKey: a.colorKey, iconKey: a.iconKey },
          iconHtml: iconSvg(a.iconKey || "Sparkle"),
          run: () => {
            deps.onClose();
            deps.navigate({ kind: "app", id: a.id });
          },
        };
      }),
    });
  }

  if (q && deps.conversationSearch) {
    deps.conversationSearch.ensure(query);
    const hits = deps.conversationSearch.results(query);
    if (hits.length > 0) {
      groups.push({
        group: "Conversations",
        icon: assistantGroupIcon(),
        items: hits.slice(0, 6).map(
          (h): PaletteRowDTO => ({
            variant: "chat",
            label: h.title || "New conversation",
            kind: "conversation",
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

  // Vault OBJECTS, never "open app X": one group per app id.
  if (q && deps.entitySearch) {
    deps.entitySearch.ensure(query);
    const hits = deps.entitySearch.results(query);
    const byApp = new Map<string, typeof hits>();
    for (const hit of hits) {
      const rows = byApp.get(hit.appId) ?? [];
      rows.push(hit);
      byApp.set(hit.appId, rows);
    }
    for (const [appId, rows] of byApp) {
      groups.push({
        group: rows[0]?.appLabel ?? appId,
        icon: appGroupIcon(appId),
        items: rows.slice(0, 6).map((hit) => entityRow(hit, deps)),
      });
    }
  }

  const navMatches = navActions(deps.capabilities ?? CAPABILITIES_ON).filter(
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

  return groups;
}

export function buildPaletteSuggestions(deps: PaletteDeps): string[] {
  if (!deps.recents) return [];
  deps.recents.ensure();
  return deps.recents.suggestions();
}
