// An app failing `tileEarnsGrid` becomes a FIRST MOVE. Keep this pure; copy
// comes from @centraid/client/home-copy — one state, one spelling.

import { HOME_FIRST_MOVE_COPY } from "@centraid/client/home-copy";
import { apps as BUILTIN_APPS } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

export interface FirstMove {
  /** App id, or `connectors` — the one move that is not an app. */
  id: string;
  label: string;
  hint: string;
  iconKey: AppMetaResolved["iconKey"];
  /** Absent on the non-app move. */
  color?: string;
}

/** Leverage order, not springboard order; keep in step with
 *  `homeFirstMoves`. */
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

const CONNECTORS_ICON: AppMetaResolved["iconKey"] = "Plug";

/** Three, not one per empty app: a nudge as tall as its grid is no nudge. */
export const FIRST_MOVE_LIMIT = 3;

/** Every move must land somewhere that can TAKE content. */
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
      // Offered while ANY app is idle: one connection fills several at once.
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
