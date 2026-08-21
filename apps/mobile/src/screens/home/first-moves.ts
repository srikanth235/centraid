// What Home offers for the apps that have NOT earned the grid.
//
// The Binding Layer's Home is graded: a tile earns its slot by having something
// to show (./tile-model#tileEarnsGrid), and every app that has not becomes a
// FIRST MOVE — an invitation to put something in it. There are two renderings
// of the same list and they are deliberately different in weight:
//
//  · day one (nothing anywhere) is a themed page — display serif, one paragraph
//    in the reading register, three moves, a mono foot with real counts;
//  · under a populated grid it is a quiet band — a hairline rule, a micro-caps
//    label, three 44px rows with a trailing arrow, no serif and no paragraph.
//
// Pure by the same discipline as ./catalog, ./band and ./tile-model: the
// selection rule is the part that can be wrong, so it is the part under test.
// The copy itself is shared with desktop (@centraid/client/home-copy) because a
// single state may not have two spellings across surfaces.

import { HOME_FIRST_MOVE_COPY } from "@centraid/client/home-copy";
import { apps as BUILTIN_APPS } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

/** One thing a member can do that will actually put something on this page. */
export interface FirstMove {
  /** App id, or `connectors` — the one move that is not an app. */
  id: string;
  label: string;
  hint: string;
  iconKey: AppMetaResolved["iconKey"];
  /** Identity hue hex, or `undefined` for the non-app move (no hue to claim). */
  color?: string;
}

/**
 * Leverage order, which is not springboard order.
 *
 * `connectors` leads because it is the only move whose result is bigger than
 * the act: mail, calendar and contacts arrive on their own afterwards, so one
 * decision fills three tiles. Photos and Docs follow because they are what the
 * day-one copy actually promises ("bring your photographs and documents in"),
 * and the rest by how quickly one action pays back.
 *
 * Kept in step with `homeFirstMoves` in
 * packages/client/src/react/shell/routes/homeTiles.ts, which carries the same
 * order for the desktop grid; the labels themselves come from the one shared
 * copy module, so only the ordering is stated twice.
 */
const FIRST_MOVE_ORDER: readonly string[] = [
  "connectors",
  "photos",
  "docs",
  "notes",
  "agenda",
  "tasks",
  "people",
  "tally",
  "locker",
];

/** Connectors is not an app, so it has no entry in the app registry. */
const CONNECTORS_ICON: AppMetaResolved["iconKey"] = "Plug";

/**
 * THREE, not one per empty app.
 *
 * A nudge as tall as the grid it sits under stops being a nudge, and day one
 * offers a picture of what Home becomes rather than an inventory of what is
 * missing. Both renderings take the same three so the transition from day one
 * to a filling vault is a list getting shorter, not a different list.
 */
export const FIRST_MOVE_LIMIT = 3;

/**
 * The moves to offer, given the ids of the apps that did not earn the grid.
 *
 * Every move has to land somewhere that can TAKE content — an invitation that
 * opens the empty app it names is a dead end wearing an invitation, since you
 * arrive at the same emptiness one screen deeper with no more idea what to do.
 */
export function firstMoves(
  idleAppIds: Iterable<string>,
  limit = FIRST_MOVE_LIMIT
): FirstMove[] {
  const idle = new Set(idleAppIds);
  const byId = new Map(BUILTIN_APPS.map((app) => [app.id, app]));
  const moves: FirstMove[] = [];
  for (const id of FIRST_MOVE_ORDER) {
    if (moves.length >= limit) break;
    const copy = HOME_FIRST_MOVE_COPY[id];
    if (!copy) continue;
    if (id === "connectors") {
      // Offered while ANY app is idle: the accounts it connects fill several of
      // them at once, so it is never the wrong suggestion on a thin page.
      if (idle.size === 0) continue;
      moves.push({ ...copy, iconKey: CONNECTORS_ICON, id });
      continue;
    }
    if (!idle.has(id)) continue;
    const meta = byId.get(id);
    if (!meta) continue;
    moves.push({ ...copy, color: meta.color, iconKey: meta.iconKey, id });
  }
  return moves;
}
