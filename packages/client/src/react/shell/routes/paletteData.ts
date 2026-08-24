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

// The ⌘K command palette's data driver. Given the current query it returns
// grouped rows (apps, navigation targets, a "build a new app" create row),
// each with a `run` closure the palette invokes on Enter/click. Kept pure +
// deps-injected so it is unit-testable without a live shell.

// The palette's destinations ARE the launcher's, read from the one model
// rather than restated here (#707). The palette is the keyboard route to the
// same places and the complete index of them — including the ones nobody has
// pinned — so two lists that could disagree about a label or drop a
// destination outright is exactly the failure to design out. A member who
// reads "Devices" on the stem types "devices" here and gets the same row.
// Gated destinations leave the index with the launcher (C1): the palette is
// the KEYBOARD route to the same places, so a row here for a place the stem
// stopped offering would be the silent no-op the capability wall exists to
// prevent — Enter, and a page that cannot load.
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
  /** What this gateway offers (C1). Optional so a caller without a live
   *  handshake (older tests, harnesses) still indexes every destination. */
  capabilities?: ShellCapabilities;
  tileVariant: AppearancePrefs["tileVariant"];
  navigate: (route: ShellRoute) => void;
  onClose: () => void;
  /**
   * Async conversation FTS source (#420). `buildPaletteGroups` reads its
   * synchronous cache and schedules a debounced fetch; when results land the
   * source calls the palette's `refresh()`, re-running this builder. Optional
   * so callers (and older tests) without a search source still work.
   */
  conversationSearch?: PaletteConversationSearch;
  /** FTS5 results across the eight bundled blueprint entity types. */
  entitySearch?: PaletteEntitySearch;
  /**
   * Recently opened/edited vault objects + the suggestion chips derived from
   * them — the pre-query empty state (#708). Optional so callers
   * without a live replica session still work, same convention as the other
   * two search sources.
   */
  recents?: PaletteRecents;
}

/** The owning app's icon + identity hue for a group header (#708 §A
 *  point 2 — "icon as group marker"). Looked up from the shared app catalog
 *  rather than `deps.userApps` so a group renders correctly even before the
 *  bundled app has been added to the member's home screen. */
function appGroupIcon(appId: string): PaletteGroupIconDTO | undefined {
  const app = APP_CATALOG.find((a) => a.id === appId);
  if (!app) return undefined;
  return { html: iconSvg(app.iconKey), hue: `var(--c-${app.colorKey})` };
}

/** Conversations aren't owned by a blueprint app — they're the Assistant
 *  surface's own object kind — so its group marker comes from the launcher
 *  destination instead of the app catalog. */
function assistantGroupIcon(): PaletteGroupIconDTO | undefined {
  const assistant = LAUNCHER_DESTINATIONS.find((d) => d.id === "assistant");
  if (!assistant) return undefined;
  /* No `hue`: the Assistant is a frame destination, and the frame spends no
     colour (invariant 3). The group still reads as its own because the mark is
     its own — a hue would have to be borrowed from one of the eight apps. */
  return { html: iconSvg(assistant.icon) };
}

/**
 * One vault-object row from an entity hit (#708) — shared between
 * the query-time entity-search groups and the empty-state Recents group so
 * the two present identically.
 *
 * KNOWN SEAM: `run` still opens the owning app (`{kind:"app", id: appId}`),
 * not the specific object. `ShellRoute`'s `app` variant carries only the
 * app's id — there is currently no field, postMessage type, or app-manifest
 * convention to hand a record id into a running blueprint app (no
 * `openRecordId` on the route, no `centraid:open-entity` message, no
 * "detail route" in app.json). Opening the app is the closest available
 * action until that plumbing exists; faking a deeper deep-link here would
 * misrepresent what actually happens on click.
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

  // Recents (#708): the pre-query empty state. Objects, not apps —
  // rows are the member's own recently opened/edited items, grouped by their
  // owning app exactly like a live entity-search hit would be.
  if (!q && deps.recents) {
    deps.recents.ensure();
    const hits = deps.recents.items();
    if (hits.length > 0) {
      groups.push({
        // Recents mixes objects from every app, so — unlike the entity-search
        // and Conversations groups below — there is no single owning app to
        // tint the marker with; the clock glyph stays neutral (no hue).
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

  // Conversations (#420): FTS over titles + message text. The source
  // fetches asynchronously and re-runs this builder when hits arrive, so the
  // group fills in a beat after typing. Only shown when there's a query.
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

  // Entity search (#420, extended #708 §A): vault OBJECTS —
  // never "open app X" — grouped by their owning app, one group per app id
  // so the header carries that app's own icon + identity hue.
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

/**
 * Suggestion chips for the empty state (#708) — the palette calls
 * this only while the query field is empty. A thin wrapper over
 * `deps.recents` so `App.tsx` can pass it as `PaletteBridgeProps.suggestions`
 * without reaching into the recents source's shape itself.
 */
export function buildPaletteSuggestions(deps: PaletteDeps): string[] {
  if (!deps.recents) return [];
  deps.recents.ensure();
  return deps.recents.suggestions();
}
